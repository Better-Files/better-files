import { describe, expect, it, vi } from 'vitest';

describe('examples', () => {
  it('runs the quickstart end to end', async () => {
    const lines: unknown[][] = [];
    const log = vi
      .spyOn(console, 'log')
      .mockImplementation((...args: unknown[]) => void lines.push(args));
    try {
      await import('../../examples/quickstart/index.js');
    } finally {
      log.mockRestore();
    }
    const find = (label: string) => lines.find((line) => line[0] === label)?.slice(1);
    expect(find('Ben sees:')).toEqual([['1 Financials', '1.1 revenue.txt']]);
    expect(find('Ben may:')?.[0]).toEqual(expect.arrayContaining(['VIEW', 'DOWNLOAD_WATERMARKED']));
    expect(find('Ben may:')?.[0]).not.toContain('DOWNLOAD_ORIGINAL');
    expect(find('Original download:')).toBeDefined();
    expect(find('Olivia reads:')).toEqual(['Revenue 2025: 12.4m']);
    expect(find('Chain:')?.[0]).toMatchObject({ valid: true });
  });
});
