// Test-only helpers shared across the suite.

import { transpile as transpileFull } from "../src/index";

/**
 * Strip the leading `import { … } from "bun:wrap";` line that the
 * wrap-imports pass injects when a transform emits runtime helpers.
 * Tests that assert byte-equal output of one transform should use this
 * to avoid coupling each test to whether the injection happens to fire.
 */
export function stripWrapImport(out: string): string {
  return out.replace(/^import\s*\{[^}]*\}\s*from\s*["']bun:wrap["'];?\n?/, "");
}

/** transpile() composed with stripWrapImport — the common test shape. */
export function transpileBare(src: string): string {
  return stripWrapImport(transpileFull(src));
}
