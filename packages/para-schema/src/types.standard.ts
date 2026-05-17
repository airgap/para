/**
 * Standard (downgraded) Para schema types — for vanilla TS projects that
 * consume schema-bearing packages without opting into the brand machinery.
 *
 * Every constraint brand collapses to its base TS primitive:
 *   StringOf<C>      → string
 *   NumberOf<C>      → number
 *   BigIntOf<C>      → bigint
 *   BooleanOf<C>     → boolean
 *   ArrayOf<T, C>    → readonly T[]
 *   ObjectOf<S, C>   → S
 *
 * This is the file resolved by tsc when no `parabun` package-export
 * condition is set. Same exported names as the extended variant so a
 * single `.d.ts` emitted by `gen-dts-rewrite` can be consumed by either
 * audience without changing imports.
 */

export type Brand<T, _B> = T;

export type StringOf<_C extends StringConstraints = StringConstraints> = string;
export interface StringConstraints {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
  readonly enum?: readonly string[];
  readonly const?: string;
}
export type StringFormat = string;

export type NumberOf<_C extends NumberConstraints = NumberConstraints> = number;
export interface NumberConstraints {
  readonly integer?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly multipleOf?: number;
  readonly enum?: readonly number[];
  readonly const?: number;
}

export type BigIntOf<_C extends BigIntConstraints = BigIntConstraints> = bigint;
export interface BigIntConstraints {
  readonly minimum?: bigint;
  readonly maximum?: bigint;
  readonly enum?: readonly bigint[];
  readonly const?: bigint;
}

export type BooleanOf<_C extends BooleanConstraints = BooleanConstraints> = boolean;
export interface BooleanConstraints {
  readonly const?: boolean;
}

export type ArrayOf<T, _C extends ArrayConstraints = ArrayConstraints> = readonly T[];
export interface ArrayConstraints {
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
}

export type ObjectOf<Shape extends Record<string, unknown>, _C extends ObjectConstraints = ObjectConstraints> = Shape;
export interface ObjectConstraints {
  readonly minProperties?: number;
  readonly maxProperties?: number;
  readonly additionalProperties?: boolean | unknown;
}

export type Result<T, E> = { readonly tag: "Ok"; readonly value: T } | { readonly tag: "Err"; readonly error: E };

export type SchemaValue<T, _S = unknown> = {
  parse: (v: unknown) => Result<T, string>;
  is: (v: unknown) => v is T;
  schema: unknown;
};

export type Schema<T = unknown> = SchemaValue<T, any>;

export type Infer<X> = X extends SchemaValue<infer T, any> ? T : never;

// `InferFromSchema` is a codegen-only helper; in standard mode it's just
// `unknown`. Hand-written code uses `Infer<typeof X>` instead, which still
// works because `SchemaValue<T>` carries `T` in both variants.
export type InferFromSchema<_S> = unknown;

export type Handles<M extends { request: Schema; response: Schema }, Ctx = unknown> = (
  req: Infer<M["request"]>,
  ctx: Ctx,
) => Promise<Infer<M["response"]>> | Infer<M["response"]>;
