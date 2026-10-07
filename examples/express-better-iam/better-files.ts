/**
 * A production-shaped instance: Better IAM for identity, policy, groups, KMS and audit; SQLite for data; the local
 * file system for encrypted files; and a set of plugins. The Next.js, NestJS, MCP and CLI examples reuse it.
 */
import { betterIam } from 'better-iam';
import { sqliteAdapter as iamSqlite } from 'better-iam/adapter-sqlite';
import { sqliteAdapter } from 'better-files/adapter-sqlite';
import {
  betterIamFeatures,
  betterIamIntegration,
  betterFilesIamPlugin,
  betterFilesResolver,
} from 'better-files/iam';
import { mcpPlugin } from 'better-files/mcp';
import { aiPlugin, claudeProvider } from 'better-files/plugin-ai';
import { betterIamThreats, guardPlugin } from 'better-files/plugin-guard';
import { ndaPlugin } from 'better-files/plugin-nda';
import { betterIamMetering } from 'better-files/plugin-quotas';
import { qaPlugin } from 'better-files/plugin-qa';
import { pdfExtractor, plainTextExtractor, searchPlugin } from 'better-files/plugin-search';
import { syncPlugin } from 'better-files/plugin-sync';
import { watermarkPlugin } from 'better-files/plugin-watermark';
import { betterFiles } from 'better-files/server';
import { fileStorage } from 'better-files/storage-fs';

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
};

const extractors = [plainTextExtractor, pdfExtractor];

export const plugins = [
  ndaPlugin(),
  watermarkPlugin(),
  searchPlugin({ indexContent: true, extractors }),
  qaPlugin(),
  syncPlugin(),
  mcpPlugin({ extractors }),
  // Claude answers from documents the asker may view. Reads ANTHROPIC_API_KEY when first used.
  aiPlugin({ provider: claudeProvider() }),
] as const;

// Registers the Better Files actions and resource types on Better IAM, so policies can name them.
const iamPlugin = betterFilesIamPlugin({ plugins });

export const iam = betterIam({
  database: iamSqlite({ filename: process.env.IAM_DB ?? 'iam.db' }),
  secret: env('IAM_SECRET'),
  baseURL: process.env.APP_URL ?? 'http://localhost:3000',
  plugins: [iamPlugin],
  // Lets Better IAM policies see folder and document attributes (room, classification, view-only).
  resolveResource: betterFilesResolver(() => dr),
});

// These two add no actions, so they stay out of the list given to the IAM plugin and can use the instance.
const security = [
  // Stops bulk downloads, raises the downloader's Better IAM risk and ends their sessions; anyone Better IAM rates
  // high risk (for any reason) cannot download from any room.
  guardPlugin({
    maxDownloads: 100,
    ...betterIamThreats(iam, {
      // A service account whose role carries `threatsPolicy()`.
      credential: () => ({ token: env('BETTER_FILES_SECURITY_TOKEN') }),
      actions: [{ kind: 'revoke-sessions' }, { kind: 'notify' }],
    }),
  }),
  // Bytes stored and served, downloads, views, rooms and active participants on Better IAM billing meters
  // (create them once with `meteringMeters()`), refusing work once an enforced budget is spent.
  betterIamMetering(iam, { enforceBudgets: true }),
];

export const dr = betterFiles({
  iam: betterIamIntegration(iam, {
    iamPlugin,
    // A per-tenant service account allowed the actions in `systemPolicy(iam)`: registers rooms, roles and guests.
    systemCredential: () => ({ token: env('BETTER_FILES_SERVICE_TOKEN') }),
    // better-iam 0.2.0 (npm) has no guests: invite outsiders as tenant members, which this app's roles give nothing.
    ...(betterIamFeatures(iam).guests ? {} : { externalInvites: 'members' as const }),
  }),
  database: sqliteAdapter({ filename: process.env.BETTER_FILES_DB ?? 'better-files.db' }),
  storage: fileStorage({ root: process.env.BETTER_FILES_FILES ?? './files' }),
  secret: env('BETTER_FILES_SECRET'),
  plugins: [...plugins, ...security],
});
