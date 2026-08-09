// Standard (downgraded) variant entry point. Re-exports the
// constraint-collapsing types so vanilla TS consumers see plain TS
// primitives instead of phantom-branded ones. The runtime is identical:
// there is one validator, shared by both variants.

export type * from "./types.standard.ts";

export { fromSchema } from "./runtime.standard.js";
