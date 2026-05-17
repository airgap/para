// Persistent Worker pool for `@para/parallel` — `pmap` / `preduce` /
// `run`, with a transparent sequential fallback when Worker + `new
// Function` aren't available (CSP-restricted contexts, non-browser
// hosts that lack Worker).
//
// The contract requires user functions to be **pure** — they're shipped
// across the worker boundary via `fn.toString()` and rehydrated with
// `new Function(...)`, so closures over outer scope are not supported.
// That matches the constraint native Parabun enforces.
//
// Inputs cross via structured clone by default. For TypedArray inputs,
// the chunker passes ownership of each chunk's buffer using the
// transfer list — a 100MB Float32Array splits into N transferred
// chunks rather than N copies. Callers can supply additional
// `Transferable`s via the `transfer` option for non-typed-array data.

import { signal as makeSignal, effect as makeEffect } from "@lyku/para-signals";

// ── Worker script, inlined as a blob URL ────────────────────────────────

const WORKER_SOURCE = /* js */ `
let fn = null;
let fnSrc = null;

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.kind === 'init') {
    if (msg.fnSrc !== fnSrc) {
      try {
        fn = (new Function('return (' + msg.fnSrc + ')'))();
        fnSrc = msg.fnSrc;
      } catch (err) {
        self.postMessage({ kind: 'error', id: msg.id, error: String(err && err.message || err) });
        return;
      }
    }
    self.postMessage({ kind: 'ready', id: msg.id });
    return;
  }
  if (msg.kind === 'map') {
    try {
      const { chunk, start, id } = msg;
      let out;
      if (ArrayBuffer.isView(chunk)) {
        out = new chunk.constructor(chunk.length);
        for (let i = 0; i < chunk.length; i++) out[i] = await fn(chunk[i], start + i);
      } else {
        out = new Array(chunk.length);
        for (let i = 0; i < chunk.length; i++) out[i] = await fn(chunk[i], start + i);
      }
      const transfer = ArrayBuffer.isView(out) ? [out.buffer] : [];
      self.postMessage({ kind: 'map', id, out }, transfer);
    } catch (err) {
      self.postMessage({ kind: 'error', id: msg.id, error: String(err && err.message || err) });
    }
    return;
  }
  if (msg.kind === 'reduce') {
    try {
      const { chunk, init, start, id } = msg;
      let acc = init;
      for (let i = 0; i < chunk.length; i++) acc = await fn(acc, chunk[i], start + i);
      self.postMessage({ kind: 'reduce', id, acc });
    } catch (err) {
      self.postMessage({ kind: 'error', id: msg.id, error: String(err && err.message || err) });
    }
    return;
  }
  if (msg.kind === 'run') {
    try {
      const out = await fn(...(msg.args || []));
      self.postMessage({ kind: 'run', id: msg.id, out });
    } catch (err) {
      self.postMessage({ kind: 'error', id: msg.id, error: String(err && err.message || err) });
    }
    return;
  }
};
`;

function supportsWorkers() {
  if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") {
    return false;
  }
  // `new Function(...)` is blocked under strict CSP `script-src` without
  // `unsafe-eval`; detect at module load so we can short-circuit to the
  // sequential fallback.
  try {
    new Function("return 1")();
    return true;
  } catch {
    return false;
  }
}

function defaultConcurrency() {
  if (typeof navigator !== "undefined" && navigator.hardwareConcurrency) {
    return Math.max(1, navigator.hardwareConcurrency);
  }
  // Bun / Node fallback.
  try {
    const os = require("node:os");
    if (typeof os.availableParallelism === "function") return Math.max(1, os.availableParallelism());
    if (typeof os.cpus === "function") return Math.max(1, os.cpus().length);
  } catch {}
  return 4;
}

// ── Errors ──────────────────────────────────────────────────────────────

function makeAbortError() {
  if (typeof DOMException !== "undefined") return new DOMException("Aborted", "AbortError");
  const e = new Error("Aborted");
  e.name = "AbortError";
  return e;
}

function makeTimeoutError() {
  if (typeof DOMException !== "undefined") return new DOMException("Timed out", "TimeoutError");
  const e = new Error("Timed out");
  e.name = "TimeoutError";
  return e;
}

// ── Pool ────────────────────────────────────────────────────────────────

class Pool {
  // Each slot tracks the in-flight task so abort/timeout can forcefully
  // terminate the worker holding it. Replacement workers are spawned
  // synchronously when a slot vacates (under abort, error, or recycle).
  #blobURL = null;
  #slots = []; // [{ worker, fnSrc, busy, currentTask, tasksCompleted, index } | null]
  #queue = []; // pending task records waiting for an idle slot
  #waiters = []; // resolvers for #waitForSlot callers
  // In-flight init operations keyed only by their reject fn. Dispose
  // walks this so a Worker terminated mid-`init` doesn't leave the
  // caller of `#ensureFn` hanging forever on a message that'll never
  // arrive.
  #pendingInits = new Set();
  #closed = false;
  #nextRpcId = 1;
  #completedTotal = 0;
  #config;
  #seq = false; // sequential-fallback mode
  // Lifetime signal — true from createPool() until dispose(). Lets
  // consumers observe pool health reactively instead of polling
  // .stats(). Tied to a private `effect`-bound list (`#boundEffects`)
  // so `pool.use(fn)` auto-tears-down on dispose.
  #alive;
  #boundEffects = [];

  constructor(config = {}) {
    this.#config = {
      concurrency: Math.max(1, config.concurrency ?? defaultConcurrency()),
      maxTasksPerWorker: Math.max(1, config.maxTasksPerWorker ?? Infinity),
    };
    this.#alive = makeSignal(true);
    if (!supportsWorkers()) {
      this.#seq = true;
      return;
    }
    const blob = new Blob([WORKER_SOURCE], { type: "application/javascript" });
    this.#blobURL = URL.createObjectURL(blob);
    for (let i = 0; i < this.#config.concurrency; i++) this.#spawnSlot(i);
  }

  get alive() {
    return this.#alive;
  }

  /**
   * Run an effect bound to this pool's lifetime. Behaves like
   * `signals.effect(fn)` but is automatically disposed when the pool
   * is disposed — no defensive `pool.alive.get()` guards needed.
   */
  use(fn) {
    const stop = makeEffect(fn);
    this.#boundEffects.push(stop);
    return stop;
  }

  // ── slot lifecycle ─────────────────────────────────────────────────

  #spawnSlot(index) {
    const worker = new Worker(this.#blobURL);
    const slot = {
      worker,
      fnSrc: null,
      busy: false,
      currentTask: null,
      tasksCompleted: 0,
      index,
    };
    worker.addEventListener("message", e => this.#onMessage(slot, e));
    worker.addEventListener("error", err => this.#onWorkerError(slot, err));
    this.#slots[index] = slot;
    return slot;
  }

  #replaceSlot(index) {
    const old = this.#slots[index];
    if (old) {
      try {
        old.worker.terminate();
      } catch {}
    }
    this.#slots[index] = null;
    if (this.#closed) return null;
    const fresh = this.#spawnSlot(index);
    this.#onSlotIdle();
    return fresh;
  }

  #findIdleSlot() {
    for (const slot of this.#slots) if (slot && !slot.busy) return slot;
    return null;
  }

  // Called whenever a slot transitions from busy → idle (or appears
  // freshly via #spawnSlot). Drains the queue and wakes any
  // #waitForSlot callers.
  #onSlotIdle() {
    while (this.#queue.length > 0) {
      const slot = this.#findIdleSlot();
      if (!slot) break;
      const task = this.#queue.shift();
      if (task.signal && task.signal.aborted) {
        task.reject(makeAbortError());
        continue;
      }
      this.#runOnSlot(slot, task);
    }
    while (this.#waiters.length > 0) {
      const slot = this.#findIdleSlot();
      if (!slot) break;
      const waiter = this.#waiters.shift();
      slot.busy = true; // pre-claim; the waiter will issue work next
      waiter.resolve(slot);
    }
  }

  // ── RPC dispatch ───────────────────────────────────────────────────

  #dispatch(task) {
    if (this.#closed) {
      task.reject(new Error("@para/parallel: pool is disposed"));
      return;
    }
    if (task.signal && task.signal.aborted) {
      task.reject(makeAbortError());
      return;
    }
    const slot = this.#findIdleSlot();
    if (!slot) {
      this.#queue.push(task);
      return;
    }
    this.#runOnSlot(slot, task);
  }

  #runOnSlot(slot, task) {
    if (this.#closed) {
      task.reject(new Error("@para/parallel: pool is disposed"));
      return;
    }
    slot.busy = true;
    slot.currentTask = task;
    task.slot = slot;

    if (task.signal) {
      task.abortListener = () => this.#abortTask(task, makeAbortError());
      task.signal.addEventListener("abort", task.abortListener, { once: true });
    }
    if (task.timeoutMs && task.timeoutMs > 0 && Number.isFinite(task.timeoutMs)) {
      task.timeoutTimer = setTimeout(() => this.#abortTask(task, makeTimeoutError()), task.timeoutMs);
    }

    try {
      slot.worker.postMessage(task.msg, task.transfer || []);
    } catch (err) {
      this.#cleanupTaskHandlers(task);
      slot.busy = false;
      slot.currentTask = null;
      task.reject(err);
      this.#onSlotIdle();
    }
  }

  #onMessage(slot, e) {
    const task = slot.currentTask;
    if (!task) return;
    const data = e.data;
    if (!data || data.id !== task.msg.id) return;
    this.#cleanupTaskHandlers(task);
    if (data.kind === "error") {
      task.reject(new Error(data.error));
    } else {
      task.resolve(data);
    }
    this.#releaseSlot(slot);
  }

  #onWorkerError(slot, err) {
    const task = slot.currentTask;
    if (task) {
      this.#cleanupTaskHandlers(task);
      task.reject(err && err.message ? new Error(err.message) : new Error("@para/parallel: worker error"));
    }
    this.#replaceSlot(slot.index);
  }

  #abortTask(task, error) {
    const slot = task.slot;
    if (!slot || slot.currentTask !== task) {
      // Already completed — nothing to abort.
      return;
    }
    this.#cleanupTaskHandlers(task);
    task.reject(error);
    // Forceful: workers can't be told to stop mid-task, so terminate
    // and respawn. piscina does the same.
    this.#replaceSlot(slot.index);
  }

  #cleanupTaskHandlers(task) {
    if (task.abortListener && task.signal) {
      try {
        task.signal.removeEventListener("abort", task.abortListener);
      } catch {}
      task.abortListener = null;
    }
    if (task.timeoutTimer) {
      clearTimeout(task.timeoutTimer);
      task.timeoutTimer = null;
    }
  }

  #releaseSlot(slot) {
    slot.tasksCompleted++;
    this.#completedTotal++;
    slot.currentTask = null;
    slot.busy = false;
    if (slot.tasksCompleted >= this.#config.maxTasksPerWorker) {
      // Recycle: terminate + respawn. fnSrc cache is dropped.
      this.#replaceSlot(slot.index);
    } else {
      this.#onSlotIdle();
    }
  }

  // Resolve once a slot becomes idle — and atomically pre-claim it
  // (slot.busy = true) so a racing #onSlotIdle pass can't hand it to
  // someone else. Caller is responsible for issuing work via
  // #runOnSlot (which is idempotent re: slot.busy = true).
  #waitForSlot(signal) {
    return new Promise((resolve, reject) => {
      if (this.#closed) {
        reject(new Error("@para/parallel: pool is disposed"));
        return;
      }
      if (signal && signal.aborted) {
        reject(makeAbortError());
        return;
      }
      const slot = this.#findIdleSlot();
      if (slot) {
        slot.busy = true;
        resolve(slot);
        return;
      }
      const waiter = { resolve, reject, signal, abortListener: null };
      if (signal) {
        waiter.abortListener = () => {
          const i = this.#waiters.indexOf(waiter);
          if (i >= 0) this.#waiters.splice(i, 1);
          reject(makeAbortError());
        };
        signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }

  async #waitForNSlots(n, signal) {
    const claimed = [];
    try {
      while (claimed.length < n) claimed.push(await this.#waitForSlot(signal));
    } catch (e) {
      // Release any slots we already claimed before re-throwing.
      for (const s of claimed) {
        s.busy = false;
      }
      this.#onSlotIdle();
      throw e;
    }
    return claimed;
  }

  // ── ensureFn: cached init per worker ───────────────────────────────
  //
  // Init runs INSIDE an already-claimed slot's lifetime — the slot is
  // already `busy:true` from `#waitForSlot`. Init must NOT go through
  // the user-task release path (which would free the slot mid-flow,
  // leaving a window where another caller could grab it). So we use a
  // dedicated one-off listener that resolves on the matching `ready`
  // and never touches `slot.busy` or the completion counter.

  #ensureFn(slot, fnSrc, signal) {
    if (slot.fnSrc === fnSrc) return Promise.resolve();
    if (this.#closed) return Promise.reject(new Error("@para/parallel: pool is disposed"));
    return new Promise((resolve, reject) => {
      const id = this.#nextRpcId++;
      let abortListener = null;
      const cleanup = () => {
        slot.worker.removeEventListener("message", onMsg);
        if (signal && abortListener) {
          try {
            signal.removeEventListener("abort", abortListener);
          } catch {}
        }
        this.#pendingInits.delete(rejectEntry);
      };
      const onMsg = e => {
        const data = e.data;
        if (!data || data.id !== id) return;
        cleanup();
        if (data.kind === "error") reject(new Error(data.error));
        else {
          slot.fnSrc = fnSrc;
          resolve();
        }
      };
      // Tracked so dispose() can reject in-flight inits whose worker
      // gets terminated before `ready` arrives.
      const rejectEntry = err => {
        cleanup();
        reject(err);
      };
      this.#pendingInits.add(rejectEntry);
      slot.worker.addEventListener("message", onMsg);
      if (signal) {
        abortListener = () => rejectEntry(makeAbortError());
        signal.addEventListener("abort", abortListener, { once: true });
      }
      try {
        slot.worker.postMessage({ kind: "init", fnSrc, id });
      } catch (e) {
        rejectEntry(e);
      }
    });
  }

  // ── Public methods ─────────────────────────────────────────────────

  /**
   * Generic single-task dispatch: ship `fn` and `args` to a worker,
   * await its result. Use `pmap` for element-wise parallelism over
   * a typed array; use `run` for one-off CPU-bound work.
   *
   * Options: `signal` (AbortSignal), `timeout` (ms), `transfer`
   * (Transferable[]).
   */
  async run(fn, args = [], opts = {}) {
    const { signal, timeout, transfer } = opts;
    if (signal && signal.aborted) throw makeAbortError();
    if (this.#seq) {
      if (signal?.aborted) throw makeAbortError();
      const wrapped = await Promise.race(buildRaceFor(fn(...args), signal, timeout));
      return wrapped;
    }
    const slot = await this.#waitForSlot(signal);
    const fnSrc = fn.toString();
    try {
      await this.#ensureFn(slot, fnSrc, signal);
    } catch (e) {
      slot.busy = false;
      this.#onSlotIdle();
      throw e;
    }
    const id = this.#nextRpcId++;
    return await new Promise((resolve, reject) => {
      const task = {
        msg: { kind: "run", id, args },
        transfer: transfer ?? [],
        signal,
        timeoutMs: timeout,
        resolve: data => resolve(data.out),
        reject,
      };
      this.#runOnSlot(slot, task);
    });
  }

  async pmap(fn, input, opts = {}) {
    const { signal, timeout, concurrency } = opts;
    if (signal && signal.aborted) throw makeAbortError();
    if (this.#seq) {
      const n = input.length;
      const out = ArrayBuffer.isView(input) ? new input.constructor(n) : new Array(n);
      for (let i = 0; i < n; i++) {
        if (signal?.aborted) throw makeAbortError();
        out[i] = await fn(input[i], i);
      }
      return out;
    }

    const wantedConc = Math.min(concurrency ?? this.#config.concurrency, this.#config.concurrency, input.length || 1);
    const slots = await this.#waitForNSlots(wantedConc, signal);
    const fnSrc = fn.toString();
    try {
      await Promise.all(slots.map(s => this.#ensureFn(s, fnSrc, signal)));
    } catch (e) {
      for (const s of slots) s.busy = false;
      this.#onSlotIdle();
      throw e;
    }

    const chunks = chunkInput(input, slots.length);
    let results;
    try {
      results = await Promise.all(
        chunks.map(({ sub, start }, i) => {
          const id = this.#nextRpcId++;
          const transfer = ArrayBuffer.isView(sub) ? [sub.buffer] : [];
          return new Promise((resolve, reject) => {
            const task = {
              msg: { kind: "map", chunk: sub, start, id },
              transfer,
              signal,
              timeoutMs: timeout,
              resolve: data => resolve(data.out),
              reject,
            };
            this.#runOnSlot(slots[i], task);
          });
        }),
      );
    } catch (e) {
      // Slots that errored have been replaced; no leak. The successful
      // ones already released themselves via #releaseSlot. Nothing else
      // to do beyond rethrow.
      throw e;
    }

    const n = input.length;
    if (ArrayBuffer.isView(input)) {
      const out = new input.constructor(n);
      let offset = 0;
      for (const partial of results) {
        out.set(partial, offset);
        offset += partial.length;
      }
      return out;
    }
    const out = new Array(n);
    let offset = 0;
    for (const partial of results) {
      for (let k = 0; k < partial.length; k++) out[offset + k] = partial[k];
      offset += partial.length;
    }
    return out;
  }

  async preduce(fn, input, init, opts = {}) {
    const { signal, timeout, concurrency, mapFn } = opts;
    if (signal && signal.aborted) throw makeAbortError();
    if (this.#seq) {
      let acc = init;
      for (let i = 0; i < input.length; i++) {
        if (signal?.aborted) throw makeAbortError();
        const v = mapFn ? await mapFn(input[i], i) : input[i];
        acc = await fn(acc, v, i);
      }
      return acc;
    }

    const wantedConc = Math.min(concurrency ?? this.#config.concurrency, this.#config.concurrency, input.length || 1);
    const slots = await this.#waitForNSlots(wantedConc, signal);
    // mapFn: fused map-then-reduce. If provided, the worker runs each
    // element through mapFn first, then through fn. Same parity
    // constraint (associativity of fn).
    const composedSrc = mapFn
      ? `(function (acc, x, i) { return (${fn.toString()})(acc, (${mapFn.toString()})(x, i), i); })`
      : `(${fn.toString()})`;
    try {
      await Promise.all(slots.map(s => this.#ensureFn(s, composedSrc, signal)));
    } catch (e) {
      for (const s of slots) s.busy = false;
      this.#onSlotIdle();
      throw e;
    }

    const chunks = chunkInput(input, slots.length);
    const partials = await Promise.all(
      chunks.map(({ sub, start }, i) => {
        const id = this.#nextRpcId++;
        const transfer = ArrayBuffer.isView(sub) ? [sub.buffer] : [];
        return new Promise((resolve, reject) => {
          const task = {
            msg: { kind: "reduce", chunk: sub, init, start, id },
            transfer,
            signal,
            timeoutMs: timeout,
            resolve: data => resolve(data.acc),
            reject,
          };
          this.#runOnSlot(slots[i], task);
        });
      }),
    );

    let acc = init;
    for (const partial of partials) acc = await fn(acc, partial);
    return acc;
  }

  stats() {
    return {
      workers: this.#slots.filter(s => s !== null).length,
      busy: this.#slots.filter(s => s && s.busy).length,
      idle: this.#slots.filter(s => s && !s.busy).length,
      queued: this.#queue.length,
      waiting: this.#waiters.length,
      completed: this.#completedTotal,
      sequential: this.#seq,
    };
  }

  async dispose() {
    if (this.#closed) return;
    this.#closed = true;
    for (const task of this.#queue) {
      task.reject(new Error("@para/parallel: pool is disposed"));
    }
    this.#queue.length = 0;
    for (const waiter of this.#waiters) {
      waiter.reject(new Error("@para/parallel: pool is disposed"));
    }
    this.#waiters.length = 0;
    // Reject any in-flight init operation. The worker about to be
    // terminated would otherwise drop the message-listener silently.
    for (const reject of this.#pendingInits) {
      reject(new Error("@para/parallel: pool is disposed"));
    }
    this.#pendingInits.clear();
    // Reject any in-flight task BEFORE terminating its worker so
    // awaiting callers don't hang forever on a killed RPC.
    for (const slot of this.#slots) {
      if (!slot) continue;
      if (slot.currentTask) {
        this.#cleanupTaskHandlers(slot.currentTask);
        slot.currentTask.reject(new Error("@para/parallel: pool is disposed"));
        slot.currentTask = null;
      }
      try {
        slot.worker.terminate();
      } catch {}
    }
    this.#slots = [];
    if (this.#blobURL) {
      try {
        URL.revokeObjectURL(this.#blobURL);
      } catch {}
      this.#blobURL = null;
    }
    if (this.#alive.peek()) {
      this.#alive.set(false);
      while (this.#boundEffects.length > 0) {
        const stop = this.#boundEffects.pop();
        try {
          stop();
        } catch {}
      }
    }
  }
}

// Race a sync-fallback promise against signal/timeout for parity with
// the worker-path semantics. Used only by the `seq` branch of `run`.
function buildRaceFor(promise, signal, timeoutMs) {
  const races = [Promise.resolve(promise)];
  if (signal) {
    races.push(
      new Promise((_, reject) => {
        if (signal.aborted) reject(makeAbortError());
        else signal.addEventListener("abort", () => reject(makeAbortError()), { once: true });
      }),
    );
  }
  if (timeoutMs && timeoutMs > 0 && Number.isFinite(timeoutMs)) {
    races.push(new Promise((_, reject) => setTimeout(() => reject(makeTimeoutError()), timeoutMs)));
  }
  return races;
}

// ── helpers ─────────────────────────────────────────────────────────

function chunkInput(input, nChunks) {
  const n = input.length;
  const chunkSize = Math.ceil(n / nChunks) || 1;
  const chunks = [];
  for (let i = 0; i < n; i += chunkSize) {
    const end = Math.min(i + chunkSize, n);
    const sub = ArrayBuffer.isView(input) ? input.slice(i, end) : input.slice(i, end);
    chunks.push({ sub, start: i });
  }
  return chunks;
}

// ── Default singleton + functional API ──────────────────────────────

let _defaultPool = null;
function defaultPool() {
  if (_defaultPool === null) _defaultPool = new Pool();
  return _defaultPool;
}

function createPool(config = {}) {
  return new Pool(config);
}

async function pmap(fn, input, opts = {}) {
  return defaultPool().pmap(fn, input, opts);
}

async function preduce(fn, input, init, opts = {}) {
  return defaultPool().preduce(fn, input, init, opts);
}

async function run(fn, args = [], opts = {}) {
  return defaultPool().run(fn, args, opts);
}

function disposeWorkers() {
  if (_defaultPool) {
    _defaultPool.dispose();
    _defaultPool = null;
  }
}

// Test / introspection hook used by the test suite.
const _heuristicState = {
  get hasWorker() {
    return _defaultPool ? !_defaultPool.stats().sequential : supportsWorkers();
  },
  get concurrency() {
    return _defaultPool ? _defaultPool.stats().workers : 1;
  },
};
function _resetHeuristic() {
  disposeWorkers();
}

export { Pool, createPool, pmap, preduce, run, disposeWorkers, _heuristicState, _resetHeuristic };
export default { Pool, createPool, pmap, preduce, run, disposeWorkers, _heuristicState, _resetHeuristic };
