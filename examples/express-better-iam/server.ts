/**
 * Express: the Better Files protocol at /api/better-files (for the browser client and React hooks), plus your own routes
 * guarded by room capabilities and calling the API as the signed-in user.
 */
import express from 'express';
import { createBetterFilesExpress } from 'better-files/middleware/express';
import { dr, iam } from './better-files.js';

// Run migrations at deploy time in production (`better-files migrate`); here, at startup.
await iam.initialize();
await dr.initialize();

const app = express();
const rooms = createBetterFilesExpress(dr);

app.use(express.json());
// Serves POST /api/better-files/{group}/{method}, uploads and file tickets, streaming bodies untouched.
app.use(rooms.middleware);

// Single-tenant here; multi-tenant apps take the tenant from the Better IAM session.
const TENANT = process.env.BETTER_FILES_TENANT ?? 'acme';

// Your own route: a deal summary page's data, allowed only to people who may view the document.
app.get(
  '/deals/:roomId/documents/:nodeId',
  rooms.requireCapability(['VIEW'], {
    tenantId: () => TENANT,
    roomId: (req) => req.params!.roomId!,
    nodeId: (req) => req.params!.nodeId!,
  }),
  async (req, res) => {
    // The API bound to the signed-in user: every call is authorized as them.
    const api = rooms.helpers(req).api;
    const tenantId = TENANT;
    const document = await api.documents.get({ tenantId, nodeId: req.params!.nodeId! });
    const versions = await api.versions.list({ tenantId, nodeId: document.id });
    res.json({ name: document.name, versions: versions.length });
  },
);

// Turns Better Files refusals into their HTTP status (403, 404, 409, 423 …) with a JSON body.
app.use(rooms.errorHandler);

// Maintenance: expired tickets and uploads, trash retention, plugin sweeps.
setInterval(
  () => void dr.maintain().catch((error: unknown) => console.error('maintain failed', error)),
  5 * 60_000,
);

app.listen(3000, () => console.log('Listening on http://localhost:3000'));
