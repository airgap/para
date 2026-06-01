import type { SyncEnvelope, SyncTransport } from "./transport.js";
import type { SyncSchema, Cell, ReplicaStatus, ReplicaMeta } from "./client.js";

/**
 * A change-envelope stream: the client's receipt source for one key. `listen`
 * registers a per-envelope callback; `close` (if present) stops delivery.
 * Envelopes are assumed already wire-decoded.
 */
export type SyncStream = {
    listen(onEnvelope: (envelope: SyncEnvelope) => void): void;
    close?(): void;
};

export type SyncedStats = {
    applied: number;
    ignoredStale: number;
    gaps: number;
    parseErrors: number;
    refetches: number;
    schemaSkews: number;
};

export type SyncedOptions<T = any> = {
    /** the `parse` gate — every inbound value crosses a trust boundary */
    schema: SyncSchema;
    /** factory for the receipt stream; its envelopes are published on `key` */
    stream?: () => SyncStream;
    /** transport override; default: a private InProcessTransport fed by `stream` */
    transport?: SyncTransport;
    /** SSR-embedded initial envelope */
    seed?: SyncEnvelope;
    /** Err/skew/gap recovery: fetch the current authoritative snapshot */
    refetch?: () => Promise<SyncEnvelope>;
    /** expected schema version ("major.minor"); a MAJOR mismatch is breaking skew */
    schemaVersion?: string;
    /** reactive cell override; default: a para signal */
    cell?: Cell;
};

/**
 * The reactive handle returned by {@link synced}. `value`/`get()` are tracked
 * reads of the underlying cell; reading them inside a para reactive context
 * subscribes to live updates.
 */
export type SyncedHandle<T = any> = {
    /** current value (tracked read) — the rune's primary read surface */
    readonly value: T;
    /** reconcile status (tracked) */
    readonly status: ReplicaStatus;
    /** current value (tracked read), signal-style */
    get(): T;
    /** current value (untracked) */
    peek(): T;
    /**
     * Subscribe to value changes (current value now, then on every apply);
     * returns an unsubscribe. Satisfies the `.pui` `source`/`synced` binding
     * convention. No-op when an injected cell has no `subscribe`.
     */
    subscribe(onChange: (value: T) => void): () => void;
    /** full reconcile meta (tracked) */
    meta(): ReplicaMeta;
    /** full reconcile meta (untracked) */
    peekMeta(): ReplicaMeta;
    /** observability counters */
    stats: SyncedStats;
    /** resolves when no recovery refetch is in flight */
    whenIdle(): Promise<void>;
    /** stop the stream + reconciler; idempotent */
    dispose(): void;
};

/**
 * Live-replicate one server-authoritative object into a reactive cell. Composes
 * the client reconciler with a default in-process transport, a stream bridge,
 * and one bundled teardown.
 *
 * @param key   synced key, e.g. "user:123"
 * @param opts  schema gate (required), plus stream / transport / seed / refetch /
 *              schemaVersion / cell.
 */
export function synced<T = any>(key: string, opts: SyncedOptions<T>): SyncedHandle<T>;
