import { createHash } from 'node:crypto';
import {
  BetterFilesError,
  invalidConfig,
  type JobEnvelope,
  type JobRunner,
  type Logger,
} from '@better-files/core';
import { signHeaders, type AwsCredentials } from '@better-files/storage-s3';
import {
  defaultRecoverAfterMs,
  queuedJob,
  runMessage,
  runOf,
  type JobsHost,
  type QueuedJob,
  type RunJob,
} from './shared.js';

/** An SQS message body: the job's identity and when it is due. */
export interface SqsJobMessage extends QueuedJob {
  runAt: number;
}

export interface SqsRunnerOptions {
  /** `https://sqs.{region}.amazonaws.com/{account}/{queue}`. Standard queues; FIFO queues (`.fifo`) work too. */
  queueUrl: string;
  region: string;
  credentials: AwsCredentials | (() => Promise<AwsCredentials>);
  /** API endpoint, for VPC endpoints and emulators. Default: the origin of `queueUrl`. */
  endpoint?: string;
  fetch?: typeof fetch;
  /** Consumer (`dr.jobs.start()`): parallel long-poll loops. Default 1, each taking up to 10 messages. */
  pollers?: number;
  /** Consumer: long-poll wait, 0–20 seconds. Default 20. */
  waitTimeSeconds?: number;
  /** Consumer: messages per receive, 1–10. Default 10. */
  batchSize?: number;
  /** See `JobRunner.recoverAfterMs`. Default 5 minutes. */
  recoverAfterMs?: number;
  /** Where consumer errors go (network failures, throttling). Default: `console`. */
  logger?: Pick<Logger, 'warn' | 'error'>;
}

/** An SQS record as Lambda's event source mapping delivers it. */
export interface SqsLambdaRecord {
  messageId: string;
  body: string;
}

/** The Lambda handler's answer, for `ReportBatchItemFailures`: only failed messages come back. */
export interface SqsBatchResponse {
  batchItemFailures: { itemIdentifier: string }[];
}

/** An SQS runner: a `JobRunner` plus a Lambda handler. */
export interface SqsRunner extends JobRunner {
  /**
   * A handler for an SQS-triggered Lambda: `export const handler = runner.lambdaHandler(dr)`. Turn on
   * `ReportBatchItemFailures` in the event source mapping, so only messages whose job could not be run come back.
   */
  lambdaHandler(
    host: JobsHost | RunJob,
  ): (event: { Records: SqsLambdaRecord[] }) => Promise<SqsBatchResponse>;
}

/** SQS's longest message delay (15 minutes) and visibility timeout (12 hours), in seconds. */
const maxDelaySeconds = 900;
const maxVisibilitySeconds = 43_200;

const seconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));

/** Parses a message body; `undefined` when it is not one of ours. */
function parse(body: string): SqsJobMessage | undefined {
  try {
    const value = JSON.parse(body) as Partial<SqsJobMessage> | null;
    if (value && typeof value.id === 'string' && typeof value.runAt === 'number')
      return value as SqsJobMessage;
  } catch {
    // Not JSON: another producer's message.
  }
  return undefined;
}

/**
 * Runs Better Files jobs on Amazon SQS, over SigV4 and `fetch` (no AWS SDK). SQS only delivers; attempts, backoff and
 * failures stay in the Better Files `jobs` table, and `dr.maintain()` runs anything the queue lost.
 *
 * Jobs due within 15 minutes use SQS's message delay. A job due later is held by extending the message's
 * visibility (up to 12 hours at a time) when a consumer receives it early; the Lambda handler sends it again
 * with a new delay. Either way it counts as a receive, so a redrive policy's `maxReceiveCount` should allow for long
 * delays (or rely on `dr.maintain()`, which runs them when due regardless).
 *
 * ```ts
 * const runner = sqsRunner({ queueUrl, region: 'eu-west-1', credentials });
 * const dr = betterFiles({ ..., jobs: { runner } });
 * await dr.jobs.start();                              // a long-running worker, or:
 * export const handler = runner.lambdaHandler(dr);    // an SQS-triggered Lambda
 * ```
 */
export function sqsRunner(options: SqsRunnerOptions): SqsRunner {
  if (!options.queueUrl || !options.region || !options.credentials)
    throw invalidConfig('sqsRunner: queueUrl, region and credentials are required');
  const queueUrl = options.queueUrl;
  const fifo = queueUrl.endsWith('.fifo');
  const endpoint = new URL(options.endpoint ?? new URL(queueUrl).origin);
  const doFetch = options.fetch ?? fetch;
  const logger = options.logger ?? console;
  const waitTimeSeconds = Math.min(20, Math.max(0, options.waitTimeSeconds ?? 20));
  const batchSize = Math.min(10, Math.max(1, options.batchSize ?? 10));

  async function call<T>(
    action: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const credentials =
      typeof options.credentials === 'function' ? await options.credentials() : options.credentials;
    const body = JSON.stringify({ QueueUrl: queueUrl, ...payload });
    const date = new Date();
    const headers: Record<string, string> = {
      host: endpoint.host,
      'content-type': 'application/x-amz-json-1.0',
      'x-amz-date': date.toISOString().replace(/[:-]|\.\d{3}/g, ''),
      'x-amz-target': `AmazonSQS.${action}`,
      ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
    };
    const authorization = signHeaders({
      method: 'POST',
      path: endpoint.pathname || '/',
      headers,
      payloadHash: createHash('sha256').update(body).digest('hex'),
      region: options.region,
      service: 'sqs',
      credentials,
      date,
    });
    delete headers.host;
    const response = await doFetch(endpoint, {
      method: 'POST',
      headers: { ...headers, authorization },
      body,
      ...(signal ? { signal } : {}),
    });
    const text = await response.text();
    const json = (text ? JSON.parse(text) : {}) as T & { __type?: string; message?: string };
    if (!response.ok) {
      const code = json.__type?.split('#').pop() ?? `HTTP ${response.status}`;
      throw new BetterFilesError(
        response.status === 429 || code.includes('Throttl') ? 'RATE_LIMITED' : 'INTERNAL_ERROR',
        `SQS ${action} failed: ${code}${json.message ? `: ${json.message}` : ''}`,
      );
    }
    return json;
  }

  /** Sends messages, ten per request; a message SQS refuses fails the whole dispatch (maintain() recovers it). */
  async function send(messages: SqsJobMessage[]) {
    const now = Date.now();
    for (let i = 0; i < messages.length; i += 10) {
      const chunk = messages.slice(i, i + 10);
      const result = await call<{ Failed?: { Id: string; Code?: string; Message?: string }[] }>(
        'SendMessageBatch',
        {
          Entries: chunk.map((message, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(message),
            // FIFO queues take no per-message delay; consumers hold early messages instead.
            ...(fifo
              ? {
                  MessageGroupId: message.id,
                  MessageDeduplicationId: `${message.id}-${message.runAt}`,
                }
              : { DelaySeconds: Math.min(maxDelaySeconds, seconds(message.runAt - now)) }),
          })),
        },
      );
      if (result.Failed?.length)
        throw new BetterFilesError(
          'INTERNAL_ERROR',
          `SQS refused ${result.Failed.length} message(s): ${result.Failed[0]!.Code ?? 'unknown'}`,
        );
    }
  }

  let controller: AbortController | undefined;
  let loops: Promise<void>[] = [];

  async function poll(run: RunJob, signal: AbortSignal) {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const { Messages = [] } = await call<{
          Messages?: { MessageId: string; ReceiptHandle: string; Body: string }[];
        }>(
          'ReceiveMessage',
          { MaxNumberOfMessages: batchSize, WaitTimeSeconds: waitTimeSeconds },
          signal,
        );
        failures = 0;
        const done: { Id: string; ReceiptHandle: string }[] = [];
        await Promise.all(
          Messages.map(async (message, index) => {
            const job = parse(message.Body);
            const early = job ? job.runAt - Date.now() : 0;
            if (job && early > 1000) {
              await call('ChangeMessageVisibility', {
                ReceiptHandle: message.ReceiptHandle,
                VisibilityTimeout: Math.min(maxVisibilitySeconds, seconds(early)),
              });
              return;
            }
            try {
              await runMessage(run, job);
              done.push({ Id: String(index), ReceiptHandle: message.ReceiptHandle });
            } catch (error) {
              // Left on the queue: SQS delivers it again after the visibility timeout.
              logger.error('Better Files could not run a job from SQS', {
                messageId: message.MessageId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }),
        );
        if (done.length) await call('DeleteMessageBatch', { Entries: done });
      } catch (error) {
        if (signal.aborted) return;
        failures++;
        logger.warn('Better Files SQS consumer failed; retrying', {
          error: error instanceof Error ? error.message : String(error),
        });
        // Back off on repeated failures (network down, throttling): 1 s doubling, capped at 30 s.
        await new Promise((resolve) => {
          const timer = setTimeout(
            resolve,
            Math.min(30_000, 1000 * 2 ** Math.min(5, failures - 1)),
          );
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve(undefined);
          });
        });
      }
    }
  }

  return {
    id: 'sqs',
    recoverAfterMs: options.recoverAfterMs ?? defaultRecoverAfterMs,
    async dispatch(envelopes: readonly JobEnvelope[]) {
      if (envelopes.length === 0) return;
      await send(envelopes.map((envelope) => ({ ...queuedJob(envelope), runAt: envelope.runAt })));
    },
    start(run) {
      if (controller) return;
      controller = new AbortController();
      const { signal } = controller;
      loops = Array.from({ length: Math.max(1, options.pollers ?? 1) }, () => poll(run, signal));
    },
    async close() {
      controller?.abort();
      controller = undefined;
      await Promise.all(loops);
      loops = [];
    },
    lambdaHandler(host) {
      const run = runOf(host);
      return async (event) => {
        const failures: { itemIdentifier: string }[] = [];
        const later: { record: SqsLambdaRecord; job: SqsJobMessage }[] = [];
        await Promise.all(
          (event?.Records ?? []).map(async (record) => {
            const job = parse(record.body);
            if (job && job.runAt - Date.now() > 1000) {
              later.push({ record, job });
              return;
            }
            try {
              await runMessage(run, job);
            } catch {
              failures.push({ itemIdentifier: record.messageId });
            }
          }),
        );
        // Not due yet: sent again with a new delay, and this delivery succeeds. If sending fails, SQS redelivers.
        if (later.length)
          try {
            await send(later.map((item) => item.job));
          } catch {
            failures.push(...later.map((item) => ({ itemIdentifier: item.record.messageId })));
          }
        return { batchItemFailures: failures };
      };
    },
  };
}
