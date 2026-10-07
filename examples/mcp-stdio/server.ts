/**
 * A local MCP server over stdio: Claude (or any MCP client) browses, searches, reads and asks questions of your
 * data rooms as you, with your permissions, and every read is in the room's activity log.
 *
 * Claude Code:  claude mcp add better-files -e BETTER_FILES_TOKEN=... -- node examples/mcp-stdio/server.ts
 *
 * The token is a Better IAM credential: your session, or an agent key (`agents.create`) so policies can tell the
 * agent apart from you. The tenant is the one the credential acts in.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBetterFilesMcpServer, sessionTenant } from 'better-files/mcp';
import { pdfExtractor, plainTextExtractor } from 'better-files/plugin-search';
import { dr, iam } from '../express-better-iam/better-files.js';

const server = await createBetterFilesMcpServer(dr, {
  credential: { token: process.env.BETTER_FILES_TOKEN! },
  tenantId: sessionTenant(iam),
  // Read-only by default; `write: true` adds create_folder, upload_text_document and Q&A tools.
  write: process.env.BETTER_FILES_MCP_WRITE === '1',
  extractors: [plainTextExtractor, pdfExtractor],
});
await server.connect(new StdioServerTransport());
