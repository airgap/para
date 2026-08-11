// @lyku/para-sync: the opaque server-source host (§13.8, plan step 4).
//
// `sync stats :: Stats from server db.slowAggregate(orgId) every 30s`: the
// L-server tier. The expression is OPAQUE hand-written server code, so nobody
// can know its read-set and liveness cannot be automatic: the refresh contract
// is DECLARED, never faked. This host runs the extracted server expression
// (`run`) under exactly one of the three policies and publishes SyncEnvelopes
// on the subscription key, so the CLIENT side is just shipped Tier-1
// (`synced(key, Schema)`): no new client machinery at all.
//
//   every: N     one shared timer per key; fan-out to N clients rides the
//                transport (never per-connection timers).
//   on: KEY      re-run when anything publishes on the invalidation key -
//                the author-declared read-set. Pair with `invalidate()`.
//   once         seed only. A VISIBLE never-refreshes choice, not a
//                forgotten default.
//
// Shared discipline with the query authority (both-ends gating, §13.8):
// every run's result crosses the schema parse gate BEFORE publish (a server
// bug surfaces once, at the boundary, via onError: clients keep their last
// good value); sequences bump by EXACTLY one per real change (the
// reconciler's exact-successor rule) with a deep-equal short-circuit; runs
// are serialized (a slow run never overlaps or clobbers a later trigger -
// triggers arriving mid-run coalesce into ONE trailing re-run).

/** @typedef {import('./transport.js').SyncTransport} SyncTransport */
/** @typedef {import('./client.js').SyncSchema} SyncSchema */

/** Structural deep-equality over JSON-profile values (the wire domain). */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!Object.hasOwn(b, k) || !deepEqual(a[k], b[k])) return false;
  return true;
}

/**
 * One-line author-declared invalidation: `invalidate(transport, "users:changed")`
 * re-runs every server source whose policy is `on: "users:changed"`. The
 * payload is a bare bump: invalidation keys carry no value.
 * @param {SyncTransport} transport
 * @param {string} key
 */
export function invalidate(transport, key) {
  transport.publish(key, { invalidatedAt: true });
}

/**
 * The subscription-key derivation BOTH ends share (§13.8 / §13.7 re-key rule):
 * a server-source declaration + its current wire-param values identify one
 * channel. The client binding computes it inside its tracked bridge (so a
 * param change re-keys); the host computes it when wiring a
 * {@link createServerSource} per live param-set. JSON.stringify is stable
 * here because params are positional (an array), not an object.
 * @param {string} declId  e.g. `src/Stats.pui#stats`
 * @param {unknown[]} [params]
 */
export function subKey(declId, params) {
  return `${declId}:${JSON.stringify(params ?? [])}`;
}

/**
 * Host one extracted server expression under a declared refresh policy.
 *
 * @param {object} cfg
 * @param {string} cfg.key  the subscription key clients bind (`synced(key, S)`).
 * @param {() => unknown | Promise<unknown>} cfg.run  the extracted server
 *        expression (the generated `<file>.server.pts` export, params bound).
 * @param {SyncSchema} cfg.schema  the OUTBOUND parse gate.
 * @param {SyncTransport} cfg.transport
 * @param {number} [cfg.every]  poll cadence in ms.
 * @param {string | string[]} [cfg.on]  invalidation key(s) on the transport.
 * @param {boolean} [cfg.once]  seed-only.
 * @param {string} [cfg.schemaVersion]
 * @param {(error: unknown, ctx: { phase: string }) => void} [cfg.onError]
 */
export function createServerSource({
  key,
  run,
  schema,
  transport,
  every,
  on,
  once,
  schemaVersion = "1.0",
  onError,
}) {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("createServerSource: `key` must be a non-empty string");
  }
  if (typeof run !== "function") throw new Error("createServerSource: `run` is required");
  if (!schema || typeof schema.parse !== "function") {
    throw new Error("createServerSource: `schema` (with parse) is required");
  }
  if (!transport || typeof transport.publish !== "function") {
    throw new Error("createServerSource: a `transport` is required");
  }
  // The policy is syntactically mandatory in the surface form; the host
  // enforces the same rule so a hand-wired source can't silently be a
  // never-refreshing accident either.
  const declared = [every !== undefined, on !== undefined, Boolean(once)].filter(Boolean).length;
  if (declared !== 1) {
    throw new Error(
      "createServerSource: declare exactly one refresh policy: `every` (ms), `on` (invalidation key), or `once`"
    );
  }

  let sequence = 0;
  let last;
  let started = false;
  let stopped = false;
  let running = false;
  let trailing = false; // a trigger landed mid-run → exactly one re-run after
  let timer;
  /** @type {Array<() => void>} */
  let unsubs = [];
  let runs = 0;

  const currentEnvelope = () =>
    sequence === 0 ? undefined : { value: last, schema_version: schemaVersion, sequence };

  async function execute() {
    if (stopped) return;
    if (running) {
      trailing = true;
      return;
    }
    running = true;
    try {
      runs++;
      let value;
      try {
        value = await run();
      } catch (error) {
        onError?.(error, { phase: "run" });
        return;
      }
      let r;
      try {
        r = schema.parse(value);
      } catch (error) {
        onError?.(error, { phase: "parse" });
        return;
      }
      if (!r || r.tag !== "Ok") {
        onError?.(r && r.tag === "Err" ? r.error : new Error("non-Result parse"), { phase: "parse" });
        return; // gated: clients keep their last good value
      }
      if (sequence > 0 && deepEqual(last, r.value)) return; // no real change
      sequence += 1;
      last = r.value;
      transport.publish(key, currentEnvelope());
    } finally {
      running = false;
      if (trailing && !stopped) {
        trailing = false;
        void execute();
      }
    }
  }

  return {
    /** run once now (the seed), with the declared policy armed around it */
    async start() {
      if (started || stopped) return;
      started = true;
      // Arm invalidations BEFORE the seed run: the same subscribe-before-
      // seed discipline the SSE endpoint applies. An invalidation landing
      // while the seed run is in flight coalesces into the trailing re-run
      // (execute's running/trailing latch) instead of vanishing into the
      // gap between first-run and subscribe. Found by the first consumer
      // whose invalidations fire during subscriber setup (presence).
      if (on !== undefined) {
        const keys = Array.isArray(on) ? on : [on];
        unsubs = keys.map((k) => transport.subscribe(k, () => void execute()));
      }
      await execute();
      if (stopped || once) return;
      if (every !== undefined) {
        timer = setInterval(() => void execute(), every);
      }
    },
    /** force a re-run outside the policy (tests, admin hooks) */
    refresh: () => execute(),
    /** the current envelope (SSR seed for P9 loads), or undefined pre-first-run */
    seed: currentEnvelope,
    /** observability */
    stats: () => ({ runs, sequence, started, stopped }),
    /** stop the timer / invalidation listeners; idempotent */
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      for (const u of unsubs) u();
      unsubs = [];
    },
  };
}
