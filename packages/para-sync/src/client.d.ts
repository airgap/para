/** @typedef {import('./transport.js').SyncEnvelope} SyncEnvelope */
/** @typedef {import('./transport.js').SyncTransport} SyncTransport */
/**
 * A schema's parse result — matches para-schema's Result<T, string>.
 * @typedef {{ tag: 'Ok', value: any } | { tag: 'Err', error: string }} Result
 */
/**
 * Anything with a `parse` returning {@link Result}. In production this is a
 * para-schema `SchemaValue`; in tests it can be a hand-rolled gate. The replica
 * depends only on this shape, never on para-schema directly — which is also why
 * the client gates branch on `.tag` instead of using the throw-on-Err `::`
 * convention (a malformed delta must trigger recovery, not crash the apply).
 * @typedef {{ parse(v: unknown): Result }} SyncSchema
 */
/**
 * A minimal reactive value cell: get / peek / set. A para-signals `signal()`
 * satisfies it exactly and is the default. Injectable for testing and for the
 * fork-backed cell on the para-svelte side.
 * @typedef {{ get(): any, peek(): any, set(v: any): void }} Cell
 */
/**
 * @typedef {'ok' | 'stale' | 'skew' | 'refetching'} ReplicaStatus
 *  - ok          last apply succeeded; replica is current
 *  - stale       uninitialized, or a refetch failed / none available
 *  - skew        an inbound value failed `parse` (malformed or schema-skew)
 *  - refetching  a recovery refetch is in flight
 */
/**
 * @typedef {object} ReplicaMeta
 * @property {string | null} schemaVersion  schema version of the applied value
 * @property {number} sequence              sequence of the applied value (-1 if uninitialized)
 * @property {ReplicaStatus} status
 */
/**
 * Create a client replica for one synced key.
 *
 * @param {object} opts
 * @param {string} opts.key                              synced key, e.g. "user:123"
 * @param {SyncSchema} opts.schema                       the `parse` gate
 * @param {SyncTransport} opts.transport                 change-envelope source
 * @param {SyncEnvelope} [opts.seed]                     SSR-embedded initial envelope
 * @param {() => Promise<SyncEnvelope>} [opts.refetch]   Err/skew/gap fallback: fetch the
 *        current authoritative snapshot. Omit → no recovery (status goes 'stale').
 * @param {Cell} [opts.cell]                             reactive cell (default: a para signal)
 */
export function createClientReplica({ key, schema, transport, seed, refetch, cell }: {
    key: string;
    schema: SyncSchema;
    transport: SyncTransport;
    seed?: SyncEnvelope;
    refetch?: () => Promise<SyncEnvelope>;
    cell?: Cell;
}): {
    /** current value (tracked read) */
    get: () => any;
    /** current value (untracked) */
    peek: () => any;
    /** reconcile metadata (tracked): { schemaVersion, sequence, status } */
    meta: () => any;
    /** reconcile metadata (untracked) */
    peekMeta: () => any;
    /** observability counters — read directly */
    stats: {
        applied: number;
        ignoredStale: number;
        gaps: number;
        parseErrors: number;
        refetches: number;
    };
    /** resolves when no recovery refetch is in flight (test/await aid) */
    whenIdle: () => Promise<void>;
    /** stop listening; idempotent */
    dispose: () => void;
};
export type SyncEnvelope = import("./transport.js").SyncEnvelope;
export type SyncTransport = import("./transport.js").SyncTransport;
/**
 * A schema's parse result — matches para-schema's Result<T, string>.
 */
export type Result = {
    tag: "Ok";
    value: any;
} | {
    tag: "Err";
    error: string;
};
/**
 * Anything with a `parse` returning {@link Result}. In production this is a
 * para-schema `SchemaValue`; in tests it can be a hand-rolled gate. The replica
 * depends only on this shape, never on para-schema directly — which is also why
 * the client gates branch on `.tag` instead of using the throw-on-Err `::`
 * convention (a malformed delta must trigger recovery, not crash the apply).
 */
export type SyncSchema = {
    parse(v: unknown): Result;
};
/**
 * A minimal reactive value cell: get / peek / set. A para-signals `signal()`
 * satisfies it exactly and is the default. Injectable for testing and for the
 * fork-backed cell on the para-svelte side.
 */
export type Cell = {
    get(): any;
    peek(): any;
    set(v: any): void;
};
/**
 * - ok          last apply succeeded; replica is current
 * - stale       uninitialized, or a refetch failed / none available
 * - skew        an inbound value failed `parse` (malformed or schema-skew)
 * - refetching  a recovery refetch is in flight
 */
export type ReplicaStatus = "ok" | "stale" | "skew" | "refetching";
export type ReplicaMeta = {
    /**
     * schema version of the applied value
     */
    schemaVersion: string | null;
    /**
     * sequence of the applied value (-1 if uninitialized)
     */
    sequence: number;
    status: ReplicaStatus;
};
