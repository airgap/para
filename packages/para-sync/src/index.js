// @lyku/para-sync — distributed object sync for the para:* suite.
//
// Public barrel. The package is split by concern:
//   - transport.js — the pluggable SyncTransport interface + InProcessTransport
//     (server-internal: carry a change envelope from writer to listeners).
//   - client.js    — createClientReplica: the client-side reconciler
//     (receive → parse → version-check → apply into a reactive cell).
//
// `synced<T>(key)` (the full primitive) composes the client reconciler with the
// server resolver + SSR plumbing; it lands on top of these pieces.

export * from "./transport.js";
export * from "./client.js";
