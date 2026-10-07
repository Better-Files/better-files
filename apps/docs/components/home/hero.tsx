import { Fragment } from 'react';
import Link from 'next/link';
import { highlight } from 'fumadocs-core/highlight';
import { RiArrowRightLine, RiArrowRightUpLine } from 'react-icons/ri';
import { ActionLink } from '@/components/site/action';
import { Band, gutter } from '@/components/site/frame';
import { codeThemes } from '@/lib/code-themes';
import { version } from '@/lib/shared';
import { cx } from '@/utils/cx';
import { CreatorCredit } from '@/components/site/creator-credit';
import { WordReveal } from '@/components/site/motion-text';
import { HeroGrid } from './hero-grid';
import { HeroWindow, type HeroTab } from './hero-window';
import { InstallCommand } from './install-command';

/**
 * Checked against the real APIs: betterIamIntegration (packages/iam), permissions.setEntries and
 * documents.requestOriginal (packages/server), and qa.ask (packages/plugin-qa).
 */
const examples: (HeroTab & { source: string })[] = [
  {
    label: 'Set up',
    file: 'lib/auth.ts',
    note: 'Sign-in, groups and policy decisions come from Better IAM; files are encrypted with a key per room.',
    source: `import { betterFiles } from 'better-files';
import { betterIamIntegration } from 'better-files/iam';
import { postgresAdapter } from 'better-files/adapter-postgres';
import { s3Storage } from 'better-files/storage-s3';

export const dr = betterFiles({
  iam: betterIamIntegration(iam, { iamPlugin, systemCredential }),
  database: postgresAdapter({ pool }),
  storage: s3Storage({ bucket: 'rooms', region: 'eu-west-1', credentials }),
  secret: process.env.BETTER_FILES_SECRET!,
  plugins,
});`,
  },
  {
    label: 'Permissions',
    file: 'app/actions.ts',
    note: 'Both layers must allow it: the permission matrix, then a Better IAM decision on the action.',
    source: `// Buyer B may download originals from the Financials folder.
await dr.api.permissions.setEntries(credential, {
  tenantId,
  nodeId: financials.id,
  entries: [{ subject: { type: 'group', id: buyerB.id }, preset: 'downloadOriginal' }],
});

// A signed, short-lived ticket; the file is decrypted as it streams.
const ticket = await dr.api.documents.requestOriginal(credential, {
  tenantId,
  nodeId: model.id,
});`,
  },
  {
    label: 'Plugins',
    file: 'lib/plugins.ts',
    note: 'Plugin endpoints are typed from the instance, on the server and in the browser client.',
    source: `import { ndaPlugin } from 'better-files/plugin-nda';
import { qaPlugin } from 'better-files/plugin-qa';
import { watermarkPlugin } from 'better-files/plugin-watermark';

export const plugins = [ndaPlugin(), watermarkPlugin(), qaPlugin()] as const;

// Due-diligence Q&A with team-scoped visibility.
await dr.api.qa.ask(credential, {
  tenantId,
  roomId,
  subject: 'Change of control',
  text: 'Which customer contracts have change-of-control clauses?',
});`,
  },
];

export async function Hero() {
  // Keyed, because the array itself crosses to the client component.
  const code = await Promise.all(
    examples.map(async ({ source }, index) => (
      <Fragment key={index}>
        {await highlight(source, { lang: 'ts', themes: codeThemes, defaultColor: false })}
      </Fragment>
    )),
  );

  return (
    <Band frameClassName="overflow-hidden">
      <HeroGrid />

      <div className={cx('relative pt-14 pb-12 md:pt-20 md:pb-14', gutter)}>
        <Link
          href="/docs/reference/changelog"
          className="animate-float-in group inline-flex items-center gap-2 rounded-full border border-border-button-default bg-background-primary-default py-1 ps-1 pe-3 text-caption-1-medium text-text-secondary shadow-xs transition-colors hover:border-border-button-hover hover:text-text-primary"
        >
          <span className="rounded-full bg-text-primary px-2 py-0.5 font-mono text-background-full">
            v{version}
          </span>
          Read the changelog
          <RiArrowRightLine
            className="size-3.5 transition-transform group-hover:translate-x-0.5"
            aria-hidden
          />
        </Link>

        <h1 className="mt-7 max-w-[15ch] text-[2.5rem] leading-[1.04] font-semibold tracking-[-0.045em] text-balance sm:text-[3.5rem] lg:max-w-[17ch] lg:text-[4.5rem]">
          <WordReveal text="Secure data rooms" immediate delay={0.08} />{' '}
          <WordReveal
            text="that live in your codebase"
            immediate
            delay={0.26}
            className="text-text-secondary"
          />
        </h1>

        <div className="mt-10 grid gap-8 lg:grid-cols-12 lg:items-end">
          <div className="animate-float-in flex flex-col gap-5 [animation-delay:220ms] lg:col-span-6">
            <p className="text-headline-regular leading-7 text-pretty text-text-secondary md:text-[1.0625rem]">
              Better Files is an embeddable TypeScript library for data rooms: folders and versions,
              a permission matrix, guests, NDAs, watermarks, Q&amp;A and audit. Built on Better IAM,
              it runs in your app, on your database and storage, behind one typed API.
            </p>
            <CreatorCredit />
          </div>
          <div className="animate-float-in flex flex-col gap-4 [animation-delay:300ms] lg:col-span-6 lg:col-start-7 lg:items-end">
            <div className="flex flex-wrap items-center gap-2.5 lg:justify-end">
              <ActionLink href="/docs/guides/quickstart" trailingIcon={RiArrowRightLine}>
                Get started
              </ActionLink>
              <InstallCommand />
              <ActionLink
                href="https://better-iam.com"
                variant="ghost"
                trailingIcon={RiArrowRightUpLine}
                className="bg-transparent"
              >
                Better IAM
              </ActionLink>
            </div>
            <p className="text-caption-1-regular text-text-secondary">
              Node.js 22.12+ <Dot /> PostgreSQL, SQLite, or libSQL <Dot /> S3, disk, or your own
              servers
            </p>
          </div>
        </div>
      </div>

      <div className={cx('relative pb-10 md:pb-14', gutter)}>
        <HeroWindow code={code} tabs={examples.map(({ source: _source, ...tab }) => tab)} />
      </div>
    </Band>
  );
}

function Dot() {
  return (
    <span className="mx-1.5 inline-block size-[3px] rounded-full bg-text-tertiary align-middle" />
  );
}
