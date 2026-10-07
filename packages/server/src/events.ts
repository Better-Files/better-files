import { randomUUID } from 'node:crypto';
import type { BetterFilesEvent, Logger } from '@better-files/core';

export type { BetterFilesEvent } from '@better-files/core';
export type EventHandler = (event: BetterFilesEvent) => void | Promise<void>;

const matcher = (pattern: string) => {
  if (pattern === '*') return () => true;
  const expression = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^]*')}$`,
  );
  return (type: string) => expression.test(type);
};

/** True when `type` matches one of the patterns (`document.*`, `*`, `room.created`). */
export const matchesEvent = (patterns: readonly string[], type: string) =>
  patterns.some((pattern) => matcher(pattern)(type));

/**
 * In-process events, delivered after the operation's transaction commits. Handlers run in order; one failing handler
 * is logged and never affects the operation or the other handlers. `sinks` (plugin `onEvent` hooks) run last.
 */
export function createEventBus(logger: Logger) {
  const subscribers = new Set<{ test: (type: string) => boolean; handler: EventHandler }>();
  const sinks: EventHandler[] = [];
  const run = async (handler: EventHandler, event: BetterFilesEvent) => {
    try {
      await handler(event);
    } catch (error) {
      logger.error('Better Files event handler failed', {
        type: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return {
    subscribe(patterns: string | readonly string[], handler: EventHandler): () => void {
      const tests = (typeof patterns === 'string' ? [patterns] : patterns).map(matcher);
      const entry = { test: (type: string) => tests.some((test) => test(type)), handler };
      subscribers.add(entry);
      return () => subscribers.delete(entry);
    },
    addSink(handler: EventHandler) {
      sinks.push(handler);
    },
    async publish(event: Omit<BetterFilesEvent, 'id'> & { id?: string }): Promise<void> {
      const full: BetterFilesEvent = { ...event, id: event.id ?? randomUUID() };
      for (const subscriber of subscribers)
        if (subscriber.test(full.type)) await run(subscriber.handler, full);
      for (const sink of sinks) await run(sink, full);
    },
  };
}

export type EventBus = ReturnType<typeof createEventBus>;
