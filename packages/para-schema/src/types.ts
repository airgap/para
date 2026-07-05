/**
 * Para schema type system — JSON Schema 2020-12 with 1:1 brand-type parity.
 *
 * Two output modes:
 *   1. Extended (`parabun` package-export condition) — full constraint
 *      brands. `StringOf<{ minLength: 3 }>` is structurally distinct from
 *      `string` and from a `StringOf<{ minLength: 5 }>`. Constraints are
 *      kept in the type so a downstream consumer can derive UI hints,
 *      generate fixtures, run schema-aware refactors, etc.
 *   2. Standard (default) — every brand collapses to its base TS primitive.
 *      Importing the same module from a vanilla TS project yields plain
 *      `string` / `number` / `{ id: bigint }` types, no `@lyku/para-schema`
 *      dependency required.
 *
 * The library file you're reading is the EXTENDED variant. The downgrade
 * is provided by a sibling `.standard.d.ts` shipped under the package's
 * default `types` export — see `package.json`.
 */

// -- Phantom brand machinery ------------------------------------------

/** Phantom property used to mark a primitive as branded with constraints. */
declare const __schemaBrand: unique symbol;

/** Generic brand. `T` is the runtime base type, `B` is the constraint bag. */
export type Brand<T, B> = T & { readonly [__schemaBrand]: B };

/** Phantom property marking a codegen'd data type as ORIGINATING from a
 *  Para schema declaration. */
declare const __paraDeclBrand: unique symbol;

/**
 * `FromDecl<T, Name>` — marks a codegen'd TS type as the data shape of the
 * Para declaration `Name` in the same module scope. The TS extractor
 * (`@lyku/para-extract`) links references to such types back to the
 * existing registry node — `{ $ref: "#Name" }` — instead of re-deriving
 * their structure, so the embedded declaration keeps its own capability
 * bits (non-propagation, recursion plan §1.4/§3).
 *
 * Emit it from schema→TS codegen (gen-dts-rewrite Phase-1 brand pipeline):
 *   `export type UserData = FromDecl<Infer<typeof User>, "User">;`
 */
export type FromDecl<T, Name extends string> = T & { readonly [__paraDeclBrand]: Name };

// -- Primitive constraint brands -------------------------------------

/**
 * `StringOf<C>` — a `string` carrying the constraint shape `C`.
 * `C` may include any of: `minLength`, `maxLength`, `pattern`, `format`,
 * `enum`, `const`. Constraints not provided default to "no bound".
 */
export type StringOf<C extends StringConstraints> = Brand<string, C>;
export interface StringConstraints {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: StringFormat;
  readonly enum?: readonly string[];
  readonly const?: string;
}
export type StringFormat =
  | "email"
  | "uri"
  | "uri-reference"
  | "uuid"
  | "date"
  | "time"
  | "date-time"
  | "duration"
  | "ipv4"
  | "ipv6"
  | "hostname"
  | "regex"
  | "json-pointer"
  | "relative-json-pointer"
  | (string & {});

/** Branded number with optional integer / range constraints. */
export type NumberOf<C extends NumberConstraints> = Brand<number, C>;
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

/** Branded bigint (Para's `type: "bigint"` extension). */
export type BigIntOf<C extends BigIntConstraints> = Brand<bigint, C>;
export interface BigIntConstraints {
  readonly minimum?: bigint;
  readonly maximum?: bigint;
  readonly enum?: readonly bigint[];
  readonly const?: bigint;
}

/** Branded boolean (mainly for `const: true`/`const: false` schemas). */
export type BooleanOf<C extends BooleanConstraints> = Brand<boolean, C>;
export interface BooleanConstraints {
  readonly const?: boolean;
}

// -- Composite brands ------------------------------------------------

/** Branded array — element type and `minItems`/`maxItems`/`uniqueItems`. */
export type ArrayOf<T, C extends ArrayConstraints = {}> = Brand<readonly T[], C>;
export interface ArrayConstraints {
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
}

/** Branded object with arbitrary additional-property policy. */
export type ObjectOf<Shape extends Record<string, unknown>, C extends ObjectConstraints = {}> = Brand<Shape, C>;
export interface ObjectConstraints {
  readonly minProperties?: number;
  readonly maxProperties?: number;
  readonly additionalProperties?: boolean | Schema;
}

// -- Schema runtime value -------------------------------------------

/**
 * Result returned by `parse`. Mirrors Para's runtime `Result` shape so
 * `match` discriminates without an extra wrapper.
 */
export type Result<T, E> = { readonly tag: "Ok"; readonly value: T } | { readonly tag: "Err"; readonly error: E };

/**
 * The runtime shape of `schema X = body` / `schema { body }`. Carries the
 * inferred TS type `T` so `Infer<typeof X>` can extract it. Field-navigation
 * accessors (e.g. `User.id.type`) are dynamically attached by
 * `__paraFromSchema` and are typed structurally via the rest spread `S`.
 */
export type SchemaValue<T, S = unknown> = {
  parse: (v: unknown) => Result<T, string>;
  is: (v: unknown) => v is T;
  schema: S;
} & S;

/** A general "any schema" supertype — useful as a generic constraint. */
export type Schema<T = unknown> = SchemaValue<T, any>;

// -- Inference -------------------------------------------------------

/** Pull the validated data type out of a schema value. */
export type Infer<X> = X extends SchemaValue<infer T, any> ? T : never;

/**
 * Turn a JSON Schema literal type (`{ type: "string"; minLength: 3 }`)
 * into the corresponding branded data type. Only used by the codegen;
 * hand-written code should reach for `Infer<typeof X>` instead.
 */
export type InferFromSchema<S> = S extends {
  type: "string";
  format?: infer F;
  minLength?: infer Min;
  maxLength?: infer Max;
  pattern?: infer Pat;
  enum?: readonly (infer EV)[];
  const?: infer Const;
}
  ? Const extends string
    ? Const
    : EV extends string
      ? EV
      : StringOf<TrimUndefined<{ minLength: Min; maxLength: Max; pattern: Pat; format: F }>>
  : S extends { type: "integer" | "number"; minimum?: infer Min; maximum?: infer Max; const?: infer Const }
    ? Const extends number
      ? Const
      : NumberOf<
          TrimUndefined<{ integer: S extends { type: "integer" } ? true : undefined; minimum: Min; maximum: Max }>
        >
    : S extends { type: "bigint" }
      ? bigint
      : S extends { type: "boolean" }
        ? boolean
        : S extends { type: "array"; items: infer Items; minItems?: infer Min; maxItems?: infer Max }
          ? ArrayOf<InferFromSchema<Items>, TrimUndefined<{ minItems: Min; maxItems: Max }>>
          : S extends { type: "object"; properties: infer P; required?: readonly (infer R)[] }
            ? InferObjectShape<P, R>
            : S extends { enum: readonly (infer V)[] }
              ? V
              : S extends { const: infer C }
                ? C
                : unknown;

type InferObjectShape<P, R> = {
  -readonly [K in keyof P as K extends R ? K : never]: InferFromSchema<P[K]>;
} & {
  -readonly [K in keyof P as K extends R ? never : K]?: InferFromSchema<P[K]>;
};

type TrimUndefined<T> = { [K in keyof T as T[K] extends undefined ? never : K]: T[K] };

// -- Helpers consumers will reach for -------------------------------

/**
 * Handler-type sugar. Given a model-shaped record `{ request, response }`,
 * derive a function type whose request/return are inferred from those slots.
 *
 *   const fooHandler: Handles<typeof myModel> = (req, ctx) => …;
 *
 * `Ctx` defaults to `unknown` — applications usually substitute their own
 * (e.g. `Handles<typeof getUser, AppCtx>`).
 */
export type Handles<M extends { request: Schema; response: Schema }, Ctx = unknown> = (
  req: Infer<M["request"]>,
  ctx: Ctx,
) => Promise<Infer<M["response"]>> | Infer<M["response"]>;
