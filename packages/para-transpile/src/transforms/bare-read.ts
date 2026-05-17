// Bare-read sugar — the scope-aware transform.
//
// After the structural transforms run, source like:
//   signal count = 0;
//   effect { console.log(count); }
//   count++;
// has been turned into:
//   const count = require("@lyku/para-signals").signal(0);
//   require("@lyku/para-signals").effect(() => { console.log(count); });
//   count++;
// — but the `count` references are still bare. The canonical Zig parser
// rewrites EVERY reference of a signal binding (not just inside tracked
// contexts):
//   - `count` (read)             → `count.get()`
//   - `count = X` (assign)       → `count.set(X)`
//   - `count++` / `count--`      → `count.set(count.get() ± 1)`
//   - `count += X` (compound)    → `count.set(count.get() + X)`
// Tracked contexts (effect / derived / when bodies) are about WHAT
// re-fires, not whether to insert `.get()` — the rewrite is unconditional.
//
// Auto-promotion: a signal initializer that reads other signals is
// converted from `signals.signal(EXPR)` to `signals.derived(() => EXPR)`,
// so the value re-derives on dep change.
//
// Implementation uses @babel/parser / @babel/traverse / @babel/generator
// for scope-aware identifier resolution. Babel's `path.scope.getBinding`
// handles shadowing, function args, block scope, etc.

import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import * as t from "@babel/types";
import generateModule from "@babel/generator";

const traverse = ((traverseModule as any).default ?? traverseModule) as typeof import("@babel/traverse").default;
const generate = ((generateModule as any).default ?? generateModule) as typeof import("@babel/generator").default;

// Tag attached to a Binding to mark it as referring to a signal cell.
const SIGNAL_FLAG = Symbol("paraSignalBinding");

export function transformBareRead(src: string): string {
  // Pre-flight gate: if no signal bindings appear, nothing to do.
  if (!src.includes('require("@lyku/para-signals").signal(') && !src.includes('require("@lyku/para-signals").derived(')) {
    return src;
  }

  let ast: t.File;
  try {
    ast = parse(src, {
      sourceType: "unambiguous",
      plugins: ["typescript", "jsx"],
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
    });
  } catch {
    return src;
  }

  let dirty = false;

  // Pass 1: identify signal-typed bindings.
  traverse(ast, {
    VariableDeclarator(path) {
      const init = path.node.init;
      if (!init) return;
      if (!isSignalCall(init) && !isDerivedCall(init)) return;
      const id = path.node.id;
      if (!t.isIdentifier(id)) return;
      const binding = path.scope.getBinding(id.name);
      if (binding) (binding as any)[SIGNAL_FLAG] = true;
    },
  });

  // Pass 2: auto-promote signal() to derived() when the initializer reads
  // other signals.
  traverse(ast, {
    VariableDeclarator(path) {
      const init = path.node.init;
      if (!init || !isSignalCall(init)) return;
      const args = (init as t.CallExpression).arguments;
      if (args.length !== 1) return;
      const expr = args[0];
      if (!t.isExpression(expr)) return;
      const declName = t.isIdentifier(path.node.id) ? path.node.id.name : null;
      if (!exprReadsSignal(expr, path.scope, declName)) return;
      const callee = (init as t.CallExpression).callee as t.MemberExpression;
      const newCallee = t.memberExpression(callee.object, t.identifier("derived"));
      const arrow = t.arrowFunctionExpression([], expr);
      const newCall = t.callExpression(newCallee, [arrow]);
      path.node.init = newCall;
      dirty = true;
    },
  });

  // Pass 3: bare-read rewrite. Visit AssignmentExpression and
  // UpdateExpression on EXIT so children (RHS, etc.) get processed by
  // the Identifier visitor first. The Identifier visitor itself skips
  // assignment LHS (Babel's isReferencedIdentifier returns false for
  // those) and explicitly skips update-expression arguments (which
  // ARE referenced but get rewritten by the UpdateExpression visitor).
  traverse(ast, {
    Identifier(path) {
      if (!path.isReferencedIdentifier()) return;
      // Skip update-expression arguments — handled by UpdateExpression below.
      if (
        path.parentPath?.isUpdateExpression() &&
        (path.parentPath.node as t.UpdateExpression).argument === path.node
      ) {
        return;
      }
      const binding = path.scope.getBinding(path.node.name);
      if (!binding || !(binding as any)[SIGNAL_FLAG]) return;
      path.replaceWith(t.callExpression(t.memberExpression(t.identifier(path.node.name), t.identifier("get")), []));
      dirty = true;
      path.skip();
    },
    AssignmentExpression: {
      exit(path) {
        const left = path.node.left;
        if (!t.isIdentifier(left)) return;
        const binding = path.scope.getBinding(left.name);
        if (!binding || !(binding as any)[SIGNAL_FLAG]) return;
        const right = path.node.right;
        let value: t.Expression;
        if (path.node.operator === "=") {
          value = right;
        } else {
          const op = path.node.operator.replace(/=$/, "") as t.BinaryExpression["operator"];
          value = t.binaryExpression(
            op,
            t.callExpression(t.memberExpression(t.identifier(left.name), t.identifier("get")), []),
            right,
          );
        }
        path.replaceWith(t.callExpression(t.memberExpression(t.identifier(left.name), t.identifier("set")), [value]));
        dirty = true;
        path.skip();
      },
    },
    UpdateExpression: {
      exit(path) {
        const arg = path.node.argument;
        if (!t.isIdentifier(arg)) return;
        const binding = path.scope.getBinding(arg.name);
        if (!binding || !(binding as any)[SIGNAL_FLAG]) return;
        // Match canonical's value semantics:
        //   pre-inc  ++x   →  (x.set(x.get() + 1), x.get())
        //   post-inc x++   →  (x.set(x.get() + 1), x.get() - 1)
        //   pre-dec  --x   →  (x.set(x.get() - 1), x.get())
        //   post-dec x--   →  (x.set(x.get() - 1), x.get() + 1)
        // The set call always uses `get()+1`/`get()-1`. The recovered
        // value depends on prefix vs postfix: prefix returns the new
        // value (just `get()`); postfix returns the OLD value, which is
        // `new ± 1` because the set already happened.
        const isInc = path.node.operator === "++";
        const setOp = isInc ? "+" : "-";
        const setCall = t.callExpression(t.memberExpression(t.identifier(arg.name), t.identifier("set")), [
          t.binaryExpression(
            setOp,
            t.callExpression(t.memberExpression(t.identifier(arg.name), t.identifier("get")), []),
            t.numericLiteral(1),
          ),
        ]);
        let recovered: t.Expression;
        const newGet = () => t.callExpression(t.memberExpression(t.identifier(arg.name), t.identifier("get")), []);
        if (path.node.prefix) {
          recovered = newGet();
        } else {
          // Post-increment / -decrement: subtract/add 1 to recover old.
          const recoverOp = isInc ? "-" : "+";
          recovered = t.binaryExpression(recoverOp, newGet(), t.numericLiteral(1));
        }
        path.replaceWith(t.sequenceExpression([setCall, recovered]));
        dirty = true;
        path.skip();
      },
    },
  });

  if (!dirty) return src;
  return generate(ast).code;
}

// ─── detection helpers ─────────────────────────────────────────────────────

function isSignalsRequireMember(node: t.Node, methodName: string): boolean {
  if (!t.isMemberExpression(node)) return false;
  if (!t.isIdentifier(node.property) || node.property.name !== methodName) return false;
  const obj = node.object;
  if (!t.isCallExpression(obj)) return false;
  if (!t.isIdentifier(obj.callee) || obj.callee.name !== "require") return false;
  if (obj.arguments.length !== 1) return false;
  const arg = obj.arguments[0];
  if (!t.isStringLiteral(arg) || arg.value !== "@lyku/para-signals") return false;
  return true;
}

function isSignalCall(node: t.Node): boolean {
  return t.isCallExpression(node) && isSignalsRequireMember(node.callee, "signal");
}

function isDerivedCall(node: t.Node): boolean {
  return t.isCallExpression(node) && isSignalsRequireMember(node.callee, "derived");
}

function exprReadsSignal(expr: t.Expression, scope: any, excludeName: string | null): boolean {
  let found = false;
  function visit(node: t.Node) {
    if (found) return;
    if (t.isIdentifier(node)) {
      if (node.name === excludeName) return;
      const b = scope.getBinding(node.name);
      if (b && (b as any)[SIGNAL_FLAG]) found = true;
      return;
    }
    if (t.isMemberExpression(node)) {
      visit(node.object);
      if (node.computed) visit(node.property as t.Node);
      return;
    }
    if (t.isObjectProperty(node)) {
      if (node.computed) visit(node.key);
      visit(node.value);
      return;
    }
    for (const key of Object.keys(node)) {
      const v = (node as any)[key];
      if (v && typeof v === "object") {
        if (Array.isArray(v)) {
          for (const item of v) {
            if (item && typeof item === "object" && "type" in item) visit(item);
          }
        } else if ("type" in v) {
          visit(v);
        }
      }
    }
  }
  visit(expr);
  return found;
}
