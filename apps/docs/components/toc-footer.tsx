import { RiArrowRightUpLine, RiFeedbackLine, RiFileCodeLine } from 'react-icons/ri';
import { newIssueUrl, sourceFileUrl } from '@/lib/shared';

/** Under the table of contents: the page's source and a prefilled issue when a public repository is configured. */
export function TocFooter({ path, url }: { path: string; url: string }) {
  const source = sourceFileUrl(`apps/docs/content/docs/${path}`);
  const issue = newIssueUrl(`Docs: ${url}`, `Page: ${url}\n\n`);
  if (!source && !issue) return null;
  const link =
    'inline-flex items-center gap-1.5 text-caption-1-regular text-text-secondary transition-colors hover:text-text-primary';
  return (
    <div className="mt-4 flex flex-col gap-2 border-t border-separator-border pt-4">
      {source ? (
        <a href={source} target="_blank" rel="noreferrer noopener" className={link}>
          <RiFileCodeLine className="size-3.5" aria-hidden /> Edit this page{' '}
          <RiArrowRightUpLine className="size-3" aria-hidden />
        </a>
      ) : null}
      {issue ? (
        <a href={issue} target="_blank" rel="noreferrer noopener" className={link}>
          <RiFeedbackLine className="size-3.5" aria-hidden /> Report an issue{' '}
          <RiArrowRightUpLine className="size-3" aria-hidden />
        </a>
      ) : null}
    </div>
  );
}
