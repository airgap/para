// Substitution engine — extractor plan step 6 (build-step side).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { emitJs, substituteSource } from "../src/substitute.ts";

// Sites resolve specifiers relative to this virtual file's directory,
// which contains the real fixtures/.
const VIRTUAL = join(import.meta.dir, "virtual.pts");

const SOURCE = `import something from "./elsewhere";

export cyclic(1) schema(depth: 32) Comment = ts<import("./fixtures/types").Comment>;

export schema Post = ts<import("./fixtures/types").Post>;
export schema Thread = ts<import("./fixtures/types").Thread>;

export const unrelated = { ts: 1 };
`;

describe("substituteSource", () => {
  test("fresh directives substitute to marker + extracted body", () => {
    const { code, changed, sites } = substituteSource(SOURCE, VIRTUAL);
    expect(changed).toBe(true);
    expect(sites.map(s => s.declName)).toEqual(["Comment", "Post", "Thread"]);
    // Marker survives so re-runs can refresh the body.
    expect(code).toContain('/* ts<import("./fixtures/types").Comment> */');
    // Self-recursion through the wrapping declaration.
    expect(code).toContain('items: { $ref: "#Comment" }');
    // Modifiers on the declaration are untouched.
    expect(code).toContain("cyclic(1) schema(depth: 32) Comment =");
  });

  test("all sites in a file are automatic siblings (mutual recursion links)", () => {
    const { code } = substituteSource(SOURCE, VIRTUAL);
    // Post.comments: Thread[] → links to the Thread declaration…
    expect(code).toContain('comments: { type: "array", items: { $ref: "#Thread" } }');
    // …and Thread.post? → links back to Post.
    expect(code).toContain('post: { $ref: "#Post" }');
  });

  test("substitution is idempotent (marker form re-extracts to the same body)", () => {
    const first = substituteSource(SOURCE, VIRTUAL);
    const second = substituteSource(first.code, VIRTUAL);
    expect(second.code).toBe(first.code);
    expect(second.changed).toBe(false);
  });

  test("stale substituted bodies are refreshed in place", () => {
    const first = substituteSource(SOURCE, VIRTUAL);
    // Corrupt one body: pretend the TS type used to be different.
    const stale = first.code.replace('body: { type: "string" }', 'body: { type: "bigint" }');
    const refreshed = substituteSource(stale, VIRTUAL);
    expect(refreshed.changed).toBe(true);
    expect(refreshed.code).toBe(first.code);
  });

  test("sources without directives pass through untouched", () => {
    const src = `export schema Plain = { type: "string" };`;
    const r = substituteSource(src, VIRTUAL);
    expect(r.changed).toBe(false);
    expect(r.code).toBe(src);
    expect(r.sites).toEqual([]);
  });

  test("unresolvable specifiers are a clear error", () => {
    expect(() => substituteSource(`schema X = ts<import("./nope").X>;`, VIRTUAL)).toThrow(
      /cannot resolve '\.\/nope'/,
    );
  });
});

describe("emitJs", () => {
  test("serializes bodies as JS literals, bigints included", () => {
    expect(emitJs({ type: "bigint", enum: [1n, 2n], $ref: "#X", "weird-key": null })).toBe(
      '{ type: "bigint", enum: [1n, 2n], $ref: "#X", "weird-key": null }',
    );
  });
});
