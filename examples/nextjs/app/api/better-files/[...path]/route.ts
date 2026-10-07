// The whole protocol in one catch-all route: JSON operations, streamed uploads and file tickets.
import { drNext } from '../../../../lib/better-files.js';

export const runtime = 'nodejs';
export const { GET, HEAD, POST, PUT, OPTIONS } = drNext.handlers();
