'use client';

import { useMemo, useState } from 'react';
import { RiFileTextLine, RiFolder3Line, RiLockLine } from 'react-icons/ri';
import {
  Capability,
  CORE_MASK,
  Presets,
  resolveAccess,
  subjectKey,
  type AccessEntry,
  type CorePreset,
} from '@better-files/core';
import { cx } from '@/utils/cx';

/**
 * The real permission resolver from @better-files/core, running in the browser on a small deal room. Every
 * capability shown is computed by `resolveAccess`, the same function the server uses for layer A.
 */
type Node = { id: string; name: string; parent?: string; folder?: boolean };

const nodes: Node[] = [
  { id: 'root', name: 'Project Falcon', folder: true },
  { id: 'fin', name: 'Financials', parent: 'root', folder: true },
  { id: 'model', name: 'Model.xlsx', parent: 'fin' },
  { id: 'forecast', name: 'Forecast.pdf', parent: 'fin' },
  { id: 'legal', name: 'Legal', parent: 'root', folder: true },
  { id: 'minutes', name: 'Board minutes.pdf', parent: 'legal' },
  { id: 'lit', name: 'Litigation', parent: 'legal', folder: true },
  { id: 'claim', name: 'Claim.pdf', parent: 'lit' },
];

const groups = [
  { id: 'seller', label: 'Seller team' },
  { id: 'buyerA', label: 'Buyer A' },
  { id: 'buyerB', label: 'Buyer B' },
  { id: 'counsel', label: 'Counsel' },
] as const;
type GroupId = (typeof groups)[number]['id'];

const shown: [keyof typeof Capability, string][] = [
  ['VIEW', 'View'],
  ['PRINT', 'Print'],
  ['DOWNLOAD_WATERMARKED', 'Download'],
  ['DOWNLOAD_ORIGINAL', 'Original'],
  ['UPLOAD', 'Upload'],
  ['EDIT', 'Edit'],
  ['MANAGE', 'Manage'],
];

const maskOf = (preset: CorePreset) =>
  (Presets[preset] as readonly string[]).reduce(
    (mask, name) => mask | (name === '*' ? CORE_MASK : Capability[name as keyof typeof Capability]),
    0,
  );

const pathOf = (id: string): string[] => {
  const node = nodes.find((n) => n.id === id)!;
  return node.parent ? [...pathOf(node.parent), id] : [id];
};
const depthOf = (id: string) => pathOf(id).length - 1;

// A fixed clock keeps the demo deterministic.
const NOW = Date.UTC(2026, 9, 1);

export function AccessDemo() {
  const [group, setGroup] = useState<GroupId>('buyerA');
  const [locked, setLocked] = useState(true);
  const [expired, setExpired] = useState(false);

  const entries = useMemo<(AccessEntry & { preset: CorePreset })[]>(() => {
    const entry = (
      nodeId: string,
      subject: GroupId,
      preset: CorePreset,
      extra: Partial<AccessEntry> = {},
    ) => ({
      nodeId,
      subject: subjectKey('group', subject),
      mask: maskOf(preset),
      preset,
      ...extra,
    });
    return [
      entry('root', 'seller', 'manager'),
      entry('root', 'buyerA', 'view'),
      entry('root', 'buyerB', 'view'),
      entry('root', 'counsel', 'download'),
      entry('fin', 'buyerA', 'downloadOriginal'),
      entry('legal', 'buyerA', 'view', { locked }),
      entry('legal', 'buyerB', 'hidden'),
      entry('minutes', 'buyerA', 'download'),
      entry('minutes', 'buyerB', 'download'),
      entry('lit', 'counsel', 'downloadOriginal', expired ? { expiresAt: NOW - 1 } : {}),
    ];
  }, [locked, expired]);

  const subject = subjectKey('group', group);
  const rows = nodes.map((node) => {
    const mask = resolveAccess({ path: pathOf(node.id), entries, subjects: [subject], now: NOW });
    const own = entries.find((e) => e.nodeId === node.id && e.subject === subject);
    return { node, mask, own };
  });

  return (
    <div className="overflow-hidden rounded-2lg border border-separator-border bg-background-full shadow-xs">
      <div className="flex flex-wrap items-center gap-3 border-b border-separator-border bg-surface-sunken px-4 py-3">
        <div role="radiogroup" aria-label="Permission group" className="flex flex-wrap gap-1">
          {groups.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={group === item.id}
              onClick={() => setGroup(item.id)}
              className={cx(
                'rounded-md px-3 py-1.5 text-caption-1-medium transition-colors',
                group === item.id
                  ? 'bg-text-primary text-background-full'
                  : 'text-text-secondary hover:bg-background-secondary-default hover:text-text-primary',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="ms-auto flex flex-wrap gap-4">
          <Toggle checked={locked} onChange={setLocked}>
            Lock Legal for Buyer A
          </Toggle>
          <Toggle checked={expired} onChange={setExpired}>
            Expire Counsel on Litigation
          </Toggle>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-body-2-regular">
          <thead>
            <tr className="border-b border-separator-border text-caption-1-medium text-text-tertiary">
              <th className="px-4 py-2 text-start font-medium">Node</th>
              <th className="px-2 py-2 text-start font-medium">Entry here</th>
              {shown.map(([, label]) => (
                <th key={label} className="px-1.5 py-2 text-center font-medium">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ node, mask, own }) => {
              const listed = (mask & Capability.LIST) !== 0;
              const NodeIcon = node.folder ? RiFolder3Line : RiFileTextLine;
              return (
                <tr
                  key={node.id}
                  className={cx(
                    'border-b border-separator-border last:border-b-0 transition-opacity',
                    !listed && 'opacity-45',
                  )}
                >
                  <td className="px-4 py-2">
                    <span
                      className="flex items-center gap-2"
                      style={{ paddingInlineStart: `${depthOf(node.id) * 1.1}rem` }}
                    >
                      <NodeIcon
                        className="size-4 shrink-0 text-foreground-icon-tertiary"
                        aria-hidden
                      />
                      <span className={cx(!listed && 'line-through decoration-text-tertiary')}>
                        {node.name}
                      </span>
                      {!listed && (
                        <span className="text-caption-1-regular text-text-tertiary">not found</span>
                      )}
                    </span>
                  </td>
                  <td className="px-2 py-2">
                    {own ? (
                      <span
                        className={cx(
                          'inline-flex items-center gap-1 rounded-md border border-separator-border px-1.5 py-0.5 font-mono text-caption-1-regular',
                          own.expiresAt !== undefined && 'line-through text-text-tertiary',
                        )}
                      >
                        {own.locked && <RiLockLine className="size-3" aria-label="locked" />}
                        {own.preset}
                      </span>
                    ) : (
                      <span className="text-caption-1-regular text-text-tertiary">inherited</span>
                    )}
                  </td>
                  {shown.map(([name, label]) => {
                    const has = (mask & Capability[name]) !== 0;
                    return (
                      <td key={label} className="px-1.5 py-2 text-center">
                        <span
                          aria-label={has ? `${label}: yes` : `${label}: no`}
                          className={cx(
                            'inline-block size-2.5 rounded-full transition-colors duration-300',
                            has ? 'bg-text-primary' : 'border border-separator-border',
                          )}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="border-t border-separator-border px-4 py-2.5 text-caption-1-regular text-text-secondary">
        Computed live by <code className="font-mono">resolveAccess</code> from{' '}
        <code className="font-mono">@better-files/core</code>: entries inherit down the tree, a
        deeper entry can widen or narrow, a locked entry is final for its subtree, expired entries
        are ignored, and a node you cannot list is reported as not found.
      </p>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  children: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-caption-1-medium text-text-secondary">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative h-4 w-7 shrink-0 rounded-full transition-colors',
          checked ? 'bg-text-primary' : 'bg-separator-border',
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 left-0 size-3 rounded-full bg-background-full shadow-xs transition-transform',
            checked ? 'translate-x-3.5' : 'translate-x-0.5',
          )}
        />
      </button>
      {children}
    </label>
  );
}
