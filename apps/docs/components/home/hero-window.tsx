'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { RiPauseLine, RiPlayLine } from 'react-icons/ri';
import { cx } from '@/utils/cx';
import { ease, useReducedMotionSafe } from './motion';

export interface HeroTab {
  label: string;
  file: string;
  /** One line under the code: what the snippet guarantees. */
  note: string;
}

const INTERVAL = 7000;

/**
 * The hero's code window: a few tabs of real, checked snippets (highlighted on the server), rotating until the
 * visitor picks one, pauses, or prefers reduced motion.
 */
export function HeroWindow({ code, tabs }: { code: ReactNode[]; tabs: HeroTab[] }) {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduced = useReducedMotionSafe();
  const playing = !paused && !reduced;

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setActive((index) => (index + 1) % code.length), INTERVAL);
    return () => clearInterval(timer);
  }, [playing, code.length]);

  const tab = tabs[active]!;
  return (
    <div className="overflow-hidden rounded-2lg border border-separator-border bg-background-full shadow-xs">
      <div className="flex items-center gap-1 border-b border-separator-border bg-surface-sunken px-2 py-1.5">
        <div
          role="tablist"
          aria-label="Examples"
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
        >
          {tabs.map((item, index) => (
            <button
              key={item.label}
              type="button"
              role="tab"
              aria-selected={index === active}
              onClick={() => {
                setActive(index);
                setPaused(true);
              }}
              className={cx(
                'relative shrink-0 rounded-md px-3 py-1.5 text-caption-1-medium transition-colors',
                index === active
                  ? 'bg-background-primary-default text-text-primary shadow-xs'
                  : 'text-text-secondary hover:text-text-primary',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="hidden font-mono text-caption-1-regular text-text-tertiary sm:inline">
          {tab.file}
        </span>
        {!reduced && (
          <button
            type="button"
            onClick={() => setPaused((value) => !value)}
            aria-label={paused ? 'Play the examples' : 'Pause the examples'}
            className="ms-1 flex size-7 items-center justify-center rounded-md text-foreground-icon-tertiary transition-colors hover:text-foreground-icon-primary"
          >
            {paused ? (
              <RiPlayLine className="size-4" aria-hidden />
            ) : (
              <RiPauseLine className="size-4" aria-hidden />
            )}
          </button>
        )}
      </div>

      <div
        role="tabpanel"
        className="relative min-h-[22rem] overflow-x-auto text-[0.8125rem] leading-5 [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:px-5 [&_pre]:py-4"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={active}
            initial={reduced ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? undefined : { opacity: 0, y: -6 }}
            transition={{ duration: 0.3, ease }}
          >
            {code[active]}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="flex items-center gap-3 border-t border-separator-border px-4 py-2.5">
        <span className="size-1.5 shrink-0 rounded-full bg-text-primary" aria-hidden />
        <p className="text-caption-1-regular text-text-secondary">{tab.note}</p>
        {playing && (
          <span
            className="ms-auto h-0.5 w-16 shrink-0 overflow-hidden rounded-full bg-separator-border"
            aria-hidden
          >
            <motion.span
              key={active}
              className="block h-full origin-left bg-text-tertiary"
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: INTERVAL / 1000, ease: 'linear' }}
            />
          </span>
        )}
      </div>
    </div>
  );
}
