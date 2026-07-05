// Brand round-trip + checker-resolution — extractor plan step 4.
//
// `para-schema` constraint brands (StringOf<{minLength: 3}> etc.) are
// intersections with a phantom unique-symbol property carrying the
// constraint bag as literal types. The extractor re-emits them as the
// matching JSON Schema keywords in the Para validator's dialect
// (integer: true → type "integer", const → enum). Requires the
// `parabun` custom condition so the EXTENDED para-schema variant is
// resolved — the standard variant collapses brands to bare primitives.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createExtractorProgram, extractType } from "../src/index.ts";

const FIXTURE = resolve(import.meta.dir, "fixtures/brands.ts");
const program = createExtractorProgram([FIXTURE]);
const extract = (typeName: string) => extractType({ file: FIXTURE, typeName, program }).schema;

describe("constraint brand round-trip", () => {
  test("StringOf constraints re-emit as string keywords", () => {
    expect(extract("Username")).toEqual({
      type: "string",
      minLength: 3,
      maxLength: 32,
      pattern: "^[A-Za-z0-9_]+$",
    });
    expect(extract("Email")).toEqual({ type: "string", format: "email" });
  });

  test("NumberOf: integer flag switches the type; ranges copy through", () => {
    expect(extract("Age")).toEqual({ type: "integer", minimum: 0, maximum: 150 });
    expect(extract("Ratio")).toEqual({ type: "number", minimum: 0, maximum: 1 });
  });

  test("BigIntOf: safe bigint bounds emit as numbers, unsafe as strings", () => {
    expect(extract("Snowflake")).toEqual({ type: "bigint", minimum: 0 });
    expect(extract("Huge")).toEqual({ type: "bigint", minimum: "9007199254740993" });
  });

  test("BooleanOf const becomes enum (validator dialect)", () => {
    // TS normalizes `boolean & Brand` into per-literal arms; the
    // uninhabited `false & {const: true}` arm collapses away.
    expect(extract("AlwaysTrue")).toEqual({ enum: [true] });
  });

  test("ArrayOf: element type + minItems/maxItems", () => {
    expect(extract("Tags")).toEqual({
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 10,
    });
  });

  test("branded fields inside an interface", () => {
    expect(extract("Account")).toEqual({
      type: "object",
      properties: {
        id: { type: "bigint", minimum: 0 },
        username: { type: "string", minLength: 3, maxLength: 32, pattern: "^[A-Za-z0-9_]+$" },
        email: { type: "string", format: "email" },
        age: { type: "integer", minimum: 0, maximum: 150 },
        tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
      },
      required: ["id", "username", "age", "tags"],
    });
  });
});

describe("FromDecl registry linkage (step 5)", () => {
  test("FromDecl-marked types link to the existing registry node — never re-derived", () => {
    expect(extract("Feed")).toEqual({
      type: "object",
      properties: {
        owner: { $ref: "#User" },
        viewers: { type: "array", items: { $ref: "#User" } },
        caption: { type: "string" },
      },
      required: ["owner", "viewers", "caption"],
    });
  });

  test("extracting a FromDecl-marked type itself is an error (it already IS a declaration)", () => {
    expect(() => extract("ReExported")).toThrow(/already IS the Para declaration 'User'/);
  });
});

describe("intersections and checker resolution", () => {
  test("plain object intersections merge properties and required", () => {
    expect(extract("Merged")).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    });
  });

  test("mapped types resolve: Partial<Pick<…>> drops requireds, keeps brands", () => {
    expect(extract("PartialAccount")).toEqual({
      type: "object",
      properties: {
        username: { type: "string", minLength: 3, maxLength: 32, pattern: "^[A-Za-z0-9_]+$" },
        age: { type: "integer", minimum: 0, maximum: 150 },
      },
      required: [],
    });
  });

  test("mapped literal-key types resolve to concrete objects", () => {
    expect(extract("Flags")).toEqual({
      type: "object",
      properties: { read: { type: "boolean" }, write: { type: "boolean" } },
      required: ["read", "write"],
    });
  });

  test("conditional types resolve per instantiation branch", () => {
    expect(extract("CondStr")).toEqual({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    });
    expect(extract("CondNum")).toEqual({
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    });
  });
});
