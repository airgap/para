// createSyncEndpoint's per-subscriber surface: ctx threading, the authorize
// read gate, the project shaping hook, and the SSE heartbeat. All against the
// real handlers and real Response streams: no mocks of para-kit itself.
import { describe, expect, test } from "bun:test";
import { InProcessTransport } from "@lyku/para-sync";
import { createSyncEndpoint, createSseParser } from "../src/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = (sequence, value) => ({ value, schema_version: "1.0", sequence });

/** Drain a streaming Response into parsed SSE frames (and raw text). */
function tap(res) {
  const frames = [];
  let raw = "";
  const parse = createSseParser((f) => frames.push(f));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      raw += text;
      parse(text);
    }
  })().catch(() => {});
  return { frames, rawText: () => raw, close: () => reader.cancel().catch(() => {}), pump };
}

const getUrl = (...keys) =>
  new URL(`/para-sync?${keys.map((k) => `key=${encodeURIComponent(k)}`).join("&")}`, "http://test");

describe("authorize (read gate)", () => {
  test("any denied key fails the whole GET closed with 403, before streaming", async () => {
    const transport = new InProcessTransport();
    const seen = [];
    const endpoint = createSyncEndpoint({
      transport,
      authorize: (ctx, key) => {
        seen.push([ctx, key]);
        return key.includes(`[${JSON.stringify(ctx.userId)}]`);
      },
    });
    const res = await endpoint.GET({ url: getUrl('view:["u1"]', 'view:["u2"]'), ctx: { userId: "u1" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "unauthorized key", key: 'view:["u2"]' });
    expect(seen).toEqual([
      [{ userId: "u1" }, 'view:["u1"]'],
      [{ userId: "u1" }, 'view:["u2"]'],
    ]);
  });

  test("authorized keys stream normally; async authorize supported", async () => {
    const transport = new InProcessTransport();
    const endpoint = createSyncEndpoint({
      transport,
      authorize: async (ctx, key) => key === "ok",
    });
    const res = await endpoint.GET({ url: getUrl("ok"), ctx: {} });
    expect(res.status).toBe(200);
    const t = tap(res);
    await sleep(10);
    transport.publish("ok", env(1, { n: 1 }));
    await sleep(10);
    expect(t.frames.some((f) => f.event === "ready")).toBe(true);
    expect(t.frames.some((f) => f.event === "sync" && JSON.parse(f.data).envelope.value.n === 1)).toBe(true);
    t.close();
  });

  test("no authorize configured → behavior unchanged (open endpoint)", async () => {
    const transport = new InProcessTransport();
    const endpoint = createSyncEndpoint({ transport });
    const res = await endpoint.GET({ url: getUrl("anything") });
    expect(res.status).toBe(200);
    res.body.cancel();
  });
});

describe("project (per-subscriber shaping)", () => {
  test("frames are shaped per ctx on baseline and live publishes; sequences untouched", async () => {
    const transport = new InProcessTransport();
    const endpoint = createSyncEndpoint({
      transport,
      project: (ctx, key, envelope) => ({
        ...envelope,
        value: { ...envelope.value, rack: ctx.userId === envelope.value.owner ? envelope.value.rack : undefined },
      }),
    });

    const open = async (userId) => {
      const res = await endpoint.GET({ url: getUrl("game:r1"), ctx: { userId } });
      return tap(res);
    };
    const alice = await open("u1");
    const bob = await open("u2");
    await sleep(10);
    transport.publish("game:r1", env(3, { owner: "u1", rack: ["A", "B"], score: 9 }));
    await sleep(10);

    const syncOf = (t) => t.frames.filter((f) => f.event === "sync").map((f) => JSON.parse(f.data));
    const [a] = syncOf(alice);
    const [b] = syncOf(bob);
    expect(a.envelope.value.rack).toEqual(["A", "B"]);
    expect(b.envelope.value.rack).toBeUndefined();
    expect(a.envelope.sequence).toBe(3);
    expect(b.envelope.sequence).toBe(3);
    expect(b.envelope.value.score).toBe(9);
    alice.close();
    bob.close();
  });

  test("returning null suppresses the frame entirely", async () => {
    const transport = new InProcessTransport();
    const endpoint = createSyncEndpoint({
      transport,
      project: (ctx, key, envelope) => (envelope.value.secret ? null : envelope),
    });
    const res = await endpoint.GET({ url: getUrl("k"), ctx: {} });
    const t = tap(res);
    await sleep(10);
    transport.publish("k", env(1, { secret: true }));
    transport.publish("k", env(2, { secret: false }));
    await sleep(10);
    const seqs = t.frames.filter((f) => f.event === "sync").map((f) => JSON.parse(f.data).envelope.sequence);
    expect(seqs).toEqual([2]);
    t.close();
  });
});

describe("heartbeat", () => {
  test("comment frames flow on an idle stream and are invisible to the parser", async () => {
    const transport = new InProcessTransport();
    const endpoint = createSyncEndpoint({ transport, heartbeat: 15 });
    const res = await endpoint.GET({ url: getUrl("quiet") });
    const t = tap(res);
    await sleep(60);
    expect(t.rawText()).toContain(": hb\n\n");
    // Comment frames carry no data lines, so the parser emitted nothing for them.
    expect(t.frames.filter((f) => f.event !== "ready")).toEqual([]);
    t.close();
  });

  test("no heartbeat configured → idle stream stays silent", async () => {
    const transport = new InProcessTransport();
    const endpoint = createSyncEndpoint({ transport });
    const res = await endpoint.GET({ url: getUrl("quiet") });
    const t = tap(res);
    await sleep(40);
    expect(t.rawText()).not.toContain(": hb");
    t.close();
  });
});

describe("intent ctx threading", () => {
  test("onIntent receives (intent, ctx) for single and batched bodies", async () => {
    const transport = new InProcessTransport();
    const calls = [];
    const endpoint = createSyncEndpoint({
      transport,
      onIntent: (intent, ctx) => {
        calls.push([intent, ctx]);
        return { ok: true };
      },
    });
    const post = (body) =>
      endpoint.POST({
        request: new Request("http://test/para-sync", { method: "POST", body: JSON.stringify(body) }),
        ctx: { userId: "u9" },
      });

    await post({ t: "move", n: 1 });
    await post({ intents: [{ t: "pass" }, { t: "swap" }] });
    expect(calls).toEqual([
      [{ t: "move", n: 1 }, { userId: "u9" }],
      [{ t: "pass" }, { userId: "u9" }],
      [{ t: "swap" }, { userId: "u9" }],
    ]);
  });
});
