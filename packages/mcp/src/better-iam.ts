import { operationMatrix, resourceTypes, type Credential } from '@better-files/core';
import type { BetterFiles } from '@better-files/server';
import { availableTools, type ToolsOptions } from './tools.js';

type Args = Record<string, unknown>;
type Ref = { type: string; id: string };

/**
 * A tool rule for Better IAM's MCP gate (`createMcpGate` / `createMcpAuthorizer` from `better-iam/mcp`). Structural,
 * so this package does not depend on Better IAM.
 */
export interface BetterIamToolRule {
  action?: string;
  resource?: Ref | ((args: Args) => Ref);
  listAs?: Ref;
  scopes?: string[];
  public?: boolean;
}

export interface BetterIamToolRulesOptions extends ToolsOptions {
  /** The tenant the gate decides in (the gate's own `tenantId`): tenant-wide tools are checked on `iam/{tenantId}`. */
  tenantId: string;
  /**
   * OAuth scopes per tool, for gates that also accept OAuth access tokens. Better Files itself needs a Better IAM
   * credential (a session, an agent or service-account key, a delegated session), so OAuth-only callers pass the
   * gate but Better Files refuses them; leave this out unless your tools accept them.
   */
  scopes?: { read?: string[]; write?: string[] };
}

/** What each tool does, as the operation Better Files authorizes and the resource it authorizes it on. */
type Target =
  | { kind: 'tenant' }
  | { kind: 'room'; from: string }
  | { kind: 'node'; resource: (args: Args) => Ref | undefined }
  /** The arguments do not say which resource (a node of unknown kind, a question): Better Files decides alone. */
  | { kind: 'defer' };

const documentArg =
  (name: string) =>
  (args: Args): Ref | undefined =>
    typeof args[name] === 'string'
      ? { type: resourceTypes.document, id: args[name] as string }
      : undefined;

const toolTargets: Record<string, { operation: string | readonly string[]; target: Target }> = {
  list_rooms: { operation: 'rooms.list', target: { kind: 'tenant' } },
  get_room_index: { operation: 'rooms.index', target: { kind: 'room', from: 'roomId' } },
  get_document: {
    operation: 'documents.get',
    target: { kind: 'node', resource: documentArg('documentId') },
  },
  list_versions: {
    operation: 'versions.list',
    target: { kind: 'node', resource: documentArg('documentId') },
  },
  // The MCP plugin's text endpoint when installed, otherwise the viewer ticket path.
  read_document: {
    operation: ['mcp.readText', 'documents.requestView'],
    target: { kind: 'node', resource: documentArg('documentId') },
  },
  search: { operation: 'search.query', target: { kind: 'room', from: 'roomId' } },
  ask_room: { operation: 'ai.ask', target: { kind: 'room', from: 'roomId' } },
  list_activity: { operation: 'activity.list', target: { kind: 'room', from: 'roomId' } },
  explain_access: { operation: 'permissions.explain', target: { kind: 'defer' } },
  list_questions: { operation: 'qa.list', target: { kind: 'room', from: 'roomId' } },
  create_folder: {
    operation: 'folders.create',
    target: {
      kind: 'node',
      resource: (args) =>
        typeof args.parentId === 'string'
          ? { type: resourceTypes.folder, id: args.parentId }
          : undefined,
    },
  },
  upload_text_document: {
    operation: 'uploads.create',
    target: {
      kind: 'node',
      resource: (args) =>
        typeof args.documentId === 'string'
          ? { type: resourceTypes.document, id: args.documentId }
          : typeof args.parentId === 'string'
            ? { type: resourceTypes.folder, id: args.parentId }
            : undefined,
    },
  },
  ask_question: { operation: 'qa.ask', target: { kind: 'room', from: 'roomId' } },
  answer_question: { operation: 'qa.answer', target: { kind: 'defer' } },
};

/** The identity-system action of a core or plugin operation (`group.method`), if this instance serves it. */
function actionOf(dr: Pick<BetterFiles, 'plugins'>, operation: string): string | undefined {
  const core = (operationMatrix as Record<string, { action: string } | undefined>)[operation];
  if (core) return core.action;
  const [group, method] = operation.split('.') as [string, string];
  const plugin = dr.plugins.find((candidate) => candidate.id === group);
  const endpoint = (
    plugin?.endpoints as Record<string, { operation: { action: string } }> | undefined
  )?.[method];
  return endpoint?.operation.action;
}

/**
 * Tool rules for putting the Better Files MCP server behind Better IAM's MCP gate. Each tool is checked as the
 * Better Files action it performs, on the resource Better Files authorizes it on (`better-files-room/{roomId}`,
 * `better-files-document/{id}`, `better-files-folder/{id}`, or `iam/{tenantId}` for tenant-wide tools). So Better IAM
 * policies about agents ("agents may read rooms but never upload"), delegation confirmations ("ask me before an agent
 * reads a document") and tool hiding in `tools/list` all apply. Better Files still checks both of its layers on every
 * call: tools whose arguments do not name the resource are left to it (`public` in the gate).
 *
 * ```ts
 * import { createMcpGate } from 'better-iam/mcp';
 * const gate = createMcpGate({ iam, tenantId, tools: betterIamToolRules(dr, { tenantId, write: true }) });
 * ```
 */
export function betterIamToolRules(
  dr: Pick<BetterFiles, 'plugins'>,
  options: BetterIamToolRulesOptions,
): Record<string, BetterIamToolRule> {
  const tenant: Ref = { type: 'iam', id: options.tenantId };
  const rules: Record<string, BetterIamToolRule> = {};
  for (const tool of availableTools(dr as BetterFiles, options)) {
    const spec = toolTargets[tool.name];
    const operations = spec
      ? typeof spec.operation === 'string'
        ? [spec.operation]
        : spec.operation
      : [];
    const action = operations.map((operation) => actionOf(dr, operation)).find(Boolean);
    const scopes = tool.annotations.readOnlyHint ? options.scopes?.read : options.scopes?.write;
    const withScopes = scopes ? { scopes: [...scopes] } : {};
    if (!spec || !action || spec.target.kind === 'defer') {
      rules[tool.name] = { public: true, ...withScopes };
      continue;
    }
    const target = spec.target;
    rules[tool.name] = {
      action,
      ...withScopes,
      resource:
        target.kind === 'tenant'
          ? tenant
          : target.kind === 'room'
            ? (args) =>
                typeof args[target.from] === 'string'
                  ? { type: resourceTypes.room, id: args[target.from] as string }
                  : tenant
            : (args) => target.resource(args) ?? tenant,
    };
  }
  return rules;
}

/** The part of a `betterIam()` instance `sessionTenant` uses. */
export interface SessionAuthenticator {
  authenticate(credential: Credential): Promise<{ session: { tenantId: string } }>;
}

/**
 * `tenantId` for `createBetterFilesMcpServer` from the caller's Better IAM session: the tenant the credential acts in
 * (for an assumed role, the role's tenant). Use it when one MCP server serves several organizations.
 */
export function sessionTenant(iam: SessionAuthenticator) {
  return async (credential: Credential): Promise<string> =>
    (await iam.authenticate(credential)).session.tenantId;
}
