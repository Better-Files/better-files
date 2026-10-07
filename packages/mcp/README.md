# @better-files/mcp

Model Context Protocol tools for Better Files: AI agents browse, search, read and ask questions of data rooms
as the signed-in user, with that user's permissions.

```ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBetterFilesMcpServer, mcpPlugin } from 'better-files/mcp';

// Register mcpPlugin() on the instance so agents can read view-only documents' text (not the files).
const dr = betterFiles({ ...options, plugins: [mcpPlugin(), ...otherPlugins] });

const server = await createBetterFilesMcpServer(dr, {
  credential: { token: process.env.BETTER_FILES_TOKEN! }, // or (request) => … from the transport's auth
  tenantId: 'acme',
  write: false, // true adds create_folder, upload_text_document, ask_question, answer_question
});
await server.connect(new StdioServerTransport());
```

| Tool                                                             | Runs                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------- |
| `list_rooms`, `get_room_index`                                   | `rooms.list`, `rooms.get` + `rooms.index` (numbered tree) |
| `get_document`, `list_versions`, `read_document`                 | `documents.get`, `versions.list`, `mcp.readText` (paged)  |
| `search` (search plugin), `ask_room` (AI plugin)                 | `search.query`, `ai.ask`                                  |
| `list_activity`, `explain_access`                                | `activity.list`, `permissions.explain`                    |
| `list_questions`, `ask_question`, `answer_question` (Q&A plugin) | `qa.*`                                                    |

- Tools for plugins that aren't installed are not offered.
- Refusals come back as tool errors the model can read (`FORBIDDEN: …`); other failures are logged and hidden.
- Every read is an ordinary view: NDA gates, network rules and the activity log apply.
- Over HTTP, the default credential is the bearer token the transport validated (`authInfo.token`).
- `betterFilesTools()` returns the same tools without the MCP SDK, for other agent frameworks.

## Behind Better IAM's MCP gate

`better-iam/mcp` puts tool-level authorization in front of any Streamable HTTP MCP endpoint: OAuth access tokens
for MCP clients, agent keys and delegated agent sessions, tools hidden from callers who may not use them, and
"ask me first" confirmations for agents acting for a person. `betterIamToolRules(dr, { tenantId })` gives the gate a
rule per Better Files tool: the Better Files action the tool performs, on the resource Better Files authorizes it on.

```ts
import { createMcpGate } from 'better-iam/mcp';
import { betterIamToolRules, sessionTenant } from 'better-files/mcp';

const gate = createMcpGate({
  iam,
  tenantId: 'acme',
  tools: betterIamToolRules(dr, { tenantId: 'acme', write: true }),
});
// Each MCP request: gate(request, (request) => mcpHttpHandler(request))
const server = await createBetterFilesMcpServer(dr, { tenantId: sessionTenant(iam), write: true });
```

| Tool works on                                                            | Checked by the gate as                               |
| ------------------------------------------------------------------------ | ---------------------------------------------------- |
| The tenant (`list_rooms`)                                                | its action on `iam/{tenantId}`                       |
| A room (`get_room_index`, `list_activity`, `search`, `qa.*`)             | its action on `better-files-room/{roomId}`           |
| A document or folder (`read_document`, `create_folder`, …)               | its action on `better-files-document/` or `-folder/` |
| No resource named in its arguments (`explain_access`, `answer_question`) | public in the gate; Better Files decides             |

So Better IAM policies can say "agents may read rooms but never upload", and a person's delegation can require a
confirmation before their agent reads a document. Better Files still checks both of its layers on every call.
`sessionTenant(iam)` takes the tenant from the caller's session, for servers used by several organizations.
Better Files needs a Better IAM credential (a session, an agent or service-account key, a delegated session); callers
holding only an OAuth access token pass the gate but Better Files refuses them.

`@modelcontextprotocol/sdk` is an optional peer dependency, needed only for `createBetterFilesMcpServer`.

Part of [Better Files](../../README.md).
