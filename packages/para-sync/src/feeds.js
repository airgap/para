// @lyku/para-sync — typed subscription/query surface: collections (§13.3).
//
// `sync feed :: Post[] from query(...)` replicates a COLLECTION. The reconcile
// spine scales to a collection "by composition, not a new engine": each row is a
// §3 createClientReplica keyed by its row key, and the collection's MEMBERSHIP
// (insert/remove/reorder) is a SEPARATE typed channel from the per-row VALUE
// deltas — so a reorder never re-parses every row, and each row reconciles by
// (schema_version, sequence) independently.
//
// The value is a reactive array in membership order. `row(key)` exposes a row's
// replica so an offline-queued mutation (§13.5) can target it by row key.

import { signal, derived, effect, batch } from "@lyku/para-signals";
import { createClientReplica } from "./client.js";

/**
 * App-wide defaults so a lowered `sync feed :: T[] from query(spec)` call
 * (`syncedQuery(T, spec)`) can infer delivery: a shared per-row value transport
 * and a `resolveMembership(schema, spec) → MembershipStream` that opens the
 * server query subscription from the spec. Set ONCE near app init.
 * @type {{ transport?: any, resolveMembership?: (schema: any, spec: any) => any }}
 */
let queryDefaults = {};

/**
 * Configure app-wide {@link syncedQuery} delivery (merged into prior config).
 * @param {{ transport?: any, resolveMembership?: (schema: any, spec: any) => any }} config
 */
export function configureSyncedQuery(config) {
  queryDefaults = { ...queryDefaults, ...config };
}

/** @typedef {import('./transport.js').SyncEnvelope} SyncEnvelope */
/** @typedef {import('./transport.js').SyncTransport} SyncTransport */
/** @typedef {import('./client.js').SyncSchema} SyncSchema */

/**
 * A membership delta: the ordered row keys of the collection, plus optional
 * per-row seeds so an inserted row shows its value immediately (server sends the
 * value with the insert). Value deltas for existing rows travel the per-row
 * `transport` instead.
 * @typedef {object} MembershipEnvelope
 * @property {string[]} keys                          the ordered row keys (server-projected order)
 * @property {Record<string, SyncEnvelope>} [seeds]   initial value per newly-inserted key
 */

/**
 * A membership stream: `listen` registers a per-delta callback; `close` stops it.
 * @typedef {object} MembershipStream
 * @property {(onDelta: (m: MembershipEnvelope) => void) => void} listen
 * @property {() => void} [close]
 */

/**
 * Live-replicate a server-projected collection into a reactive array.
 *
 * @template [T=any]
 * @param {SyncSchema} schema  the ROW schema (the parse gate applied per row).
 * @param {object} opts
 * @param {SyncTransport} opts.transport  per-row VALUE delta source (keyed by row key).
 * @param {MembershipStream | (() => MembershipStream)} [opts.membership]  the
 *        membership (insert/remove/reorder) channel; a factory is invoked once.
 * @param {MembershipEnvelope} [opts.seed]  SSR-embedded initial membership + seeds.
 * @param {string} [opts.schemaVersion]  expected row schema version.
 * @param {(rowKey: string) => Promise<SyncEnvelope>} [opts.refetchRow]  per-row recovery.
 * @param {*} [opts.where]    typed query predicate (server-applied; metadata here).
 * @param {*} [opts.orderBy]  typed order key (server-applied; metadata here).
 * @param {number} [opts.limit]  page size (server-applied; metadata here).
 */
export function syncedQuery(schema, opts = {}) {
  if (!schema || typeof schema.parse !== "function") {
    throw new Error("syncedQuery: `schema` (the row schema, with parse) is required");
  }
  // Delivery: explicit opts win; else the app-wide config (a lowered
  // `syncedQuery(T, { where, orderBy, limit })` carries no transport/membership).
  const transport = opts.transport ?? queryDefaults.transport;
  const membership =
    opts.membership ??
    (queryDefaults.resolveMembership ? () => queryDefaults.resolveMembership(schema, opts) : undefined);
  const { seed, schemaVersion, refetchRow } = opts;
  if (!transport || typeof transport.subscribe !== "function") {
    throw new Error("syncedQuery: a `transport` is required (pass it, or set one via configureSyncedQuery)");
  }

  /** @type {Map<string, ReturnType<typeof createClientReplica>>} rowKey -> replica */
  const rows = new Map();
  const orderSig = signal(/** @type {string[]} */ ([]));

  // The reactive array: membership order mapped to each row's current value.
  // Reading a row's `get()` tracks its cell, so the derived recomputes on any
  // row-value change; reading orderSig tracks membership changes.
  const arr = derived(() =>
    orderSig
      .get()
      .map((k) => rows.get(k)?.get())
      .filter((v) => v !== undefined)
  );

  function ensureRow(rowKey, rowSeed) {
    if (rows.has(rowKey)) return;
    rows.set(
      rowKey,
      createClientReplica({
        key: rowKey,
        schema,
        transport,
        seed: rowSeed,
        schemaVersion,
        refetch: refetchRow ? () => refetchRow(rowKey) : undefined,
      })
    );
  }

  function dropRow(rowKey) {
    const r = rows.get(rowKey);
    if (r) {
      r.dispose();
      rows.delete(rowKey);
    }
  }

  /** @param {MembershipEnvelope} m */
  function applyMembership(m) {
    const keys = Array.isArray(m?.keys) ? m.keys : [];
    const seeds = m?.seeds ?? {};
    const next = new Set(keys);
    for (const k of keys) ensureRow(k, seeds[k]); // inserts (seeded → visible immediately)
    for (const k of [...rows.keys()]) if (!next.has(k)) dropRow(k); // removals
    orderSig.set(keys.slice()); // order (a reorder is just this — no row re-parse)
  }

  if (seed) applyMembership(seed);

  /** @type {MembershipStream | undefined} */
  let memSock;
  if (membership) {
    memSock = typeof membership === "function" ? membership() : membership;
    memSock.listen(applyMembership);
  }

  let disposed = false;

  return {
    /** the collection as a reactive array (tracked read) */
    get: () => arr.get(),
    /** the collection (untracked) */
    peek: () => arr.peek(),
    /**
     * Subscribe to array changes: fires with the current array now and on every
     * membership/row change; returns an unsubscribe (the .pui `sync feed` binding).
     * @param {(rows: T[]) => void} onChange
     */
    subscribe(onChange) {
      return effect(() => onChange(arr.get()));
    },
    /** the current row keys, in order (untracked) */
    rowKeys: () => orderSig.peek().slice(),
    /** a row's replica (for a per-row §13.5 mutation), or undefined */
    row: (rowKey) => rows.get(rowKey),
    /** number of live rows */
    size: () => rows.size,
    /** stop the membership stream + every row replica; idempotent */
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        memSock?.close?.();
      } catch {
        /* already closed */
      }
      for (const r of rows.values()) r.dispose();
      rows.clear();
      orderSig.set([]);
    },
  };
}

/**
 * Scalar query sync (§13.7): ONE entity selected by a typed predicate —
 * the `limit: 1` degeneration of {@link syncedQuery}, sharing its whole
 * machinery (per-row createClientReplica, membership vs value channels)
 * by composition, not a new engine. The `.pui` form
 * `sync user :: User from query({ where })` lowers here.
 *
 * The value is `T | undefined`, and `undefined` is a MEMBERSHIP FACT
 * ("the server said no row matches"), never a not-yet-loaded state. The
 * `ready` gate is what keeps those distinct: before the first membership
 * fact (an SSR `seed`, or the first membership delta), `peek()` returns
 * `undefined` and `subscribe` stays silent — so a re-keyed component
 * binding keeps showing its stale value instead of flashing undefined
 * while the new subscription loads. After ready, an empty key set emits
 * a real `undefined` (row absent / deleted).
 *
 * @template [T=any]
 * @param {SyncSchema} schema  the row schema (parse gate per envelope).
 * @param {object} [opts]  syncedQuery opts; `limit` defaults to 1.
 */
export function syncedOne(schema, opts = {}) {
  if (!schema || typeof schema.parse !== "function") {
    throw new Error("syncedOne: `schema` (with parse) is required");
  }
  const readySig = signal(Boolean(opts.seed));
  // Wrap the membership stream (explicit, or resolved from the app-wide
  // config — resolved HERE so the limit:1 injection reaches the server
  // subscription) to flip `ready` on the first delta.
  const rawMembership =
    opts.membership ??
    (queryDefaults.resolveMembership
      ? queryDefaults.resolveMembership(schema, { limit: 1, ...opts })
      : undefined);
  const resolved = typeof rawMembership === "function" ? rawMembership() : rawMembership;
  const membership = resolved
    ? {
        // Membership applies BEFORE ready flips, and both inside one batch:
        // effects drain synchronously in para-signals, so flipping ready
        // first would emit a spurious `undefined` ("no row" — a false fact)
        // in the gap before the delta lands.
        listen: (onDelta) =>
          resolved.listen((d) =>
            batch(() => {
              onDelta(d);
              readySig.set(true);
            })
          ),
        close: () => resolved.close?.(),
      }
    : undefined;
  const q = syncedQuery(schema, { ...opts, limit: opts.limit ?? 1, membership });
  // Reading readySig INSIDE the derived makes the ready flip itself a
  // tracked change, so a subscriber sees the first real fact the moment
  // membership lands.
  const one = derived(() => (readySig.get() ? q.get()[0] : undefined));
  return {
    /** the entity (tracked read) — `undefined` means "no row matches" once ready */
    get: () => one.get(),
    /** the entity (untracked); `undefined` before the first membership fact */
    peek: () => (readySig.peek() ? one.peek() : undefined),
    /**
     * Fires on every change AFTER the first membership fact; silent before
     * (the SWR contract for re-keyed bindings). Returns an unsubscribe.
     * @param {(v: T | undefined) => void} onChange
     */
    subscribe(onChange) {
      return effect(() => {
        const v = one.get();
        if (readySig.get()) onChange(v);
      });
    },
    /** true once a membership fact (seed or delta) has arrived */
    ready: () => readySig.peek(),
    /** the row's replica (Tier-2 seams), or undefined when no row */
    row: () => q.row(q.rowKeys()[0]),
    /** stop membership + the row replica; idempotent */
    dispose: () => q.dispose(),
  };
}
