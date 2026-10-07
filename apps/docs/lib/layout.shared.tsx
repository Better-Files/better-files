import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { DocsSearchFull, DocsSearchSm } from '@/components/docs-slots';
import { Logo } from '@/components/logo';
import { repositoryUrl } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <Logo />,
      transparentMode: 'top',
    },
    githubUrl: repositoryUrl,
    // BoardUI search triggers; the theme toggle lives in the sidebar footer (components/sidebar-footer.tsx).
    slots: {
      searchTrigger: { full: DocsSearchFull, sm: DocsSearchSm },
      themeSwitch: false,
    },
    links: [
      { text: 'Documentation', url: '/docs/guides', active: 'nested-url', on: 'nav' },
      { text: 'Plugins', url: '/docs/plugins', active: 'nested-url', on: 'nav' },
      { text: 'Reference', url: '/docs/reference', active: 'nested-url', on: 'nav' },
      { text: 'Changelog', url: '/docs/reference/changelog', active: 'url', on: 'nav' },
    ],
  };
}
