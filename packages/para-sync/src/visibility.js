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

/**
 * Build a {@link SyncedModel} `authorize` from a per-field visibility spec —
 * the generic gate that replaces a hand-written one. The owner (requester === id)
 * always sees the full record; everyone else gets a per-field projection: each
 * gated field is kept only if the resolver for ITS tag (read off the record at
 * `spec.fields[field]`) allows this viewer, and the tag-holding keys themselves
 * are stripped (they're the owner's settings).
 *
 * Domain-free: it dispatches opaque tags to {@link defineVisibility} resolvers
 * and never interprets them.
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
  const gatedFields = Object.keys(fields ?? {});
  const tagKeys = gatedFields.map((f) => fields[f]);

  return async ({ requester, id }) => {
    if (requester !== undefined && requester === id) return true; // owner → full

    return {
      /** @param {any} value */
      check: async (value) => {
        const owner = (ownerOf ? ownerOf(value) : undefined) ?? id;

        // Resolve each DISTINCT tag present on this record once (not per field).
        const tags = new Set();
        for (const key of tagKeys) tags.add(value == null ? undefined : value[key]);
        /** @type {Record<string, boolean>} */
        const allowed = {};
        await Promise.all(
          [...tags].map(async (tag) => {
            const resolver = resolvers[tag];
            try {
              allowed[tag] = resolver ? !!(await resolver(requester, owner)) : false;
            } catch {
              allowed[tag] = false; // a throwing resolver denies
            }
          }),
        );

        return {
          project: (v) => {
            const out = { ...v };
            for (const field of gatedFields) {
              const tagKey = fields[field];
              const tag = out[tagKey];
              delete out[tagKey]; // never expose the owner's visibility setting
              if (!allowed[tag]) delete out[field];
            }
            return out;
          },
        };
      },
    };
  };
}
