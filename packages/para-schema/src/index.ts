/**
 * Para schema runtime + types.
 *
 * Re-exports the type surface (extended variant — see types.ts) and the
 * runtime helpers consumers need to mint schema values outside Para's
 * `schema { ... }` keyword (e.g. when generating schemas from external
 * sources).
 */

export type * from "./types.ts";

import type { SchemaValue } from "./types.ts";

/**
 * Wrap a JSON Schema literal as a runtime `SchemaValue<T>`. Mirrors what
 * the `schema { ... }` expression in `.pts` files lowers to. Provided for
 * consumers in pure-JS / pure-TS codebases that don't have the keyword.
 *
 * The actual decoration logic lives in Bun's runtime (`__paraFromSchema`
 * in src/runtime.bun.js) — this re-exports it under a stable public name.
 *
 * @param body - JSON Schema 2020-12 object (Para extensions allowed)
 * @returns A SchemaValue carrying `parse`, `is`, `schema`, and field accessors.
 */
export declare function fromSchema<S>(body: S): SchemaValue<unknown, S>;
