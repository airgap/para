// para-extract: extractor plan steps 1–3 acceptance (para-ts-extractor-plan.md §4,
// recursion plan §7.4 subset).
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createExtractorProgram, extractType } from "../src/index.ts";

const FIXTURE = resolve(import.meta.dir, "fixtures/types.ts");
// One shared program: extraction is batch-friendly by design.
const program = createExtractorProgram([FIXTURE]);
const extract = (typeName: string, opts: Partial<Parameters<typeof extractType>[0]> = {}) =>
  extractType({ file: FIXTURE, typeName, program, ...opts }).schema;

describe("structural lowering", () => {
  test("interface → object with source-ordered properties and optional-aware required", () => {
    expect(extract("User")).toEqual({
      type: "object",
      properties: {
        id: { type: "bigint" },
        name: { type: "string" },
        bio: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["id", "name", "tags"],
    });
  });

  test("anonymous nested objects inline", () => {
    expect(extract("Anon")).toEqual({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: {
            deep: {
              type: "object",
              properties: { leaf: { type: "string" } },
              required: ["leaf"],
            },
          },
          required: ["deep"],
        },
      },
      required: ["nested"],
    });
  });

  test("literal unions collapse to enum", () => {
    expect(extract("Status")).toEqual({ enum: ["active", "banned", "deleted"] });
    expect(extract("Mixed")).toEqual({ enum: ["a", 1, true] });
  });

  test("structural unions become anyOf", () => {
    expect(extract("StringOrNumber")).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
    });
  });

  test("template literal types compile to anchored regex patterns", () => {
    expect(extract("UserId")).toEqual({
      type: "string",
      pattern: "^user--?\\d+(?:\\.\\d+)?$",
    });
  });

  test("Date maps to timestamptz", () => {
    expect(extract("Timestamps")).toEqual({
      type: "object",
      properties: { created: { type: "timestamptz" }, updated: { type: "timestamptz" } },
      required: ["created"],
    });
  });

  test("null/undefined union members read as optionality and are stripped", () => {
    expect(extract("Nullable")).toEqual({
      type: "object",
      properties: { note: { type: "string" }, score: { type: "number" } },
      required: [],
    });
  });

  test("function-typed fields degrade to the function marker", () => {
    expect(extract("WithFn")).toEqual({
      type: "object",
      properties: { handler: { type: "function" } },
      required: ["handler"],
    });
  });
});

describe("recursion → registry $refs", () => {
  test("self-recursion lowers to a module-relative $ref of the wrapping declaration", () => {
    expect(extract("Comment")).toEqual({
      type: "object",
      properties: {
        body: { type: "string" },
        replies: { type: "array", items: { $ref: "#Comment" } },
      },
      required: ["body", "replies"],
    });
  });

  test("declName overrides the emitted self-reference name", () => {
    const schema = extract("Comment", { declName: "Note" }) as {
      properties: { replies: { items: unknown } };
    };
    expect(schema.properties.replies.items).toEqual({ $ref: "#Note" });
  });

  test("mutual recursion links through siblings, never re-derived", () => {
    expect(extract("Post", { siblings: { Thread: "Thread" } })).toEqual({
      type: "object",
      properties: {
        title: { type: "string" },
        comments: { type: "array", items: { $ref: "#Thread" } },
      },
      required: ["title", "comments"],
    });
    expect(extract("Thread", { siblings: { Post: "Post" } })).toEqual({
      type: "object",
      properties: {
        body: { type: "string" },
        post: { $ref: "#Post" },
      },
      required: ["body"],
    });
  });

  test("sibling linkage applies even without recursion (non-propagation)", () => {
    const schema = extract("Post", { siblings: { Thread: "ThreadDecl" } }) as {
      properties: { comments: { items: unknown } };
    };
    expect(schema.properties.comments.items).toEqual({ $ref: "#ThreadDecl" });
  });

  test("recursion through a type with no Para declaration is an error", () => {
    expect(() => extract("UsesHidden")).toThrow(/recursive TS type 'Hidden' has no Para declaration/);
  });
});

describe("determinism & diagnostics", () => {
  test("same type extracted twice yields byte-identical bodies", () => {
    const a = JSON.stringify(extract("User"), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const b = JSON.stringify(
      extractType({ file: FIXTURE, typeName: "User" }).schema,
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    );
    expect(a).toBe(b);
  });

  test("extracted bodies are plain acyclic JSON (stringify succeeds)", () => {
    expect(() => JSON.stringify(extract("Comment"))).not.toThrow();
  });

  test("Map fields are a clear v1 error", () => {
    expect(() => extract("Bad")).toThrow(/'Map' fields are not extractable in v1/);
  });

  test("unknown exported name is a clear error", () => {
    expect(() => extract("Nope")).toThrow(/not exported from/);
  });
});
