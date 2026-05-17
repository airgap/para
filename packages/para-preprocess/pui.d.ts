// Ambient module declaration for `.pui` (Para UI) component imports.
//
// `.pui` files are lowered to standard Svelte 5 components by
// @lyku/para-preprocess at build time, so `import Foo from './Foo.pui'`
// resolves to a Svelte 5 component. TypeScript / svelte-check needs this
// shim to type the import — without it you get
// "Cannot find module './Foo.pui'".
//
// First-class usage — ONE line, no hand-written `declare module`:
// add to any `.d.ts` on your tsconfig include path (SvelteKit:
// `src/app.d.ts`; Vite: `src/vite-env.d.ts` or `src/app.d.ts`):
//
//   /// <reference types="@lyku/para-preprocess/pui" />
//
// Svelte 5: components are functions, not classes. This uses the modern
// `Component` type (works with `mount()` and in markup). Props are kept
// permissive here — precise per-component prop inference is the LSP /
// ts-plugin projection's job, not an ambient's. `ComponentType` (the
// legacy Svelte <=4 class type) is deliberately NOT used: it mistypes
// `mount(Foo)` and forces consumers to hand-roll a correct shim.

declare module "*.pui" {
  import type { Component } from "svelte";
  const component: Component<Record<string, any>>;
  export default component;
}
