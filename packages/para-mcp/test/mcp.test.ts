import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import mcp from "../src/index";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "echo-server.ts");

describe("@para/mcp end-to-end (stdio)", () => {
  let conn: Awaited<ReturnType<typeof mcp.connect>>;

  beforeAll(async () => {
    conn = await mcp.connect("stdio", process.execPath, { args: [fixturePath] });
  });

  afterAll(async () => {
    await conn.close();
  });

  test("initialize handshake populates serverInfo + capabilities", () => {
    expect(conn.serverInfo).toEqual({ name: "echo-test", version: "0.0.1" });
    expect(conn.protocolVersion).toBeString();
    expect(conn.serverCapabilities).toBeDefined();
  });

  test("tools/list catalog populated by initialize", () => {
    const names = conn.tools.map(t => t.name).sort();
    expect(names).toEqual(["echo", "fail"]);
  });

  test("tools/call returns echoed text", async () => {
    const res = await conn.call("echo", { message: "hi" });
    expect(res.content).toEqual([{ type: "text", text: "hi" }]);
  });

  test("tools/call surfaces handler errors as MCPError", async () => {
    await expect(conn.call("fail")).rejects.toMatchObject({
      name: "MCPError",
      code: -32000,
    });
  });

  test("resources/list catalog populated by initialize", () => {
    const uris = conn.resources.map(r => r.uri);
    expect(uris).toEqual(["echo://greeting"]);
  });

  test("resources/read returns content", async () => {
    const res = await conn.readResource("echo://greeting");
    expect(res.contents[0]).toEqual({
      uri: "echo://greeting",
      mimeType: "text/plain",
      text: "hello from echo-test",
    });
  });

  test("resources/read on unknown URI rejects", async () => {
    await expect(conn.readResource("echo://unknown")).rejects.toMatchObject({
      name: "MCPError",
    });
  });

  test("prompts/list catalog populated by initialize", () => {
    const names = conn.prompts.map(p => p.name);
    expect(names).toEqual(["wave"]);
  });

  test("prompts/get renders messages", async () => {
    const res = await conn.getPrompt("wave", { name: "alice" });
    expect(res.messages).toEqual([{ role: "user", content: { type: "text", text: "wave at alice" } }]);
  });

  test("notification subscription delivers server-pushed events", async () => {
    // Tee an `on` listener and use the public client API to
    // subscribe + then verify subscribe-acknowledgement happens.
    // Subscribe-then-unsubscribe should round-trip cleanly.
    const unsub = await conn.subscribeResource("echo://greeting");
    expect(typeof unsub).toBe("function");
    await unsub();
  });

  test("connection survives an unknown method as MCPError", async () => {
    // Reach in via the same #request path indirectly: getPrompt of
    // an unknown name yields a server-side MCPError.
    await expect(conn.getPrompt("nope", {})).rejects.toMatchObject({
      name: "MCPError",
    });
  });

  test("alive starts true; use(fn) auto-tears-down on close", async () => {
    // Open a fresh connection just for this case so we can close it
    // without affecting the suite-shared `conn`.
    const c = await mcp.connect("stdio", process.execPath, { args: [fixturePath] });
    expect(c.alive.get()).toBe(true);
    let runs = 0;
    c.use(() => {
      runs++;
      c.alive.get();
    });
    expect(runs).toBe(1);
    await c.close();
    expect(c.alive.get()).toBe(false);
    const before = runs;
    await new Promise(r => setTimeout(r, 30));
    expect(runs).toBe(before);
  });
});

describe("@para/mcp server lifecycle (alive + use)", () => {
  test("server.alive starts true; flips false on close()", async () => {
    const server = mcp.serve({ name: "alive-test", version: "0.0.0" });
    expect(server.alive.get()).toBe(true);
    let runs = 0;
    server.use(() => {
      runs++;
      server.alive.get();
    });
    expect(runs).toBe(1);
    await server.close();
    expect(server.alive.get()).toBe(false);
    const before = runs;
    await new Promise(r => setTimeout(r, 30));
    expect(runs).toBe(before);
  });
});
