// @lyku/para-sync — cross-entity transactional sync (§13.6).
//
// Some intents span MULTIPLE synced entities atomically: move an item from
// cart:A to cart:B, transfer a balance, reassign a task across boards. Applied as
// independent §13.1 intents they can tear (one confirms, one rejects → the item
// is in neither cart or both). An atomic multi-key intent makes the optimistic
// apply, the confirm/reject, and the rollback span all keys as ONE unit — a
// transaction across the trust boundary.
//
// The atomic boundary is §13.1's single op-id extended to a GROUP op-id; each
// key still reconciles by its own `sequence` (the transaction is the optimistic/
// confirm/rollback unit, not a new reconcile key). Partial per-key echoes are
// BUFFERED until the group resolves, so nothing applies torn. Explicit + visible,
// never ambient distributed-transaction magic (the §7.2 anti-Meteor boundary).

import { signal } from "@lyku/para-signals";
import { createOpIds } from "./writer.js";
import { guardOptimistic } from "./authority.js";

/**
 * @typedef {object} TxIntentSpec
 * @property {string} key                                 the synced key this arm touches.
 * @property {import('./writer.js').ReplicaWriteSeam} replica  the entity's replica.
 * @property {(input: any, current: any) => any} optimistic    the arm (pure; per §13.2 authority).
 * @property {any} [input]                                mutation input threaded to `optimistic`.
 * @property {(snapshot: any, current: any) => any} [rollback]  revert; default snapshot-restore.
 * @property {import('./authority.js').Authority} [authority]   per-field authority for this arm.
 */

/**
 * Apply an atomic group of optimistic mutations over distinct keys. All arms
 * apply immediately (all-or-nothing locally) under one group op-id; the caller
 * routes the server's group answer into `confirm`/`reject`, and every inbound
 * per-key echo through `onEcho` (buffered until the group resolves).
 *
 * @param {object} opts
 * @param {string} [opts.groupOpId]        the correlating group op-id (default: generated).
 * @param {TxIntentSpec[]} opts.intents    the arms — at least one, distinct keys.
 * @param {(grouped: { groupOpId: string, intents: Array<{ key: string, v: number, value: any }> }) => void} [opts.send]
 *        publish the grouped envelope (omit to send it yourself).
 * @param {() => string} [opts.nextOpId]   group op-id source when `groupOpId` is omitted.
 */
export function createTransaction({ groupOpId, intents, send, nextOpId = createOpIds("tx") }) {
  if (!Array.isArray(intents) || intents.length === 0) {
    throw new Error("createTransaction: `intents` must be a non-empty array");
  }
  for (const it of intents) {
    if (
      !it ||
      typeof it.key !== "string" ||
      !it.replica ||
      typeof it.replica.applyLocal !== "function" ||
      typeof it.replica.nextIntent !== "function" ||
      typeof it.optimistic !== "function"
    ) {
      throw new Error("createTransaction: each intent needs { key, replica (a replica handle), optimistic(input, current) }");
    }
  }

  const gid = groupOpId ?? nextOpId();

  // Apply ALL optimistic arms behind the one group op-id (all-or-nothing local).
  const applied = intents.map((it) => {
    const snapshot = it.replica.peek();
    const v = it.replica.nextIntent();
    const value = guardOptimistic(it.authority, snapshot, it.optimistic(it.input, snapshot));
    it.replica.applyLocal(value);
    return { key: it.key, replica: it.replica, snapshot, v, value, rollback: it.rollback ?? ((s) => s) };
  });

  const statusSig = signal(/** @type {'pending'|'confirmed'|'rejected'} */ ("pending"));
  const keySet = new Set(applied.map((a) => a.key));
  /** @type {Map<string, any>} per-key echoes held until the group resolves */
  const buffered = new Map();

  send?.({ groupOpId: gid, intents: applied.map((a) => ({ key: a.key, v: a.v, value: a.value })) });

  return {
    groupOpId: gid,
    keys: () => applied.map((a) => a.key),
    /** group status (tracked): 'pending' | 'confirmed' | 'rejected' */
    get status() {
      return statusSig.get();
    },
    peekStatus: () => statusSig.peek(),
    /**
     * Group confirm → clear pending and hand back the buffered per-key echoes
     * (held to avoid a torn mid-transaction apply) so the caller can now let the
     * reconciler apply them.
     * @returns {Array<{ key: string, echo: any }>}
     */
    confirm() {
      if (statusSig.peek() !== "pending") return [];
      statusSig.set("confirmed");
      const flush = [...buffered.entries()].map(([key, echo]) => ({ key, echo }));
      buffered.clear();
      return flush;
    },
    /**
     * Group reject → roll back ALL optimistic arms to their snapshots (atomic
     * revert) and drop the buffered echoes.
     * @returns {boolean} whether the group was pending
     */
    reject() {
      if (statusSig.peek() !== "pending") return false;
      statusSig.set("rejected");
      for (const a of applied) a.replica.applyLocal(a.rollback(a.snapshot, a.replica.peek()));
      buffered.clear();
      return true;
    },
    /**
     * Gate a per-key echo. While the group is pending, an echo for one of the
     * transaction's keys is BUFFERED ('buffer') so a partial apply can't tear the
     * group; after it resolves the echo is 'pass' (apply normally).
     * @param {string} key
     * @param {any} echo
     * @returns {'buffer' | 'pass'}
     */
    onEcho(key, echo) {
      if (statusSig.peek() === "pending" && keySet.has(key)) {
        buffered.set(key, echo);
        return "buffer";
      }
      return "pass";
    },
  };
}
