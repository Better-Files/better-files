// A server component: the Better IAM session gives the credential and the tenant; refusals surface as errors.
import { drNext } from '../../../lib/better-files.js';
import { RoomBrowser } from './room-browser.js';

export default async function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  // In a real app, `iamNext.page(...)` or `iamNext.requireSession()` redirects signed-out visitors first.
  const { tenant, tenantId } = await drNext.request();
  const room = await tenant.rooms.get({ roomId });
  return (
    <main>
      <h1>{room.name}</h1>
      <p>Status: {room.status}</p>
      <RoomBrowser tenantId={tenantId} roomId={roomId} rootNodeId={room.rootNodeId} />
    </main>
  );
}
