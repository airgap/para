import type { InferFromSchema, SchemaValue } from "./types.standard.ts";

/** See runtime.d.ts. Standard variant: no constraint brands, so `T` defaults to `unknown` unless codegen supplies it. */
export declare function fromSchema<S, T = InferFromSchema<S>>(body: S): SchemaValue<T, S>;
