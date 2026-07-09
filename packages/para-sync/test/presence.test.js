import { describe, expect, test } from "bun:test";
import { InProcessTransport, presence, configurePresence } from "../src/index.js";

// A cursor: needs a numeric `x`.
const cursorSchema = {
  parse: (v) =>
    v && typeof v === "object" && typeof v.x === "number"
      ? { tag: "Ok", value: v }
      : { tag: "Err", error: "not a Cursor" },
};

describe("presence — ephemeral peer state (§13.4)", () => {
  test("two peers see each other; last-write-wins per peer", () => {
    const t = new InProcessTransport();
    const A = presence("room:1", cursorSchema, { transport: t, peerId: "A" });
    const B = presence("room:1", cursorSchema, { transport: t, peerId: "B" });

    A.set({ x: 1 });
    B.set({ x: 2 });
    expect(A.peek().get("A")).toEqual({ x: 1 }); // self reflected immediately
    expect(A.peek().get("B")).toEqual({ x: 2 });
    expect(B.peek().get("A")).toEqual({ x: 1 });

    A.set({ x: 9 }); // last-write-wins for peer A
    expect(B.peek().get("A")).toEqual({ x: 9 });

    A.dispose();
    B.dispose();
  });

  test("a peer cannot publish malformed state (parse-gated, dropped)", () => {
    const t = new InProcessTransport();
    const A = presence("room:1", cursorSchema, { transport: t, peerId: "A" });
    t.publish("room:1", { peerId: "X", value: { nope: true } }); // rogue malformed publish
    expect(A.peek().has("X")).toBe(false);
    expect(A.stats.parseErrors).toBe(1);
    A.dispose();
  });

  test("dispose broadcasts a leave; the peer GCs for everyone (disconnect-GC)", () => {
    const t = new InProcessTransport();
    const A = presence("room:1", cursorSchema, { transport: t, peerId: "A" });
    const B = presence("room:1", cursorSchema, { transport: t, peerId: "B" });
    A.set({ x: 1 });
    B.set({ x: 2 });
    expect(B.peek().has("A")).toBe(true);

    A.dispose(); // A leaves
    expect(B.peek().has("A")).toBe(false);
    expect(B.stats.leaves).toBe(1);
    B.dispose();
  });

  test("set requires a peerId; a read-only observer can still watch", () => {
    const t = new InProcessTransport();
    const observer = presence("room:1", cursorSchema, { transport: t }); // no peerId
    expect(() => observer.set({ x: 1 })).toThrow(/peerId/);

    const A = presence("room:1", cursorSchema, { transport: t, peerId: "A" });
    A.set({ x: 5 });
    expect(observer.peek().get("A")).toEqual({ x: 5 });

    expect(() => A.set({ y: "bad" })).toThrow(/parse gate/); // own state gated too
    A.dispose();
    observer.dispose();
  });

  test("the members map is reactive (join / update fire subscribers)", () => {
    const t = new InProcessTransport();
    const A = presence("room:1", cursorSchema, { transport: t, peerId: "A" });
    const seen = [];
    const stop = A.subscribe((m) => seen.push([...m.keys()].sort()));
    expect(seen).toEqual([[]]); // initial empty map

    A.set({ x: 1 });
    const B = presence("room:1", cursorSchema, { transport: t, peerId: "B" });
    B.set({ x: 2 });
    expect(seen).toEqual([[], ["A"], ["A", "B"]]);

    stop();
    A.dispose();
    B.dispose();
  });

  test("guards: bad channel / schema / transport throw", () => {
    expect(() => presence("", cursorSchema, { transport: new InProcessTransport() })).toThrow(/channel/);
    expect(() => presence("room:1", null, { transport: new InProcessTransport() })).toThrow(/schema/);
    expect(() => presence("room:1", cursorSchema, {})).toThrow(/transport/);
  });

  test("configurePresence infers delivery for a lowered presence(channel, schema)", () => {
    const t = new InProcessTransport();
    configurePresence({ transport: t, peerId: "me" });
    const p = presence("room:9", cursorSchema); // lowered form: no transport/peerId
    p.set({ x: 1 });
    expect(p.peek().get("me")).toEqual({ x: 1 });
    p.dispose();
    configurePresence({ transport: undefined, peerId: undefined }); // reset global
  });
});
