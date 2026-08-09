// @lyku/para-sync: presence / ephemeral-state channels (§13.4).
//
// "Who is online," "who is typing," cursor positions, live viewer counts: state
// that is NOT authoritative, NOT persisted, NOT reconciled by sequence. The
// truth is "whoever is connected right now." So presence deliberately does NOT
// use the reconcile machine: no seed, no sequence, no refetch. It is:
//
//   - a reactive MAP of peerId → value (live members only),
//   - parse-gated per peer (a peer cannot publish a malformed state: the same
//     §3.3 trust boundary, shared transport contract §4),
//   - last-write-wins per peer,
//   - disconnect-GC'd: a peer's entry vanishes when it leaves.
//
// It is explicitly NOT a synced entity: there is no server authority to confirm
// against, so there is no `mutate` here. The local peer just publishes its own
// state and the map mirrors all live peers.

import { signal } from "@lyku/para-signals";

/** @typedef {import('./transport.js').SyncTransport} SyncTransport */
/** @typedef {import('./client.js').SyncSchema} SyncSchema */

/**
 * App-wide defaults so a lowered `presence NAME :: Schema in CHANNEL` call
 * (`presence(CHANNEL, Schema)`) can infer its ephemeral transport + local peer
 * id. Set ONCE near app init.
 * @type {{ transport?: SyncTransport, peerId?: string }}
 */
let presenceDefaults = {};

/**
 * Configure app-wide {@link presence} delivery (merged into prior config).
 * @param {{ transport?: SyncTransport, peerId?: string }} config
 */
export function configurePresence(config) {
  presenceDefaults = { ...presenceDefaults, ...config };
}

/**
 * A presence envelope on the channel. Either a peer's current state or its leave.
 * @typedef {{ peerId: string, value?: any, leave?: boolean }} PresenceEnvelope
 */

/**
 * Join an ephemeral presence room.
 *
 * @template [T=any]
 * @param {string} channel   the room key, e.g. `doc:${id}`.
 * @param {SyncSchema} schema  the per-peer parse gate.
 * @param {object} opts
 * @param {SyncTransport} opts.transport  the ephemeral channel (same SyncTransport
 *        shape; carries {@link PresenceEnvelope}s: no seed/sequence/refetch).
 * @param {string} [opts.peerId]  the local peer id. Required to publish (`set`)
 *        or leave; omit for a read-only observer.
 */
export function presence(channel, schema, opts = {}) {
  // Delivery: explicit opts win; else the app-wide config (a lowered
  // `presence(CHANNEL, Schema)` carries no transport/peerId).
  const transport = opts.transport ?? presenceDefaults.transport;
  const peerId = opts.peerId ?? presenceDefaults.peerId;
  if (typeof channel !== "string" || channel.length === 0) {
    throw new Error("presence(channel, …): `channel` must be a non-empty string");
  }
  if (!schema || typeof schema.parse !== "function") {
    throw new Error("presence: `schema` (the per-peer parse gate) is required");
  }
  if (!transport || typeof transport.subscribe !== "function" || typeof transport.publish !== "function") {
    throw new Error("presence: a `transport` is required (pass it, or set one via configurePresence)");
  }

  /** @type {Map<string, T>} peerId → live value */
  const members = new Map();
  const cell = signal(new Map());
  const stats = { updates: 0, leaves: 0, parseErrors: 0 };
  let disposed = false;

  // New Map reference on every change so the reactive read re-fires.
  const publishLocal = () => cell.set(new Map(members));

  const unsub = transport.subscribe(channel, (env) => {
    if (disposed || !env || env.peerId == null) return;
    // My own echoes are managed locally (set reflects self immediately, dispose
    // removes it), so ignore them. Otherwise a self-echoing transport double-fires.
    if (peerId != null && env.peerId === peerId) return;
    if (env.leave) {
      if (members.delete(env.peerId)) {
        stats.leaves++;
        publishLocal();
      }
      return;
    }
    // Parse gate: a peer cannot publish a malformed state (drop, don't poison).
    const res = schema.parse(env.value);
    if (res.tag !== "Ok") {
      stats.parseErrors++;
      return;
    }
    members.set(env.peerId, res.value); // last-write-wins per peer
    stats.updates++;
    publishLocal();
  });

  return {
    /** the live-members map (tracked read): peerId → value */
    get: () => cell.get(),
    /** the live-members map (untracked) */
    peek: () => cell.peek(),
    /**
     * Subscribe to membership changes: fires now and on every join/leave/update.
     * @param {(members: Map<string, T>) => void} onChange
     */
    subscribe: (onChange) => cell.subscribe(onChange),
    /** observability: updates / leaves / parseErrors seen */
    stats,
    /**
     * Publish MY ephemeral state (last-write-wins for this peer). Requires a
     * `peerId`. The value is parse-gated locally too. You cannot broadcast a
     * state your peers would reject.
     * @param {T} value
     */
    set(value) {
      if (disposed) return;
      if (peerId == null) throw new Error("presence.set: a `peerId` is required to publish");
      const res = schema.parse(value);
      if (res.tag !== "Ok") throw new Error("presence.set: value failed the schema parse gate");
      members.set(peerId, res.value); // reflect self immediately (self-echo is idempotent)
      publishLocal();
      transport.publish(channel, { peerId, value });
    },
    /** leave the room: broadcast a leave so my entry GCs for every peer; idempotent. */
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        if (peerId != null) transport.publish(channel, { peerId, leave: true });
      } catch {
        /* transport already down: best-effort leave */
      }
      unsub();
    },
  };
}
