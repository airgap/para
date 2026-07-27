# @lyku/para-kit

The **P9 fullstack projection** for Para sync — the build + runtime glue that
turns `.pui` sync declarations (spec ch. 08 §13.7–§13.8) into a running app:
escape-analyzed server artifacts, a host that runs them, and SyncEnvelopes
over SSE. SvelteKit-shaped; built on web standards, so host-agnostic in fact.

## The loop

```
.pui  ──para-kit emit──▶  *.server-sources.pts + para-sync-manifest.js
                              │
                              ▼
          createServerSourceHost(serverSources, { transport })
                              │  one createServerSource per LIVE subKey
                              ▼
          createSyncEndpoint({ transport, host })   ← routes/para-sync/+server.ts
                              │  SSE: baseline + every publish for the named keys
                              ▼
          createSseTransport({ url, eventSource: (u) => new EventSource(u) })
                              │  the para-sync dumb-pipe subscribe contract
                              ▼
          the .pui client binding — stock Tier-1 synced(subKey(declId, params), Schema)
```

## Setup

```sh
para-kit emit src            # writes artifacts + manifest (+ endpoint, once)
para-kit emit src --check    # CI drift gate
```

Wire the client transport once near app init:

```js
import { configureSynced } from "@lyku/para-sync";
import { createSseTransport } from "@lyku/para-kit";

configureSynced({
  transport: createSseTransport({ url: "/para-sync", eventSource: (u) => new EventSource(u) }),
});
```

SSR seeds: call `host.seedFor(declId, params)` in a `+page.server.ts` load and
pass the envelope as the binding's `seed`.

## Contracts worth knowing

- The generated endpoint route is written **once** and never regenerated —
  ejected by construction. Artifacts + manifest are regenerated boundary
  files: don't hand-edit, re-run `emit`.
- Client subscription keys equal host keys by construction: both sides derive
  `subKey(declId, params)` from the same `moduleId` — pass the same paths to
  `emit` that the preprocessor sees as `filename`.
- `SseTransport.publish` throws: the read path is one-directional; writes
  cross as POST intents (§13.1) via the endpoint's `onIntent`.
- Late joiners on an already-open key are replayed the last envelope —
  idempotent, since envelopes carry `(schema_version, sequence)`.
