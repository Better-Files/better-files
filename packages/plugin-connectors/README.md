# @better-files/plugin-connectors

Imports from cloud drives into Better Files: Google Drive (including shared drives), Dropbox, OneDrive,
SharePoint and Box, with folder structure, background progress and re-import of changed files.

```ts
import {
  connectorsPlugin,
  googleDrive,
  dropbox,
  microsoftGraph,
  box,
} from 'better-files/plugin-connectors';

connectorsPlugin({
  connectors: [googleDrive(), dropbox(), microsoftGraph(), microsoftGraph({ driveId }), box()],
  // Your app runs the OAuth flow and stores tokens; return the caller's access token (refreshing as needed).
  token: ({ connector, principalId, tenantId }) =>
    oauthTokens.get(tenantId, principalId, connector),
});

const items = await api.connectors.browse({
  tenantId,
  roomId,
  connector: 'google-drive',
  folderId,
});
const { importId } = await api.connectors.import({
  tenantId,
  connector: 'google-drive',
  destinationId: folderId,
  items,
});
await api.connectors.status({ tenantId, importId }); // { status, imported, updated, skipped, failed, errors }
```

- Imports need `UPLOAD` on the destination folder and the `better-files:connectors:use` action (contributors and up).
- Files are encrypted and versioned like uploads and recorded as the caller's; `connector.imported` goes to the
  activity log and `connectors.import.finished` to events and webhooks.
- Importing the same items again adds changed files as new versions (by content hash, etag or revision) and skips
  the rest. Google Docs, Slides and Drawings arrive as PDF, Sheets as XLSX.
- Limits: `maxFiles` per import (2000) and `maxBytes` per file (250 MiB).
- The `Connector` interface (`list`, `download`) is small: implement it for SFTP, a DMS or another data room.

Part of [Better Files](../../README.md).
