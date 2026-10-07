import { notFound } from 'next/navigation';
import stats from '@/generated/stats.json';
import { socialCard, type SocialCard } from '@/lib/og';

export const revalidate = false;

/** Social cards for the pages outside the docs (`siteImages` in lib/metadata.ts points at these). */
const cards: Record<string, SocialCard> = {
  'home.png': {
    trail: ['Open source', 'Apache 2.0'],
    title: 'Embeddable data rooms for TypeScript',
    description:
      'Rooms, permission matrices, guests, NDAs, watermarking, share links, and a tamper-evident activity log, mounted in your own app.',
    tags: [
      `${stats.packages} packages`,
      `${stats.plugins} plugins`,
      `${stats.operations} core operations`,
    ],
  },
};

export async function GET(_req: Request, { params }: RouteContext<'/og/[image]'>) {
  const { image } = await params;
  const card = cards[image];
  if (!card) notFound();
  return socialCard(card);
}

export function generateStaticParams() {
  return Object.keys(cards).map((image) => ({ image }));
}

export const dynamicParams = false;
