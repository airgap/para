// @lyku/para-sync: offline / queued mutations with deterministic replay (§13.5).
//
// A queued mutation IS a §13.1 optimistic mutation with a DURABLE log: every
// apply is persisted (op-id, intent version v, key, input) before it is
// confirmed, and removed on confirm/reject. When the client reconnects, the log
// is replayed DETERMINISTICALLY against the current server baseline:
//
//   1. the reconciler has (re)established the confirmed baseline (seed / reconnect
//      refetch), its last commit;
//   2. clear the stale in-memory pending (it was against the old baseline);
//   3. fold each durable optimistic arm onto the fresh baseline, in op-id order,
//      re-sent under its ORIGINAL op-id (server-idempotent) with a FRESH v.
//
// Determinism comes from the op-id ordering + pure optimistic arms. This makes
// offline a first-class case, not an `any`-shaped reconnection hack: intent is
// never silently dropped and never blindly re-sent against moved state.

import { createIntent } from "./writer.js";

/** @typedef {import('./durable.js').MutationStore} MutationStore */

/**
 * Create a durable, replayable optimistic-write handle.
 *
 * Same surface as {@link createIntent} (apply/confirm/reject/onEcho/stats/…) plus
 * `replay()` and a durable `store`. `key` scopes the persisted records to this
 * entity so a page can restore + replay them across sessions.
 *
 * @param {object} opts
 * @param {import('./writer.js').ReplicaWriteSeam} opts.replica  a createClientReplica handle.
 * @param {string} opts.key                                the synced key, e.g. "cart:42".
 * @param {MutationStore} opts.store                       the durable log.
 * @param {(input: any, current: any) => any} opts.optimistic  the policy delta (pure; re-run on replay).
 * @param {(baseline: any, current: any) => any} [opts.rollback]  revert on reject.
 * @param {(intent: { opId: string, v: number, value: any }) => void} [opts.send]  publish the intent.
 * @param {() => string} [opts.nextOpId]                   op-id source.
 */
export function createQueuedIntent({ replica, key, store, optimistic, rollback, send, nextOpId }) {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("createQueuedIntent: `key` must be a non-empty string");
  }
  if (!store || typeof store.list !== "function" || typeof store.append !== "function" || typeof store.remove !== "function") {
    throw new Error("createQueuedIntent: `store` must be a MutationStore (list/append/remove/clear)");
  }

  const intent = createIntent({ replica, optimistic, rollback, send, nextOpId });

  // Serialize durable writes so `flushed()` observes a settled log; failures are
  // swallowed at the chain (durability is best-effort, surfaced via the store).
  let flush = Promise.resolve();
  const track = (p) => {
    flush = flush.then(() => p).catch(() => {});
    return p;
  };

  function apply(input) {
    const res = intent.apply(input); // sync optimistic flip + send
    track(store.append({ opId: res.opId, v: res.v, key, input }));
    return res;
  }

  function confirm(opId) {
    const ok = intent.confirm(opId);
    if (ok) track(store.remove(opId));
    return ok;
  }

  function reject(opId) {
    const ok = intent.reject(opId);
    if (ok) track(store.remove(opId));
    return ok;
  }

  function onEcho(echo) {
    const r = intent.onEcho(echo);
    // A resolved own-echo (dedupe or suppress) is durably done. Drop its record.
    if ((r === "dedupe" || r === "suppress") && echo && echo.opId != null) {
      track(store.remove(echo.opId));
    }
    return r;
  }

  /**
   * Reconnect replay (§13.5). Call AFTER the reconciler has (re)established the
   * confirmed baseline (its seed / reconnect refetch commit): folds the durable
   * pending log onto that baseline in op-id order, each re-sent under its
   * original op-id with a fresh `v`. Idempotent given a stable baseline; the
   * server dedupes re-sends by op-id.
   * @returns {Promise<Array<{ opId: string, v: number, value: any }>>} the re-sent intents
   */
  async function replay() {
    const records = await store.list();
    if (records.length === 0) return [];
    intent.clearPending(); // the fresh baseline is in the cell; drop stale pending
    const resent = [];
    for (const rec of records) {
      const res = intent.apply(rec.input, { opId: rec.opId }); // fold onto the evolving baseline, reuse op-id, fresh v
      await store.append({ opId: rec.opId, v: res.v, key, input: rec.input }); // upsert the new v
      resent.push(res);
    }
    return resent;
  }

  return {
    apply,
    confirm,
    reject,
    onEcho,
    replay,
    stats: intent.stats,
    get status() {
      return intent.status;
    },
    peekStatus: () => intent.peekStatus(),
    pendingCount: () => intent.pendingCount(),
    pendingOpIds: () => intent.pendingOpIds(),
    /** resolves when queued durable writes have settled (test / robustness aid) */
    flushed: () => flush,
    /** the durable store (inspection / cross-session restore) */
    store,
  };
}
