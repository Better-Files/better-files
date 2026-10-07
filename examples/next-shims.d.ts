// Stand-ins so the examples typecheck without installing Next.js; a real app gets these from `next`.
declare module 'next/headers' {
  export function headers(): Promise<Headers>;
}
declare module 'server-only' {}
