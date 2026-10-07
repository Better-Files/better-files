/** Span and metric attributes. Keep metric attribute values low-cardinality (no ids, keys or user input). */
export type Attributes = Record<string, string | number | boolean>;

export interface SpanHandle {
  setAttributes(attributes: Attributes): void;
}

/**
 * Where instrumentation reports to. `openTelemetry()` and `prometheusMetrics()` implement it, `combineTelemetry()`
 * fans out to several, and a host can implement it for anything else (StatsD, Datadog, logs).
 */
export interface Telemetry {
  /** Runs `fn` inside a span; a thrown error marks the span as failed and is rethrown. */
  span<T>(name: string, attributes: Attributes, fn: (span: SpanHandle) => Promise<T>): Promise<T>;
  /** Adds to a counter. */
  count(metric: MetricName, value: number, attributes: Attributes): void;
  /** Records a histogram observation. */
  record(metric: MetricName, value: number, attributes: Attributes): void;
}

export interface MetricDefinition {
  kind: 'counter' | 'histogram';
  /** The Prometheus name. */
  prometheus: string;
  /** The OpenTelemetry name, following its semantic-convention style. */
  otel: string;
  unit: string;
  description: string;
}

/** Every metric the instrumentation reports. */
export const METRICS = {
  httpRequests: {
    kind: 'counter',
    prometheus: 'better_files_http_requests_total',
    otel: 'better-files.http.requests',
    unit: '{request}',
    description: 'Better Files protocol requests, by route, method and status',
  },
  httpDuration: {
    kind: 'histogram',
    prometheus: 'better_files_http_request_duration_seconds',
    otel: 'better-files.http.request.duration',
    unit: 's',
    description: 'Time until the response headers were ready, by route and method',
  },
  dbOperations: {
    kind: 'counter',
    prometheus: 'better_files_db_operations_total',
    otel: 'better-files.db.operations',
    unit: '{operation}',
    description: 'Database adapter calls, by operation, model and outcome',
  },
  dbDuration: {
    kind: 'histogram',
    prometheus: 'better_files_db_operation_duration_seconds',
    otel: 'better-files.db.operation.duration',
    unit: 's',
    description: 'Database adapter call duration, by operation and model',
  },
  storageOperations: {
    kind: 'counter',
    prometheus: 'better_files_storage_operations_total',
    otel: 'better-files.storage.operations',
    unit: '{operation}',
    description: 'Storage adapter calls, by operation and outcome',
  },
  storageDuration: {
    kind: 'histogram',
    prometheus: 'better_files_storage_operation_duration_seconds',
    otel: 'better-files.storage.operation.duration',
    unit: 's',
    description: 'Storage adapter call duration (until a read stream is ready), by operation',
  },
  storageBytes: {
    kind: 'counter',
    prometheus: 'better_files_storage_bytes_total',
    otel: 'better-files.storage.bytes',
    unit: 'By',
    description: 'Bytes written to (in) and read from (out) storage',
  },
  events: {
    kind: 'counter',
    prometheus: 'better_files_events_total',
    otel: 'better-files.events',
    unit: '{event}',
    description: 'Better Files events published, by type',
  },
} as const satisfies Record<string, MetricDefinition>;

export type MetricName = keyof typeof METRICS;

/** Reports to every target: nested spans (outermost first), and each metric to all of them. */
export function combineTelemetry(...targets: Telemetry[]): Telemetry {
  return {
    span(name, attributes, fn) {
      const run = (index: number, handles: SpanHandle[]): Promise<unknown> =>
        index === targets.length
          ? fn({ setAttributes: (a) => handles.forEach((h) => h.setAttributes(a)) })
          : targets[index]!.span(name, attributes, (handle) =>
              run(index + 1, [...handles, handle]),
            );
      return run(0, []) as never;
    },
    count: (metric, value, attributes) =>
      targets.forEach((t) => t.count(metric, value, attributes)),
    record: (metric, value, attributes) =>
      targets.forEach((t) => t.record(metric, value, attributes)),
  };
}

/** Seconds since `start` (a `performance.now()` reading). */
export const elapsed = (start: number) => (performance.now() - start) / 1000;

/** The error code for an `outcome` attribute: a BetterFilesError code, or `error`. */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? code : 'error';
}
