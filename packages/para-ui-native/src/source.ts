// The convention the `.pui` `source` keyword (LYK-895) consumes. A handle
// is read with `.peek()`, observed with `.subscribe(cb)` (returns an
// unsubscribe), and torn down with `.dispose()`. All three are what a
// para `Signal<T>` already provides for `.peek`/`.subscribe`; adapters in
// this package wrap raw native parabun handles (whose surface is async +
// multi-signal) into this single synchronous shape.
export interface SourceHandle<T> {
  peek(): T;
  subscribe(cb: (v: T) => void): () => void;
  dispose(): void;
}
