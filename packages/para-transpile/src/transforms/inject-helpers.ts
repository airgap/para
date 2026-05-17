// Inline-helper injection for `using` polyfill.
//
// When transformUsingPolyfill emits calls to `__addDisposableResource` and
// `__disposeResources`, those helpers need to exist somewhere. Two
// strategies:
//   (a) import from `bun:wrap` — couples the standalone output to the
//       shim package having a specific export shape.
//   (b) inline at the top of the emitted file — self-contained, no
//       shim coupling. Costs ~30 lines per file that uses `using`.
//
// We pick (b) here because the standalone aims to be self-sufficient.
// Bundlers will dedupe the helper across files via tree-shaking + dead-
// code elimination, so the per-bundle cost is paid once.
//
// The helpers match TypeScript's tslib polyfill shape closely. Skipped:
// SuppressedError chaining for multi-error scenarios (rare in practice;
// we just keep the first error). The runtime behavior matches canonical
// for the common single-error case.

const HELPER_PREAMBLE = `function __addDisposableResource(env, value, async) {
  if (value !== null && value !== void 0) {
    if (typeof value !== "object" && typeof value !== "function") {
      throw new TypeError("Object expected.");
    }
    var dispose;
    if (async) dispose = value[Symbol.asyncDispose];
    if (dispose === void 0) dispose = value[Symbol.dispose];
    if (typeof dispose !== "function") {
      throw new TypeError("Object not disposable.");
    }
    env.stack.push({ value: value, dispose: dispose, async: async });
  }
  return value;
}
function __disposeResources(env) {
  function fail(e) {
    if (!env.hasError) { env.error = e; env.hasError = true; }
  }
  function next() {
    while (env.stack.length) {
      var rec = env.stack.pop();
      try {
        var result = rec.dispose && rec.dispose.call(rec.value);
        if (rec.async) return Promise.resolve(result).then(next, function (e) { fail(e); return next(); });
      } catch (e) { fail(e); }
    }
    if (env.hasError) throw env.error;
  }
  return next();
}`;

export function injectUsingHelpers(src: string): string {
  // Inject only if the polyfill helpers are referenced AND not already
  // defined. Cheap detection on the call sites — the user is unlikely to
  // shadow these specific names.
  const needsAdd = src.includes("__addDisposableResource(");
  const needsDispose = src.includes("__disposeResources(");
  if (!needsAdd && !needsDispose) return src;
  if (/function\s+__addDisposableResource\b/.test(src)) return src;
  return HELPER_PREAMBLE + "\n" + src;
}
