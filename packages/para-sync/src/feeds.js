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

import { signal, derived, effect } from "@lyku/para-signals";
import { createClientReplica } from "./client.js";

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
  const { transport, membership, seed, schemaVersion, refetchRow } = opts;
  if (!transport || typeof transport.subscribe !== "function") {
    throw new Error("syncedQuery: `transport` (per-row value delta source) is required");
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
