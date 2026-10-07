import packages from '@/generated/packages.json';
import { Mermaid } from '@/components/mermaid';

/**
 * The internal dependency graph of the workspace packages, built from their manifests. The umbrella package
 * depends on everything, so it is left out to keep the graph readable.
 */
export function PackageGraph({ filter }: { filter?: string[] }) {
  const short = (name: string) => name.replace('@better-files/', '');
  const id = (name: string) => short(name).replace(/[^a-z0-9]/gi, '_');
  const shown = packages.filter(
    (pkg) => pkg.name !== 'better-files' && (!filter || filter.includes(pkg.name)),
  );
  const names = new Set(shown.map((pkg) => pkg.name));
  const lines = ['flowchart BT'];
  for (const pkg of shown) lines.push(`  ${id(pkg.name)}["${short(pkg.name)}"]`);
  for (const pkg of shown)
    for (const dependency of pkg.internalDependencies)
      if (names.has(dependency)) lines.push(`  ${id(pkg.name)} --> ${id(dependency)}`);
  return <Mermaid chart={lines.join('\n')} />;
}
