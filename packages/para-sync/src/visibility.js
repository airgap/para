// @lyku/para-sync — field-visibility projection (domain-FREE).
//
// The framework knows that a field can carry an opaque "visibility tag" and that
// a tag maps to an allow/deny decision for a (viewer, owner) pair. It does NOT
// know what any tag MEANS — "friends", "followers", "subscribers" are the app's
// vocabulary, supplied via defineVisibility. Adding a brand-new relationship type
// touches zero framework code; it's one resolver entry in the app.
//
// This is the strategy/extension point behind a generic, annotation-driven
// `authorize`: instead of hand-writing a gate per model, a model declares which
// record key holds each field's tag, and visibilityGate dispatches each tag to
// the registered resolver and projects accordingly.

/**
 * (viewer, owner) → may the viewer see a field tagged with this resolver's key?
 * Sync or async (a relationship/DB lookup). Throwing is treated as deny.
 * @typedef {(viewer: bigint | undefined, owner: bigint) => boolean | Promise<boolean>} VisibilityResolver
 */

/**
 * Tag → resolver registry. The framework owns the MECHANISM (this map + the
 * gate); the app owns the MEANING (the entries). An unregistered tag denies
 * (fail-safe) — a typo or a not-yet-defined tag never leaks.
 * @type {Record<string, VisibilityResolver>}
 */
const resolvers = {};

/**
 * Register app-defined visibility tags. Merges into prior registrations; call
 * once near init. The ONLY place a domain relationship ("friend", "follower")
 * enters the sync layer.
 * @param {Record<string, VisibilityResolver>} map
 */
export function defineVisibility(map) {
  for (const key of Object.keys(map)) resolvers[key] = map[key];
}

/** Test/introspection: is a tag registered? */
export function hasVisibilityResolver(tag) {
  return typeof resolvers[tag] === "function";
}

/** Sentinel class for the owner (sees the full record). */
const SELF_CLASS = "self";

/**
 * The viewer's VISIBILITY CLASS for an object: the canonical (sorted, '+'-joined)
 * set of registered tags whose resolver allows this (viewer, owner). This is the
 * cache-sharding key — two viewers who satisfy the SAME tag set get the IDENTICAL
 * projection, so they share one cache entry. Bounded by the realized tag
 * combinations (a handful), NOT by the number of viewers. The owner is `self`.
 *
 * Domain-free: calls the app resolvers, never interprets a tag. Resolver cost is
 * the app's to amortize (cache the underlying relation per owner, not per pair).
 *
 * @param {bigint | undefined} viewer
 * @param {bigint} owner
 * @returns {Promise<string>}
 */
export async function classKeyOf(viewer, owner) {
  if (viewer !== undefined && viewer === owner) return SELF_CLASS;
  const tags = Object.keys(resolvers).sort();
  const satisfied = [];
  await Promise.all(
    tags.map(async (tag) => {
      try {
        if (await resolvers[tag](viewer, owner)) satisfied.push(tag);
      } catch {
        /* a throwing resolver denies its tag */
      }
    }),
  );
  return satisfied.length ? satisfied.join("+") : "none";
}

/**
 * Project a record for a given class key — a PURE function (no resolver calls):
 * keep a gated field iff its tag is in the class's satisfied set; always strip
 * the visibility-setting keys. `self` returns the value untouched.
 *
 * @param {any} value
 * @param {Record<string, string>} fields  gatedField → its visibility-tag key
 * @param {string} classKey
 */
export function projectByClass(value, fields, classKey) {
  if (classKey === SELF_CLASS || value == null) return value;
  const satisfied = new Set(classKey.split("+"));
  const out = { ...value };
  for (const field of Object.keys(fields)) {
    const tagKey = fields[field];
    const tag = out[tagKey];
    delete out[tagKey]; // never expose the owner's visibility setting
    if (!satisfied.has(tag)) delete out[field];
  }
  return out;
}

/**
 * Build a {@link SyncedModel} `authorize` from a per-field visibility spec — the
 * generic gate that replaces a hand-written one. Owner → full; everyone else →
 * a per-field projection driven by their visibility class. Domain-free.
 *
 * @template [T=any]
 * @param {object} spec
 * @param {Record<string, string>} spec.fields  gatedField → the record key holding
 *        that field's visibility tag (e.g. { dateOfBirth: 'dateOfBirthVisibility' }).
 * @param {(value: T) => (bigint | undefined)} [spec.ownerOf]  extract the owner id
 *        from the record; defaults to the synced key's id.
 * @returns {(ctx: { requester: bigint | undefined, id: bigint }) => Promise<any>}
 */
export function visibilityGate({ fields, ownerOf } = {}) {
  const spec = fields ?? {};
  return async ({ requester, id }) => {
    if (requester !== undefined && requester === id) return true; // owner → full
    return {
      /** @param {any} value */
      check: async (value) => {
        const owner = (ownerOf ? ownerOf(value) : undefined) ?? id;
        const classKey = await classKeyOf(requester, owner);
        return { project: (v) => projectByClass(v, spec, classKey) };
      },
    };
  };
}

/**
 * Per-class, version-stamped projection cache — the scalable serve path.
 *
 * Cache key = `${keyPrefix}${objectKey}:${classKey}:${version}`. This keying is
 * what makes granular access control scale:
 *   - VERSION-STAMPED: a data change bumps `version`, producing NEW keys; stale
 *     entries simply LRU-evict — no invalidation messaging, no fan-out.
 *   - CLASS-keyed (not viewer-keyed): cardinality is objects × realized-classes
 *     (a handful), not objects × viewers. Hot objects are cached once per class
 *     and shared by every viewer in that class; cold ones evict.
 *   - RELATIONSHIP CHURN IS FREE: an unfriend/unfollow never invalidates a
 *     projection — the viewer just resolves to a different classKey next read and
 *     hits a different (already-warm) entry. The expensive cache only changes on
 *     actual DATA change. (Relationship caching is the app's resolvers' job.)
 *
 * Backend is injected (domain- AND store-agnostic): any `{ get, set }` over
 * bytes — a Valkey/Redis adapter in production, a Map in tests.
 *
 * @param {object} opts
 * @param {{ get(key: string): Promise<any>, set(key: string, value: any, ttlSeconds?: number): Promise<any> }} opts.backend
 * @param {number} [opts.ttlSeconds]   per-entry TTL (default 300)
 * @param {{ encode(v: any): any, decode(v: any): any }} [opts.codec]  default: identity
 * @param {string} [opts.keyPrefix]    default 'synced:'
 */
export function createVisibilityCache({ backend, ttlSeconds = 300, codec, keyPrefix = "synced:" } = {}) {
  const encode = codec?.encode ?? ((v) => v);
  const decode = codec?.decode ?? ((v) => v);

  return {
    classKeyOf,

    /**
     * The cached per-class projection of `value` for `viewer`. Owner gets the
     * full value (uncached — it's their own one-off view).
     *
     * @param {object} req
     * @param {string} req.key       object key (e.g. "user:123")
     * @param {string|number} req.version  the object's version (the synced sequence)
     * @param {any} req.value        the full authoritative record
     * @param {bigint | undefined} req.viewer
     * @param {bigint} req.owner
     * @param {Record<string, string>} req.fields  gatedField → its visibility-tag key
     */
    async project({ key, version, value, viewer, owner, fields }) {
      const classKey = await classKeyOf(viewer, owner);
      if (classKey === SELF_CLASS) return value; // owner → full, not cached
      const cacheKey = `${keyPrefix}${key}:${classKey}:${version}`;
      try {
        const hit = await backend.get(cacheKey);
        if (hit != null && hit !== undefined) return decode(hit);
      } catch {
        /* cache read failure → fall through to compute */
      }
      const projected = projectByClass(value, fields, classKey);
      try {
        await backend.set(cacheKey, encode(projected), ttlSeconds);
      } catch {
        /* cache write failure must not fail the read */
      }
      return projected;
    },
  };
}
