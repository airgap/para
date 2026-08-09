import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parabunPath, pinnedVersion, platformKey, resolveParabun } from "../src/index.js";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.PARABUN_BIN;
});
afterEach(() => {
  if (saved === undefined) delete process.env.PARABUN_BIN;
  else process.env.PARABUN_BIN = saved;
});

test("platformKey maps node platform/arch to manifest keys", () => {
  expect(platformKey("linux", "x64")).toBe("linux-x64");
  expect(platformKey("darwin", "arm64")).toBe("darwin-arm64");
  expect(platformKey("win32", "x64")).toBe("win32-x64");
  // unsupported pair passes through verbatim so the error message can name it
  expect(platformKey("aix", "ppc64")).toBe("aix-ppc64");
});

test("PARABUN_BIN override resolves, unverified, source=env", () => {
  const dir = mkdtempSync(join(tmpdir(), "parabun-bin-"));
  try {
    const fake = join(dir, "parabun");
    writeFileSync(fake, "#!/bin/sh\necho parabun\n");
    process.env.PARABUN_BIN = fake;

    const r = resolveParabun();
    expect(r.path).toBe(fake);
    expect(r.source).toBe("env");
    expect(r.verified).toBe(false);
    expect(r.version).toBe(pinnedVersion());
    expect(parabunPath()).toBe(fake);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PARABUN_BIN pointing at a missing file throws clearly", () => {
  process.env.PARABUN_BIN = "/no/such/parabun-binary-xyz";
  expect(() => resolveParabun()).toThrow(/no file exists there/);
});

test("scaffold manifest (empty platforms) forces the escape hatch", () => {
  delete process.env.PARABUN_BIN;
  // Until Jenkins bakes real platform entries, package resolution must
  // fail with an actionable message naming PARABUN_BIN: never silently.
  expect(() => resolveParabun()).toThrow(/PARABUN_BIN/);
});
