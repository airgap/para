// @lyku/para-sync — synced<T>: the client-facing reactive primitive (the "rune").
//
// createClientReplica is the pure receive→parse→version-check→apply engine; it
// needs a transport already fed with envelopes, and it leaves stream wiring and
// teardown to the caller. Every adopter therefore hand-rolls the same four
// pieces: stand up an InProcessTransport, open the change stream, pump
// stream→transport, and bundle (stream.close + replica.dispose) into one
// teardown. `synced` collapses that into a single call.
//
// What it adds on top of createClientReplica:
//   1. A default transport — a private InProcessTransport, the client model
//      (the WS stream is the only producer; there is no server-internal bus to
//      inject). Caller may still inject one for tests/advanced use.
//   2. A stream bridge — given `stream` (a factory yielding {listen, close?}),
//      every delivered envelope is published on `key`, so the reconciler ingests
//      it. This is the receipt source; SSR initial state still arrives via seed.
//   3. A reactive read surface — `.value` / `.get()` are TRACKED reads of the
//      default para-signal cell, so reading inside a para reactive context (a
//      `.pui` component, a derived, an effect) subscribes to live updates with
//      no manual effect. Reads of `.status` track the reconcile state the same
//      way. The cell is injectable (e.g. a Svelte-fork-backed or store-backed
//      cell) for hosts that don't read para signals directly.
//   4. One teardown — `.dispose()` closes the stream and disposes the replica.
//
// It does NOT write (Tier 1 is read-only replication) and does NOT own the
// schema or the schema version — those are the caller's, passed straight through.

import { signal } from "@lyku/para-signals";
import { InProcessTransport } from "./transport.js";
import { createClientReplica } from "./client.js";

/** @typedef {import('./transport.js').SyncEnvelope} SyncEnvelope */
/** @typedef {import('./transport.js').SyncTransport} SyncTransport */
/** @typedef {import('./client.js').SyncSchema} SyncSchema */
/** @typedef {import('./client.js').Cell} Cell */
/** @typedef {import('./client.js').ReplicaStatus} ReplicaStatus */
/** @typedef {import('./client.js').ReplicaMeta} ReplicaMeta */

/**
 * A change-envelope stream: the client's receipt source for one key (in Lyku, an
 * `api.stream*()` socket). `listen` registers a per-envelope callback; `close`
 * (if present) stops delivery. Envelopes are assumed already wire-decoded
 * (msgpackr/BON) — `synced` publishes them verbatim and the parse gate is the
 * trust boundary.
 *
 * @typedef {object} SyncStream
 * @property {(onEnvelope: (envelope: SyncEnvelope) => void) => void} listen
 * @property {() => void} [close]
 */

/**
 * Live-replicate one server-authoritative object into a reactive cell.
 *
 * @template [T=any]
 * @param {string} key                          synced key, e.g. "user:123"
 * @param {object} opts
 * @param {SyncSchema} opts.schema              the `parse` gate (every inbound
 *        value crosses a trust boundary). Required.
 * @param {() => SyncStream} [opts.stream]      factory for the receipt stream.
 *        Called once; its envelopes are published on `key`. Omit when an
 *        injected transport delivers receipts on its own.
 * @param {SyncTransport} [opts.transport]      transport override. Default: a
 *        private InProcessTransport fed by `stream` (the client model).
 * @param {SyncEnvelope} [opts.seed]            SSR-embedded initial envelope.
 * @param {() => Promise<SyncEnvelope>} [opts.refetch]  Err/skew/gap recovery.
 * @param {string} [opts.schemaVersion]         expected schema version
 *        ("major.minor"); a MAJOR-mismatched envelope is treated as breaking skew.
 * @param {Cell} [opts.cell]                    reactive cell override. Default: a
 *        para signal (the reconciler's own default) — tracked reads work in any
 *        para reactive context.
 * @returns {{
 *   readonly value: T,
 *   readonly status: ReplicaStatus,
 *   get(): T,
 *   peek(): T,
 *   meta(): ReplicaMeta,
 *   peekMeta(): ReplicaMeta,
 *   stats: { applied: number, ignoredStale: number, gaps: number, parseErrors: number, refetches: number, schemaSkews: number },
 *   whenIdle(): Promise<void>,
 *   dispose(): void,
 * }}
 */
export function synced(key, opts) {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("synced(key, opts): `key` must be a non-empty string");
  }
  if (opts == null || typeof opts.schema?.parse !== "function") {
    throw new Error(
      "synced(key, opts): `opts.schema` with a parse(value) method is required"
    );
  }

  const { schema, stream, transport, seed, refetch, schemaVersion, cell } = opts;

  // Own the value cell so the handle can expose `.subscribe` (the .pui `source`/
  // `synced` binding convention). Default: a para signal — the reconciler's own
  // default, hoisted here so we keep a reference. An injected cell (e.g. a host
  // SvelteMap-backed one) is used as-is; if it has no `.subscribe`, the handle's
  // is a no-op and the host store drives reactivity instead.
  const valueCell = cell ?? signal(undefined);

  // Client model: a private InProcessTransport fed by the WS stream. An injected
  // transport (tests, or a shared bus) takes over delivery; the caller then
  // typically omits `stream`.
  const tx = transport ?? new InProcessTransport();

  const replica = createClientReplica({
    key,
    schema,
    transport: tx,
    seed,
    refetch,
    schemaVersion,
    cell: valueCell,
  });

  // Bridge the receipt stream → transport. Open AFTER the replica subscribes so
  // no envelope is delivered to an unsubscribed key (InProcessTransport drops
  // publishes with no subscribers). The stream carries only future changes;
  // initial state is the seed's job.
  /** @type {SyncStream | undefined} */
  let sock;
  if (stream) {
    sock = stream();
    sock.listen((envelope) => tx.publish(key, envelope));
  }

  let disposed = false;

  return {
    /** current value (tracked read) — the rune's primary read surface */
    get value() {
      return replica.get();
    },
    /** reconcile status (tracked): 'ok' | 'stale' | 'skew' | 'refetching' */
    get status() {
      return replica.meta().status;
    },
    /** current value (tracked read), signal-style */
    get() {
      return replica.get();
    },
    /** current value (untracked) */
    peek() {
      return replica.peek();
    },
    /**
     * Subscribe to value changes: `onChange` fires with the current value now
     * and on every apply; returns an unsubscribe. Lets the handle satisfy the
     * `.pui` `source`/`synced` binding convention (a `.pui` `synced x = …`
     * lowers to a $state mirror driven by this). No-op when the injected cell
     * has no `.subscribe` (a host store drives reactivity in that case).
     * @param {(value: any) => void} onChange
     * @returns {() => void}
     */
    subscribe(onChange) {
      return typeof valueCell.subscribe === "function"
        ? valueCell.subscribe(onChange)
        : () => {};
    },
    /** full reconcile meta (tracked): { schemaVersion, sequence, status } */
    meta() {
      return replica.meta();
    },
    /** full reconcile meta (untracked) */
    peekMeta() {
      return replica.peekMeta();
    },
    /** observability counters — read directly */
    stats: replica.stats,
    /** resolves when no recovery refetch is in flight (test/await aid) */
    whenIdle() {
      return replica.whenIdle();
    },
    /** stop the stream + reconciler; idempotent */
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        sock?.close?.();
      } catch {
        /* already closed — teardown must not throw */
      }
      replica.dispose();
    },
  };
}
