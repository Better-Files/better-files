import { createId, defineJob, type JobEnvelope } from '@better-files/core';
import { sqsRunner, type SqsJobMessage } from '@better-files/jobs';
import { betterFiles } from '@better-files/server';
import { memoryDatabase } from '@better-files/testing';
import { describe, expect, it } from 'vitest';
import { fixture, SECRET, TENANT } from '../fixtures.js';

const queueUrl = 'https://sqs.eu-west-1.amazonaws.com/123456789012/better-files';
const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' };
const quiet = { warn() {}, error() {} };

interface StoredMessage {
  id: string;
  body: string;
  visibleAt: number;
  receipt: number;
  receives: number;
  group?: string;
  dedupe?: string;
}

/** Just enough of the SQS JSON protocol: send, receive (with long-poll wait skipped), delete, visibility. */
function fakeSqs(options: { failSends?: () => boolean } = {}) {
  const messages: StoredMessage[] = [];
  const calls: { action: string; body: Record<string, unknown>; headers: Headers }[] = [];
  let next = 0;
  const sqsFetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init!.headers);
    const action = headers.get('x-amz-target')!.replace('AmazonSQS.', '');
    const body = JSON.parse(String(init!.body)) as Record<string, any>;
    calls.push({ action, body, headers });
    expect(String(url)).toBe('https://sqs.eu-west-1.amazonaws.com/');
    expect(body.QueueUrl).toBe(queueUrl);
    expect(headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/sqs\/aws4_request, SignedHeaders=content-type;host;x-amz-date(;x-amz-security-token)?;x-amz-target, Signature=[0-9a-f]{64}$/,
    );
    const now = Date.now();
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/x-amz-json-1.0' },
      });
    switch (action) {
      case 'SendMessageBatch': {
        if (options.failSends?.())
          return json({ __type: 'com.amazonaws.sqs#RequestThrottled', message: 'slow down' }, 400);
        for (const entry of body.Entries)
          messages.push({
            id: `m${next++}`,
            body: entry.MessageBody,
            visibleAt: now + (entry.DelaySeconds ?? 0) * 1000,
            receipt: 0,
            receives: 0,
            group: entry.MessageGroupId,
            dedupe: entry.MessageDeduplicationId,
          });
        return json({
          Successful: body.Entries.map((e: { Id: string }) => ({ Id: e.Id })),
          Failed: [],
        });
      }
      case 'ReceiveMessage': {
        const visible = messages
          .filter((m) => m.visibleAt <= now)
          .slice(0, body.MaxNumberOfMessages);
        for (const m of visible) {
          m.visibleAt = now + 30_000;
          m.receipt++;
          m.receives++;
        }
        if (!visible.length) await new Promise((resolve) => setTimeout(resolve, 20));
        return json({
          Messages: visible.map((m) => ({
            MessageId: m.id,
            ReceiptHandle: `${m.id}:${m.receipt}`,
            Body: m.body,
          })),
        });
      }
      case 'DeleteMessageBatch': {
        for (const entry of body.Entries) {
          const index = messages.findIndex((m) => `${m.id}:${m.receipt}` === entry.ReceiptHandle);
          if (index >= 0) messages.splice(index, 1);
        }
        return json({
          Successful: body.Entries.map((e: { Id: string }) => ({ Id: e.Id })),
          Failed: [],
        });
      }
      case 'ChangeMessageVisibility': {
        const m = messages.find((m) => `${m.id}:${m.receipt}` === body.ReceiptHandle)!;
        m.visibleAt = now + body.VisibilityTimeout * 1000;
        return json({});
      }
      default:
        return json({ __type: 'com.amazonaws.sqs#InvalidAction' }, 400);
    }
  }) as typeof fetch;
  return { fetch: sqsFetch, messages, calls };
}

const envelope = (runAt = Date.now()): JobEnvelope => ({
  id: createId('job'),
  tenantId: TENANT,
  name: 'tests.work',
  runAt,
});

const waitFor = async (condition: () => boolean, timeoutMs = 10_000) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('sqsRunner', () => {
  it('sends signed batches of ten, delaying up to 15 minutes', async () => {
    const sqs = fakeSqs();
    const runner = sqsRunner({ queueUrl, region: 'eu-west-1', credentials, fetch: sqs.fetch });
    expect(runner.id).toBe('sqs');
    expect(runner.recoverAfterMs).toBe(5 * 60_000);
    const now = Date.now();
    const jobs = Array.from({ length: 12 }, () => envelope(now));
    jobs.push(envelope(now + 90_000), envelope(now + 2 * 60 * 60_000));
    await runner.dispatch(jobs);
    const sends = sqs.calls.filter((call) => call.action === 'SendMessageBatch');
    expect(sends.map((call) => (call.body.Entries as unknown[]).length)).toEqual([10, 4]);
    const delays = sends.flatMap((call) =>
      (call.body.Entries as { DelaySeconds: number }[]).map((entry) => entry.DelaySeconds),
    );
    expect(delays.slice(0, 12).every((delay) => delay === 0)).toBe(true);
    expect(delays[12]).toBeGreaterThanOrEqual(89);
    expect(delays[12]).toBeLessThanOrEqual(90);
    expect(delays[13]).toBe(900);
    const body = JSON.parse(sqs.messages[0]!.body) as SqsJobMessage;
    expect(body).toEqual({ id: jobs[0]!.id, tenantId: TENANT, name: 'tests.work', runAt: now });
  });

  it('uses message groups and deduplication ids on FIFO queues', async () => {
    const sqs = fakeSqs();
    const runner = sqsRunner({
      queueUrl: `${queueUrl}.fifo`,
      region: 'eu-west-1',
      credentials: async () => ({ ...credentials, sessionToken: 'token' }),
      fetch: async (url, init) => {
        const body = JSON.parse(String(init!.body));
        body.QueueUrl = queueUrl;
        expect(new Headers(init!.headers).get('x-amz-security-token')).toBe('token');
        return sqs.fetch(url, { ...init, body: JSON.stringify(body) });
      },
    });
    const job = envelope(Date.now() + 60_000);
    await runner.dispatch([job]);
    expect(sqs.messages[0]).toMatchObject({
      group: job.id,
      dedupe: `${job.id}-${job.runAt}`,
    });
    expect(sqs.calls[0]!.body.Entries).toEqual([
      expect.not.objectContaining({ DelaySeconds: expect.anything() }),
    ]);
  });

  it('reports SQS errors', async () => {
    const sqs = fakeSqs({ failSends: () => true });
    const runner = sqsRunner({ queueUrl, region: 'eu-west-1', credentials, fetch: sqs.fetch });
    await expect(runner.dispatch([envelope()])).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      message: expect.stringContaining('RequestThrottled: slow down'),
    });
    expect(() => sqsRunner({ queueUrl: '', region: 'x', credentials })).toThrow(/required/);
  });

  it('consumes: runs due jobs, deletes them, and holds back early ones', async () => {
    const sqs = fakeSqs();
    const runner = sqsRunner({
      queueUrl,
      region: 'eu-west-1',
      credentials,
      fetch: sqs.fetch,
      waitTimeSeconds: 1,
      logger: quiet,
    });
    const ran: string[] = [];
    const due = envelope();
    const failing = envelope();
    await runner.dispatch([due, failing]);
    // A message delayed by SQS reaches the consumer early when its job is due after 15 minutes.
    const late = envelope(Date.now() + 60 * 60_000);
    sqs.messages.push({
      id: 'early',
      body: JSON.stringify({ id: late.id, tenantId: TENANT, name: 'x', runAt: late.runAt }),
      visibleAt: 0,
      receipt: 0,
      receives: 0,
    });
    sqs.messages.push({ id: 'foreign', body: 'not json', visibleAt: 0, receipt: 0, receives: 0 });
    await runner.start!(async (id) => {
      if (id === failing.id) throw new Error('database down');
      ran.push(id);
      return { id, status: 'completed' };
    });
    await waitFor(() => sqs.calls.some((call) => call.action === 'DeleteMessageBatch'));
    await runner.close!();
    expect(ran).toEqual([due.id]);
    // Deleted: the run job and the foreign message. Kept: the failed one (redelivered later) and the early one.
    expect(sqs.messages.map((m) => m.id).sort()).toEqual(['early', 'm1']);
    const early = sqs.messages.find((m) => m.id === 'early')!;
    expect(early.visibleAt - Date.now()).toBeGreaterThan(59 * 60_000);
    const visibility = sqs.calls.find((call) => call.action === 'ChangeMessageVisibility')!;
    expect(visibility.body.VisibilityTimeout).toBeGreaterThanOrEqual(3599);
  });

  it('keeps polling after errors and stops on close', async () => {
    let failing = true;
    const sqs = fakeSqs();
    const flaky = (async (url: string | URL | Request, init?: RequestInit) => {
      if (failing) {
        failing = false;
        throw new TypeError('fetch failed');
      }
      return sqs.fetch(url, init);
    }) as typeof fetch;
    const warnings: string[] = [];
    const runner = sqsRunner({
      queueUrl,
      region: 'eu-west-1',
      credentials,
      fetch: flaky,
      pollers: 2,
      logger: { warn: (message) => warnings.push(message), error() {} },
    });
    const ran: string[] = [];
    await runner.start!(async (id) => {
      ran.push(id);
      return { id, status: 'completed' };
    });
    const job = envelope();
    await runner.dispatch([job]);
    await waitFor(() => ran.length === 1, 15_000);
    expect(warnings).toEqual(['Better Files SQS consumer failed; retrying']);
    await runner.close!();
    const receives = sqs.calls.filter((call) => call.action === 'ReceiveMessage').length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sqs.calls.filter((call) => call.action === 'ReceiveMessage').length).toBe(receives);
  });

  it('lambdaHandler runs due jobs, re-sends early ones and reports only failures', async () => {
    const sqs = fakeSqs();
    const runner = sqsRunner({ queueUrl, region: 'eu-west-1', credentials, fetch: sqs.fetch });
    const ran: string[] = [];
    const ok = envelope();
    const broken = envelope();
    const later = envelope(Date.now() + 2 * 60 * 60_000);
    const handler = runner.lambdaHandler({
      jobs: {
        run: async (id) => {
          if (id === broken.id) throw new Error('database down');
          ran.push(id);
          return { id, status: 'completed' };
        },
      },
    });
    const record = (messageId: string, job: JobEnvelope) => ({
      messageId,
      body: JSON.stringify({
        id: job.id,
        tenantId: job.tenantId,
        name: job.name,
        runAt: job.runAt,
      }),
    });
    const result = await handler({
      Records: [
        record('a', ok),
        record('b', broken),
        record('c', later),
        { messageId: 'd', body: '{}' },
      ],
    });
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'b' }] });
    expect(ran).toEqual([ok.id]);
    expect(sqs.messages).toHaveLength(1);
    expect(JSON.parse(sqs.messages[0]!.body)).toMatchObject({ id: later.id });
    expect(sqs.calls[0]!.body.Entries).toEqual([expect.objectContaining({ DelaySeconds: 900 })]);

    // When the re-send fails, those records go back to SQS instead.
    const failingSqs = fakeSqs({ failSends: () => true });
    const failingRunner = sqsRunner({
      queueUrl,
      region: 'eu-west-1',
      credentials,
      fetch: failingSqs.fetch,
    });
    expect(
      await failingRunner.lambdaHandler(async (id) => ({ id, status: 'completed' }))({
        Records: [record('c', later)],
      }),
    ).toEqual({
      batchItemFailures: [{ itemIdentifier: 'c' }],
    });
  });

  it('runs Better Files jobs end to end through the queue', async () => {
    const sqs = fakeSqs();
    const f = await fixture({ database: memoryDatabase() });
    const seen: number[] = [];
    let attempts = 0;
    const dr = betterFiles({
      iam: f.iam,
      database: f.database,
      storage: f.storage,
      secret: SECRET,
      encryption: false,
      logger: quiet,
      jobs: {
        runner: sqsRunner({
          queueUrl,
          region: 'eu-west-1',
          credentials,
          fetch: sqs.fetch,
          waitTimeSeconds: 1,
          logger: quiet,
        }),
        handlers: {
          work: defineJob<{ n: number }>({
            backoff: () => 0,
            async handler(payload) {
              attempts++;
              if (attempts === 1) throw new Error('flaky');
              seen.push(payload.n);
            },
          }),
        },
      },
    });
    await dr.initialize();
    try {
      await dr.jobs.start();
      const job = await dr.jobs.enqueue(TENANT, 'work', { n: 42 });
      await waitFor(() => seen.length === 1);
      expect(seen).toEqual([42]);
      expect(await dr.jobs.get(TENANT, job.id)).toMatchObject({ status: 'completed', attempts: 2 });
      await waitFor(() => sqs.messages.length === 0);
    } finally {
      await dr.close();
    }
  });
});
