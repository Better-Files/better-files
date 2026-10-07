import { RiLinkM } from 'react-icons/ri';

/**
 * An illustration of the room activity log (packages/server/src/activity.ts): each record stores the hash of the one
 * before it, so changing or removing any record breaks every link after it, and activity.verify reports where.
 * The hashes here are shortened examples, not computed values.
 */
const records = [
  {
    seq: 1,
    action: 'room.created',
    actor: 'olivia@seller.test',
    hash: '4f2a…9c1e',
    prev: '0000…0000',
  },
  {
    seq: 2,
    action: 'permissions.changed',
    actor: 'olivia@seller.test',
    hash: 'b81d…02aa',
    prev: '4f2a…9c1e',
  },
  {
    seq: 3,
    action: 'member.invited',
    actor: 'olivia@seller.test',
    hash: '7c09…e4f3',
    prev: 'b81d…02aa',
  },
  {
    seq: 4,
    action: 'document.viewed',
    actor: 'gina@buyer.test',
    hash: 'e3b5…71d8',
    prev: '7c09…e4f3',
  },
  {
    seq: 5,
    action: 'document.downloaded',
    actor: 'gina@buyer.test',
    hash: '19fe…a6b0',
    prev: 'e3b5…71d8',
  },
];

export function ActivityChain() {
  return (
    <div className="overflow-hidden rounded-2lg border border-separator-border bg-background-full shadow-xs">
      <ol className="flex snap-x gap-0 overflow-x-auto p-4">
        {records.map((record, index) => (
          <li key={record.seq} className="flex shrink-0 snap-start items-center">
            {index > 0 && (
              <span
                className="flex w-8 items-center justify-center text-foreground-icon-tertiary"
                aria-hidden
              >
                <RiLinkM className="size-4" />
              </span>
            )}
            <div className="flex w-56 flex-col gap-2 rounded-lg border border-separator-border bg-surface-sunken p-3.5">
              <span className="flex items-center justify-between font-mono text-caption-1-regular text-text-tertiary">
                <span>#{record.seq}</span>
                <span>{record.hash}</span>
              </span>
              <span className="font-mono text-body-2-medium">{record.action}</span>
              <span className="truncate text-caption-1-regular text-text-secondary">
                {record.actor}
              </span>
              <span className="border-t border-separator-border pt-2 font-mono text-caption-1-regular text-text-tertiary">
                prev {record.prev}
              </span>
            </div>
          </li>
        ))}
      </ol>
      <p className="border-t border-separator-border px-4 py-2.5 text-caption-1-regular text-text-secondary">
        Illustration. Each record carries the hash of the one before it;{' '}
        <code className="font-mono">activity.verify</code> recomputes the chain and reports the
        first record that does not match.
      </p>
    </div>
  );
}
