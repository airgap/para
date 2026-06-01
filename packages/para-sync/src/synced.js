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
 * App-wide defaults so call sites can shrink to `synced(key, schema)` — the
 * delivery for a key is inferred from here instead of repeated at every call.
 * Set ONCE near app init. Two deployment shapes (use whichever fits; not both):
 *
 *   - transport — a shared keyed transport (the "single objectfeed WS" model):
 *     its subscribe(key) IS the per-key stream, so no per-call stream is needed.
 *     This is the intended end-state.
 *   - resolveStream — for today's per-object endpoints: a (key) => SyncStream
 *     map (e.g. key === 'currentUser' ? api.streamCurrentUser() : …). Each
 *     replica then gets a private InProcessTransport fed by the resolved stream.
 *
 * @type {{ transport?: SyncTransport, resolveStream?: (key: string) => SyncStream }}
 */
let syncDefaults = {};

/**
 * No-validation gate for the type-only `sync x: T from key` form: accept every
 * inbound value verbatim. Used when no schema is supplied — see the schema note
 * in {@link synced}.
 * @type {import('./client.js').SyncSchema}
 */
const PASSTHROUGH_SCHEMA = { parse: (value) => ({ tag: "Ok", value }) };

/**
 * Configure app-wide `synced` defaults (merged into prior config). Call once at
 * client init so components can write `synced(key, schema)` with delivery
 * inferred. Passing `{}` is a no-op; pass explicit `undefined` fields to clear.
 *
 * @param {{ transport?: SyncTransport, resolveStream?: (key: string) => SyncStream }} config
 */
export function configureSynced(config) {
  syncDefaults = { ...syncDefaults, ...config };
}

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
 * Two call forms:
 *   - `synced(key, schema, opts?)` — schema positional (the ergonomic form);
 *     with delivery configured via {@link configureSynced}, `synced(key, schema)`
 *     is all you write.
 *   - `synced(key, opts)` — schema inside `opts` (the explicit form).
 *
 * @template [T=any]
 * @param {string} key                          synced key, e.g. "user:123"
 * @param {SyncSchema | SyncedOptions} schemaOrOpts  the `parse` gate (positional)
 *        OR the full options object (when it has no `parse`).
 * @param {SyncedOptions} [maybeOpts]           extra options when schema is
 *        passed positionally.
 *
 * @typedef {object} SyncedOptions
 * @property {SyncSchema} [schema]              the parse gate (if not positional)
 * @property {() => SyncStream} [stream]        receipt-stream factory; overrides
 *        the configured `resolveStream`.
 * @property {SyncTransport} [transport]        transport override; else the
 *        configured default transport, else a private InProcessTransport.
 * @property {SyncEnvelope} [seed]              SSR-embedded initial envelope.
 * @property {() => Promise<SyncEnvelope>} [refetch]  Err/skew/gap recovery.
 * @property {string} [schemaVersion]          expected schema version.
 * @property {Cell} [cell]                      reactive cell override.
 *
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
export function synced(key, schemaOrOpts, maybeOpts) {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("synced(key, …): `key` must be a non-empty string");
  }

  // Disambiguate the two forms: a positional schema is anything with a
  // `parse` method; otherwise the 2nd arg is the options object.
  const positionalSchema =
    schemaOrOpts != null && typeof schemaOrOpts.parse === "function"
      ? schemaOrOpts
      : undefined;
  const opts = (positionalSchema ? maybeOpts : schemaOrOpts) ?? {};
  // Schema is OPTIONAL: absent ⇒ PASSTHROUGH (no runtime validation) — the
  // `sync x: T from key` type-only / trusted mode. synced replicates server-
  // authoritative data over an untrusted wire, so a real gate is the default
  // (the `sync x :: Schema from key` form); skipping it is the deliberate
  // opt-out. A schema that is PRESENT but malformed (no `parse`) is still a hard
  // error — that's a mistake, not an opt-out.
  const schema = positionalSchema ?? opts.schema ?? PASSTHROUGH_SCHEMA;
  if (typeof schema.parse !== "function") {
    throw new Error("synced: the provided `schema` has no parse(value) method");
  }

  const { stream, transport, seed, refetch, schemaVersion, cell } = opts;

  // Own the value cell so the handle can expose `.subscribe` (the .pui `source`/
  // `synced` binding convention). Default: a para signal — the reconciler's own
  // default, hoisted here so we keep a reference. An injected cell (e.g. a host
  // SvelteMap-backed one) is used as-is; if it has no `.subscribe`, the handle's
  // is a no-op and the host store drives reactivity instead.
  const valueCell = cell ?? signal(undefined);

  // Resolve the transport: explicit override → configured shared transport (the
  // objectfeed) → a private InProcessTransport (the per-object/per-call model).
  const sharedTransport = transport ?? syncDefaults.transport;
  const tx = sharedTransport ?? new InProcessTransport();
  const ownsTransport = sharedTransport === undefined;

  // Resolve the receipt stream: an explicit `stream` always wins; otherwise,
  // when we own a private transport, fall back to the configured `resolveStream`
  // so `synced(key, schema)` infers its delivery. A shared transport delivers by
  // key on its own, so no stream bridge is wired for it.
  const streamFactory =
    stream ??
    (ownsTransport && syncDefaults.resolveStream
      ? () => syncDefaults.resolveStream(key)
      : undefined);

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
  if (streamFactory) {
    sock = streamFactory();
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
