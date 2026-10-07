/** Event-type patterns: `*` matches any run of characters (`document.*`, `*`). */
export function matchesEvent(patterns: readonly string[], type: string): boolean {
  return patterns.some((pattern) => {
    if (pattern === '*') return true;
    const expression = new RegExp(
      `^${pattern
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^]*')}$`,
    );
    return expression.test(type);
  });
}
