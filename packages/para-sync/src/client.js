// @lyku/para-sync — client-side replica reconciler (Tier 1 core).
//
// The heart of the client half of synced<T>: take the SSR seed and the stream
// of change envelopes, gate every inbound value through the schema `parse`,
// reconcile by (schema_version, sequence), and apply the authoritative value
// into a reactive cell so the DOM reacts.
//
// What this is NOT: it does not open the WS, does not run the connect-time
// handshake (Tier 1 step 4), and does not write (Tier 2). It is the pure
// receive → parse → version-check → apply engine, transport-agnostic.

import { signal } from "@lyku/para-signals";

/** @typedef {import('./transport.js').SyncEnvelope} SyncEnvelope */
/** @typedef {import('./transport.js').SyncTransport} SyncTransport */

/**
 * A schema's parse result — matches para-schema's Result<T, string>.
 * @typedef {{ tag: 'Ok', value: any } | { tag: 'Err', error: string }} Result
 */

/**
 * Anything with a `parse` returning {@link Result}. In production this is a
 * para-schema `SchemaValue`; in tests it can be a hand-rolled gate. The replica
 * depends only on this shape, never on para-schema directly — which is also why
 * the client gates branch on `.tag` instead of using the throw-on-Err `::`
 * convention (a malformed delta must trigger recovery, not crash the apply).
 * @typedef {{ parse(v: unknown): Result }} SyncSchema
 */

/**
 * A minimal reactive value cell: get / peek / set. A para-signals `signal()`
 * satisfies it exactly and is the default. Injectable for testing and for the
 * fork-backed cell on the para-svelte side.
 * @typedef {{ get(): any, peek(): any, set(v: any): void }} Cell
 */

/**
 * @typedef {'ok' | 'stale' | 'skew' | 'refetching'} ReplicaStatus
 *  - ok          last apply succeeded; replica is current
 *  - stale       uninitialized, or a refetch failed / none available
 *  - skew        an inbound value failed `parse` (malformed or schema-skew)
 *  - refetching  a recovery refetch is in flight
 */

/**
 * @typedef {object} ReplicaMeta
 * @property {string | null} schemaVersion  schema version of the applied value
 * @property {number} sequence              sequence of the applied value (-1 if uninitialized)
 * @property {ReplicaStatus} status
 */

/**
 * Compare two "major.minor" version strings by MAJOR only. Returns true iff both
 * are well-formed and their majors differ (a breaking change). Missing/malformed
 * versions return false — let the parse gate be the backstop rather than block on
 * a version-format quirk.
 * @param {string | undefined} a
 * @param {string | undefined} b
 */
function majorMismatch(a, b) {
  const ma = /^(\d+)\./.exec(a == null ? "" : String(a));
  const mb = /^(\d+)\./.exec(b == null ? "" : String(b));
  if (ma === null || mb === null) return false;
  return ma[1] !== mb[1];
}

/**
 * Create a client replica for one synced key.
 *
 * @param {object} opts
 * @param {string} opts.key                              synced key, e.g. "user:123"
 * @param {SyncSchema} opts.schema                       the `parse` gate
 * @param {SyncTransport} opts.transport                 change-envelope source
 * @param {SyncEnvelope} [opts.seed]                     SSR-embedded initial envelope
 * @param {() => Promise<SyncEnvelope>} [opts.refetch]   Err/skew/gap fallback: fetch the
 *        current authoritative snapshot. Omit → no recovery (status goes 'stale').
 * @param {Cell} [opts.cell]                             reactive cell (default: a para signal)
 * @param {string} [opts.schemaVersion]                  the client's expected schema
 *        version ("major.minor"). When set, an inbound envelope whose MAJOR
 *        differs is treated as a breaking skew: not applied, recovery refetched.
 *        A minor difference is compatible and falls through to the parse gate.
 */
export function createClientReplica({
  key,
  schema,
  transport,
  seed,
  refetch,
  cell,
  schemaVersion,
}) {
  const value = cell ?? signal(undefined);
  /** @type {Cell} */
  const meta = signal(
    /** @type {ReplicaMeta} */ ({ schemaVersion: null, sequence: -1, status: "stale" })
  );

  let initialized = false;
  let disposed = false;
  let pending = Promise.resolve();
  // Tier-2 seam (§13.1): the per-entity intent version. The read reconciler
  // owns it so the write path (writer.js) and the reconciler share ONE monotonic
  // counter (INV-sync-12). Untouched by Tier-1 ingest; only nextIntent() bumps it.
  let intentVersion = 0;

  const stats = {
    applied: 0,
    ignoredStale: 0,
    gaps: 0,
    parseErrors: 0,
    refetches: 0,
    schemaSkews: 0,
  };

  /** @param {Partial<ReplicaMeta>} patch */
  const setMeta = (patch) => meta.set({ ...meta.peek(), ...patch });

  /** @param {any} parsedValue @param {SyncEnvelope} envelope */
  function commit(parsedValue, envelope) {
    value.set(parsedValue);
    initialized = true;
    setMeta({ schemaVersion: envelope.schema_version, sequence: envelope.sequence, status: "ok" });
    stats.applied++;
  }

  function startRefetch() {
    if (!refetch) {
      setMeta({ status: "stale" });
      return;
    }
    stats.refetches++;
    setMeta({ status: "refetching" });
    pending = (async () => {
      try {
        const snap = await refetch();
        if (!disposed) ingest(snap, "refetch");
      } catch {
        if (!disposed) setMeta({ status: "stale" });
      }
    })();
  }

  /**
   * @param {SyncEnvelope} envelope
   * @param {'hydration' | 'receipt' | 'refetch'} source
   */
  function ingest(envelope, source) {
    if (disposed) return;

    // ── schema-version gate ──
    // A breaking (major) schema-version difference means the value was produced
    // against an incompatible shape. Don't apply it — the parse gate would
    // likely reject it too, but the version is the explicit, earlier signal and
    // tells us this is "different shape" (refetch), not "behind but compatible".
    // A minor difference (same major) is compatible and falls through to parse.
    if (
      schemaVersion !== undefined &&
      majorMismatch(schemaVersion, envelope.schema_version)
    ) {
      stats.schemaSkews++;
      setMeta({ status: "skew" });
      if (source !== "refetch") startRefetch();
      return;
    }

    // ── parse gate (every inbound value crosses a trust boundary) ──
    const res = schema.parse(envelope.value);
    if (res.tag !== "Ok") {
      stats.parseErrors++;
      setMeta({ status: "skew" });
      // Don't poison the cell. Recover via a known-good snapshot — but never
      // refetch in response to a refetch result (avoids an Err→refetch loop).
      if (source !== "refetch") startRefetch();
      return;
    }

    // ── baseline (re)seed ──
    // SSR hydration, a recovery refetch, or the very first value we have seen:
    // accept unconditionally as the new authoritative baseline.
    if (source === "hydration" || source === "refetch" || !initialized) {
      commit(res.value, envelope);
      return;
    }

    // ── steady-state receipt: reconcile by sequence ──
    const cur = meta.peek().sequence;
    if (envelope.sequence <= cur) {
      stats.ignoredStale++; // stale / duplicate / out-of-order
      return;
    }
    if (envelope.sequence === cur + 1) {
      commit(res.value, envelope); // in-order
      return;
    }
    // Gap: one or more envelopes were missed. v2 step 5 → refetch the full
    // snapshot and resync. (Under the full-object delta model the gapped
    // envelope already carries the complete current value, so committing it
    // directly would be correct and cheaper — a documented future optimization;
    // we follow v2's explicit gap→refetch here.)
    stats.gaps++;
    startRefetch();
  }

  // ── wire up ──
  const unsub = transport.subscribe(key, (envelope) => ingest(envelope, "receipt"));
  if (seed !== undefined) ingest(seed, "hydration"); // SSR-hydration parse gate

  return {
    /** current value (tracked read) */
    get: () => value.get(),
    /** current value (untracked) */
    peek: () => value.peek(),
    /** reconcile metadata (tracked): { schemaVersion, sequence, status } */
    meta: () => meta.get(),
    /** reconcile metadata (untracked) */
    peekMeta: () => meta.peek(),
    /** observability counters — read directly */
    stats,
    /** resolves when no recovery refetch is in flight (test/await aid) */
    whenIdle: () => pending,
    // ── Tier-2 seams (§13.1 `mutate`) ───────────────────────────────────────
    // The write path (writer.js) drives these; Tier-1-only consumers ignore them.
    /** Bump + return the per-entity intent version — the optimistic-write counter. */
    nextIntent: () => (disposed ? intentVersion : ++intentVersion),
    /** Current intent version (untracked). */
    peekIntent: () => intentVersion,
    /**
     * Optimistic local write: set the value cell WITHOUT a server sequence. The
     * authoritative receipt still wins when it arrives (ingest commits by
     * sequence + overwrites). This is the local flip half of §13.1.
     * @param {any} v
     */
    applyLocal: (v) => {
      if (!disposed) value.set(v);
    },
    /** stop listening; idempotent */
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsub();
    }
  };
}
