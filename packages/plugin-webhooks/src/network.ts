import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/** Resolves a host name to its addresses. Default: the system resolver (`dns.lookup`). */
export type Resolver = (hostname: string) => Promise<string[]>;

const blocked = new BlockList();
const ipv4: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
];
for (const [network, prefix] of ipv4) blocked.addSubnet(network, prefix, 'ipv4');
const ipv6: [string, number][] = [
  ['::', 127], // unspecified and loopback
  ['100::', 64], // discard
  ['2001::', 32], // Teredo: tunnels to arbitrary IPv4
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4: tunnels to arbitrary IPv4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
];
for (const [network, prefix] of ipv6) blocked.addSubnet(network, prefix, 'ipv6');

/** The eight 16-bit groups of an IPv6 address, including forms with an embedded dotted IPv4 tail. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address.toLowerCase().replace(/%.*$/, '');
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const octets = dotted[1]!.split('.').map(Number);
    text =
      text.slice(0, -dotted[1]!.length) +
      `${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const [head, tail] = text.split('::') as [string, string | undefined];
  const parse = (part: string) => (part ? part.split(':').map((group) => parseInt(group, 16)) : []);
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff)
    ? groups
    : undefined;
}

const embeddedIpv4 = (groups: number[]) =>
  [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join('.');

/**
 * Why an address must not receive webhooks (loopback, private, link-local, reserved …), or undefined when it is a
 * public unicast address. IPv4-mapped (`::ffff:a.b.c.d`, also in hex) and NAT64 (`64:ff9b::/96`) addresses are judged
 * by the IPv4 address they carry.
 */
export function blockedAddressReason(address: string): string | undefined {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4') ? 'a non-public' : undefined;
  if (family !== 6) return 'an invalid';
  const groups = ipv6Groups(address);
  if (!groups) return 'an invalid';
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const compatible = groups.slice(0, 6).every((group) => group === 0) && groups[6] !== 0;
  const nat64 =
    groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0);
  if (mapped || compatible || nat64)
    return blocked.check(embeddedIpv4(groups), 'ipv4') ? 'a non-public' : undefined;
  return blocked.check(address, 'ipv6') ? 'a non-public' : undefined;
}

export class BlockedAddressError extends Error {
  constructor(reason: string) {
    super(`Webhook URLs cannot point to ${reason} address`);
    this.name = 'BlockedAddressError';
  }
}

/**
 * A `lookup` for sockets that refuses non-public addresses at connect time. This is what defeats DNS rebinding: the
 * address checked is the address connected to, not the result of an earlier, separate resolution.
 */
export function guardedLookup(resolver?: Resolver): LookupFunction {
  return (hostname, options, callback) => {
    const finish = (error: Error | null, addresses: LookupAddress[]) => {
      if (error) return callback(error as NodeJS.ErrnoException, '', 0);
      for (const entry of addresses) {
        const reason = blockedAddressReason(entry.address);
        if (reason) return callback(new BlockedAddressError(reason), '', 0);
      }
      if (addresses.length === 0)
        return callback(new Error(`No addresses for ${hostname}`) as NodeJS.ErrnoException, '', 0);
      if (options.all)
        (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    };
    if (resolver)
      resolver(hostname).then(
        (list) =>
          finish(
            null,
            list.map((address) => ({ address, family: isIP(address) })),
          ),
        (error: Error) => finish(error, []),
      );
    else
      dnsLookup(hostname, { all: true, verbatim: true }, (error, list) =>
        finish(error, list ?? []),
      );
  };
}

/**
 * POSTs a body with Node's HTTP client, resolving through `guardedLookup` unless private networks are allowed.
 * Redirects are not followed. The response body is discarded.
 */
export function postGuarded(
  url: URL,
  init: {
    headers: Record<string, string>;
    body: string;
    timeoutMs: number;
    allowPrivate: boolean;
    resolver?: Resolver;
  },
): Promise<{ status: number }> {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const body = Buffer.from(init.body);
  return new Promise((resolve, reject) => {
    const request = send(
      url,
      {
        method: 'POST',
        headers: { ...init.headers, 'content-length': String(body.byteLength) },
        timeout: init.timeoutMs,
        ...(init.allowPrivate ? {} : { lookup: guardedLookup(init.resolver) }),
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve({ status: response.statusCode ?? 0 }));
        response.on('error', reject);
      },
    );
    const deadline = setTimeout(
      () => request.destroy(new Error(`Timed out after ${init.timeoutMs} ms`)),
      init.timeoutMs,
    );
    request.on('close', () => clearTimeout(deadline));
    request.on('timeout', () => request.destroy(new Error(`Timed out after ${init.timeoutMs} ms`)));
    request.on('error', reject);
    request.end(body);
  });
}
