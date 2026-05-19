// Slice 0 verification for the reactive-graph hover. Unit-tests the pure
// static analysis + hover string — NOT in-editor rendering (that needs the
// installed .vsix + a real hover popup; the explicit next gate).
// PARABUN_LSP_NO_LISTEN keeps importing the server from taking over stdin.
process.env.PARABUN_LSP_NO_LISTEN = "1";
import { test, expect, describe } from "bun:test";
import { staticReactiveDependents, getParabunHover } from "./parabun-lsp";

const SRC = [
  "signal count = 0;", // 0
  "derived doubled = count * 2;", // 1
  "derived other = 5;", // 2
  "effect {", // 3
  "  console.log(count);", // 4
  "}", // 5
  "when count > 10 {", // 6
  "  notify();", // 7
  "}", // 8
  "let total = count ~> sink;", // 9
  "let plain = 42;", // 10
].join("\n");

describe("staticReactiveDependents", () => {
  test("finds derived / effect / when / binding that read the signal", () => {
    expect(staticReactiveDependents(SRC, "count")).toEqual([
      { kind: "derived", label: "derived doubled", line: 1 },
      { kind: "effect", label: "effect { … }", line: 3 },
      { kind: "when", label: "when count > 10", line: 6 },
      { kind: "binding", label: "reactive binding (~> / ->)", line: 9 },
    ]);
  });

  test("excludes a derived that does not read the signal", () => {
    expect(staticReactiveDependents(SRC, "count").some(x => x.label === "derived other")).toBe(false);
  });

  test("no dependents → empty", () => {
    expect(staticReactiveDependents("signal lonely = 1;\nlet x = 2;", "lonely")).toEqual([]);
  });

  test("word boundary: `count` ≠ `count2` / `mycount`", () => {
    expect(staticReactiveDependents("signal count = 0;\nderived d = count2 + mycount;", "count")).toEqual([]);
  });

  test("// comments ignored", () => {
    expect(staticReactiveDependents("signal count = 0;\nderived d = 1; // count in comment", "count")).toEqual([]);
  });
});

describe("getParabunHover — signal/derived name", () => {
  test("signal name lists its reactive dependents", () => {
    const h = getParabunHover(SRC, 0, 7);
    expect(h).toContain("`count` — reactive signal");
    expect(h).toContain("derived doubled");
    expect(h).toContain("effect { … }");
    expect(h).toContain("when count > 10");
    expect(h).toMatch(/runtime property/);
  });

  test("derived name → read-only, no dependents here", () => {
    const h = getParabunHover(SRC, 1, 10);
    expect(h).toContain("`doubled` — reactive derived (read-only)");
    expect(h).toContain("No static single-file dependents found");
  });

  test("plain identifier → no reactive hover", () => {
    const h = getParabunHover(SRC, 10, 5);
    expect(h == null || !/reactive (signal|derived)/.test(h)).toBe(true);
  });

  test("`signal` keyword hover unchanged", () => {
    expect(getParabunHover(SRC, 0, 2)).toContain("`signal` — reactive binding");
  });
});
