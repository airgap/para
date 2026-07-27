// The P9 loop, end to end and fully in-memory except the generated artifact
// (written to a temp dir and imported — proving the emitted code RUNS):
//
//   .pui fixture → emitServerArtifacts → artifact on disk → import →
//   createServerSourceHost → createSyncEndpoint (real Response/stream) →
//   harness EventSource → createSseTransport → synced(key, Schema) cell.
//
// A server-side invalidate() then flows the whole way back down to the
// client cell — the complete §13.8 story under test in one process.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InProcessTransport, invalidate, subKey, synced } from "@lyku/para-sync";
import {
  emitServerArtifacts,
  createServerSourceHost,
  createSyncEndpoint,
  createSseTransport,
  createSseParser,
} from "../src/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PUI = `<script lang="ts">
import { Stats } from "./models.js";
import { db } from "./db.js";
prop orgId: number;
sync stats :: Stats from server db.total(orgId) on "stats:bump";
</script>
<p>{stats?.total}</p>`;

// EventSource harness: each factory call invokes the real GET handler and
// pumps its Response stream through the SSE parser.
function eventSourceHarness(endpoint) {
  return (url) => {
    const listeners = new Map();
    const res = endpoint.GET({ url: new URL(url, "http://test") });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parse = createSseParser(({ event, data }) => {
      const cbs = listeners.get(event);
      if (cbs) for (const cb of [...cbs]) cb({ data });
    });
    let closed = false;
    (async () => {
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        parse(decoder.decode(value));
      }
    })().catch(() => {});
    return {
      addEventListener(type, cb) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(cb);
      },
      close() {
        closed = true;
        reader.cancel().catch(() => {});
      },
    };
  };
}

describe("P9 end to end", () => {
  test("emitted artifact runs; SSE baseline + live invalidation reach the client cell", async () => {
    // ── the app tree ──
    const dir = mkdtempSync(join(tmpdir(), "para-kit-e2e-"));
    writeFileSync(
      join(dir, "models.js"),
      `export const Stats = { parse: (v) => v && typeof v.total === "number" ? { tag: "Ok", value: v } : { tag: "Err", error: "not Stats" } };`
    );
    writeFileSync(
      join(dir, "db.js"),
      `export const db = { base: 100, total(orgId) { return { total: this.base + orgId }; } };`
    );
    const puiPath = join(dir, "+page.pui");
    writeFileSync(puiPath, PUI);

    // ── emit + load the artifact (as .js so plain bun imports it) ──
    const r = emitServerArtifacts([{ path: puiPath, source: PUI }]);
    expect(r.diagnostics).toEqual([]);
    const artifactPath = join(dir, "server-sources.js");
    writeFileSync(artifactPath, r.artifacts[0].code);
    const { __paraServerSources } = await import(artifactPath);
    expect(__paraServerSources).toHaveLength(1);
    const { db } = await import(join(dir, "db.js"));

    // ── server side ──
    const serverTransport = new InProcessTransport();
    const host = createServerSourceHost(__paraServerSources, { transport: serverTransport });
    const endpoint = createSyncEndpoint({ transport: serverTransport, host });

    // ── client side ──
    const sse = createSseTransport({ url: "/para-sync", eventSource: eventSourceHarness(endpoint) });
    const declId = `${puiPath}#stats`;
    const key = subKey(declId, [7]); // what the .pui binding computes for orgId = 7
    const { Stats } = await import(join(dir, "models.js"));
    const cell = synced(key, Stats, { transport: sse });

    await sleep(20); // microtask connect + GET start + baseline event
    expect(cell.peek()).toEqual({ total: 107 }); // seeded via the SSE baseline

    db.base = 200; // the opaque expression's world changes…
    invalidate(serverTransport, "stats:bump"); // …and the author declared when
    await sleep(20);
    expect(cell.peek()).toEqual({ total: 207 }); // seq 2 streamed + reconciled

    // A second client on the SAME subKey shares the host instance (one timer,
    // one sequence stream — §4.4).
    const cell2 = synced(key, Stats, { transport: sse });
    await sleep(20);
    expect(cell2.peek()).toEqual({ total: 207 });
    expect(host.stats().live).toBe(1);

    // Distinct params = distinct channel.
    const seed9 = await host.seedFor(declId, [9]);
    expect(seed9.value).toEqual({ total: 209 });
    expect(host.stats().live).toBe(2);

    cell.dispose();
    cell2.dispose();
    sse.close();
    host.dispose();
  });

  test("SseTransport is read-side only", () => {
    const sse = createSseTransport({ url: "/x", eventSource: () => ({ addEventListener() {}, close() {} }) });
    expect(() => sse.publish("k", {})).toThrow(/read side/);
    sse.close();
  });

  test("POST intents delegate to the app handler; 501 without one", async () => {
    const t = new InProcessTransport();
    const seen = [];
    const withHandler = createSyncEndpoint({ transport: t, onIntent: (i) => (seen.push(i), "ok") });
    const res = await withHandler.POST({
      request: new Request("http://test/para-sync", {
        method: "POST",
        body: JSON.stringify({ intents: [{ op: "add" }, { op: "del" }] }),
      }),
    });
    expect(await res.json()).toEqual({ results: ["ok", "ok"] });
    expect(seen).toHaveLength(2);

    const without = createSyncEndpoint({ transport: t });
    const res501 = await without.POST({
      request: new Request("http://test/para-sync", { method: "POST", body: "{}" }),
    });
    expect(res501.status).toBe(501);
  });
});
