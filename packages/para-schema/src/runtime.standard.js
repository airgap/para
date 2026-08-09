// Standard-variant runtime entry. Same implementation as the extended variant:
// the split is purely at the type level (see types.standard.ts), so there is
// exactly one validator.
export { fromSchema } from "./runtime.js";
