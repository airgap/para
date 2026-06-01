/** (viewer, owner) → may the viewer see a field tagged with this resolver's key? */
export type VisibilityResolver = (
    viewer: bigint | undefined,
    owner: bigint,
) => boolean | Promise<boolean>;

/**
 * Register app-defined visibility tags (merges into prior registrations). The
 * ONLY place a domain relationship enters the sync layer; the framework never
 * interprets a tag. An unregistered tag denies (fail-safe).
 */
export function defineVisibility(map: Record<string, VisibilityResolver>): void;

/** Is a tag registered? (test/introspection) */
export function hasVisibilityResolver(tag: string): boolean;

/**
 * The viewer's visibility CLASS for an object — the canonical set of tags they
 * satisfy ('self' for the owner). The cache-sharding key: viewers in the same
 * class share a projection. Bounded by realized tag combinations, not viewers.
 */
export function classKeyOf(viewer: bigint | undefined, owner: bigint): Promise<string>;

/**
 * Pure per-class projection: keep a gated field iff its tag is in the class.
 * No resolver calls. 'self' returns the value untouched.
 */
export function projectByClass<T = any>(
    value: T,
    fields: Record<string, string>,
    classKey: string,
): T;

export type VisibilityCacheBackend = {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown, ttlSeconds?: number): Promise<unknown>;
};

export type VisibilityCacheOptions = {
    backend: VisibilityCacheBackend;
    ttlSeconds?: number;
    codec?: { encode(v: unknown): unknown; decode(v: unknown): unknown };
    keyPrefix?: string;
};

export type VisibilityCacheRequest<T = any> = {
    /** object key, e.g. "user:123" */
    key: string;
    /** the object's version — the synced sequence (version-stamps the cache key) */
    version: string | number;
    /** the full authoritative record */
    value: T;
    viewer: bigint | undefined;
    owner: bigint;
    /** gatedField → its visibility-tag key */
    fields: Record<string, string>;
};

/**
 * Per-class, version-stamped projection cache (the scalable serve path). Cache
 * key = `${keyPrefix}${key}:${classKey}:${version}` — class-keyed not
 * viewer-keyed (cardinality = objects × classes), version-stamped (data changes
 * mint new keys, no invalidation), so relationship churn never invalidates a
 * projection. Backend is injected (Valkey in prod, a Map in tests).
 */
export function createVisibilityCache(opts: VisibilityCacheOptions): {
    classKeyOf: typeof classKeyOf;
    project<T = any>(req: VisibilityCacheRequest<T>): Promise<T>;
};

export type VisibilityGateSpec<T = any> = {
    /** gatedField → the record key holding that field's visibility tag */
    fields: Record<string, string>;
    /** extract the owner id from the record; defaults to the synced key's id */
    ownerOf?: (value: T) => bigint | undefined;
};

/** The per-subscription gate produced for non-owners. */
type VisibilitySyncGate = {
    check: (value: unknown) => Promise<{ project: (value: unknown) => unknown }>;
};

/**
 * Build a SyncedModel `authorize` from a per-field visibility spec — a generic,
 * annotation-driven gate that replaces a hand-written one. Owner → full record;
 * everyone else → a per-field projection driven by the registered resolvers.
 * Domain-free: dispatches opaque tags, never interprets them.
 */
export function visibilityGate<T = any>(
    spec: VisibilityGateSpec<T>,
): (ctx: {
    requester: bigint | undefined;
    id: bigint;
}) => Promise<true | VisibilitySyncGate>;
