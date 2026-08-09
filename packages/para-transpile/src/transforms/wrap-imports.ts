// After all the structural / scope-aware transforms have run, scan the
// emitted source for runtime-helper references and prepend the required
// `import { … } from "bun:wrap"` statement.
//
// The transforms emit bare calls like `__parabunRange(0, 5)` for clarity
// in their own logic; this pass adds the import so the output is valid /
// runnable in a host that resolves `bun:wrap` (Parabun natively, or
// `parabun-browser-shims/wrap` aliased via the bundler config. Moves
// into @lyku/para-transpile's runtime alongside the compiler in a follow-up).
//
// Mirrors what the canonical Zig parser does, though it generates per-
// emit aliases (`__parabunRange as __parabunRange_HASH`) for Bun's
// internal-module deduplication. We don't need the aliases.

const HELPERS = [
  "__parabunRange",
  "__parabunRangeInclusive",
  "__parabunMemo",
  "__parabunDefer0",
  "__parabunAsyncDefer0",
  "__paraDec",
] as const;

const HELPER_RE = new RegExp(`\\b(${HELPERS.join("|")})\\b`, "g");

export function injectWrapImports(src: string): string {
  // Skip the whole pass if no helpers appear in the source, common case.
  if (!HELPERS.some(h => src.includes(h))) return src;

  // Collect which helpers are actually referenced. The regex check is
  // sufficient. These names start with `__parabun` and are extremely
  // unlikely to collide with user identifiers; a false positive inside
  // a string would just inject a spurious import (harmless).
  const used = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = HELPER_RE.exec(src)) !== null) used.add(m[1]!);
  if (used.size === 0) return src;

  // Don't double-import if the user already wrote one. Cheap detection:
  // an existing `import … from "bun:wrap"` line at the top.
  if (/import\s*\{[^}]*\}\s*from\s*["']bun:wrap["']/.test(src)) return src;

  const importStmt = `import { ${Array.from(used).sort().join(", ")} } from "bun:wrap";\n`;
  return importStmt + src;
}
