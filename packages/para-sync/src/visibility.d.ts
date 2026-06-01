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
