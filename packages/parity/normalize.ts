// Normalize two transpiler outputs so they can be compared structurally.
// The two parsers (Zig + our TS) emit semantically-equivalent JS but
// differ in surface details:
//   - gensym names: canonical uses `__parabun_defer_0$`, ours uses
//     `__paraDefer0` etc. Identifiers are renamed to a stable
//     `__GENSYM_<kind>_N` shape based on first-occurrence order.
//   - formatting / whitespace: handled by re-emitting through Babel
//     with consistent options.
//   - comma expressions vs Block / SExpr statements: split a top-level
//     `(a, b);` into separate `a; b;` statements so parser choice
//     doesn't matter.
//
// Returns a normalized string that can be byte-compared.

import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import * as t from "@babel/types";
import generateModule from "@babel/generator";

const traverse = ((traverseModule as any).default ?? traverseModule) as typeof import("@babel/traverse").default;
const generate = ((generateModule as any).default ?? generateModule) as typeof import("@babel/generator").default;

// Patterns that mark gensym'd identifiers from either transpiler. The
// `kind` group captures the semantic role (defer, etc.) so we can
// rename to `__GENSYM_DEFER_0` rather than collapsing all gensyms.
const GENSYM_PATTERNS: { re: RegExp; kind: string }[] = [
  { re: /^__parabun_defer_(\d+)\$$/, kind: "DEFER" },
  { re: /^__paraDefer(\d+)$/, kind: "DEFER" },
  { re: /^__bun_temp_ref_([\da-fA-F]+)\$$/, kind: "TEMP" },
  { re: /^__pb([\da-fA-F]*)$/, kind: "TEMP" },
];

function classifyGensym(name: string): { kind: string; index: number } | null {
  for (const { re, kind } of GENSYM_PATTERNS) {
    const m = name.match(re);
    if (m) return { kind, index: parseInt(m[1] ?? "0", 16) };
  }
  return null;
}

export function normalize(src: string): string {
  let ast: t.File;
  try {
    ast = parse(src, {
      sourceType: "unambiguous",
      plugins: ["typescript", "jsx"],
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
    });
  } catch (e) {
    // If we can't parse, return the source verbatim — the caller's diff
    // surfaces this with the parse error preserved.
    return src;
  }

  // Step 1: strip TS-only nodes (canonical emits plain JS; standalone
  // preserves type annotations because TSC isn't in our pipeline).
  stripTypeScript(ast);

  // Step 2: unwrap canonical's IIFE signal initializer wrappers —
  // `signals.signal((() => EXPR)())` ≡ `signals.signal(EXPR)`.
  unwrapSignalIIFE(ast);

  // Step 3: drop `import { X as X_HASH } from "bun:wrap"` (and similar
  // bare-helper imports) and rewrite the aliased call sites to bare
  // names. Mirrors how the canonical Zig parser pulls runtime helpers
  // into module scope, vs. the standalone's bare-name calls.
  normalizeWrapImports(ast);

  // Step 4: split top-level comma expressions into separate statements.
  // This collapses the difference between `(a, b);` (our paired-when
  // emit) and `a; b;` (canonical's two-statement emit).
  splitTopLevelCommaStatements(ast);

  // Step 4b: unwind the ES2024 `using` polyfill on both sides back to
  // raw `using` declarations. Canonical and standalone use different
  // helper shapes (canonical: __using + array-stack env; standalone:
  // __addDisposableResource + object env), so reducing both to the raw
  // declaration shape lets the comparison focus on the user-visible
  // semantics rather than helper plumbing.
  unwindUsingPolyfill(ast);

  // Step 5: rename gensym'd identifiers to stable per-kind indices based
  // on first-binding order.
  renameGensyms(ast);

  // Step 6: regenerate with consistent formatting.
  return generate(ast, {
    compact: false,
    concise: false,
    retainLines: false,
    minified: false,
  }).code;
}

function stripTypeScript(ast: t.File) {
  traverse(ast, {
    // Replace `EXPR as TYPE` with EXPR.
    TSAsExpression(path) {
      path.replaceWith(path.node.expression);
    },
    TSTypeAssertion(path) {
      path.replaceWith(path.node.expression);
    },
    TSNonNullExpression(path) {
      path.replaceWith(path.node.expression);
    },
    // Drop variable / parameter annotations.
    Identifier(path) {
      if ((path.node as any).typeAnnotation) (path.node as any).typeAnnotation = null;
      if ((path.node as any).optional) (path.node as any).optional = null;
    },
    // Drop type-only declarations entirely.
    "TSInterfaceDeclaration|TSTypeAliasDeclaration|TSDeclareFunction|TSDeclareMethod"(path) {
      path.remove();
    },
    // Strip return-type annotations on functions and arrows.
    Function(path) {
      if ((path.node as any).returnType) (path.node as any).returnType = null;
      if ((path.node as any).typeParameters) (path.node as any).typeParameters = null;
    },
  });
}

function unwrapSignalIIFE(ast: t.File) {
  // Pattern: CallExpression(callee=ArrowFunctionExpression(params=[], body=EXPR), arguments=[])
  // — i.e., `(() => EXPR)()` evaluating to EXPR. Replace with the body.
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (path.node.arguments.length !== 0) return;
      if (!t.isArrowFunctionExpression(callee)) return;
      if (callee.params.length !== 0) return;
      const body = callee.body;
      if (t.isExpression(body)) {
        path.replaceWith(body);
      }
      // For block bodies (function-style arrows), leave as-is.
    },
  });
}

function normalizeWrapImports(ast: t.File) {
  // First pass: collect alias maps from `import { X as Y } from "bun:wrap"`.
  const aliasToOriginal = new Map<string, string>();
  const importsToRemove: any[] = [];
  traverse(ast, {
    ImportDeclaration(path) {
      const src = path.node.source.value;
      if (src !== "bun:wrap") return;
      for (const spec of path.node.specifiers) {
        if (t.isImportSpecifier(spec)) {
          const importedName = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
          aliasToOriginal.set(spec.local.name, importedName);
        }
      }
      importsToRemove.push(path);
    },
  });
  for (const p of importsToRemove) p.remove();
  if (aliasToOriginal.size === 0) return;
  // Second pass: rewrite all references to the aliased names.
  traverse(ast, {
    Identifier(path) {
      const target = aliasToOriginal.get(path.node.name);
      if (target) path.node.name = target;
    },
  });
}

function splitTopLevelCommaStatements(ast: t.File) {
  // Walk every block (Program + BlockStatement) and replace any
  // ExpressionStatement whose expression is a top-level SequenceExpression
  // with N separate ExpressionStatements.
  traverse(ast, {
    "Program|BlockStatement"(path) {
      const body = (path.node as any).body as t.Statement[];
      const out: t.Statement[] = [];
      for (const stmt of body) {
        if (t.isExpressionStatement(stmt) && t.isSequenceExpression(stmt.expression)) {
          for (const expr of stmt.expression.expressions) {
            out.push(t.expressionStatement(expr));
          }
        } else {
          out.push(stmt);
        }
      }
      (path.node as any).body = out;
    },
  });
}

// Recognize the env-decl that the canonical / standalone polyfills emit
// just before their try/catch/finally block. Two shapes:
//   canonical: `let __X = [];` (array stack, error vars are siblings)
//   standalone: `const __X = { stack: [], error: undefined, hasError: false };`
function envDeclName(stmt: t.Statement): string | null {
  if (!t.isVariableDeclaration(stmt)) return null;
  if (stmt.declarations.length !== 1) return null;
  const d = stmt.declarations[0]!;
  if (!t.isIdentifier(d.id)) return null;
  if (!d.init) return null;
  // Canonical shape: `let __X = []`
  if (t.isArrayExpression(d.init) && d.init.elements.length === 0) {
    return d.id.name;
  }
  // Standalone shape: `const __X = { stack: [], error: undefined, hasError: false }`
  if (t.isObjectExpression(d.init)) {
    const hasStack = d.init.properties.some(
      p => t.isObjectProperty(p) && t.isIdentifier(p.key) && p.key.name === "stack",
    );
    if (hasStack) return d.id.name;
  }
  return null;
}

// Match a `const X = HELPER(envIdent, EXPR, FLAG)` declaration where
// HELPER is `__using` (canonical) or `__addDisposableResource` (standalone).
// Returns { id, init: EXPR, async: bool } if matched, else null.
function matchUsingResourceDecl(
  stmt: t.Statement,
  envName: string,
): { id: t.LVal; init: t.Expression; async: boolean } | null {
  if (!t.isVariableDeclaration(stmt)) return null;
  if (stmt.declarations.length !== 1) return null;
  const d = stmt.declarations[0]!;
  if (!d.init || !t.isCallExpression(d.init)) return null;
  const call = d.init;
  if (!t.isIdentifier(call.callee)) return null;
  const name = call.callee.name;
  if (name !== "__using" && name !== "__addDisposableResource") return null;
  if (call.arguments.length !== 3) return null;
  const [envArg, valueArg, flagArg] = call.arguments;
  if (!t.isIdentifier(envArg) || envArg.name !== envName) return null;
  if (!t.isExpression(valueArg)) return null;
  // Async flag: canonical emits 0/1, standalone emits true/false.
  let isAsync = false;
  if (t.isBooleanLiteral(flagArg)) isAsync = flagArg.value;
  else if (t.isNumericLiteral(flagArg)) isAsync = flagArg.value !== 0;
  return { id: d.id, init: valueArg, async: isAsync };
}

// Drop the standalone's inline helper preamble: function definitions for
// __addDisposableResource and __disposeResources. Canonical imports the
// equivalents (__using / __callDispose) from "bun:wrap" and those are
// stripped by normalizeWrapImports. Symmetric removal puts both outputs
// on the same footing before structural comparison.
const POLYFILL_HELPER_FN_NAMES = new Set(["__addDisposableResource", "__disposeResources"]);

function dropInlineUsingHelpers(ast: t.File) {
  ast.program.body = ast.program.body.filter(stmt => {
    if (t.isFunctionDeclaration(stmt) && stmt.id && POLYFILL_HELPER_FN_NAMES.has(stmt.id.name)) {
      return false;
    }
    return true;
  });
}

function unwindUsingPolyfill(ast: t.File) {
  dropInlineUsingHelpers(ast);
  traverse(ast, {
    "Program|BlockStatement"(path) {
      const body = (path.node as any).body as t.Statement[];
      const out: t.Statement[] = [];
      let i = 0;
      while (i < body.length) {
        const stmt = body[i]!;
        const envName = envDeclName(stmt);
        const next = body[i + 1];
        if (envName && next && t.isTryStatement(next)) {
          // Verify the try body contains at least one `using` resource decl
          // tied to this env — otherwise this is some unrelated env-shaped
          // decl and we leave it alone.
          const tryBody = next.block.body;
          const hasMatch = tryBody.some(s => matchUsingResourceDecl(s, envName) !== null);
          if (hasMatch) {
            // Walk the try body: convert resource decls to `using`/`await using`
            // declarations, keep everything else verbatim. Drop catch + finally.
            for (const s of tryBody) {
              const m = matchUsingResourceDecl(s, envName);
              if (m) {
                const decl = t.variableDeclaration("const", [t.variableDeclarator(m.id, m.init)]);
                // Babel doesn't model `using` as a kind on the AST in older
                // versions — but @babel/types ≥7.21 does. Set via cast.
                (decl as any).kind = m.async ? "await using" : "using";
                out.push(decl);
              } else {
                out.push(s);
              }
            }
            i += 2;
            continue;
          }
        }
        // Drop trailing scaffolding: canonical emits sibling
        // `var __bun_temp_ref_3$, __bun_temp_ref_4$` AFTER the try block
        // for the catch's error/hasError tracking. Those are dead in our
        // normalization once the try is unwound — but we already advanced
        // past the try, so they remain as-is. Most of the time renameGensyms
        // collapses them; for safety we just leave them.
        out.push(stmt);
        i++;
      }
      (path.node as any).body = out;
    },
  });
}

function renameGensyms(ast: t.File) {
  // First pass: collect all gensym BINDING names in source order, assign
  // each to a stable rename.
  const renames = new Map<string, string>();
  const counters = new Map<string, number>();
  traverse(ast, {
    Identifier(path) {
      const name = path.node.name;
      if (renames.has(name)) return;
      const cls = classifyGensym(name);
      if (!cls) return;
      // Only rename based on a binding (declaration), not a reference.
      // For VariableDeclarator IDs and function/arrow params.
      if (path.parent && t.isVariableDeclarator(path.parent) && path.parent.id === path.node) {
        const n = counters.get(cls.kind) ?? 0;
        counters.set(cls.kind, n + 1);
        renames.set(name, `__GENSYM_${cls.kind}_${n}`);
      }
    },
  });
  // Second pass: rewrite all references.
  traverse(ast, {
    Identifier(path) {
      const target = renames.get(path.node.name);
      if (target) path.node.name = target;
    },
  });
}
