/**
 * Live room activity over Server-Sent Events, read with `fetch` (so bearer tokens work, unlike `EventSource`), with
 * automatic reconnection that resumes after the last received entry.
 */

export interface RoomActivity {
  sequence: number;
  action: string;
  actorId: string;
  nodeId?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  roomId: string;
}

export interface SubscribeOptions {
  onActivity(activity: RoomActivity): void;
  /** Access to the room was withdrawn; the subscription has ended. */
  onRevoked?(): void;
  onError?(error: unknown): void;
  /** Resume after this sequence. */
  after?: number;
  signal?: AbortSignal;
}

export interface LiveConnection {
  url(roomId: string): string;
  fetch: typeof fetch;
  headers(): Promise<Record<string, string>>;
  credentials: RequestCredentials;
}

/** Parses an SSE byte stream into events. */
export async function* parseEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ id?: string; event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + (buffer[boundary] === '\r' ? 4 : 2));
      let id: string | undefined;
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const content = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'id') id = content;
        else if (field === 'event') event = content;
        else if (field === 'data') data.push(content);
      }
      if (data.length || event !== 'message')
        yield { ...(id ? { id } : {}), event, data: data.join('\n') };
    }
  }
}

/** Follows a room's activity until `close()` or the signal aborts. */
export function subscribeRoom(
  connection: LiveConnection,
  roomId: string,
  options: SubscribeOptions,
) {
  const controller = new AbortController();
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  let last = options.after;
  let attempt = 0;
  const run = async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await connection.fetch(connection.url(roomId), {
          method: 'GET',
          credentials: connection.credentials,
          headers: {
            accept: 'text/event-stream',
            ...(await connection.headers()),
            ...(last !== undefined ? { 'last-event-id': String(last) } : {}),
          },
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          options.onRevoked?.();
          return;
        }
        if (!response.ok || !response.body)
          throw new Error(`Activity stream answered ${response.status}`);
        attempt = 0;
        for await (const message of parseEventStream(response.body)) {
          if (message.event === 'revoked') {
            options.onRevoked?.();
            controller.abort();
            return;
          }
          if (message.event !== 'activity') continue;
          const activity = JSON.parse(message.data) as RoomActivity;
          last = activity.sequence;
          options.onActivity(activity);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        options.onError?.(error);
      }
      // Reconnect with backoff (capped at 30 s), resuming after the last entry.
      const delay = Math.min(30_000, 500 * 2 ** attempt++);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  };
  void run();
  return { close: () => controller.abort() };
}

/** Cache prefixes a room activity makes stale, for the UI bindings. */
export function liveInvalidations(roomId: string, activity: RoomActivity): string[] {
  if (/^(folder|document|version)\./.test(activity.action))
    return [
      `index:${roomId}`,
      'folder:',
      ...(activity.nodeId ? [`document:${activity.nodeId}`] : []),
    ];
  if (/^(member|group)\./.test(activity.action)) return [`members:${roomId}`, `caps:${roomId}`];
  if (activity.action === 'permissions.changed')
    return [`caps:${roomId}`, `index:${roomId}`, 'folder:'];
  if (activity.action.startsWith('room.')) return [`room:${roomId}`, 'rooms:'];
  return [];
}
