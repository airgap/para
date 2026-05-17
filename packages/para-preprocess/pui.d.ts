// Ambient module declaration for `.pui` (Para UI) component imports.
//
// `.pui` files compile to Svelte components via @lyku/para-preprocess +
// @lyku/para-ui's compiler, so an `import Foo from './Foo.pui'` resolves
// to a component constructor at build time. TypeScript needs this shim to
// type the import.
//
// Usage — add to a `.d.ts` on your tsconfig include path (e.g. src/vite-env.d.ts):
//   /// <reference types="@lyku/para-preprocess/pui" />

declare module "*.pui" {
  import type { ComponentType } from "svelte";
  const component: ComponentType;
  export default component;
}
