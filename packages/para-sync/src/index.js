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

export * from "./transport.js";
export * from "./client.js";
export * from "./synced.js";
export * from "./writer.js";
export * from "./visibility.js";
