'use client';
// A client component on the typed React hooks. Types come from the server instance through a type-only import.
import { createBetterFilesClient } from 'better-files/client';
import { createBetterFilesReact } from 'better-files/react';
import type { dr } from '../../../lib/better-files.js';

const rooms = createBetterFilesReact<typeof dr>();
// One client per tenant; the server page passes the tenant of the visitor's Better IAM session.
const clients = new Map<string, ReturnType<typeof createBetterFilesClient<typeof dr>>>();
const clientFor = (tenantId: string) => {
  let client = clients.get(tenantId);
  if (!client) {
    client = createBetterFilesClient<typeof dr>({ tenantId });
    clients.set(tenantId, client);
  }
  return client;
};

function Index({ roomId, rootNodeId }: { roomId: string; rootNodeId: string }) {
  const index = rooms.useRoomIndex(roomId);
  const { upload, items } = rooms.useUpload();
  if (index.error) return <p role="alert">{index.error.message}</p>;
  if (!index.data) return <p>Loading…</p>;
  return (
    <>
      <ol>
        {index.data.map((node) => (
          <li key={node.id} style={{ paddingLeft: node.depth * 16 }}>
            {node.index} {node.name}
            <rooms.Can
              roomId={roomId}
              nodeId={node.id}
              capability="DOWNLOAD_ORIGINAL"
              fallback={<small> (view only)</small>}
            >
              <small> (downloadable)</small>
            </rooms.Can>
          </li>
        ))}
      </ol>
      <rooms.Can roomId={roomId} nodeId={rootNodeId} capability="UPLOAD">
        <input
          type="file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload({ parentId: rootNodeId, file });
          }}
        />
      </rooms.Can>
      {items.map((item) => (
        <p key={item.id}>
          {item.filename}: {Math.round(item.progress.ratio * 100)}% {item.status}
        </p>
      ))}
    </>
  );
}

export function RoomBrowser({
  tenantId,
  ...props
}: {
  tenantId: string;
  roomId: string;
  rootNodeId: string;
}) {
  return (
    <rooms.BetterFilesProvider client={clientFor(tenantId)}>
      <Index {...props} />
    </rooms.BetterFilesProvider>
  );
}
