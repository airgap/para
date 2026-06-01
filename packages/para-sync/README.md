# @lyku/para-sync

`synced<T>` distributed object sync for the para:\* suite — server-authoritative
records with live, version-reconciled client replicas over the existing
single-WS-per-browser objectfeed.

> **Pre-release (0.0.1-pre).** API will change before 0.1.0. This package
> currently ships the **transport layer** (`InProcessTransport` +
> `NatsTransport`) and the **client-side reconciler**. The full `synced<T>`
> primitive (server resolver + SSR plumbing) and the server-write `::` gate land
> on top — those touch Postgres/Valkey and the schema-version layer, so they
> live closer to the app.

## What's here today: the transport layer

`synced<T>` must not couple to any one message bus. It depends only on the
`SyncTransport` interface; the concrete transport is chosen by deployment config.

```js
import { InProcessTransport } from "@lyku/para-sync";

const transport = new InProcessTransport();

// listen handler (e.g. a WS-stream handler) subscribes for a key
const off = transport.subscribe("user:123", (envelope) => {
  // envelope = { value, schema_version, sequence }
  // parse-gate + version-check + apply happen in the consumer, not here
});

// write handler publishes the change envelope after persisting
transport.publish("user:123", { value: updatedUser, schema_version: "3.1", sequence: 42 });

off(); // idempotent unsubscribe
```

### `SyncTransport` contract

| member | behavior |
| --- | --- |
| `publish(key, envelope)` | delivers `envelope` to every current subscriber of `key`, in subscription order; no-op if none |
| `subscribe(key, handler)` | registers `handler`; returns an idempotent `Unsub` |

The transport is a **dumb pipe**: it does not retain the latest value, does not
validate the envelope (`parse` gating is the consumer's job at the apply
boundary), and does not dedupe by sequence. A subscriber receives only publishes
that happen **after** it subscribes — initial state arrives via the SSR seed.

### Implementations

- **`InProcessTransport`** (here) — monolith / edge / IoT / all-in-one, where the
  write handler and listen handlers share a process and there is no inter-service
  bus. A keyed `Map<key, Set<handler>>` emitter; delivery is a synchronous call.
  Empty key entries are GC'd when their last subscriber leaves (`keyCount()` is a
  leak-check diagnostic).
- **`NatsTransport`** — multi-service deployments; the change crosses services
  over NATS, matching Lyku's existing full-object-over-NATS convention. Inject a
  `connection` (callback-adapted: `publish(subject, bytes)` /
  `subscribe(subject, onMessage) → unsub`), a wire `codec` (BON/msgpackr in
  production — bigint IDs rule out JSON), and an optional `subjectOf(key)`.
  N local subscribers to one key share a single bus subscription (local fanout),
  torn down when the last leaves.

The **client side is identical** across transports: WS receive → `parse` →
version-check → apply. Only the server-internal delivery path differs.

## Client reconciler

`createClientReplica` is the client half of `synced<T>`: it takes the SSR seed
and the stream of envelopes, gates every inbound value through the schema
`parse`, reconciles by `(schema_version, sequence)`, and applies the
authoritative value into a reactive cell so the DOM reacts.

```js
import { createClientReplica, InProcessTransport } from "@lyku/para-sync";

const replica = createClientReplica({
  key: "user:123",
  schema: User,                 // anything with parse(v) => {tag:'Ok',value} | {tag:'Err',error}
  transport,                    // a SyncTransport
  seed: ssrEnvelope,            // {value, schema_version, sequence} embedded in the HTML
  refetch: () => fetchSnapshot("user:123") // Err/skew/gap fallback → current snapshot
});

replica.get();   // current value, tracked (read inside an effect/template → reacts)
replica.meta();  // { schemaVersion, sequence, status }, tracked
replica.dispose();
```

Reconcile rules (Tier 1):

- **parse gate** on every inbound value (SSR seed, receipt, refetch). `Err` →
  status `skew`, the cell is **not** poisoned, and a `refetch` recovers a
  known-good snapshot. Gates branch on `.tag` — they never throw (that is why
  `::`, which throws on `Err`, is reserved for the server-write gate only).
- **baseline (re)seed** — hydration, a recovery refetch, or the first value ever
  seen is accepted unconditionally as the authoritative base.
- **steady-state receipt** — apply iff `sequence === current + 1`; `<= current`
  is ignored (stale/duplicate/out-of-order); `> current + 1` is a gap → refetch
  + resync.

`replica.stats` exposes counters (`applied`, `ignoredStale`, `gaps`,
`parseErrors`, `refetches`); `replica.whenIdle()` resolves when no recovery
refetch is in flight (a test/await aid).

## `synced` — the reactive primitive

`createClientReplica` is the engine; `synced` is the ergonomic front. It composes
the reconciler with a **default in-process transport**, a **change-stream
bridge**, and **one bundled teardown**, so an adopter writes a single call
instead of standing up a transport, pumping the stream into it, and threading two
disposers.

```js
import { synced } from "@lyku/para-sync";

const user = synced("user:123", {
  schema: User,                       // parse(v) => {tag:'Ok',value} | {tag:'Err',error}
  schemaVersion: "1.0",               // optional: MAJOR mismatch ⇒ breaking skew
  stream: () => api.streamCurrentUser(), // { listen(cb), close?() } — the receipt source
  seed: ssrEnvelope,                  // optional SSR baseline
  refetch: () => fetchSnapshot("user:123") // optional Err/skew/gap recovery
});

user.value;   // current value, TRACKED — read it in a .pui template / derived / effect and it reacts
user.status;  // 'ok' | 'stale' | 'skew' | 'refetching', tracked
user.dispose(); // closes the stream + disposes the replica (idempotent)
```

The default cell is a para signal, so `user.value` is a tracked read in any para
reactive context (no manual effect). Inject `cell` to back the value with a
different reactive store (e.g. a Svelte-fork cell, or a host `SvelteMap`); inject
`transport` (and omit `stream`) when delivery is owned elsewhere. `synced` is
read-only — Tier 1 replication; writes are the server-write gate's job.

## Test

```
bun test        # from packages/para-sync
```
