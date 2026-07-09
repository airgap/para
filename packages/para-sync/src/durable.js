// @lyku/para-sync — durable storage adapters for the offline layer.
//
// Two shapes, both pluggable so the browser can back them with IndexedDB /
// localStorage while tests + SSR use in-memory:
//
//   MutationStore  — an op-id-keyed durable LOG of unconfirmed optimistic
//                    mutations (§13.5). list/append(upsert)/remove/clear.
//   SnapshotStore  — a single durable ENVELOPE per synced key (read-side
//                    durability): { load(): SyncEnvelope|undefined, save(env) }.
//
// The mutation `input` and the snapshot `value` must be serializable for the
// persistent adapters (they cross the wire anyway). Async APIs on the log so an
// IndexedDB adapter fits without changing callers.

/** @typedef {import('./transport.js').SyncEnvelope} SyncEnvelope */
/** @typedef {{ opId: string, v: number, key: string, input: any }} MutationRecord */

/**
 * @typedef {object} MutationStore
 * @property {() => Promise<MutationRecord[]>} list   insertion (op-id issue) order
 * @property {(r: MutationRecord) => Promise<void>} append  upsert by r.opId
 * @property {(opId: string) => Promise<void>} remove
 * @property {() => Promise<void>} clear
 */

/**
 * In-memory mutation log — tests, SSR, and the default when no durable backend
 * is configured (offline replay still works within a session; it just doesn't
 * survive a reload).
 * @returns {MutationStore}
 */
export function createMemoryStore() {
  const map = new Map(); // opId -> record (Map preserves insertion order)
  return {
    async list() {
      return [...map.values()];
    },
    async append(record) {
      // Map.set updates an existing key IN PLACE (preserves insertion order), so
      // a replayed record keeps its op-id-issue position while taking the new v.
      map.set(record.opId, record);
    },
    async remove(opId) {
      map.delete(opId);
    },
    async clear() {
      map.clear();
    },
  };
}

/**
 * localStorage-backed mutation log. Good for a bounded pending queue; for large
 * logs prefer an IndexedDB adapter (same interface).
 * @param {string} namespace  scope key (e.g. the workspace/tenant)
 * @param {Storage} [storage] injectable (SSR/tests); defaults to window.localStorage
 * @returns {MutationStore}
 */
export function createLocalStorageStore(namespace, storage) {
  const ls = storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
  if (!ls) {
    throw new Error("createLocalStorageStore: no localStorage available (pass a storage impl for SSR/tests)");
  }
  const KEY = `para-sync:mut:${namespace}`;
  const read = () => {
    try {
      const arr = JSON.parse(ls.getItem(KEY) ?? "[]");
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  };
  const write = (arr) => ls.setItem(KEY, JSON.stringify(arr));
  return {
    async list() {
      return read();
    },
    async append(record) {
      const arr = read();
      const i = arr.findIndex((r) => r.opId === record.opId);
      if (i >= 0) arr[i] = record; // upsert in place (preserve op-id-issue order)
      else arr.push(record);
      write(arr);
    },
    async remove(opId) {
      write(read().filter((r) => r.opId !== opId));
    },
    async clear() {
      ls.removeItem(KEY);
    },
  };
}

/**
 * @typedef {object} SnapshotStore
 * @property {() => (SyncEnvelope | undefined)} load
 * @property {(env: SyncEnvelope) => void} save
 */

/**
 * In-memory snapshot store (tests / SSR no-op durability).
 * @returns {SnapshotStore}
 */
export function createMemorySnapshot() {
  let env;
  return {
    load: () => env,
    save: (e) => {
      env = e;
    },
  };
}

/**
 * localStorage-backed snapshot for one synced key — pass as `persist` to
 * createClientReplica / synced so a cold start seeds from the last confirmed
 * value before any network.
 * @param {string} key       the synced key, e.g. "channel:42"
 * @param {Storage} [storage] injectable (SSR/tests); defaults to window.localStorage
 * @returns {SnapshotStore}
 */
export function localStorageSnapshot(key, storage) {
  const ls = storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
  if (!ls) {
    throw new Error("localStorageSnapshot: no localStorage available (pass a storage impl for SSR/tests)");
  }
  const K = `para-sync:snap:${key}`;
  return {
    load: () => {
      try {
        const raw = ls.getItem(K);
        return raw ? JSON.parse(raw) : undefined;
      } catch {
        return undefined;
      }
    },
    save: (env) => {
      try {
        ls.setItem(K, JSON.stringify(env));
      } catch {
        /* quota / serialization failure — durability is best-effort */
      }
    },
  };
}
