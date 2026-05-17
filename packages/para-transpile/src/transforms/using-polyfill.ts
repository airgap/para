// Polyfill ES2024 `using` / `await using` declarations to ES2022-compatible
// code so the standalone transpiler's output runs on Node 18/20 and pre-2024
// browsers. The shape mirrors what TypeScript / tslib emit:
//
//   {
//     using x = makeResource();
//     doWork(x);
//   }
//
// becomes
//
//   {
//     const __paraEnv0 = { stack: [], error: undefined, hasError: false };
//     try {
//       const x = __addDisposableResource(__paraEnv0, makeResource(), false);
//       doWork(x);
//     } catch (__paraErr0) {
//       __paraEnv0.error = __paraErr0;
//       __paraEnv0.hasError = true;
//     } finally {
//       __disposeResources(__paraEnv0);
//     }
//   }
//
// `await using` flips the `false` to `true` in the helper call and the
// finally block becomes `await __disposeResources(...)`. The enclosing
// function must already be async — Babel's parser rejects `await using`
// outside async context, so we don't have to validate.
//
// Helper definitions (__addDisposableResource, __disposeResources) get
// inlined at the top of every file that uses `using`, by inject-helpers.ts
// — keeps the standalone output self-contained without coupling to a
// specific shim package export. Roughly 30 lines per file, but only
// emitted when needed.

import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import * as t from "@babel/types";
import generateModule from "@babel/generator";

const traverse = ((traverseModule as any).default ?? traverseModule) as typeof import("@babel/traverse").default;
const generate = ((generateModule as any).default ?? generateModule) as typeof import("@babel/generator").default;

export function transformUsingPolyfill(src: string): string {
  // Pre-flight: skip the parse if no `using` declarations are present.
  // `using ` (with trailing space) is unique enough — JS doesn't have
  // `using` as a regular identifier in expression position commonly
  // enough to false-positive.
  if (!/\busing\s/.test(src)) return src;

  let ast: t.File;
  try {
    ast = parse(src, {
      sourceType: "unambiguous",
      plugins: ["typescript", "jsx", "explicitResourceManagement"],
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
    });
  } catch {
    return src;
  }

  let dirty = false;
  let envCounter = 0;
  let errCounter = 0;
  const newId = (prefix: string) => `__para${prefix}${envCounter++}`;
  const newErr = () => `__paraErr${errCounter++}`;

  // Walk every BlockStatement / Program body and rewrite if it contains
  // any `using` / `await using` declarations.
  traverse(ast, {
    "BlockStatement|Program"(path) {
      const body = (path.node as any).body as t.Statement[];
      const hasUsing = body.some(
        s => t.isVariableDeclaration(s) && (s.kind === "using" || (s.kind as any) === "await using"),
      );
      if (!hasUsing) return;

      const isAsync = body.some(s => t.isVariableDeclaration(s) && (s.kind as any) === "await using");
      const envName = newId("Env");
      const errName = newErr();

      // Build env decl: const __paraEnv0 = { stack: [], error: undefined, hasError: false };
      const envDecl = t.variableDeclaration("const", [
        t.variableDeclarator(
          t.identifier(envName),
          t.objectExpression([
            t.objectProperty(t.identifier("stack"), t.arrayExpression([])),
            t.objectProperty(t.identifier("error"), t.identifier("undefined")),
            t.objectProperty(t.identifier("hasError"), t.booleanLiteral(false)),
          ]),
        ),
      ]);

      // Transform each `using x = expr` into
      // `const x = __addDisposableResource(__paraEnv0, expr, async?)`.
      const transformed: t.Statement[] = [];
      for (const stmt of body) {
        if (t.isVariableDeclaration(stmt) && (stmt.kind === "using" || (stmt.kind as any) === "await using")) {
          const isAsyncDecl = (stmt.kind as any) === "await using";
          const newDeclarators = stmt.declarations.map(d =>
            t.variableDeclarator(
              d.id,
              t.callExpression(t.identifier("__addDisposableResource"), [
                t.identifier(envName),
                d.init ?? t.identifier("undefined"),
                t.booleanLiteral(isAsyncDecl),
              ]),
            ),
          );
          transformed.push(t.variableDeclaration("const", newDeclarators));
        } else {
          transformed.push(stmt);
        }
      }

      // catch clause: assign error + hasError flag.
      const catchClause = t.catchClause(
        t.identifier(errName),
        t.blockStatement([
          t.expressionStatement(
            t.assignmentExpression(
              "=",
              t.memberExpression(t.identifier(envName), t.identifier("error")),
              t.identifier(errName),
            ),
          ),
          t.expressionStatement(
            t.assignmentExpression(
              "=",
              t.memberExpression(t.identifier(envName), t.identifier("hasError")),
              t.booleanLiteral(true),
            ),
          ),
        ]),
      );

      // finally clause: __disposeResources(env) — awaited if any decl was await using.
      const disposeCall = t.callExpression(t.identifier("__disposeResources"), [t.identifier(envName)]);
      const finallyBody = t.blockStatement([
        t.expressionStatement(isAsync ? t.awaitExpression(disposeCall) : disposeCall),
      ]);

      const tryStmt = t.tryStatement(t.blockStatement(transformed), catchClause, finallyBody);
      (path.node as any).body = [envDecl, tryStmt];
      dirty = true;
    },
  });

  if (!dirty) return src;
  return generate(ast).code;
}
