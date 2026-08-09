/**
 * Para schema runtime + types (EXTENDED variant, constraint brands; see
 * types.ts and the `parabun` export condition in package.json).
 *
 * `fromSchema` is the runtime half: it turns a JSON Schema body into a value
 * carrying `parse` / `validate` / `is` / `schema`. On ParaBun the `schema { … }`
 * keyword lowers to the equivalent built-in; everywhere else (browsers,
 * Cloudflare Workers, plain Node) this is the implementation, and importing it
 * is how a codebase without the keyword mints a schema value.
 */

export type * from "./types.ts";

export { fromSchema } from "./runtime.js";
