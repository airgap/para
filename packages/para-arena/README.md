# @para/arena

Buffer-pool helpers for typed-array hot loops + a no-op `scope()` so `.pts` code with `arena { … }` blocks compiles cleanly outside the runtime.

```js
import { Pool, scope } from "@para/arena";

const buf = new Pool(Float32Array, 1024, { prewarm: 4 });

scope(() => {
  const a = buf.acquire();
  // ... use a ...
  buf.release(a);
});
```

## API

- **`Pool(TypedArray, size, opts?)`** — typed-array free list. `acquire()` returns a buffer (recycled if available, allocated otherwise); `release(buf)` returns it. `opts.prewarm` allocates N buffers up front; `opts.limit` caps the free list; `opts.clear: true` zeroes recycled buffers (security-sensitive callers).
- **`pool.use(fn)`** — `acquire` + `fn(buf)` + `release` in a try/finally.
- **`scope(fn)`** — runs `fn()` and returns its result. Outside the runtime, this is a passthrough; browsers don't expose GC control. Inside ParaBun (`parabun:arena`), the same call defers JSC garbage collection for `fn`'s synchronous duration.

## Status

`private:true / 0.0.0-dev` — pending the workspace split. See [parabun.script.dev](https://parabun.script.dev) for the runtime-bundled story today.
