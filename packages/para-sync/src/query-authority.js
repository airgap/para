// @lyku/para-sync: the authority-side query host (§13.7 liveness, plan step 3).
//
// The server story for L-query sources: a query is LIVE because the authority
// knows its READ-SET, which table/rows the result depends on, so a write
// flowing through the authority re-evaluates exactly the intersecting
// subscriptions and re-publishes what changed. This module is the
// evaluator-agnostic HOST: `evaluate` (spec → rows) and `readSetOf`
// (spec → read-set) are supplied by the deployment: lockstep-pg compiles the
// typed spec to SQL and derives the precise read-set in production; tests and
// monoliths hand in plain functions. The host owns everything else: per-row
// sequences, the outbound parse gate, membership diffing, and delta fan-out.
//
// Composition with the client spine is deliberate and exact:
//   - a subscription IS a feeds.js MembershipStream ({ listen, close }), the
//     value a `.pui` binding's `membership` opt (or configureSyncedQuery's
//     resolveMembership) wants;
//   - row VALUE deltas travel the SyncTransport keyed by row key, so each
//     client-side createClientReplica reconciles by (schema_version, sequence)
//     exactly as for any other synced entity. Steady-state ingest demands
//     sequence === current + 1, so the authority bumps a row's sequence by
//     EXACTLY one per real change (deep-equal short-circuit: a write that
//     leaves a row's value identical publishes nothing).
//
// Both-ends gating (the §13.8 principle applies here too): every row an
// evaluation returns crosses the schema's parse gate BEFORE it can seed or
// publish. A server-side bug surfaces once at the boundary (onError), never
// as reconcile chaos on N clients.

/** @typedef {import('./transport.js').SyncTransport} SyncTransport */
/** @typedef {import('./client.js').SyncSchema} SyncSchema */
/** @typedef {import('./feeds.js').MembershipEnvelope} MembershipEnvelope */

/** Structural deep-equality over JSON-profile values (the wire domain). */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!Object.hasOwn(b, k) || !deepEqual(a[k], b[k])) return false;
  return true;
}

/** @param {*} s  a read-set or write scope: string table, or { table?, rowKeys? } */
function normalizeScope(s) {
  if (s === undefined || s === null) return { table: "*", rowKeys: undefined };
  if (typeof s === "string") return { table: s, rowKeys: undefined };
  return { table: s.table ?? "*", rowKeys: s.rowKeys ?? (s.rowKey !== undefined ? [s.rowKey] : undefined) };
}

/** A read-set and a write scope intersect unless they provably don't. */
function intersects(readSet, scope) {
  if (readSet.table !== "*" && scope.table !== "*" && readSet.table !== scope.table) return false;
  if (readSet.rowKeys && scope.rowKeys) {
    const set = new Set(readSet.rowKeys);
    return scope.rowKeys.some((k) => set.has(k));
  }
  return true; // either side covers its whole table
}

/**
 * Create the authority-side host for one row schema ("one entity, one
 * authority", the `.para` manifest's `authority { S => … }` granularity).
 *
 * @param {object} cfg
 * @param {SyncTransport} cfg.transport  where row value envelopes publish.
 * @param {(spec: any) => any[] | Promise<any[]>} cfg.evaluate  spec → rows
 *        (lockstep-pg-compiled SQL in production; any function in tests).
 * @param {(row: any) => string} cfg.keyOf  row → row key (e.g. r => `user:${r.id}`).
 * @param {SyncSchema} cfg.schema  the row schema, the OUTBOUND parse gate.
 * @param {(spec: any) => any} [cfg.readSetOf]  spec → read-set; defaults to
 *        "the whole world" (`*`), i.e. every write re-evaluates. Precision is
 *        the deployment's job (lockstep-pg knows the columns/rows a compiled
 *        spec reads); correctness never depends on it.
 * @param {string} [cfg.schemaVersion]
 * @param {(error: unknown, ctx: { phase: string, rowKey?: string }) => void} [cfg.onError]
 */
export function createQueryAuthority({
  transport,
  evaluate,
  keyOf,
  schema,
  readSetOf,
  schemaVersion = "1.0",
  onError,
}) {
  if (!transport || typeof transport.publish !== "function") {
    throw new Error("createQueryAuthority: a `transport` (with publish) is required");
  }
  if (typeof evaluate !== "function") throw new Error("createQueryAuthority: `evaluate` is required");
  if (typeof keyOf !== "function") throw new Error("createQueryAuthority: `keyOf` is required");
  if (!schema || typeof schema.parse !== "function") {
    throw new Error("createQueryAuthority: `schema` (with parse) is required");
  }

  /** @type {Map<string, number>} rowKey → current sequence (monotonic, +1 per real change) */
  const rowSeq = new Map();
  /** @type {Map<string, any>} rowKey → last published (PARSED) value */
  const rowLast = new Map();
  /** @type {Set<object>} live subscriptions */
  const subs = new Set();
  let disposed = false;
  let evaluations = 0; // observability + "no re-eval on non-intersecting write" tests

  const envOf = (rowKey) => ({
    value: rowLast.get(rowKey),
    schema_version: schemaVersion,
    sequence: rowSeq.get(rowKey) ?? 0,
  });

  // One evaluation result flows through here regardless of what triggered it
  // (a fresh subscribe or a write): gate every row, then bump + publish any
  // row whose parsed value actually changed. Returns the gated ordered keys.
  function applyRows(rows) {
    const keys = [];
    for (const row of rows) {
      let r;
      try {
        r = schema.parse(row);
      } catch (error) {
        onError?.(error, { phase: "parse" });
        continue;
      }
      if (!r || r.tag !== "Ok") {
        onError?.(r && r.tag === "Err" ? r.error : new Error("non-Result parse"), { phase: "parse" });
        continue; // gated out, never seeds, never publishes
      }
      const rowKey = keyOf(r.value);
      keys.push(rowKey);
      const prev = rowLast.get(rowKey);
      if (rowSeq.has(rowKey) && deepEqual(prev, r.value)) continue; // short-circuit
      rowSeq.set(rowKey, (rowSeq.get(rowKey) ?? 0) + 1);
      rowLast.set(rowKey, r.value);
      transport.publish(rowKey, envOf(rowKey));
    }
    return keys;
  }

  async function reevaluate(sub, emitEvenIfSame) {
    evaluations++;
    const rows = await evaluate(sub.spec);
    const keys = applyRows(Array.isArray(rows) ? rows : []);
    const changed =
      keys.length !== sub.keys.length || keys.some((k, i) => k !== sub.keys[i]);
    if (changed || emitEvenIfSame) {
      sub.keys = keys;
      /** @type {MembershipEnvelope} */
      const delta = { keys: keys.slice(), seeds: {} };
      for (const k of keys) delta.seeds[k] = envOf(k);
      sub.onDelta?.(delta);
    }
  }

  return {
    /**
     * Open a live subscription for a query spec. The return value IS a
     * feeds.js MembershipStream. Hand it to `syncedOne`/`syncedQuery` as
     * the `membership` opt (or return it from resolveMembership). The
     * first membership delta (keys + full seeds) arrives after the initial
     * evaluation completes; value deltas ride the shared transport.
     * @param {*} spec
     */
    subscribe(spec) {
      const sub = {
        spec,
        readSet: normalizeScope(readSetOf ? readSetOf(spec) : undefined),
        keys: /** @type {string[]} */ ([]),
        onDelta: /** @type {((m: MembershipEnvelope) => void) | undefined} */ (undefined),
        pending: Promise.resolve(),
        closed: false,
      };
      subs.add(sub);
      const chain = (fn) => {
        // Serialize this subscription's evaluations so a slow initial eval
        // can never emit after (and clobber) a faster wrote()-triggered one.
        sub.pending = sub.pending.then(fn).catch((error) => onError?.(error, { phase: "evaluate" }));
        return sub.pending;
      };
      return {
        listen: (onDelta) => {
          sub.onDelta = onDelta;
          chain(() => (sub.closed ? undefined : reevaluate(sub, true)));
        },
        close: () => {
          sub.closed = true;
          subs.delete(sub);
        },
      };
    },

    /**
     * The write-path hook: call after applying a write (a §13.1 intent
     * confirm, a P4 handler, a migration). Re-evaluates every live
     * subscription whose read-set intersects the scope; publishes membership
     * deltas and per-row value envelopes for what actually changed.
     * @param {*} [scope]  string table or { table?, rowKey?, rowKeys? };
     *        omitted = everything (the §4.4 `invalidate(KEY)` manual hook).
     */
    wrote(scope) {
      if (disposed) return Promise.resolve();
      const s = normalizeScope(scope);
      const waits = [];
      for (const sub of subs) {
        if (!intersects(sub.readSet, s)) continue;
        waits.push(
          (sub.pending = sub.pending
            .then(() => (sub.closed ? undefined : reevaluate(sub, false)))
            .catch((error) => onError?.(error, { phase: "evaluate" })))
        );
      }
      return Promise.all(waits).then(() => undefined);
    },

    /** Alias for the author-declared read-set: `on KEY` policies call this. */
    invalidate(scope) {
      return this.wrote(scope);
    },

    /** evaluations run so far (observability; tests assert no wasted evals) */
    stats: () => ({ evaluations, liveSubscriptions: subs.size, knownRows: rowSeq.size }),

    /** drop every subscription; further wrote() calls are no-ops */
    dispose() {
      disposed = true;
      for (const sub of subs) sub.closed = true;
      subs.clear();
    },
  };
}
