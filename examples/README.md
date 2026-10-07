# Examples

| Example                                                             | Shows                                                                                    |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [quickstart](quickstart/index.ts)                                   | One file, no services: rooms, groups, permissions, uploads, tickets and the activity log |
| [express-better-iam](express-better-iam)                            | A production-shaped instance on Better IAM, SQLite and disk, served by Express           |
| [nextjs](nextjs)                                                    | The catch-all route, a server component, and a client component on the React hooks       |
| [nestjs](nestjs/app.module.ts)                                      | `BetterFilesModule`, `@RequireCapability` and `@BetterFilesApi()`                        |
| [mcp-stdio](mcp-stdio/server.ts)                                    | A local MCP server for Claude Code or Claude Desktop                                     |
| [better-files.config.ts](express-better-iam/better-files.config.ts) | The config the CLI loads                                                                 |

The examples import `better-files/*` subpaths, as an application would. `pnpm typecheck` checks them against
the workspace and the test suite runs the quickstart.

Environment for the Better IAM examples: `IAM_SECRET`, `BETTER_FILES_SECRET` (32+ characters each),
`BETTER_FILES_SERVICE_TOKEN` (a service account allowed the actions in `systemPolicy(iam)`), and optionally
`ANTHROPIC_API_KEY` for the AI plugin.
