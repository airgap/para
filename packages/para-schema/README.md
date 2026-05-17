# `@para/schema`

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
} from "@para/schema";
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
import type { Handles } from "@para/schema";

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

## Notes

- The runtime `fromSchema` export is a `declare function` placeholder —
  the actual implementation lives in Bun's runtime
  (`src/runtime.bun.js → __paraFromSchema`). The package re-exports it
  under a stable public name for non-`.pts` consumers.
- This package is `private: true` until `gen-dts-rewrite` lands the
  Phase-1 codegen and the tooling can produce both variants automatically.
