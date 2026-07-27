// @lyku/para-sync — distributed object sync for the para:* suite.
//
// Public barrel. The package is split by concern:
//   - transport.js — the pluggable SyncTransport interface + InProcessTransport
//     (server-internal: carry a change envelope from writer to listeners).
//   - client.js    — createClientReplica: the client-side reconciler
//     (receive → parse → version-check → apply into a reactive cell).
//   - synced.js    — synced<T>(key): the client-facing reactive primitive that
//     composes the reconciler with a default in-process transport, a change-
//     stream bridge, and one bundled teardown.
//   - writer.js    — createIntent: the Tier-2 optimistic write machine (§13.1)
//     — optimistic apply → op-id correlation → confirm/reject → echo dedupe /
//     stale-suppression → rollback, sharing the reconciler's intent counter.
//   - queue.js     — createQueuedIntent: offline queued mutations (§13.5) — a
//     durable log over writer.js + deterministic reconnect replay.
//   - durable.js   — storage adapters: MutationStore (log) + SnapshotStore
//     (read-side durability) in memory + localStorage flavors.
//   - feeds.js     — syncedQuery: typed collections (§13.3) — a createClientReplica
//     per row, composed by a membership channel into a reactive array; syncedOne:
//     the §13.7 scalar (limit-1) degeneration with the ready gate.
//   - query-authority.js — createQueryAuthority: the server-side query host
//     (§13.7 liveness) — read-set registration, wrote()/invalidate()
//     re-evaluation, per-row sequences, outbound parse gate, membership diffs.
//   - presence.js  — presence: ephemeral peer state (§13.4) — a parse-gated,
//     LWW-per-peer, disconnect-GC'd map; no sequence, no reconcile machine.
//   - authority.js — per-field authority (§13.2): @server/@lww/@merge, projected
//     onto the write gate (writer.js) + the reconciler's Class-B merge (client.js).
//   - transaction.js — createTransaction: atomic multi-key intents (§13.6).

export * from "./transport.js";
export * from "./client.js";
export * from "./synced.js";
export * from "./writer.js";
export * from "./queue.js";
export * from "./durable.js";
export * from "./feeds.js";
export * from "./query-authority.js";
export * from "./presence.js";
export * from "./authority.js";
export * from "./transaction.js";
export * from "./visibility.js";
