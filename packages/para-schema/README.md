# `@lyku/para-schema`

JSON Schema 2020-12 with 1:1 TypeScript brand-type parity.

## Two variants, one package

| Audience                     | Resolves to               | What you get                                                |
| ---------------------------- | ------------------------- | ----------------------------------------------------------- |
| `.pts` / Para projects       | `src/index.ts`            | Full constraint brands (`StringOf<{ minLength: 3 }>`, etc.) |
| Vanilla TS / Node consumers  | `src/index.standard.ts`   | Same names, all collapse to base primitives (`string`, `number`, …) |

The split is implemented via the `parabun` package-export condition:

```jsonc
// In a Para-aware tsconfig.json:
{
  "compilerOptions": {
    "moduleResolution": "bundler",
    "customConditions": ["parabun"]
  }
}
```

When `customConditions` includes `"parabun"`, tsc resolves to the extended
variant. Without it, vanilla TS resolves to the standard variant. The
exported names are identical in both files, so a `.d.ts` emitted by
`gen-dts-rewrite` works unchanged in either audience — only the
constraint expressivity changes.

## Surface

```ts
import type {
  // Brands
  StringOf, NumberOf, BigIntOf, BooleanOf, ArrayOf, ObjectOf, Brand,
  // Schema runtime types
  SchemaValue, Schema, Infer, InferFromSchema, Result,
  // Helpers
  Handles,
} from "@lyku/para-schema";
```

### Constraint brands

```ts
type Username   = StringOf<{ minLength: 3; maxLength: 32; pattern: "^[A-Za-z0-9_]+$" }>;
type Email      = StringOf<{ format: "email" }>;
type Age        = NumberOf<{ integer: true; minimum: 0; maximum: 150 }>;
type Snowflake  = BigIntOf<{ minimum: 0n }>;
type Tags       = ArrayOf<string, { minItems: 1; maxItems: 10 }>;
```

In the extended variant these are structurally distinct from their base
types — you can't pass a raw `string` where `Username` is expected. In
the standard variant they all collapse to `string`/`number`/etc. and
the constraints are dropped silently.

### Schema values + `Handles<…>`

```ts
import type { Handles } from "@lyku/para-schema";

const getUser = {
  request:  schema { type: "object", properties: { id: { type: "bigint" } }, required: ["id"] },
  response: schema { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
};

const handler: Handles<typeof getUser, AppCtx> = (req, ctx) => {
  // req: { id: bigint } — derived from request schema
  // return: { name: string } — derived from response schema
  return { name: `user${req.id}` };
};
```

## `fromSchema` — the portable runtime

```ts
import { fromSchema } from "@lyku/para-schema";

const Workspace = fromSchema({
  type: "object",
  properties: { name: { type: "varchar", maxLength: 120 } },
  required: ["name"],
  additionalProperties: false,
} as const);

Workspace.parse({ name: "Lyku" });        // { tag: "Ok", value: { name: "Lyku" } }
Workspace.parse({ name: 42 });            // { tag: "Err", error: "name: expected string" }
Workspace.is({ name: "Lyku" });           // true
Workspace.name.maxLength;                 // 120 — field navigation
```

**Why this exists.** On ParaBun, `schema NAME = { … }` lowers to the
built-in validator in the Bun fork. Off ParaBun, ParaBun's own fallback
is `__paraFromSchema = (schema) => schema` — the *identity function*. A
schema shipped to a browser or a Cloudflare Worker therefore validated
nothing at all. `fromSchema` is a faithful, dependency-free port of that
validator, so the same schema gates data on the edge and in the client
exactly as it does on the server.

Codegen that already knows the resolved TS type supplies it explicitly,
skipping brand inference:

```ts
export const organization = fromSchema<typeof body, Organization>(body);
```

The body's own keys stay enumerable (so `{ ...Workspace }` is a plain
JSON Schema again, safe to embed in another schema literal); `parse`,
`validate`, `is`, `schema`, and the field accessors are non-enumerable.

### Dialect

JSON Schema 2020-12 plus the Para/Postgres type tags, so a lockstep
record model is already a valid body: `bigint`, `snowflake`, `varchar`,
`text`, `char`, `numeric`, `timestamptz`, `date`, `jsonb`, `enum`.
`required` means NOT NULL — an omitted key is nullable, and a present
`null` fails a required field. A record with `properties` and no
explicit `type` is treated as an object.

Composition is by **embedding**: a sub-schema that is itself a wrapped
schema (it has `.parse`) validates itself. The portable runtime has no
module `$ref` registry, so a string `$ref` throws rather than silently
passing — an unresolvable reference must never read as "valid".

Two places this validator is deliberately *stricter* than ParaBun's,
both cases where ParaBun is permissive by omission rather than by
contract: `type: "date"` is checked (ParaBun has no `date` arm, so it
falls through to permissive — and `date` is what lockstep emits for every
temporal column), and `additionalProperties: false` is enforced.

## Notes

- Pre-release (`0.0.x-pre`): the API may change before `0.1.0`.
- The extended/standard type split is still hand-maintained; it becomes
  automatic when `gen-dts-rewrite` lands the Phase-1 codegen.
