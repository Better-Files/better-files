import { AsyncLocalStorage } from 'node:async_hooks';
import {
  IamError,
  type AuditEvent,
  type IamPlugin,
  type IamStore,
  type PolicyStatement,
  type StoredRecord,
} from 'better-iam/core';
import { resourceTypes } from '@better-files/core';

export const PARTICIPANT_ROLE_NAME = 'Better Files participant';
/** The Better IAM group outsiders join when the release has no guests (`externalInvites: 'members'`). */
export const OUTSIDERS_GROUP_NAME = 'Better Files outsiders';
/** The policy context key `betterFilesIamPlugin` adds: the id of the tenant's outsiders group, once it has one. */
export const OUTSIDERS_GROUP_CONTEXT_KEY = 'better-files.outsidersGroup';

/**
 * A Deny statement for host roles: people invited from outside the organization as tenant members
 * (`externalInvites: 'members'`) do not get `actions` on `resources`, whatever else the role allows. Better IAM's own
 * group list decides membership; `betterFilesIamPlugin` supplies which group is the outsiders group.
 *
 * ```ts
 * document: { version: 1, statements: [allowStaff, outsiderBoundary({ actions: ['app:*', 'iam:identities:read'] })] }
 * ```
 */
export function outsiderBoundary(input: {
  actions: string[];
  resources?: string[];
  sid?: string;
}): PolicyStatement {
  return {
    sid: input.sid ?? 'BetterFilesOutsiderBoundary',
    effect: 'deny',
    actions: [...input.actions],
    resources: [...(input.resources ?? ['*'])],
    conditions: { ArrayContains: { 'principal.groups': `\${${OUTSIDERS_GROUP_CONTEXT_KEY}}` } },
  };
}

/** Set while Better Files itself writes to Better IAM, so the guard tells its writes from anyone else's. */
const betterFilesWrites = new AsyncLocalStorage<true>();

/**
 * Runs `fn` as Better Files, past the guard on Better Files-managed Better IAM records. For repair scripts and migrations
 * that must change room resources, room relations, the participant role or the outsiders group directly; normal
 * changes go through Better Files (`dr.api`), which keeps its own tables in step.
 */
export function bypassBetterFilesGuard<T>(fn: () => Promise<T>): Promise<T> {
  return betterFilesWrites.run(true, fn);
}

/** What `betterIamIntegration` shares with the plugin it was given. */
export interface PluginLink {
  /** Better IAM's store, for refreshing the outsiders groups outside any transaction. */
  store?: IamStore;
  listeners: Set<(event: AuditEvent) => void>;
}
const links = new WeakMap<IamPlugin, PluginLink>();
export function linkOf(plugin: IamPlugin): PluginLink | undefined {
  return links.get(plugin);
}

export interface HookOptions {
  /**
   * Refuse changes to Better Files-managed Better IAM records made outside Better Files (default true): writes to
   * `better-files-room/*` resources and their relations, changing or unbinding the `Better Files participant` role, deleting a
   * room's groups, and deleting or renaming the outsiders group. Each would leave rooms disagreeing with Better IAM,
   * or turn outsiders into full members.
   */
  guard?: boolean;
}

const managedTypes = [resourceTypes.room, resourceTypes.folder, resourceTypes.document];
const mutating = /:(create|update|delete)$/;
type Named = StoredRecord & { name?: string };

function managed(message: string): IamError {
  return new IamError(
    'BETTER_FILES_MANAGED',
    `${message}. Better Files manages it: change it through Better Files, or use bypassBetterFilesGuard() for repairs`,
    409,
  );
}

/** The plugin hooks: the guard, the outsiders group in the policy context, purge and audit events. */
export function pluginHooks(options: HookOptions): Pick<
  IamPlugin,
  'hooks' | 'migrate' | 'resolveContext' | 'afterAudit' | 'purge'
> & {
  attach(plugin: IamPlugin): void;
} {
  const link: PluginLink = { listeners: new Set() };
  const guard = options.guard !== false;
  // Transactions renaming the outsiders group, checked once the rename is applied.
  const renaming = new WeakSet<IamStore>();
  const named = async (store: IamStore, collection: string, id: string) =>
    (await store.get<Named>(collection, id))?.name;

  // Outsiders group per tenant. Decisions run inside a store transaction, where another read would wait for it, so
  // resolveContext only reads this map: loaded at start-up, kept by the hooks below, and refreshed in the background
  // for tenants it has no group for (one created by another Better IAM instance, say).
  const outsiders = new Map<string, string>();
  const checked = new Map<string, number>();
  const load = (groups: Named[]) => {
    for (const group of groups)
      if (group.name === OUTSIDERS_GROUP_NAME) outsiders.set(group.tenantId, group.id);
  };
  function refresh(tenantId: string) {
    const store = link.store;
    const now = Date.now();
    if (!store || (checked.get(tenantId) ?? 0) > now - 30_000) return;
    checked.set(tenantId, now);
    setTimeout(() => {
      store
        .find<Named>('groups', { tenantId, name: OUTSIDERS_GROUP_NAME })
        .then(load, () => checked.delete(tenantId));
    }, 0).unref?.();
  }

  return {
    attach: (plugin) => links.set(plugin, link),
    async migrate(store) {
      load(await store.find<Named>('groups', { name: OUTSIDERS_GROUP_NAME }));
    },
    hooks: {
      async beforeOperation({ store, tenantId, action, resourceId }) {
        if (!guard || betterFilesWrites.getStore()) return;
        if (
          /^iam:(resources|relationships):/.test(action) &&
          mutating.test(action) &&
          managedTypes.some((type) => resourceId.startsWith(`${type}/`))
        )
          throw managed(`${resourceId} is a data room record`);
        if (action === 'iam:roles:update' || action === 'iam:roles:delete') {
          if ((await named(store, 'roles', resourceId)) === PARTICIPANT_ROLE_NAME)
            throw managed(`The ${PARTICIPANT_ROLE_NAME} role grants room access`);
        } else if (action === 'iam:bindings:delete') {
          const binding = await store.get<StoredRecord & { roleId: string }>(
            'bindings',
            resourceId,
          );
          if (binding && (await named(store, 'roles', binding.roleId)) === PARTICIPANT_ROLE_NAME)
            throw managed(`This binding of the ${PARTICIPANT_ROLE_NAME} role grants room access`);
        } else if (action === 'iam:groups:delete') {
          if ((await named(store, 'groups', resourceId)) === OUTSIDERS_GROUP_NAME)
            throw managed(`Deleting ${OUTSIDERS_GROUP_NAME} would make outsiders full members`);
          const holds = await store.find<StoredRecord & { type: string }>('relationships', {
            tenantId,
            subjectType: 'group',
            subjectId: resourceId,
          });
          if (holds.some((tuple) => tuple.type === resourceTypes.room))
            throw managed('This group gives people access to a data room');
        } else if (action === 'iam:groups:update') {
          if ((await named(store, 'groups', resourceId)) === OUTSIDERS_GROUP_NAME)
            renaming.add(store);
        }
      },
      async afterOperation({ store, tenantId, action, resourceId, result }) {
        if (action === 'iam:groups:create') {
          const group = result as Partial<Named> | undefined;
          if (group?.name === OUTSIDERS_GROUP_NAME && group.id) outsiders.set(tenantId, group.id);
          return;
        }
        if (action !== 'iam:groups:update' || !renaming.has(store)) return;
        renaming.delete(store);
        // Membership changes are fine (taking someone out makes them a member); a new name is not, because
        // Better Files finds the group by name and would start a new one, leaving the old outsiders as members.
        if ((await named(store, 'groups', resourceId)) !== OUTSIDERS_GROUP_NAME)
          throw managed(`Renaming ${OUTSIDERS_GROUP_NAME} would make outsiders full members`);
      },
    },
    async resolveContext({ session }) {
      const id = outsiders.get(session.tenantId);
      if (id === undefined) {
        refresh(session.tenantId);
        return {};
      }
      return { [OUTSIDERS_GROUP_CONTEXT_KEY]: id };
    },
    async purge(_store, tenantIds) {
      for (const tenantId of tenantIds) {
        outsiders.delete(tenantId);
        checked.delete(tenantId);
      }
    },
    async afterAudit(event) {
      // Deleted with the guard off, or with bypassBetterFilesGuard.
      if (
        event.action === 'iam:groups:delete' &&
        outsiders.get(event.tenantId) === event.resourceId
      )
        outsiders.delete(event.tenantId);
      for (const listener of link.listeners) listener(event);
    },
  };
}
