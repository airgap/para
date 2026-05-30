/**
 * The change envelope. Delta/full-object model: the new value travels with
 * the reconcile key, so steady-state replication is deliver → parse → apply,
 * with no refetch round-trip (refetch is the Err/gap/skew fallback only).
 *
 * @typedef {object} SyncEnvelope
 * @property {unknown} value          The full changed object. NOT validated by
 *                                    the transport — `parse` gating is the
 *                                    consumer's job at the apply boundary.
 * @property {string} schema_version  Reconcile key, part 1: the model's schema
 *                                    version (e.g. "3.1"). Distinguishes a
 *                                    compatible-but-behind replica from a
 *                                    different/breaking shape.
 * @property {number} sequence        Reconcile key, part 2: the object's
 *                                    monotonic Postgres-authoritative sequence.
 *                                    Sole job is ordering + gap detection.
 */
/**
 * A listener for a key's change envelopes.
 * @callback SyncHandler
 * @param {SyncEnvelope} envelope
 * @returns {void}
 */
/**
 * Returned by subscribe(); calling it removes the subscription. Idempotent.
 * @callback Unsub
 * @returns {void}
 */
/**
 * The pluggable transport contract. `synced<T>` depends ONLY on this shape, not
 * on any concrete transport — that decoupling is what lets the same primitive
 * run on a single box (InProcessTransport) or across services (NatsTransport).
 *
 * Contract notes that every implementation must honor:
 *   - publish(key, envelope) delivers `envelope` to every current subscriber of
 *     `key`. Publishing to a key with no subscribers is a no-op (never throws).
 *   - The transport is a dumb pipe: it does NOT retain the latest value, does
 *     NOT validate the envelope, and does NOT dedupe by sequence. A subscriber
 *     receives only publishes that happen AFTER it subscribes — initial state
 *     arrives via the SSR seed, not the transport.
 *   - subscribe(key, handler) returns an idempotent Unsub.
 *
 * @typedef {object} SyncTransport
 * @property {(key: string, envelope: SyncEnvelope) => void} publish
 * @property {(key: string, handler: SyncHandler) => Unsub} subscribe
 */
/**
 * In-process implementation of {@link SyncTransport}. A keyed pub/sub emitter:
 * `Map<key, Set<handler>>`. No bus, no network, no serialization — the write
 * and the listen happen in the same process, so delivery is a synchronous call.
 *
 * Why a plain emitter and not a para-signal per key: the transport contract is
 * notification semantics ("deliver future publishes to this handler"), not
 * value-cell semantics ("hand me the current value on subscribe, then deltas").
 * Initial state is the SSR seed's job; the transport only carries changes. A
 * keyed emitter models that exactly, without the current-value-on-subscribe and
 * Object.is-dedupe behavior a signal would impose.
 *
 * @implements {SyncTransport}
 */
export class InProcessTransport implements SyncTransport {
    /**
     * key → set of handlers. A key is present iff it has ≥1 live subscriber;
     * the entry is deleted when its last subscriber unsubscribes (no key leak).
     * @type {Map<string, Set<SyncHandler>>}
     */
    _subs: Map<string, Set<SyncHandler>>;
    /**
     * Deliver `envelope` to every current subscriber of `key`, in subscription
     * order. No-op if `key` has no subscribers.
     * @param {string} key
     * @param {SyncEnvelope} envelope
     */
    publish(key: string, envelope: SyncEnvelope): void;
    /**
     * Subscribe `handler` to `key`'s change envelopes. Returns an idempotent
     * Unsub; calling it more than once is safe and will not remove a handler that
     * was re-subscribed in between.
     * @param {string} key
     * @param {SyncHandler} handler
     * @returns {Unsub}
     */
    subscribe(key: string, handler: SyncHandler): Unsub;
    /**
     * Diagnostic: number of keys with at least one live subscriber. Useful for
     * leak checks (a healthy server returns to a steady key count as sessions
     * come and go).
     * @returns {number}
     */
    keyCount(): number;
}
/**
 * NATS implementation of {@link SyncTransport}, for multi-service deployments
 * where a write in the writer's service must reach listeners in other services.
 * Matches Lyku's existing full-object-over-NATS convention.
 *
 * Honors the same contract as InProcessTransport (deliver to current
 * subscribers, no retention, dumb pipe, idempotent unsub). On top it adds:
 *   - subject mapping (key → NATS subject),
 *   - the wire codec (encode on publish, decode on receipt),
 *   - LOCAL FANOUT: N local subscribers to one key share ONE bus subscription,
 *     and that bus subscription is torn down when the last local subscriber
 *     leaves (the cross-service analog of subscriber-set GC).
 *
 * @implements {SyncTransport}
 */
export class NatsTransport implements SyncTransport {
    /**
     * @param {object} opts
     * @param {SyncNatsConnection} opts.connection
     * @param {SyncCodec} [opts.codec]                     default: identity (tests only)
     * @param {(key: string) => string} [opts.subjectOf]   default: `synced.${key}`
     */
    constructor({ connection, codec, subjectOf }: {
        connection: SyncNatsConnection;
        codec?: SyncCodec;
        subjectOf?: (key: string) => string;
    });
    _nc: SyncNatsConnection;
    _codec: SyncCodec;
    _subjectOf: (key: string) => string;
    /**
     * key → { natsUnsub, handlers } — present iff the key has ≥1 local
     * subscriber (and therefore one live bus subscription).
     * @type {Map<string, { natsUnsub: () => void, handlers: Set<SyncHandler> }>}
     */
    _keys: Map<string, {
        natsUnsub: () => void;
        handlers: Set<SyncHandler>;
    }>;
    /**
     * @param {string} key
     * @param {SyncEnvelope} envelope
     */
    publish(key: string, envelope: SyncEnvelope): void;
    /**
     * @param {string} key
     * @param {SyncHandler} handler
     * @returns {Unsub}
     */
    subscribe(key: string, handler: SyncHandler): Unsub;
    /**
     * Diagnostic: number of keys with a live bus subscription.
     * @returns {number}
     */
    keyCount(): number;
}
/**
 * The change envelope. Delta/full-object model: the new value travels with
 * the reconcile key, so steady-state replication is deliver → parse → apply,
 * with no refetch round-trip (refetch is the Err/gap/skew fallback only).
 */
export type SyncEnvelope = {
    /**
     * The full changed object. NOT validated by
     * the transport — `parse` gating is the
     * consumer's job at the apply boundary.
     */
    value: unknown;
    /**
     * Reconcile key, part 1: the model's schema
     * version (e.g. "3.1"). Distinguishes a
     * compatible-but-behind replica from a
     * different/breaking shape.
     */
    schema_version: string;
    /**
     * Reconcile key, part 2: the object's
     * monotonic Postgres-authoritative sequence.
     * Sole job is ordering + gap detection.
     */
    sequence: number;
};
/**
 * A listener for a key's change envelopes.
 */
export type SyncHandler = (envelope: SyncEnvelope) => void;
/**
 * Returned by subscribe(); calling it removes the subscription. Idempotent.
 */
export type Unsub = () => void;
/**
 * The pluggable transport contract. `synced<T>` depends ONLY on this shape, not
 * on any concrete transport — that decoupling is what lets the same primitive
 * run on a single box (InProcessTransport) or across services (NatsTransport).
 *
 * Contract notes that every implementation must honor:
 *   - publish(key, envelope) delivers `envelope` to every current subscriber of
 *     `key`. Publishing to a key with no subscribers is a no-op (never throws).
 *   - The transport is a dumb pipe: it does NOT retain the latest value, does
 *     NOT validate the envelope, and does NOT dedupe by sequence. A subscriber
 *     receives only publishes that happen AFTER it subscribes — initial state
 *     arrives via the SSR seed, not the transport.
 *   - subscribe(key, handler) returns an idempotent Unsub.
 */
export type SyncTransport = {
    publish: (key: string, envelope: SyncEnvelope) => void;
    subscribe: (key: string, handler: SyncHandler) => Unsub;
};
/**
 * A NATS connection, callback-adapted. NatsTransport expects delivery as a
 * callback + an unsubscribe, NOT nats.js's raw async-iterable subscription —
 * the iterable→callback adaptation is a 3-line caller concern that Lyku already
 * does (`const sub = nc.subscribe(subj); (async () => { for await (const m of
 * sub) onMessage(m.data); })(); return () => sub.unsubscribe();`). Keeping that
 * out of the transport makes delivery synchronous and deterministic to test.
 */
export type SyncNatsConnection = {
    publish: (subject: string, payload: Uint8Array) => void;
    /**
     *   subscribe to `subject`; `onMessage` is called per message with the raw
     *   payload; returns an unsubscribe function.
     */
    subscribe: (subject: string, onMessage: (payload: Uint8Array) => void) => (() => void);
};
/**
 * Wire codec: envelope ⇄ bytes. NATS payloads are `Uint8Array`. In production
 * inject a BON or msgpackr codec (envelopes carry bigint IDs, which JSON cannot
 * represent — BON is the SSR/wire serializer for exactly this reason). Defaults
 * to identity (object passthrough), which works for in-memory fakes/tests but
 * NOT a real NATS connection.
 */
export type SyncCodec = {
    encode: (envelope: SyncEnvelope) => any;
    decode: (payload: any) => SyncEnvelope;
};
