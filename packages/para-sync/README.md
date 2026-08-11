# @lyku/para-sync

`synced<T>` distributed object sync for the para:\* suite: server-authoritative
records with live, version-reconciled client replicas over the existing
single-WS-per-browser objectfeed.

> **Pre-release (0.0.1-pre).** API will change before 0.1.0. The client runtime
> for the whole authority model (spec/08) now ships here:
>
> - **Tier 1: read/reconcile:** `SyncTransport` (`InProcessTransport` /
>   `NatsTransport`), `createClientReplica`, `synced`, `visibility`.
> - **Tier 2: writes (§13.1):** `createIntent` (optimistic apply → op-id
>   correlation → confirm/reject/rollback → echo dedupe/stale-suppression).
> - **Offline (§13.5):** `createQueuedIntent` + durable stores (`durable.js`) and
>   read-side durability (the reconciler `persist` seam).
> - **Collections (§13.3):** `syncedQuery`. **Presence (§13.4):** `presence`.
> - **Per-field authority (§13.2):** `defineAuthority` (@server/@lww/@merge),
>   projected onto the write gate + the reconciler's Class-B merge.
> - **Transactions (§13.6):** `createTransaction` (atomic multi-key intents).
>
> Still app-side (they touch Postgres/Valkey + the schema-version layer): the
> server resolver, SSR seed plumbing, and the server-write `::` gate. The
> ergonomic `.pui` keywords (`sync` / `mutate` / `sync feed` / `presence`) lower
> to this API in `para-preprocess`.

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
that happen **after** it subscribes: initial state arrives via the SSR seed.

### Implementations

- **`InProcessTransport`** (here): monolith / edge / IoT / all-in-one, where the
  write handler and listen handlers share a process and there is no inter-service
  bus. A keyed `Map<key, Set<handler>>` emitter; delivery is a synchronous call.
  Empty key entries are GC'd when their last subscriber leaves (`keyCount()` is a
  leak-check diagnostic).
- **`NatsTransport`**: multi-service deployments; the change crosses services
  over NATS, matching Lyku's existing full-object-over-NATS convention. Inject a
  `connection` (callback-adapted: `publish(subject, bytes)` /
  `subscribe(subject, onMessage) → unsub`), a wire `codec` (BON/msgpackr in
  production: bigint IDs rule out JSON), and an optional `subjectOf(key)`.
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
  known-good snapshot. Gates branch on `.tag`: they never throw (that is why
  `::`, which throws on `Err`, is reserved for the server-write gate only).
- **baseline (re)seed**: hydration, a recovery refetch, or the first value ever
  seen is accepted unconditionally as the authoritative base.
- **steady-state receipt**: apply iff `sequence === current + 1`; `<= current`
  is ignored (stale/duplicate/out-of-order); `> current + 1` is a gap → refetch
  + resync.

`replica.stats` exposes counters (`applied`, `ignoredStale`, `gaps`,
`parseErrors`, `refetches`); `replica.whenIdle()` resolves when no recovery
refetch is in flight (a test/await aid).

## `synced`: the reactive primitive

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
  stream: () => api.streamCurrentUser(), // { listen(cb), close?() }: the receipt source
  seed: ssrEnvelope,                  // optional SSR baseline
  refetch: () => fetchSnapshot("user:123") // optional Err/skew/gap recovery
});

user.value;   // current value, TRACKED: read it in a .pui template / derived / effect and it reacts
user.status;  // 'ok' | 'stale' | 'skew' | 'refetching', tracked
user.dispose(); // closes the stream + disposes the replica (idempotent)
```

The default cell is a para signal, so `user.value` is a tracked read in any para
reactive context (no manual effect). Inject `cell` to back the value with a
different reactive store (e.g. a Svelte-fork cell, or a host `SvelteMap`); inject
`transport` (and omit `stream`) when delivery is owned elsewhere. `synced` is
read-only: Tier 1 replication; writes are the server-write gate's job.

### Inferred delivery: `synced(key, schema)`

Configure delivery **once** at client init and call sites shrink to a key + a
schema: no per-call `stream`/`transport`:

```js
import { configureSynced, synced } from "@lyku/para-sync";

// once, at app init: choose ONE:
configureSynced({ transport: objectfeed });                 // shared keyed WS (the end-state)
configureSynced({ resolveStream: (key) => api.streamFor(key) }); // per-object endpoints (today)

// anywhere: schema is positional; delivery is inferred from the key:
const user = synced("user:123", User);
const user = synced("user:123", User, { cell, seed }); // + overrides
```

With a shared `transport`, its `subscribe(key)` *is* the per-key stream (the
single-objectfeed-WS model). With `resolveStream`, each replica gets a private
`InProcessTransport` fed by the resolved per-object stream. An explicit `stream`
or `transport` on the call always overrides the configured default.

In a `.pui`, the `synced` keyword wraps the call for you, so the minimal form is:

```svelte
synced user = `user:${userId}`, User;
```

## Recipe: `synced` over your own socket (the stream bridge)

para-sync deliberately ships **no WebSocket transport**: the `stream` option
*is* the extension point, and it is how production consumers run today (lyku's
current-user sync rides its own Metasock this way; para-kit's `SseTransport`
is just this contract over an EventSource). If your app already owns a
socket, don't wait for a transport package: bridge it:

```js
import { synced, configureSynced } from "@lyku/para-sync";

// One receipt stream per key over YOUR socket. The bridge's whole contract:
// { listen(cb), close?() } delivering {value, schema_version, sequence}
// envelopes. Ordering, dedupe, gap handling: the reconciler's job, not yours.
configureSynced({
  resolveStream: (key) => {
    const un = mySocket.subscribe(key, /* cb set by listen */);
    let cb;
    mySocket.on(key, (envelope) => cb?.(envelope));
    return {
      listen: (fn) => { cb = fn; },
      close: () => un(),
    };
  },
});

const game = synced("game:42", { schema: GameView });
```

Writes go out however your socket sends them (or as HTTP intents); the read
path stays one-directional. Gaps self-heal: a full-object envelope arriving
after a disconnect commits directly (no refetch round-trip needed), so a
reconnecting socket only has to deliver the *current* envelope per key.

## Tier 2: optimistic writes (`createIntent`, §13.1)

The write-side mirror of the reconciler: the mechanical state machine is baked;
the `optimistic` / `rollback` arms are your typed deltas. Monotonic
last-intent-wins with op-id correlation (INV-sync-12), the intent version shared
with the reconciler.

```js
import { createIntent } from "@lyku/para-sync";

const like = createIntent({
  replica: post, // a createClientReplica handle
  optimistic: (_, cur) => ({ ...cur, liked: !cur.liked }), // your delta (pure)
  send: (env) => transport.publish(`post:${id}`, env), // publish the intent
});

const { opId, v } = like.apply(); // instant local flip + emit
like.confirm(opId); // server accepted → clear pending
like.reject(opId); // server rejected → rollback to the run baseline
like.onEcho({ opId, v }); // 'dedupe' (own, apply) | 'suppress' (stale, drop) | 'pass' (foreign)
```

`onEcho` is the Class-A flicker kill: an own echo whose intent version is behind
a newer local flip is suppressed, so Like→Unlike never flickers back.

## Offline: queued mutations + read durability (§13.5)

`createQueuedIntent` is `createIntent` with a **durable log**: every `apply` is
persisted, and `replay()` re-folds the pending log onto the reconciler's fresh
baseline in op-id order (reusing each op-id, fresh `v`) on reconnect. The
reconciler's `persist` seam seeds from a local snapshot on cold start.

```js
import { createQueuedIntent, createClientReplica, localStorageSnapshot, createLocalStorageStore } from "@lyku/para-sync";

// read durability: cold start seeds from the last confirmed snapshot
const cart = createClientReplica({ key: "cart:1", schema: Cart, transport, persist: localStorageSnapshot("cart:1") });

const addItem = createQueuedIntent({
  replica: cart, key: "cart:1", store: createLocalStorageStore("ws1"), // durable
  optimistic: (item, cur) => ({ ...cur, items: [...cur.items, item] }),
  send: (env) => transport.publish("cart:1", env),
});
addItem.apply({ sku: "X" }); // works offline; persisted
// on reconnect, after the reconciler refetches its baseline:
await addItem.replay(); // re-fold + re-send the durable log deterministically
```

Stores are pluggable (`createMemoryStore` / `createLocalStorageStore` for the
log; `createMemorySnapshot` / `localStorageSnapshot` for read durability);
IndexedDB adapters slot in behind the same interfaces.

## Collections (`syncedQuery`, §13.3)

A server-projected collection as a reactive array. Each row is a
`createClientReplica` keyed by its row key (reconcile scales by composition);
membership (insert/remove/reorder) is a channel distinct from per-row value
deltas, so a reorder never re-parses a row.

```js
import { syncedQuery } from "@lyku/para-sync";

const feed = syncedQuery(Post, {
  transport, // per-row value deltas, keyed by row key
  membership, // { listen(cb), close?() }: ordered keys (+ optional seeds)
  seed: { keys: ["post:1"], seeds: { "post:1": env1 } },
});
feed.get(); // reactive Post[]
feed.row("post:1"); // the row replica (target a per-row §13.5 mutation)
```

## Presence (`presence`, §13.4)

Ephemeral peer state: a parse-gated, last-write-wins-per-peer, disconnect-GC'd
reactive map. Deliberately **not** a synced entity: no seed, no sequence, no
reconcile machine (nothing to `mutate`/confirm against).

```js
import { presence } from "@lyku/para-sync";

const cursors = presence(`doc:${id}`, Cursor, { transport, peerId: myId });
cursors.set({ x, y }); // publish MY state (LWW for this peer)
cursors.get(); // reactive Map<peerId, Cursor> of live members only
cursors.dispose(); // leave → my entry GCs for everyone
```

## Per-field authority (§13.2)

Conflict policy is a property of the data, chosen at the field and projected onto
both halves of the spine.

```js
import { defineAuthority } from "@lyku/para-sync";

const authority = defineAuthority({
  views: "server", // client never writes it
  title: "lww", // last-write-wins (Class-A)
  tags: (mine, theirs, base) => union(mine, theirs), // @merge (Class-B; explicit pure fn)
});
// write gate: createIntent({ replica, authority, optimistic }) strips @server writes.
// reconciler: createClientReplica({ ..., authority }) resolves @merge fields on echo.
```

Class-B (`@merge`) is the only way concurrent multi-writer merge becomes
reachable, and it is a named pure function: never ambient (the anti-Meteor
boundary, §7.2).

## Transactions (`createTransaction`, §13.6)

Atomic multi-key intents: all arms apply as a unit under one group op-id;
group confirm clears all, group reject rolls back all, partial per-key echoes
buffer until the group resolves (no torn apply).

```js
import { createTransaction } from "@lyku/para-sync";

const tx = createTransaction({
  intents: [
    { key: "cart:A", replica: cartA, optimistic: (_, cur) => ({ ...cur, items: cur.items.filter((i) => i.id !== item.id) }) },
    { key: "cart:B", replica: cartB, optimistic: (_, cur) => ({ ...cur, items: [...cur.items, item] }) },
  ],
  send: (grouped) => transport.publish("tx", grouped),
});
tx.confirm(); // clears all + returns the buffered echoes to apply
tx.reject(); // rolls back BOTH carts atomically
```

## Test

```
bun test        # from packages/para-sync
```
