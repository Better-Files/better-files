import type { SVGProps } from 'react';
import { cx } from '@/utils/cx';

/** Better Files mark: a solid folder with a keyhole cut through it, drawn on a 24px grid in the current color. */
export function LogoMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M4.5 3.75h4.62c.47 0 .91.19 1.24.52L12.1 6h7.4c.97 0 1.75.78 1.75 1.75v10.75c0 .97-.78 1.75-1.75 1.75h-15c-.97 0-1.75-.78-1.75-1.75v-13c0-.97.78-1.75 1.75-1.75ZM10.84 13.03a2.35 2.35 0 1 1 2.32 0l.56 3.92h-3.44l.56-3.92Z"
      />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    // Block-level flex, not inline-flex: an inline box sits on the parent's text baseline and rides a few pixels high.
    <span className={cx('flex w-fit items-center gap-2 text-headline-semibold', className)}>
      <LogoMark className="size-5 text-text-primary" />
      <span className="tracking-[-0.01em]">
        Better<span className="text-text-secondary">Files</span>
      </span>
    </span>
  );
}
