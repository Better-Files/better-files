/**
 * Better Files on your own servers' disks: a storage cluster instead of S3.
 *
 *   1. Deploy the app with this instance (the control plane is the library, inside your app).
 *   2. Create a join token as an operator-tenant administrator:
 *        npx better-files storage join-token --url https://app.example.com/api/better-files --tenant ops --token $ADMIN_TOKEN
 *   3. On each storage server:
 *        BETTER_FILES_JOIN_TOKEN=bfj_… npx better-files-node start --data /srv/better-files \
 *          --control https://app.example.com/api/better-files --tenant ops \
 *          --listen 0.0.0.0:7070 --advertise https://store-1.internal:7070 --zone eu-1a
 *   4. Watch the fleet: npx better-files storage nodes / status; drain before maintenance.
 */
import { postgresAdapter } from 'better-files/adapter-postgres';
import { betterFiles } from 'better-files/server';
import { storageCluster } from 'better-files/storage-cluster';
import { dr as base } from '../express-better-iam/better-files.js';

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
};

// The cluster index gets its own pool (it may be the same database): storage calls can happen while Better Files
// holds a transaction on its connection.
export const cluster = storageCluster({
  database: postgresAdapter({ connectionString: env('DATABASE_URL'), poolSize: 5 }),
  secret: env('STORAGE_CLUSTER_SECRET'),
  operatorTenant: env('OPERATOR_TENANT'),
  replicas: 3,
  zone: process.env.APP_ZONE,
});

export const dr = betterFiles({
  ...base.options,
  storage: cluster.storage,
  // Fleet administration (storage.*) and the node agent protocol (storage.join, storage.heartbeat).
  plugins: [...base.options.plugins, cluster.plugin],
});

await cluster.initialize();
await dr.initialize();
// `dr.maintain()` now also repairs, drains and scrubs the cluster; schedule it every few minutes.
