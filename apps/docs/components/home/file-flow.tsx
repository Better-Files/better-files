import type { IconType } from 'react-icons';
import {
  RiArrowRightLine,
  RiDatabase2Line,
  RiFileShieldLine,
  RiKey2Line,
  RiShieldCheckLine,
  RiTicketLine,
  RiUploadCloud2Line,
} from 'react-icons/ri';
import { cx } from '@/utils/cx';

type Step = { icon: IconType; title: string; body: string };

/** How a file travels, in and out. Each step names the code path that performs it (packages/server/src/files.ts). */
const lanes: { label: string; steps: Step[] }[] = [
  {
    label: 'Upload',
    steps: [
      {
        icon: RiUploadCloud2Line,
        title: 'Resumable parts',
        body: 'Through your server, or encrypted in the browser and sent straight to S3.',
      },
      {
        icon: RiKey2Line,
        title: 'A key per room',
        body: 'A fresh data key for every stored file, wrapped by the room’s key in Better IAM’s KMS.',
      },
      {
        icon: RiDatabase2Line,
        title: 'Encrypted segments',
        body: 'Storage only holds ciphertext. Deleting a room schedules its key for destruction.',
      },
    ],
  },
  {
    label: 'Download',
    steps: [
      {
        icon: RiShieldCheckLine,
        title: 'Both layers allow it',
        body: 'The permission matrix, then a Better IAM decision on the action.',
      },
      {
        icon: RiTicketLine,
        title: 'A signed ticket',
        body: 'A short-lived URL for exactly this person, document and variant.',
      },
      {
        icon: RiFileShieldLine,
        title: 'Decrypted as it streams',
        body: 'Watermarked copies are stamped for the person; every view and download is logged.',
      },
    ],
  },
];

export function FileFlow() {
  return (
    <div className="grid gap-px overflow-hidden rounded-2lg border border-separator-border bg-separator-border">
      {lanes.map((lane) => (
        <div key={lane.label} className="grid bg-background-full md:grid-cols-[7rem_1fr]">
          <div className="flex items-center border-b border-separator-border px-5 py-3 font-mono text-caption-1-medium text-text-tertiary uppercase md:border-e md:border-b-0">
            {lane.label}
          </div>
          <ol className="grid md:grid-cols-3">
            {lane.steps.map((step, index) => (
              <li
                key={step.title}
                className={cx(
                  'relative flex flex-col gap-2 p-5',
                  index > 0 && 'border-t border-separator-border md:border-t-0 md:border-s',
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="flex size-8 items-center justify-center rounded-lg border border-border-button-default bg-background-primary-default shadow-xs">
                    <step.icon className="size-4 text-foreground-icon-primary" aria-hidden />
                  </span>
                  <span className="text-body-medium">{step.title}</span>
                  {index < lane.steps.length - 1 && (
                    <RiArrowRightLine
                      className="ms-auto hidden size-4 text-foreground-icon-tertiary md:block"
                      aria-hidden
                    />
                  )}
                </span>
                <span className="text-body-2-regular leading-6 text-text-secondary">
                  {step.body}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}
