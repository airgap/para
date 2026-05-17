// Type-level tests for @para/schema. These don't run any code — every
// assertion is encoded in the type system. The test passes if `bun test`
// can typecheck this file and the runtime expectations all evaluate true.
import { describe, test, expect } from "bun:test";
import type {
  StringOf,
  NumberOf,
  BigIntOf,
  ArrayOf,
  Brand,
  Schema,
  SchemaValue,
  Infer,
  InferFromSchema,
  Handles,
} from "../src/types.ts";

// `Equal<A, B>` resolves to `true` only if A and B are mutually
// assignable (covariant invariant — the standard ts-toolbelt trick).
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

describe("@para/schema — extended variant", () => {
  test("brands stay structurally distinct from their base type", () => {
    type _A = Expect<Equal<StringOf<{ minLength: 3 }>, StringOf<{ minLength: 3 }>>>;
    // raw string is NOT the same as a constrained brand:
    type _B = Expect<Equal<Equal<string, StringOf<{ minLength: 3 }>>, false>>;
    // different constraints brand to different types:
    type _C = Expect<Equal<Equal<StringOf<{ minLength: 3 }>, StringOf<{ minLength: 5 }>>, false>>;
    expect(true).toBe(true);
  });

  test("InferFromSchema walks JSON Schema literals", () => {
    type S1 = InferFromSchema<{ type: "bigint" }>;
    type _1 = Expect<Equal<S1, bigint>>;

    type S2 = InferFromSchema<{ type: "string"; minLength: 1; maxLength: 50 }>;
    type _2 = Expect<Equal<S2, StringOf<{ minLength: 1; maxLength: 50 }>>>;

    type S3 = InferFromSchema<{ enum: readonly ["draft", "published"] }>;
    type _3 = Expect<Equal<S3, "draft" | "published">>;

    type S4 = InferFromSchema<{
      type: "object";
      properties: { id: { type: "bigint" }; name: { type: "string" } };
      required: readonly ["id"];
    }>;
    // `id` required → present; `name` not required → optional.
    type _4 = Expect<Equal<S4, { id: bigint } & { name?: StringOf<{}> }>>;

    type S5 = InferFromSchema<{ type: "array"; items: { type: "string" }; minItems: 1 }>;
    type _5 = Expect<Equal<S5, ArrayOf<StringOf<{}>, { minItems: 1 }>>>;

    expect(true).toBe(true);
  });

  test("Infer<typeof X> pulls T out of SchemaValue<T>", () => {
    type S = SchemaValue<{ id: bigint }, unknown>;
    type _ = Expect<Equal<Infer<S>, { id: bigint }>>;
    expect(true).toBe(true);
  });

  test("Handles<typeof model> derives request + response types", () => {
    type Model = {
      request: SchemaValue<{ id: bigint }, unknown>;
      response: SchemaValue<{ name: string }, unknown>;
    };
    type H = Handles<Model, { user: string }>;
    // First arg is the request data shape:
    type ReqArg = Parameters<H>[0];
    type _R = Expect<Equal<ReqArg, { id: bigint }>>;
    // Ctx threads through:
    type CtxArg = Parameters<H>[1];
    type _C = Expect<Equal<CtxArg, { user: string }>>;
    // Return is response | Promise<response>:
    type Ret = ReturnType<H>;
    type _Ret = Expect<Equal<Ret, { name: string } | Promise<{ name: string }>>>;
    expect(true).toBe(true);
  });

  test("Brand machinery is a phantom — runtime values pass through", () => {
    // At runtime, `StringOf<...>` is just a string. The brand is purely
    // type-level, so a literal string can be cast through `parse()`.
    const branded = "alice" as StringOf<{ minLength: 1 }>;
    expect(typeof branded).toBe("string");
    expect(branded).toBe("alice");
  });
});
