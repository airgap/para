// Browser shim for `@para/arena`.
//
// `arena { body }` desugars at parse time to
//   require("@para/arena").scope(() => { body });
// so the only thing we need to keep the parse output valid in a browser
// is an object with `scope(fn)` that calls `fn()` and returns whatever
// it returned. Browsers don't expose GC control, so there's nothing
// meaningful to defer — running the body inline preserves observable
// behavior (same return value, same side effects, same exceptions).

export function scope(fn) {
  return fn();
}

export class Pool {
  constructor() {}
  // Runs a function with the pool "active". Identical behavior to calling
  // the function directly in browsers — the pool concept is a no-op.
  run(fn) {
    return fn();
  }
  dispose() {}
  [Symbol.dispose]() {}
}

export default { scope, Pool };
