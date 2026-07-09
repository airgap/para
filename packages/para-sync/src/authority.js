// @lyku/para-sync — per-field authority / conflict policy (§13.2).
//
// Authority is a property of the DATA, chosen at the field, and projected onto
// BOTH halves of the spine:
//   - the write path (§13.1): a client may only write @lww / @merge fields; a
//     @server field is stripped from the optimistic arm.
//   - the reconciler (§3): a steady-state echo overwrites @server / @lww fields,
//     but a @merge field is resolved by its pure merge fn (mine, theirs, base).
//
// This is the runtime shape the compiler emits as `__paraAuthority_X`. The
// classes: "server" (client never writes), "A" (last-write-wins, the Class-A
// default), "B" (concurrent merge — the ONLY way multi-writer merge is reachable,
// and it is a named pure function, never ambient; the §7.2 anti-Meteor boundary).

/**
 * @typedef {'server' | 'A' | 'B'} AuthorityClass
 * @typedef {{ class: AuthorityClass, merge?: (mine: any, theirs: any, base: any) => any }} FieldAuthority
 * @typedef {Record<string, FieldAuthority>} Authority
 */

/**
 * Normalize a field→policy spec into an {@link Authority} map.
 *   'server'      → server-authoritative (client never writes)
 *   'lww' | 'A'   → Class-A last-write-wins
 *   function      → Class-B @merge(fn); fn is the pure (mine, theirs, base) => T
 *
 * @param {Record<string, 'server' | 'lww' | 'A' | ((mine:any, theirs:any, base:any) => any)>} spec
 * @returns {Authority}
 */
export function defineAuthority(spec) {
  /** @type {Authority} */
  const out = {};
  for (const [field, v] of Object.entries(spec ?? {})) {
    if (typeof v === "function") out[field] = { class: "B", merge: v };
    else if (v === "lww" || v === "A") out[field] = { class: "A" };
    else if (v === "server") out[field] = { class: "server" };
    else throw new Error(`defineAuthority: field "${field}" must be 'server' | 'lww' | a merge function`);
  }
  return out;
}

/**
 * The fields a client is allowed to write (class A or B).
 * @param {Authority} authority
 * @returns {Set<string>}
 */
export function writableFields(authority) {
  return new Set(
    Object.entries(authority ?? {})
      .filter(([, a]) => a.class === "A" || a.class === "B")
      .map(([f]) => f)
  );
}

/**
 * Write gate (§13.2): return `next` with every @server field forced back to its
 * `base` value — the runtime embodiment of "@server fields are stripped from the
 * optimistic arm." (The compiler makes this a compile error; this is the
 * defensive runtime backstop for the direct JS API.) Non-object values pass
 * through unchanged.
 * @param {Authority} authority
 * @param {any} base   the value before the optimistic arm ran
 * @param {any} next   the optimistic arm's output
 */
export function guardOptimistic(authority, base, next) {
  if (!authority || next === null || typeof next !== "object" || base === null || typeof base !== "object") {
    return next;
  }
  let out = next;
  for (const [field, a] of Object.entries(authority)) {
    if (a.class === "server" && out[field] !== base[field]) {
      if (out === next) out = { ...next }; // copy-on-first-write
      out[field] = base[field];
    }
  }
  return out;
}

/**
 * Class-B field reconcile (§13.2), applied by the reconciler on a steady-state
 * echo: each @merge field is resolved by its pure fn against the common `base`;
 * @server / @lww fields take `theirs` (server overwrite / last-write-wins). No
 * authority, or non-object `theirs`, returns `theirs` verbatim (the plain Tier-1
 * overwrite).
 * @param {Authority} authority
 * @param {any} mine    the current local value (may hold an optimistic edit)
 * @param {any} theirs  the incoming authoritative value
 * @param {any} base    the last server-confirmed value (the common ancestor)
 */
export function mergeFields(authority, mine, theirs, base) {
  if (!authority || theirs === null || typeof theirs !== "object") return theirs;
  const m = mine && typeof mine === "object" ? mine : {};
  const b = base && typeof base === "object" ? base : {};
  let out = theirs;
  for (const [field, a] of Object.entries(authority)) {
    if (a.class === "B" && typeof a.merge === "function") {
      const merged = a.merge(m[field], theirs[field], b[field]);
      if (merged !== theirs[field]) {
        if (out === theirs) out = { ...theirs };
        out[field] = merged;
      }
    }
  }
  return out;
}
