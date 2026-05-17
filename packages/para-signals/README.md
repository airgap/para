# @lyku/para-signals

Reactive primitives — `signal`, `derived`, `effect`, `batch`, `untrack` — plus resource-tied signals, async-source adapters, and rate-limit operators that the rest of the Para ecosystem relies on. Pure JS, no runtime deps, runs on any JS host (Node, Bun, Deno, browsers, Cloudflare Workers).

This is the runtime side of Para's reactive system. The `.pts` syntax sugar (`signal x = 0`, `effect { … }`, `~>`, `->`) compiles to imports from this package. Other modules in the `para:*` suite (`para:audio`, `para:gpio`, `parabun:llm`, etc.) expose their state through this package's primitives so reactive composition is uniform across the suite.

```js
import { signal, derived, effect } from "@lyku/para-signals";

const count = signal(0);
const doubled = derived(() => count.get() * 2);

effect(() => console.log(count.get(), doubled.get())); // 0, 0

count.set(1); // logs: 1, 2
count.update(n => n + 1); // logs: 2, 4
```

## Core primitives

| | |
| --- | --- |
| `signal(initial)` | Writable cell. Reads inside an effect register a dep; writes mark subscribers dirty and schedule a flush. |
| `derived(fn)` | Lazy memoized computation. Re-runs when its deps change. Re-subscribes to its dynamic dep set on each evaluation. |
| `effect(fn)` | Imperative subscriber. Returns a disposer. The fn may return a cleanup function that runs before each re-execution and on dispose. |
| `batch(fn)` | Coalesce writes inside `fn` into a single flush. |
| `untrack(fn)` | Read inside a tracked context without registering a dep. |

Effects are drained synchronously via a re-entrant guard, so `signal.set()` inside an effect appends to the queue rather than recursing.

## Resource-tied signals — what only Para does

Hardware modules emit signals whose lifecycle is bound to a real underlying resource (mic, camera, file watcher, websocket). When the resource closes, those signals should become inert and observers should unwind cleanly. `resource()` is the primitive that makes that explicit:

```js
import { resource } from "@lyku/para-signals";

const mic = resource(({ signal: sig, onDispose }) => {
  const peak = sig(0);
  const handle = openMic();           // pretend hardware
  handle.onPeak(v => peak.set(v));
  onDispose(() => handle.close());    // released on dispose, in reverse order
  return { peak };                    // becomes mic.peak
});

mic.peak.get();         // current peak level
mic.alive.get();        // boolean signal — true until dispose
mic.use(() => console.log(mic.peak.get())); // effect bound to resource lifetime
mic.dispose();          // close mic, run cleanups, alive flips to false,
                        // bound effects auto-tear-down

// Or with `using` syntax:
{
  using m = resource(...);
  // m disposed automatically at scope exit
}
```

The handle layers `alive` / `dispose` / `[Symbol.dispose]` / `[Symbol.asyncDispose]` / `use(fn)` on top of whatever the setup function returned. `use(fn)` is the key: bound effects auto-dispose when the resource closes, so consumers don't need defensive `if (active.get())` guards everywhere.

## Async-source adapters

Hardware emits streams (audio frames, sensor data, video frames). These adapters lift them into resource-tied signals — no manual pump loop in user code:

| | |
| --- | --- |
| `fromAsyncIter(asyncIterable, initial?)` | Pumps each yielded value into `result.value`. Disposing calls the iterator's `return()`. |
| `fromStream(readableStream, initial?)` | Same for `ReadableStream<T>`. Cancels the reader on dispose. |
| `fromEventTarget(target, eventName, { initial?, map? })` | Listens for events; signal updates with `map(event)`. Removes the listener on dispose. |

```js
const live = fromStream(audioFrames, null);
effect(() => process(live.value.get()));
// later:
live.dispose();  // reader cancelled, stream gracefully released
```

## Rate-limit operators

Hardware emits faster than UI consumers want. These operators wrap a source signal and emit at controlled cadence:

| | |
| --- | --- |
| `throttled(source, ms)` | Leading-edge: first change emits immediately; subsequent changes within `ms` coalesce into a trailing emit at window end. |
| `debounced(source, ms)` | Emits only after `ms` of silence following the last change. |

Both return resources: `result.value` is the rate-limited signal, `result.dispose()` releases the underlying effect and clears any pending timer.

```js
const peakSlow = throttled(mic.peak, 33);   // 30fps view of a 1000hz source
effect(() => render(peakSlow.value.get()));
```

## Why not `@preact/signals-core`?

Two reasons. **Supply-chain hygiene** — keeping the leaf primitive self-contained means every Para package depends on code we read and own, not a transitive trust chain we don't control. **Differentiation** — the resource / stream-adapter / rate-limit surface above is the part Preact doesn't have, and it only composes cleanly because we own the core. Future direction: a `store({...})` primitive for proxy-based fine-grained reactivity on plain objects, with TypedArray-backed derivations fused via `@para/simd`.

## Status

`private:true / 0.0.0-dev` — pending the workspace split. See [parabun.script.dev](https://parabun.script.dev) for the runtime-bundled story today.
