// Standard (downgraded) variant entry point. Re-exports the
// constraint-collapsing types so vanilla TS consumers see plain TS
// primitives instead of phantom-branded ones.

export type * from "./types.standard.ts";

import type { SchemaValue } from "./types.standard.ts";

export declare function fromSchema<S>(body: S): SchemaValue<unknown, S>;
