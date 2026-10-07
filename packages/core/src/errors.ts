export type BetterFilesErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_INPUT'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'ROOM_CLOSED'
  | 'NDA_REQUIRED'
  | 'MFA_REQUIRED'
  | 'QUARANTINED'
  | 'LEGAL_HOLD'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED'
  | 'INTERNAL_ERROR';

const defaultStatus: Record<BetterFilesErrorCode, number> = {
  INVALID_CONFIG: 500,
  INVALID_INPUT: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  ROOM_CLOSED: 409,
  NDA_REQUIRED: 403,
  MFA_REQUIRED: 403,
  QUARANTINED: 409,
  LEGAL_HOLD: 409,
  QUOTA_EXCEEDED: 429,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED: 501,
  INTERNAL_ERROR: 500,
};

/** Every error code with its default HTTP status. */
export const errorStatus: Readonly<Record<BetterFilesErrorCode, number>> = defaultStatus;

/** The one error type every Better Files API throws; `status` is the HTTP status the protocol responds with. */
export class BetterFilesError extends Error {
  readonly code: BetterFilesErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: BetterFilesErrorCode,
    message: string,
    options: { status?: number; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BetterFilesError';
    this.code = code;
    this.status = options.status ?? defaultStatus[code];
    if (options.details !== undefined) this.details = options.details;
  }
}

export const isBetterFilesError = (value: unknown): value is BetterFilesError =>
  value instanceof BetterFilesError;

export const invalidInput = (message: string, details?: Record<string, unknown>) =>
  new BetterFilesError('INVALID_INPUT', message, details ? { details } : {});
export const invalidConfig = (message: string) => new BetterFilesError('INVALID_CONFIG', message);
export const notFound = (what = 'Resource') =>
  new BetterFilesError('NOT_FOUND', `${what} not found`);
export const forbidden = (message = 'Access denied') => new BetterFilesError('FORBIDDEN', message);
export const conflict = (message: string) => new BetterFilesError('CONFLICT', message);
export const unauthenticated = (message = 'Authentication required') =>
  new BetterFilesError('UNAUTHENTICATED', message);
