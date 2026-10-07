/** Prefixes make ids recognizable in logs, URLs and support tickets. */
export const idPrefixes = {
  room: 'room',
  node: 'nod',
  version: 'ver',
  blob: 'blb',
  upload: 'upl',
  group: 'grp',
  acl: 'acl',
  member: 'mem',
  activity: 'act',
  outbox: 'obx',
  job: 'job',
} as const;
export type IdKind = keyof typeof idPrefixes;

// Crockford base32, as in ULID: sortable by time, no ambiguous characters.
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms: number): string {
  let value = ms;
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = alphabet[value % 32]! + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function randomDigits(length: number): number[] {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte % 32);
}

// Monotonic within a millisecond (as the ULID spec suggests): ids made in the same millisecond sort in the order
// they were made, so records inserted together (fields, recipients) list back in that order.
let lastTime = -1;
let lastRandom: number[] = [];

/** A ULID (26 characters) for the current time. */
export function ulid(now: number = Date.now()): string {
  let random: number[] | undefined;
  if (now === lastTime) {
    random = [...lastRandom];
    let i = random.length - 1;
    while (i >= 0 && random[i] === 31) random[i--] = 0;
    if (i < 0) random = undefined;
    else random[i]!++;
  }
  random ??= randomDigits(16);
  lastTime = now;
  lastRandom = random;
  return encodeTime(now) + random.map((digit) => alphabet[digit]!).join('');
}

/** A prefixed, time-sortable id such as `room_01J9Z3…`. */
export function createId(kind: IdKind, now?: number): string {
  return `${idPrefixes[kind]}_${ulid(now)}`;
}

/** A prefixed id for plugin records: `prefixedId('nda')` gives `nda_01J…`. */
export function prefixedId(prefix: string, now?: number): string {
  if (!/^[a-z]{2,8}$/.test(prefix)) throw new Error(`Invalid id prefix ${prefix}`);
  return `${prefix}_${ulid(now)}`;
}

const idPattern = /^[a-z]{2,8}_[0-9A-HJKMNP-TV-Z]{26}$/;
export const isId = (value: unknown, kind?: IdKind): value is string =>
  typeof value === 'string' &&
  idPattern.test(value) &&
  (kind === undefined || value.startsWith(`${idPrefixes[kind]}_`));
