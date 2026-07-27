// @lyku/para-kit — the server-source host glue (plan §6 item 4 → step 5).
//
// The manifest gives static declarations ({ name, declId, schema, params,
// policy, run }); clients subscribe to CONCRETE subKeys (declId + the
// current wire-param VALUES). This host lazily instantiates ONE
// createServerSource per live subKey — the §4.4 shared-timer-per-subKey
// rule falls out: N clients on the same subKey share one instance, one
// timer, one sequence stream — and exposes the SSR seed lookup the P9
// load path uses.

import { createServerSource, subKey } from "@lyku/para-sync";

/** Parse `declId:[...json params]` back into its parts. The separator is the
 *  FIRST `:[` — declIds are `path#name` and never contain `:[`. */
export function parseSubKey(key) {
  const i = key.indexOf(":[");
  if (i === -1) return undefined;
  const declId = key.slice(0, i);
  try {
    const params = JSON.parse(key.slice(i + 1));
    return Array.isArray(params) ? { declId, params } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {Array<{ name: string, declId: string, schema: any, params: string[],
 *                 policy: { every?: number, on?: string | string[], once?: boolean },
 *                 run: (params: Record<string, unknown>) => unknown }>} sources
 * @param {{ transport: import('@lyku/para-sync').SyncTransport,
 *           schemaVersion?: string,
 *           onError?: (error: unknown, ctx: object) => void }} cfg
 */
export function createServerSourceHost(sources, { transport, schemaVersion, onError }) {
  const byDeclId = new Map(sources.map((s) => [s.declId, s]));
  /** @type {Map<string, { src: ReturnType<typeof createServerSource>, started: Promise<void> }>} */
  const live = new Map();
  let disposed = false;

  /**
   * Ensure the source behind a concrete subKey is running. Unknown keys
   * (not a server source — e.g. a query-authority or keyed channel riding
   * the same endpoint) resolve to undefined so the caller just passes them
   * through to the transport.
   * @param {string} key
   */
  async function ensure(key) {
    if (disposed) return undefined;
    const existing = live.get(key);
    if (existing) {
      await existing.started;
      return existing.src;
    }
    const parsed = parseSubKey(key);
    if (!parsed) return undefined;
    const decl = byDeclId.get(parsed.declId);
    if (!decl) return undefined;
    if (parsed.params.length !== decl.params.length) {
      onError?.(new Error(`subKey param arity ${parsed.params.length} ≠ declared ${decl.params.length}`), {
        phase: "subscribe",
        key,
      });
      return undefined;
    }
    const bound = Object.fromEntries(decl.params.map((n, i) => [n, parsed.params[i]]));
    const src = createServerSource({
      key,
      run: () => decl.run(bound),
      schema: decl.schema,
      transport,
      every: decl.policy.every,
      on: decl.policy.on,
      once: decl.policy.once,
      schemaVersion,
      onError,
    });
    const entry = { src, started: src.start() };
    live.set(key, entry);
    await entry.started;
    return src;
  }

  return {
    ensure,
    /** SSR seed: run/ensure the source and return its current envelope. */
    async seedFor(declId, params = []) {
      const src = await ensure(subKey(declId, params));
      return src?.seed();
    },
    /** true iff the key names a declared server source */
    knows: (key) => {
      const parsed = parseSubKey(key);
      return parsed !== undefined && byDeclId.has(parsed.declId);
    },
    stats: () => ({ live: live.size, declared: byDeclId.size }),
    dispose() {
      disposed = true;
      for (const { src } of live.values()) src.stop();
      live.clear();
    },
  };
}
