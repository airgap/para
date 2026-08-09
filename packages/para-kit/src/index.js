// @lyku/para-kit: the P9 fullstack projection for Para sync.
//
//   - emit.js: emitServerArtifacts / artifactPathFor / endpointTemplate:
//     the pure emitter (artifacts + manifest + the write-once endpoint).
//   - host.js: createServerSourceHost / parseSubKey: one createServerSource
//     per live subKey; SSR seeds via seedFor.
//   - sse.js: createSyncEndpoint (SvelteKit-shaped GET/POST on web
//     standards), createSseTransport (the client read-side dumb pipe),
//     formatSyncEvent / createSseParser.
//   - cli.js: `para-kit emit` (fs shell + --check drift gate).

export * from "./emit.js";
export * from "./host.js";
export * from "./sse.js";
