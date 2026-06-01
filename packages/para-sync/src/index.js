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

export * from "./transport.js";
export * from "./client.js";
export * from "./synced.js";
export * from "./visibility.js";
