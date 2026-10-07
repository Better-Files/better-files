import type { ComponentType } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import {
  RiArrowRightLine,
  RiArrowRightUpLine,
  RiBookOpenLine,
  RiLayoutGridLine,
  RiPlugLine,
  RiPuzzleLine,
  RiRobot2Line,
  RiServerLine,
  RiShieldCheckLine,
  RiVerifiedBadgeLine,
} from 'react-icons/ri';
import stats from '@/generated/stats.json';
import { AccessDemo } from '@/components/home/access-demo';
import { ActivityChain } from '@/components/home/activity-chain';
import { CountUp } from '@/components/home/count-up';
import { FileFlow } from '@/components/home/file-flow';
import { FrameworkStrip } from '@/components/home/framework-strip';
import { Hero } from '@/components/home/hero';
import { MotionProvider, Reveal } from '@/components/home/motion';
import { PluginGrid } from '@/components/home/plugin-grid';
import { SplitExplainer, StackedExplainer } from '@/components/home/section';
import { LogoMark } from '@/components/logo';
import { ActionLink, TextLink } from '@/components/site/action';
import { CreatorCredit } from '@/components/site/creator-credit';
import { Band, SectionHeading, gutter } from '@/components/site/frame';
import { StaggerChild, StaggerList } from '@/components/site/motion-text';
import { JsonLd } from '@/components/json-ld';
import { pageMetadata, siteDescription, siteImages, siteJsonLd, siteTitle } from '@/lib/metadata';
import { cx } from '@/utils/cx';

type Icon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;

export const metadata: Metadata = pageMetadata({
  title: siteTitle,
  absolute: true,
  description: siteDescription,
  path: '/',
  image: siteImages.home,
});

export default function HomePage() {
  return (
    <MotionProvider>
      <main className="relative flex flex-1 flex-col overflow-x-clip">
        <JsonLd data={siteJsonLd()} />
        <Hero />
        <FrameworkStrip />

        <StackedExplainer
          id="permissions"
          index="01"
          eyebrow="Permissions"
          title="A permission matrix you can reason about"
          lede="Give each group or person a set of capabilities on a folder or a document. Access is inherited down the tree, a deeper entry can widen or narrow it, and a locked entry is final. Pick a group below: this is the real resolver from @better-files/core, running in your browser."
          points={[
            {
              lead: `${stats.capabilities} capabilities.`,
              body: 'From seeing that a node exists to managing it, with presets such as view, download and editor.',
            },
            {
              lead: 'Hidden means not found.',
              body: 'A node someone cannot list is reported as missing, so its name never leaks.',
            },
            {
              lead: 'Checked on the server.',
              body: 'Every operation is resolved again on the server; the browser only renders what it is told.',
            },
          ]}
          href="/docs/guides/concepts/permissions"
          linkLabel="How permissions resolve"
          visual={<AccessDemo />}
        />

        <StackedExplainer
          id="files"
          index="02"
          eyebrow="Files"
          sunken
          title="Encrypted at rest, released one ticket at a time"
          lede="Uploads resume where they stopped and can skip your server entirely. Every stored file has its own data key, every download is a short-lived signed ticket, and watermarked copies carry the name of the person who asked."
          points={[
            {
              lead: 'Your storage.',
              body: 'S3, R2, MinIO, Google Cloud Storage, Azure, local disk, or a cluster of your own servers.',
            },
            {
              lead: 'Your keys.',
              body: 'Better IAM’s KMS by default, or AWS KMS, Google Cloud KMS, Azure Key Vault and Vault.',
            },
            {
              lead: 'Large files.',
              body: 'Parallel resumable parts, or direct uploads encrypted in the browser.',
            },
          ]}
          href="/docs/guides/concepts/uploads-and-downloads"
          linkLabel="Uploads and downloads"
          visual={<FileFlow />}
        />

        <SplitExplainer
          id="better-iam"
          index="03"
          eyebrow="Better IAM"
          title="Built on the identity layer you already run"
          lede="Better Files has no users of its own. Better IAM signs people in, holds organizations, groups and guests, and decides every action; Better Files adds the rooms and the files."
          points={[
            {
              lead: 'Two layers, both must allow.',
              body: 'The permission matrix, then a policy decision. MFA, IP ranges and your own rules apply.',
            },
            {
              lead: 'Room roles are relations.',
              body: `${stats.relations} room relations, from owner to auditor, stored as Better IAM relationship tuples.`,
            },
            {
              lead: 'One audit story.',
              body: 'Security events land in Better IAM’s tamper-evident audit chain.',
            },
          ]}
          href="/docs/guides/better-iam"
          linkLabel="The Better IAM integration"
          visual={<TwoLayers />}
        />

        <StackedExplainer
          id="plugins"
          index="04"
          eyebrow="Plugins"
          sunken
          title={`${stats.plugins} plugins, each one opt-in`}
          lede="NDAs, watermarks, Q&A, legal holds, e-signature, permission-aware AI and more. Add the ones your product needs; each brings its own endpoints, tables and typed client calls."
          points={[
            {
              lead: 'Typed end to end.',
              body: 'Plugin endpoints appear on dr.api and in the browser client with their inputs and results.',
            },
            {
              lead: 'Same two layers.',
              body: 'Every plugin endpoint is authorized like the core, before its handler runs.',
            },
            {
              lead: 'Write your own.',
              body: 'The first-party plugins use the same public API your app can use.',
            },
          ]}
          href="/docs/plugins"
          linkLabel="Browse the plugins"
          visual={<PluginGrid />}
        />

        <StackedExplainer
          id="activity"
          index="05"
          eyebrow="Activity"
          title="A record of who saw what"
          lede="Every view, download, permission change and invitation is appended to the room's hash-chained activity log. Change or remove a record and verification reports exactly where the chain breaks."
          points={[
            {
              lead: 'Per person.',
              body: 'Live views and the activity feed show each person only what they may list.',
            },
            {
              lead: 'Exportable.',
              body: 'A room export carries its activity chain, so it can be checked away from the server that wrote it.',
            },
            {
              lead: 'Reports.',
              body: 'Engagement by document, person and group, and closing binders as PDF.',
            },
          ]}
          href="/docs/guides/concepts/activity-log"
          linkLabel="How the activity log works"
          visual={<ActivityChain />}
        />

        <MoreSection />
        <ReferenceSection />
        <FinalCta />
      </main>
    </MotionProvider>
  );
}

/** The two authorization layers, as a stack: both must allow an operation. */
function TwoLayers() {
  const layers = [
    {
      name: 'Better Files',
      title: 'The permission matrix',
      body: 'Capabilities per group and person on folders and documents, inherited down the tree, minus what room settings and plugins remove.',
      chips: ['LIST', 'VIEW', 'DOWNLOAD_ORIGINAL', 'MANAGE'],
    },
    {
      name: 'Better IAM',
      title: 'The policy decision',
      body: 'The action is decided on the resource: room relations through the participant role, then MFA, IP ranges, guest boundaries and your own policies.',
      chips: ['better-files:documents:view', 'better-files:rooms:update'],
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      {layers.map((layer, index) => (
        <div
          key={layer.name}
          className="rounded-2lg border border-separator-border bg-background-full p-5 shadow-xs"
        >
          <div className="flex items-center gap-3">
            <span className="flex size-7 items-center justify-center rounded-full bg-text-primary font-mono text-caption-1-medium text-background-full">
              {index === 0 ? 'A' : 'B'}
            </span>
            <span className="text-headline-medium">{layer.title}</span>
            <span className="ms-auto font-mono text-caption-1-regular text-text-tertiary">
              {layer.name}
            </span>
          </div>
          <p className="mt-3 text-body-2-regular leading-6 text-text-secondary">{layer.body}</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {layer.chips.map((chip) => (
              <span
                key={chip}
                className="rounded-md border border-separator-border px-1.5 py-0.5 font-mono text-caption-1-regular text-text-secondary"
              >
                {chip}
              </span>
            ))}
          </div>
        </div>
      ))}
      <p className="flex items-center gap-2 px-1 text-caption-1-regular text-text-secondary">
        <RiShieldCheckLine className="size-4 shrink-0" aria-hidden />
        Either layer can refuse. A node that fails layer A is reported as not found.
      </p>
    </div>
  );
}

function MoreSection() {
  const cards: { icon: Icon; title: string; href: string; items: string[] }[] = [
    {
      icon: RiServerLine,
      title: 'Operations',
      href: '/docs/operations',
      items: [
        'PostgreSQL, SQLite, libSQL, PGlite, Prisma and Drizzle',
        'S3-compatible, cloud and self-hosted cluster storage',
        'Scheduled maintenance and durable background jobs',
        'A CLI for migrations, verification and diagnostics',
      ],
    },
    {
      icon: RiPlugLine,
      title: 'Integrations',
      href: '/docs/frameworks',
      items: [
        'Next.js, Nuxt, SvelteKit and React Router',
        'React and Vue hooks, Svelte stores, a typed client',
        'NestJS modules and guards',
        'Express, Hono, Fastify, Koa and fetch runtimes',
      ],
    },
    {
      icon: RiRobot2Line,
      title: 'AI and agents',
      href: '/docs/plugins/ai',
      items: [
        'Answers and summaries on Claude, with citations',
        'Only documents the asker may view reach the model',
        'MCP tools that run as the signed-in person',
        'Permission-aware search to ground answers',
      ],
    },
  ];
  return (
    <Band id="more">
      <div className={cx('py-16 md:py-20', gutter)}>
        <SectionHeading eyebrow="And more" title="Everything around the room">
          Storage, frameworks and agents use the same permission engine and the same activity log as
          everything above.
        </SectionHeading>
      </div>
      <StaggerList className="grid gap-px border-t border-separator-border bg-separator-border md:grid-cols-3">
        {cards.map(({ icon: CardIcon, ...card }) => (
          <li key={card.title} className="bg-background-full">
            <StaggerChild className="h-full">
              <Link href={card.href} className={cellLink}>
                <HoverHatch />
                <span className="relative flex items-center gap-3">
                  <IconTile icon={CardIcon} />
                  <span className="text-title-3-semibold">{card.title}</span>
                  <CellArrow className="ms-auto" />
                </span>
                <ul className="relative flex flex-col gap-2.5">
                  {card.items.map((item, index) => (
                    <li
                      key={item}
                      className="flex gap-2.5 text-body-regular leading-6 text-text-secondary transition-colors duration-300 group-hover:text-text-primary"
                      style={{ transitionDelay: `${index * 40}ms` }}
                    >
                      <span
                        aria-hidden
                        className="mt-[0.7rem] h-px w-2.5 shrink-0 bg-text-tertiary transition-[width,background-color] duration-300 group-hover:w-4 group-hover:bg-text-primary"
                        style={{ transitionDelay: `${index * 40}ms` }}
                      />
                      {item}
                    </li>
                  ))}
                </ul>
              </Link>
            </StaggerChild>
          </li>
        ))}
      </StaggerList>
    </Band>
  );
}

function ReferenceSection() {
  const numbers = [
    {
      value: stats.operations,
      label: 'core operations',
      detail: 'each with its action, target and required capabilities',
      href: '/docs/reference/operations',
    },
    {
      value: stats.actions,
      label: 'Better IAM actions',
      detail: 'in the better-files: namespace, ready for your policies',
      href: '/docs/reference/actions',
    },
    {
      value: stats.errorCodes,
      label: 'stable error codes',
      detail: 'each with its HTTP status and meaning',
      href: '/docs/reference/errors',
    },
    {
      value: stats.packages,
      label: 'packages',
      detail: `${stats.subpaths} subpaths of one umbrella package, or only the parts you need`,
      href: '/docs/reference/packages',
    },
  ];
  const resources: [string, string][] = [
    ['llms.txt', '/llms.txt'],
    ['Changelog', '/docs/reference/changelog'],
    ['Capabilities', '/docs/reference/capabilities'],
  ];
  return (
    <Band id="reference" frameClassName="bg-surface-sunken">
      <div className={cx('grid gap-8 py-16 md:py-20 lg:grid-cols-12', gutter)}>
        <SectionHeading
          eyebrow="Reference"
          title="Generated from the source"
          className="lg:col-span-6"
        >
          The reference is extracted from the repository every time this site is built, so every
          count on it matches the code.
        </SectionHeading>
        <div className="flex flex-wrap content-end gap-2 lg:col-span-5 lg:col-start-8 lg:justify-end">
          {resources.map(([label, href]) => (
            <ActionLink
              key={href}
              href={href}
              variant="secondary"
              size="small"
              trailingIcon={RiArrowRightUpLine}
              className="font-mono text-caption-1-regular"
            >
              {label}
            </ActionLink>
          ))}
        </div>
      </div>
      <StaggerList className="grid gap-px border-t border-separator-border bg-separator-border sm:grid-cols-2 lg:grid-cols-4">
        {numbers.map((item) => (
          <li key={item.label} className="bg-surface-sunken">
            <StaggerChild className="h-full">
              <Link href={item.href} className={cx(cellLink, 'gap-2')}>
                <HoverHatch />
                <CountUp
                  value={item.value}
                  className="relative text-display-2-medium tracking-[-0.04em] tabular-nums transition-transform duration-300 ease-out group-hover:-translate-y-1"
                />
                <span className="relative text-body-medium">{item.label}</span>
                <span className="relative text-body-2-regular text-text-secondary">
                  {item.detail}
                </span>
                <CellArrow className="relative mt-3" />
              </Link>
            </StaggerChild>
          </li>
        ))}
      </StaggerList>
    </Band>
  );
}

function FinalCta() {
  const paths: { icon: Icon; title: string; body: string; href: string }[] = [
    {
      icon: RiBookOpenLine,
      title: 'Read the guides',
      body: 'Concepts first, then setup and the Better IAM integration.',
      href: '/docs/guides',
    },
    {
      icon: RiLayoutGridLine,
      title: 'Pick your framework',
      body: 'Full-stack, client and server integrations.',
      href: '/docs/frameworks',
    },
    {
      icon: RiPuzzleLine,
      title: 'Choose plugins',
      body: `${stats.plugins} opt-in features, from NDAs to e-signature.`,
      href: '/docs/plugins',
    },
    {
      icon: RiServerLine,
      title: 'Run it in production',
      body: 'Databases, storage, keys and background work.',
      href: '/docs/operations',
    },
  ];
  return (
    <Band marks={false}>
      <div className="grid lg:grid-cols-2">
        <div
          className={cx(
            'relative flex flex-col items-start gap-6 overflow-hidden border-b border-separator-border py-16 md:py-20 lg:border-e lg:border-b-0',
            gutter,
          )}
        >
          <div
            aria-hidden
            className="hatch hatch-drift pointer-events-none absolute inset-0 opacity-60"
          />
          <Reveal className="relative flex flex-col items-start gap-6">
            <LogoMark className="size-10 text-text-primary" />
            <h2 className="max-w-md text-display-4-semibold tracking-[-0.03em] text-balance md:text-display-3-semibold md:leading-[1.12]">
              Data rooms inside your product, not next to it
            </h2>
            <p className="max-w-md text-headline-regular leading-7 text-pretty text-text-secondary">
              Start in memory on your laptop, ship on PostgreSQL and S3, and keep every document,
              permission and activity record in infrastructure you control.
            </p>
            <CreatorCredit label="Built and maintained by" />
            <div className="mt-2 flex flex-wrap gap-2.5">
              <ActionLink href="/docs/guides/quickstart" trailingIcon={RiArrowRightLine}>
                Start the quickstart
              </ActionLink>
              <ActionLink
                href="/docs/operations"
                variant="secondary"
                leadingIcon={RiVerifiedBadgeLine}
              >
                Production checklist
              </ActionLink>
            </div>
          </Reveal>
        </div>
        <StaggerList className="grid gap-px bg-separator-border sm:grid-cols-2">
          {paths.map(({ icon: PathIcon, ...path }) => (
            <li key={path.title} className="bg-background-full">
              <StaggerChild className="h-full">
                <Link href={path.href} className={cx(cellLink, 'gap-2')}>
                  <HoverHatch />
                  <IconTile icon={PathIcon} className="relative" />
                  <span className="relative mt-2 flex items-center gap-1.5 text-headline-medium">
                    {path.title}
                    <CellArrow />
                  </span>
                  <span className="relative text-body-regular leading-6 text-text-secondary">
                    {path.body}
                  </span>
                </Link>
              </StaggerChild>
            </li>
          ))}
        </StaggerList>
      </div>
      <p
        className={cx(
          'border-t border-separator-border py-5 text-body-regular text-text-secondary',
          gutter,
        )}
      >
        New to data rooms?{' '}
        <TextLink
          href="/docs/guides/concepts"
          trailingIcon={RiArrowRightLine}
          className="inline-flex"
        >
          Start with the concepts
        </TextLink>
      </p>
    </Band>
  );
}

/** Grid cell links in the closing sections: full-cell hit area, press feedback, and a hatched hover fill. */
const cellLink =
  'group relative flex h-full flex-col gap-5 overflow-hidden p-6 transition-colors duration-200 hover:bg-background-secondary-default active:bg-background-secondary-hover sm:p-8';

function HoverHatch() {
  return (
    <span
      aria-hidden
      className="hatch pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
    />
  );
}

/** An icon tile that inverts to solid ink when its cell is hovered. */
function IconTile({ icon: TileIcon, className }: { icon: Icon; className?: string }) {
  return (
    <span
      className={cx(
        'flex size-9 shrink-0 items-center justify-center rounded-2lg border border-border-button-default bg-background-primary-default text-foreground-icon-primary shadow-xs transition-[background-color,border-color,color,transform] duration-300 group-hover:-rotate-6 group-hover:border-text-primary group-hover:bg-text-primary group-hover:text-background-full',
        className,
      )}
    >
      <TileIcon className="size-[18px]" aria-hidden />
    </span>
  );
}

function CellArrow({ className }: { className?: string }) {
  return (
    <RiArrowRightLine
      className={cx(
        'size-4 shrink-0 text-foreground-icon-tertiary transition-[color,transform] duration-300 group-hover:translate-x-1 group-hover:text-foreground-icon-primary',
        className,
      )}
      aria-hidden
    />
  );
}
