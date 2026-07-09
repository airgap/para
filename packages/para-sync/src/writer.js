// @lyku/para-sync — Tier-2 optimistic write machine (§13.1 `mutate`).
//
// The write-side mirror of the Tier-1 read reconciler (client.js). The spine
// bakes the MECHANICAL state machine — optimistic apply → op-id correlation →
// server confirm/reject → stale-echo dedupe/suppression → rollback — while the
// `optimistic`/`rollback` arms stay hand-written typed deltas (INV-sync-12: one
// monotonic-last-intent-wins discipline shared with the read reconciler; the
// intent version comes from the replica's `nextIntent()`, the same counter).
//
// Transport- and reconciler-agnostic. `apply` flips the local cell + emits the
// intent via `send`; the app routes the server's answer into `confirm`/`reject`
// (by op-id) and every inbound echo through `onEcho`, which classifies it so the
// caller knows whether to let the read reconciler apply the authoritative value:
//   - 'dedupe'   our own write, now authoritative → clear pending; DO apply it
//   - 'suppress' our own STALE echo (a newer local intent exists) → drop it (the
//                Class-A flicker kill, §7.1)
//   - 'pass'     a foreign / newer change → let the reconciler apply it
//
// This is the mechanical core; §13.5 (offline queued mutations) builds a durable
// log on top of it, replaying `apply` in op-id order against the fresh baseline.

import { signal } from "@lyku/para-signals";

/**
 * Monotonic, client-local op-id generator. The op-id order is the deterministic
 * replay anchor (§13.5), so ids MUST be issued in a total order — a counter,
 * never randomness. Distinct instances (or a prefix) keep replicas from colliding.
 * @param {string} [prefix]
 * @returns {() => string}
 */
export function createOpIds(prefix = "op") {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/** @typedef {'idle' | 'pending'} WriterStatus */

/**
 * @typedef {object} ReplicaWriteSeam the Tier-2 seams of a createClientReplica handle
 * @property {() => any} peek                current value (untracked)
 * @property {(v: any) => void} applyLocal   optimistic local write (no server sequence)
 * @property {() => number} nextIntent       bump + return the per-entity intent version
 * @property {() => number} peekIntent       current intent version (untracked)
 */

/**
 * Create a Tier-2 optimistic write handle bound to a Tier-1 replica.
 *
 * @param {object} opts
 * @param {ReplicaWriteSeam} opts.replica  a createClientReplica handle.
 * @param {(input: any, current: any) => any} opts.optimistic  the policy delta:
 *        the local value to show before the server answers. SHOULD be pure — it
 *        is re-run on offline replay (§13.5).
 * @param {(baseline: any, current: any) => any} [opts.rollback]  how to revert on
 *        reject; default snapshot-restore (return the pre-run baseline).
 * @param {(intent: { opId: string, v: number, value: any }) => void} [opts.send]
 *        publish the intent envelope to the transport (omit to send it yourself).
 * @param {() => string} [opts.nextOpId]  op-id source (default: a private counter).
 */
export function createIntent({
  replica,
  optimistic,
  rollback = (baseline) => baseline,
  send,
  nextOpId = createOpIds(),
}) {
  if (
    !replica ||
    typeof replica.applyLocal !== "function" ||
    typeof replica.nextIntent !== "function" ||
    typeof replica.peekIntent !== "function" ||
    typeof replica.peek !== "function"
  ) {
    throw new Error(
      "createIntent: `replica` must be a createClientReplica handle (needs peek/applyLocal/nextIntent/peekIntent)"
    );
  }
  if (typeof optimistic !== "function") {
    throw new Error("createIntent: `optimistic(input, current)` is required");
  }

  /** @type {Map<string, { v: number }>} opId -> record; Map order = issue order */
  const pending = new Map();
  // The confirmed baseline to revert to when a pending run drains on reject.
  // Captured when pending goes 0 -> 1, so it's the last authoritative value the
  // optimistic writes started from — not an intermediate optimistic snapshot.
  let baseline;
  const status = signal(/** @type {WriterStatus} */ ("idle"));
  const stats = {
    applied: 0,
    confirmed: 0,
    rolledBack: 0,
    deduped: 0,
    suppressed: 0,
    foreign: 0,
  };

  const sync = () => status.set(pending.size ? "pending" : "idle");

  /**
   * Optimistically apply an intent: capture the baseline (at run start), flip the
   * local cell via the policy delta, tag it (opId, v), and emit the envelope.
   * @param {any} input the mutation input (typed against the entity schema in Para)
   * @returns {{ opId: string, v: number, value: any }}
   */
  function apply(input) {
    if (pending.size === 0) baseline = replica.peek();
    const opId = nextOpId();
    const v = replica.nextIntent();
    const value = optimistic(input, replica.peek());
    replica.applyLocal(value);
    pending.set(opId, { v });
    stats.applied++;
    sync();
    send?.({ opId, v, value });
    return { opId, v, value };
  }

  /**
   * Server accepted the intent → clear it. The authoritative value arrives via
   * the read reconciler's echo (this handle does not apply server values).
   * @param {string} opId
   * @returns {boolean} whether an intent was pending under this op-id
   */
  function confirm(opId) {
    if (!pending.delete(opId)) return false;
    stats.confirmed++;
    sync();
    return true;
  }

  /**
   * Server rejected the intent → revert. Once the pending run fully drains, the
   * cell is restored to the run's confirmed baseline (a newer still-pending
   * intent keeps its own optimistic value until it too resolves).
   * @param {string} opId
   * @returns {boolean} whether an intent was pending under this op-id
   */
  function reject(opId) {
    if (!pending.has(opId)) return false;
    pending.delete(opId);
    stats.rolledBack++;
    if (pending.size === 0) replica.applyLocal(rollback(baseline, replica.peek()));
    sync();
    return true;
  }

  /**
   * Classify an inbound server echo carrying (opId, v). Suppression is keyed on a
   * KNOWN op-id so a foreign writer's echo is never misread as our stale flip.
   * @param {{ opId?: string, v?: number }} echo
   * @returns {'dedupe' | 'suppress' | 'pass'}
   */
  function onEcho(echo) {
    const { opId, v } = echo ?? {};
    const known = opId != null && pending.has(opId);
    if (known) {
      pending.delete(opId);
      sync();
      // Our own echo, but a newer local intent has superseded it → drop, don't
      // apply (the Like/Unlike flicker kill). Otherwise it's the authoritative
      // form of our current intent → dedupe (clear pending; caller applies it).
      if (v != null && v < replica.peekIntent()) {
        stats.suppressed++;
        return "suppress";
      }
      stats.deduped++;
      return "dedupe";
    }
    // Not ours. A stale foreign echo is the read reconciler's problem (its
    // sequence gate), so we pass it through untouched.
    stats.foreign++;
    return "pass";
  }

  return {
    apply,
    confirm,
    reject,
    onEcho,
    stats,
    /** reconcile status (tracked): 'idle' | 'pending' */
    get status() {
      return status.get();
    },
    /** status (untracked) */
    peekStatus: () => status.peek(),
    /** number of in-flight (unconfirmed) intents */
    pendingCount: () => pending.size,
    /** op-ids of in-flight intents, in issue order (the §13.5 replay order) */
    pendingOpIds: () => [...pending.keys()],
  };
}
