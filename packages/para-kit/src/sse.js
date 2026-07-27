// @lyku/para-kit — SyncEnvelopes over SSE (plan §6 items 2–3, step 5).
//
// Server: `createSyncEndpoint` returns SvelteKit-shaped handlers built on
// web standards only (Request/Response/ReadableStream), so they run — and
// test — anywhere those exist. GET is the read path: the client names its
// keys (?key=…&key=…), the endpoint ensures any server sources behind them
// are running (via the host), sends each source's CURRENT envelope as the
// baseline, then streams every transport publish for those keys as an SSE
// `sync` event. POST is the §13.1 intent path, delegated to the app's
// handler. The client cannot tell an L-server key from any other keyed
// channel — it's all SyncEnvelopes on keys, which is the point.
//
// Client: `SseTransport` implements the para-sync dumb-pipe SUBSCRIBE side
// over an EventSource; `publish` throws — the read path is one-directional,
// writes go through POST intents. The EventSource is injected (a factory),
// so browsers pass the real one and tests pass a harness that drives the
// GET handler directly. Key-set changes coalesce per microtask into one
// reconnect (EventSource cannot add query params to a live connection).

/** One SSE frame carrying a keyed envelope. */
export function formatSyncEvent(key, envelope) {
  return `event: sync\ndata: ${JSON.stringify({ key, envelope })}\n\n`;
}

/**
 * Incremental SSE frame parser (for harnesses / non-browser clients).
 * Feed chunks; emits `{ event, data }` per complete frame.
 */
export function createSseParser(onEvent) {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      const data = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (data.length > 0) onEvent({ event, data: data.join("\n") });
    }
  };
}

/**
 * @param {{ transport: import('@lyku/para-sync').SyncTransport,
 *           host?: { ensure(key: string): Promise<{ seed(): any } | undefined> },
 *           onIntent?: (intent: unknown) => unknown | Promise<unknown> }} cfg
 */
export function createSyncEndpoint({ transport, host, onIntent }) {
  return {
    /** @param {{ url: URL }} event  SvelteKit RequestEvent (url is all we read) */
    GET({ url }) {
      const keys = [...new Set(url.searchParams.getAll("key"))];
      /** @type {Array<() => void>} */
      let unsubs = [];
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (key, envelope) => controller.enqueue(encoder.encode(formatSyncEvent(key, envelope)));
          for (const key of keys) {
            // Subscribe BEFORE seeding: a publish landing between the seed
            // read and the subscribe would otherwise be lost; the replica
            // ignores a stale duplicate, so overlap is harmless.
            unsubs.push(transport.subscribe(key, (envelope) => send(key, envelope)));
            const src = await host?.ensure(key);
            const seed = src?.seed();
            if (seed !== undefined) send(key, seed);
          }
          controller.enqueue(encoder.encode(`event: ready\ndata: {}\n\n`));
        },
        cancel() {
          for (const u of unsubs) u();
          unsubs = [];
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    },

    /** @param {{ request: Request }} event */
    async POST({ request }) {
      if (!onIntent) {
        return new Response(JSON.stringify({ error: "no intent handler configured" }), {
          status: 501,
          headers: { "content-type": "application/json" },
        });
      }
      const body = await request.json();
      const intents = Array.isArray(body?.intents) ? body.intents : [body];
      const results = [];
      for (const intent of intents) results.push(await onIntent(intent));
      return new Response(JSON.stringify({ results }), {
        headers: { "content-type": "application/json" },
      });
    },
  };
}

/**
 * The client read-side transport: para-sync's subscribe contract over SSE.
 *
 * One deliberate deviation from the InProcessTransport contract: this is the
 * client's connection MULTIPLEXER, not the server pipe, and it remembers the
 * last envelope seen per key. A LATE JOINER (a second component binding a
 * key the connection already carries) is replayed that envelope on
 * subscribe — otherwise it would sit valueless until the next server
 * change, since the endpoint's baseline event was consumed by the first
 * subscriber's connection. Replay is idempotent by construction: envelopes
 * carry (schema_version, sequence), so an already-initialized replica
 * ignores it as a stale duplicate.
 *
 * @param {{ url: string,
 *           eventSource: (url: string) => { addEventListener(type: string, cb: (e: { data: string }) => void): void, close(): void } }} cfg
 */
export function createSseTransport({ url, eventSource }) {
  /** @type {Map<string, Set<(envelope: any) => void>>} */
  const handlers = new Map();
  /** @type {Map<string, any>} last envelope per key — the late-joiner baseline */
  const lastEnvelope = new Map();
  let es;
  let scheduled = false;
  let closed = false;

  function reconnect() {
    es?.close();
    es = undefined;
    const keys = [...handlers.keys()];
    if (closed || keys.length === 0) return;
    const qs = keys.map((k) => `key=${encodeURIComponent(k)}`).join("&");
    es = eventSource(`${url}?${qs}`);
    es.addEventListener("sync", (e) => {
      const { key, envelope } = JSON.parse(e.data);
      lastEnvelope.set(key, envelope);
      const set = handlers.get(key);
      if (set) for (const h of [...set]) h(envelope);
    });
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      reconnect();
    });
  }

  return {
    subscribe(key, handler) {
      if (!handlers.has(key)) {
        handlers.set(key, new Set());
        schedule(); // key-set changed → coalesced reconnect
      }
      handlers.get(key).add(handler);
      const replay = lastEnvelope.get(key);
      if (replay !== undefined) {
        // Async so subscribe() returns before delivery; re-check membership
        // in case of an immediate unsubscribe.
        queueMicrotask(() => {
          if (handlers.get(key)?.has(handler)) handler(replay);
        });
      }
      return () => {
        const set = handlers.get(key);
        if (!set) return;
        set.delete(handler);
        if (set.size === 0) {
          handlers.delete(key);
          schedule();
        }
      };
    },
    publish() {
      throw new Error(
        "SseTransport is the read side — writes cross the boundary as POST intents (§13.1), never as client publishes"
      );
    },
    close() {
      closed = true;
      es?.close();
      es = undefined;
      handlers.clear();
    },
  };
}
