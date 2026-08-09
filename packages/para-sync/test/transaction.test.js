import { describe, expect, test } from "bun:test";
import { InProcessTransport, createClientReplica, createTransaction } from "../src/index.js";

const anySchema = { parse: (value) => ({ tag: "Ok", value }) };
const env = (sequence, value, schema_version = "1.0") => ({ value, schema_version, sequence });
const seeded = (value) => createClientReplica({ key: "e", schema: anySchema, transport: new InProcessTransport(), seed: env(1, value) });

describe("createTransaction: atomic multi-key intents (§13.6)", () => {
  const moveItem = (rA, rB, send) =>
    createTransaction({
      groupOpId: "g1",
      intents: [
        { key: "cart:A", replica: rA, optimistic: (_, cur) => ({ items: cur.items.filter((i) => i !== "item") }) },
        { key: "cart:B", replica: rB, optimistic: (_, cur) => ({ items: [...cur.items, "item"] }) },
      ],
      send,
    });

  test("applies all arms atomically and sends one grouped envelope", () => {
    const rA = seeded({ items: ["item"] });
    const rB = seeded({ items: [] });
    const sent = [];
    const tx = moveItem(rA, rB, (e) => sent.push(e));

    expect(rA.peek()).toEqual({ items: [] }); // both flipped as a unit
    expect(rB.peek()).toEqual({ items: ["item"] });
    expect(tx.status).toBe("pending");
    expect(tx.keys()).toEqual(["cart:A", "cart:B"]);
    expect(sent).toEqual([
      {
        groupOpId: "g1",
        intents: [
          { key: "cart:A", v: 1, value: { items: [] } },
          { key: "cart:B", v: 1, value: { items: ["item"] } },
        ],
      },
    ]);
  });

  test("group reject rolls back ALL arms to their snapshots", () => {
    const rA = seeded({ items: ["item"] });
    const rB = seeded({ items: [] });
    const tx = moveItem(rA, rB, () => {});
    expect(tx.reject()).toBe(true);
    expect(rA.peek()).toEqual({ items: ["item"] }); // restored
    expect(rB.peek()).toEqual({ items: [] });
    expect(tx.status).toBe("rejected");
    expect(tx.reject()).toBe(false); // already resolved
  });

  test("group confirm resolves and returns the buffered per-key echoes", () => {
    const rA = seeded({ items: ["item"] });
    const rB = seeded({ items: [] });
    const tx = moveItem(rA, rB, () => {});

    // partial echoes arrive mid-transaction → buffered (no torn apply)
    const echoA = env(2, { items: [] });
    expect(tx.onEcho("cart:A", echoA)).toBe("buffer");
    expect(tx.onEcho("other:1", env(2, {}))).toBe("pass"); // not our key

    const flushed = tx.confirm();
    expect(flushed).toEqual([{ key: "cart:A", echo: echoA }]);
    expect(tx.status).toBe("confirmed");
    // after the group resolves, echoes pass through normally
    expect(tx.onEcho("cart:B", env(2, { items: ["item"] }))).toBe("pass");
  });

  test("group op-id is generated when omitted", () => {
    const rA = seeded({ items: [] });
    const tx = createTransaction({
      intents: [{ key: "cart:A", replica: rA, optimistic: (_, cur) => ({ items: [...cur.items, "x"] }) }],
    });
    expect(typeof tx.groupOpId).toBe("string");
    expect(tx.groupOpId.length).toBeGreaterThan(0);
  });

  test("guards: empty intents / malformed arm throw", () => {
    expect(() => createTransaction({ intents: [] })).toThrow(/non-empty/);
    expect(() => createTransaction({ intents: [{ key: "k", replica: {}, optimistic: () => ({}) }] })).toThrow(/replica/);
  });
});
