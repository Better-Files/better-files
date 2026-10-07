import Link from 'next/link';
import packages from '@/generated/packages.json';

const labels: Record<string, string> = {
  ai: 'AI answers',
  analytics: 'Analytics',
  annotations: 'Annotations',
  audit: 'Audit reports',
  connectors: 'Drive imports',
  esign: 'E-signature',
  guard: 'Download guard',
  inbound: 'Email to a room',
  links: 'Share links',
  nda: 'NDA gating',
  network: 'Network rules',
  notifications: 'Notifications',
  processing: 'Office to PDF',
  qa: 'Q&A',
  quotas: 'Storage quotas',
  redaction: 'Redaction',
  retention: 'Legal holds',
  reviews: 'Access reviews',
  scan: 'Virus scanning',
  search: 'Search',
  sync: 'Sync',
  tasks: 'Tasks',
  templates: 'Templates',
  watermark: 'Watermarks',
  webhooks: 'Webhooks',
};

/** Every first-party plugin, read from the generated package list so the grid follows the repository. */
export function PluginGrid() {
  const plugins = (packages as { name: string; description?: string }[])
    .filter((pkg) => pkg.name.startsWith('@better-files/plugin-'))
    .map((pkg) => {
      const id = pkg.name.slice('@better-files/plugin-'.length);
      return { id, label: labels[id] ?? id, description: pkg.description ?? '' };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  return (
    <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-2lg border border-separator-border bg-separator-border sm:grid-cols-3 lg:grid-cols-5">
      {plugins.map((plugin) => (
        <li key={plugin.id} className="bg-background-full">
          <Link
            href={`/docs/plugins/${plugin.id}`}
            title={plugin.description}
            className="group flex h-full flex-col gap-1 px-4 py-3.5 transition-colors hover:bg-background-secondary-default"
          >
            <span className="text-body-2-medium text-text-primary">{plugin.label}</span>
            <span className="font-mono text-caption-1-regular text-text-tertiary transition-colors group-hover:text-text-secondary">
              plugin-{plugin.id}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
