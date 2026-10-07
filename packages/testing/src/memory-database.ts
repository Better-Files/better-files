import {
  conflict,
  BetterFilesError,
  invalidInput,
  type Comparable,
  type DatabaseAdapter,
  type FieldFilter,
  type FindManyOptions,
  type ResolvedSchema,
  type ResolvedTable,
  type Where,
} from '@better-files/core';

type Row = Record<string, unknown>;
type State = Map<string, Map<string, Row>>;

const clone = <T>(value: T): T => structuredClone(value);
const cloneState = (state: State): State =>
  new Map(
    [...state].map(([model, rows]) => [
      model,
      new Map([...rows].map(([id, row]) => [id, clone(row)])),
    ]),
  );

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  return (a as number | string) < (b as number | string) ? -1 : 1;
}

function isOperatorFilter(filter: FieldFilter): filter is Exclude<FieldFilter, Comparable> {
  return typeof filter === 'object' && filter !== null;
}

function matches(value: unknown, filter: FieldFilter): boolean {
  const actual = value === undefined ? null : value;
  if (!isOperatorFilter(filter)) return actual === filter;
  if (filter.eq !== undefined && actual !== filter.eq) return false;
  if (filter.ne !== undefined && actual === filter.ne) return false;
  if (filter.in !== undefined && !filter.in.includes(actual as Comparable)) return false;
  if (filter.notIn !== undefined && filter.notIn.includes(actual as Comparable)) return false;
  if (filter.isNull !== undefined && (actual === null) !== filter.isNull) return false;
  if (
    filter.contains !== undefined &&
    !(typeof actual === 'string' && actual.toLowerCase().includes(filter.contains.toLowerCase()))
  )
    return false;
  const ordered = actual as number | string | null;
  if (filter.lt !== undefined && !(ordered !== null && ordered < filter.lt)) return false;
  if (filter.lte !== undefined && !(ordered !== null && ordered <= filter.lte)) return false;
  if (filter.gt !== undefined && !(ordered !== null && ordered > filter.gt)) return false;
  if (filter.gte !== undefined && !(ordered !== null && ordered >= filter.gte)) return false;
  return true;
}

/**
 * An in-memory `DatabaseAdapter` for tests and examples. Transactions work on a copy of the data that replaces the
 * committed state only on success, and are serialized, so rollback and isolation behave like a real database.
 */
export function memoryDatabase(): DatabaseAdapter {
  let schema: ResolvedSchema | undefined;
  let committed: State = new Map();
  let queue: Promise<unknown> = Promise.resolve();

  const table = (model: string): ResolvedTable => {
    const found = schema?.tables[model];
    if (!found) throw invalidInput(`Unknown model ${model}`);
    return found;
  };
  const checkFields = (model: string, names: Iterable<string>) => {
    const definition = table(model);
    for (const name of names)
      if (!definition.fields[name]) throw invalidInput(`Unknown field ${model}.${name}`);
  };
  const filterRows = (state: State, model: string, where: Where = {}): Row[] => {
    checkFields(model, Object.keys(where));
    return [...(state.get(model)?.values() ?? [])].filter((row) =>
      Object.entries(where).every(([name, filter]) => matches(row[name], filter)),
    );
  };
  const assertUnique = (state: State, model: string, row: Row, ignoreId?: string) => {
    const definition = table(model);
    const others = [...(state.get(model)?.values() ?? [])].filter((other) => other.id !== ignoreId);
    for (const field of Object.values(definition.fields))
      if (
        field.unique &&
        row[field.name] !== undefined &&
        others.some((other) => other[field.name] === row[field.name])
      )
        throw conflict(`${model}.${field.name} must be unique`);
    for (const index of definition.indexes)
      if (
        index.unique &&
        others.some((other) =>
          index.fields.every((name) => other[name] === row[name] && row[name] !== undefined),
        )
      )
        throw conflict(`${model} (${index.fields.join(', ')}) must be unique`);
  };

  function adapter(state: () => State, inTransaction: boolean): DatabaseAdapter {
    const writable = () => {
      if (!inTransaction)
        throw new BetterFilesError('INTERNAL_ERROR', 'Writes must run inside a transaction');
      return state();
    };
    const self: DatabaseAdapter = {
      id: 'memory',
      bind(resolved) {
        schema = resolved;
      },
      async migrate(resolved) {
        schema = resolved;
        const applied: string[] = [];
        for (const model of Object.keys(resolved.tables))
          if (!committed.has(model)) {
            committed.set(model, new Map());
            applied.push(model);
          }
        return { applied };
      },
      async findOne<T>(model: string, where: Where) {
        const row = filterRows(state(), model, where)[0];
        return row ? (clone(row) as T) : null;
      },
      async findMany<T>(model: string, options: FindManyOptions = {}) {
        const order = options.orderBy?.length ? options.orderBy : [{ field: 'id' }];
        checkFields(
          model,
          order.map((o) => o.field),
        );
        const rows = filterRows(state(), model, options.where).sort((a, b) => {
          for (const { field, direction } of order) {
            const result = compare(a[field], b[field]);
            if (result !== 0) return direction === 'desc' ? -result : result;
          }
          return 0;
        });
        const offset = options.offset ?? 0;
        const page = rows.slice(
          offset,
          options.limit === undefined ? undefined : offset + options.limit,
        );
        return page.map((row) => clone(row) as T);
      },
      async count(model, where) {
        return filterRows(state(), model, where).length;
      },
      async insert<T extends object>(model: string, record: T) {
        const current = writable();
        const row: Row = {};
        for (const [name, value] of Object.entries(record))
          if (value !== undefined) row[name] = clone(value);
        checkFields(model, Object.keys(row));
        for (const field of Object.values(table(model).fields))
          if (field.required && row[field.name] === undefined)
            throw invalidInput(`${model}.${field.name} is required`);
        const rows = current.get(model) ?? new Map<string, Row>();
        if (rows.has(row.id as string)) throw conflict(`${model} ${String(row.id)} already exists`);
        assertUnique(current, model, row);
        rows.set(row.id as string, row);
        current.set(model, rows);
        return clone(row) as T;
      },
      async update(model, where, patch) {
        const current = writable();
        if ('id' in patch || 'tenantId' in patch)
          throw invalidInput('id and tenantId cannot change');
        checkFields(model, Object.keys(patch));
        const targets = filterRows(current, model, where);
        for (const row of targets) {
          const next: Row = { ...row };
          for (const [name, value] of Object.entries(patch))
            if (value === undefined || value === null) delete next[name];
            else next[name] = clone(value);
          assertUnique(current, model, next, row.id as string);
          current.get(model)!.set(row.id as string, next);
        }
        return targets.length;
      },
      async increment(model, where, name, by = 1) {
        const current = writable();
        checkFields(model, [name]);
        const [row, ...others] = filterRows(current, model, where);
        if (!row) return null;
        if (others.length) throw invalidInput('increment must match exactly one row');
        const next = { ...row, [name]: (typeof row[name] === 'number' ? row[name] : 0) + by };
        current.get(model)!.set(row.id as string, next);
        return next[name] as number;
      },
      async delete(model, where) {
        const current = writable();
        const targets = filterRows(current, model, where);
        for (const row of targets) current.get(model)!.delete(row.id as string);
        return targets.length;
      },
      async transaction<R>(fn: (tx: DatabaseAdapter) => Promise<R>): Promise<R> {
        if (inTransaction) return fn(self);
        const run = async () => {
          const working = cloneState(committed);
          const result = await fn(adapter(() => working, true));
          committed = working;
          return result;
        };
        const next = queue.then(run, run);
        queue = next.catch(() => undefined);
        return next;
      },
      async close() {
        committed = new Map();
      },
    };
    return self;
  }

  return adapter(() => committed, false);
}
