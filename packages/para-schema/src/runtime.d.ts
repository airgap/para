import type { InferFromSchema, SchemaValue } from "./types.ts";

/**
 * Wrap a JSON Schema 2020-12 body (Para dialect) as a runtime `SchemaValue`,
 * carrying `parse` / `validate` / `is` / `schema` plus field-navigation
 * accessors. This is what `schema NAME = { … }` lowers to in a `.pts` file;
 * import it directly from a plain TS/JS codebase that has no `schema` keyword,
 * or emit calls to it from codegen.
 *
 * `T` — the validated data type — defaults to `InferFromSchema<S>`, so a
 * hand-written `fromSchema({ type: "object", … } as const)` infers its own
 * shape. Codegen that already knows the resolved TS type passes both:
 *
 *   export const organization = fromSchema<typeof body, Organization>(body);
 */
export declare function fromSchema<S, T = InferFromSchema<S>>(body: S): SchemaValue<T, S>;
