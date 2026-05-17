// `parallel` block — fan-out promise composition with name preservation.
// `para` is an interchangeable shorthand — both keywords trigger the
// same lowering (mirrors the `fun` / `function` precedent).
//
// Two forms:
//
//   Form A — expression form:
//     parallel { user: fetchUser(id), posts: fetchPosts(id) }
//     →
//     Promise.all([fetchUser(id), fetchPosts(id)])
//       .then(([__pb0, __pb1]) => ({ user: __pb0, posts: __pb1 }))
//
//   Form B — statement form:
//     parallel let user = fetchUser(id), posts = fetchPosts(id);
//     →
//     const [user, posts] = await Promise.all([fetchUser(id), fetchPosts(id)]);
//
// Disambiguation:
//   - `parallel let` / `parallel const` (or `para let` / `para const`)
//     → statement form (decl list)
//   - `parallel {` (or `para {`) → expression form (object literal of promises)
//   - any other continuation leaves the keyword as a plain identifier.
//
// In Form B, `let` is kept as the surface keyword (mirrors the multi-decl
// `let a=…, b=…` shape) but the lowering uses `const` because the binding
// is an awaited tuple — rebinding doesn't fit. The names ARE in scope as
// `const`s after the statement.
//
// In Form A, the body is an OBJECT LITERAL — keys are identifier or string,
// values are expressions. NOT a block of statements.

import { findMatchingBrace, scanRegions } from "../lex";
import { transformErrorChain } from "./error-chain";

export function transformParallel(src: string): string {
  // Statement form must run BEFORE expression form: a `parallel let …` line
  // contains an `=` whose RHS is an expression — if expression form ran
  // first and the keyword scan was lax, we could mis-fire on something like
  // `parallel { x: 1 }` followed by an unrelated `let`. They're independent
  // shapes today, but ordering keeps the door closed.
  let out = transformStatementForm(src);
  out = transformExpressionForm(out);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Form B — `parallel let|const NAME = EXPR, …;`
// ─────────────────────────────────────────────────────────────────────────

function transformStatementForm(src: string): string {
  const spans = scanRegions(src);
  const findSpan = (pos: number) => spans.find(s => pos >= s.start && pos < s.end);
  const inCode = (pos: number) => findSpan(pos)?.region === "code";

  // Match `parallel` (or `para` shorthand) followed by `let` or `const`
  // at a statement boundary. The leading group anchors to start-of-input
  // or a statement-terminating char (same shape as signal/derived).
  const re = /(^|[;\n{}])(\s*)(?:parallel|para)\s+(let|const)\s+/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const matchStart = m.index + m[1]!.length + m[2]!.length;
    if (!inCode(matchStart)) continue;
    const matchEnd = re.lastIndex;
    // Parse comma-separated decls until end of statement.
    const decls: { name: string; rhs: string }[] = [];
    let i = matchEnd;
    while (i < src.length) {
      // Each decl: NAME [: TS_TYPE] = EXPR
      // Skip whitespace.
      while (i < src.length && /\s/.test(src[i]!)) i++;
      // Capture name.
      const nameStart = i;
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i]!)) i++;
      const name = src.slice(nameStart, i);
      if (!name) break;
      // Optional TS type annotation: `: TYPE` — skip until `=` at depth 0.
      while (i < src.length && /\s/.test(src[i]!)) i++;
      if (src[i] === ":") {
        // skip until `=` at depth 0
        i++;
        let depth = 0;
        while (i < src.length) {
          if (!inCode(i)) {
            const span = findSpan(i);
            i = span ? span.end : i + 1;
            continue;
          }
          const c = src[i]!;
          if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
          else if (c === ")" || c === "]" || c === "}" || c === ">") depth--;
          else if (depth === 0 && c === "=") break;
          i++;
        }
      }
      // Now must be on `=`.
      if (src[i] !== "=") {
        // Malformed; bail (the source goes through unchanged from this point).
        return src;
      }
      i++; // consume `=`
      // Capture RHS up to top-level `,` or `;` or `\n`.
      let depth = 0;
      const rhsStart = i;
      while (i < src.length) {
        if (!inCode(i)) {
          const span = findSpan(i);
          i = span ? span.end : i + 1;
          continue;
        }
        const c = src[i]!;
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
        else if (depth === 0 && (c === "," || c === ";" || c === "\n")) break;
        i++;
      }
      const rhs = src.slice(rhsStart, i).trim();
      decls.push({ name, rhs });
      // Either continue past `,` or stop.
      if (i < src.length && src[i] === ",") {
        i++;
        continue;
      }
      break;
    }
    if (decls.length === 0) {
      // Empty `parallel let;` — leave as a parse error from downstream JS.
      // We don't rewrite, the source flows through unchanged for this match.
      continue;
    }
    // Emit:  const [n1, n2] = await Promise.all([rhs1, rhs2]);
    //
    // Apply error-chain (and any other per-RHS desugaring that's order-
    // sensitive) to each RHS BEFORE joining with `, `. We can't let the
    // join string flow into transformErrorChain unprotected — that pass
    // doesn't treat top-level `,` as a chain boundary, so multiple
    // `..!`-bearing RHSes would collapse into one `.catch(…, …)` call.
    const names = decls.map(d => d.name).join(", ");
    const rhss = decls.map(d => transformErrorChain(d.rhs)).join(", ");
    out += src.slice(last, matchStart);
    out += `const [${names}] = await Promise.all([${rhss}])`;
    last = i; // trailing `;` / `\n` carries over
    re.lastIndex = i;
  }
  out += src.slice(last);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Form A — `parallel { key: expr, … }`
// ─────────────────────────────────────────────────────────────────────────

function transformExpressionForm(src: string): string {
  const spans = scanRegions(src);
  const findSpan = (pos: number) => spans.find(s => pos >= s.start && pos < s.end);
  const inCode = (pos: number) => findSpan(pos)?.region === "code";

  // `parallel` (or `para` shorthand) at any position, immediately
  // followed (whitespace allowed) by `{`. We don't restrict to statement
  // boundaries — expression form can show up after `await`, `=`, `(`,
  // `,`, `:` in an object, etc. The safety check is `inCode(matchStart)`
  // — we never fire inside strings/comments.
  const re = /\b(?:parallel|para)(\s*)\{/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const matchStart = m.index;
    if (!inCode(matchStart)) continue;
    // Validate `parallel` is a standalone token — the prior char must not
    // be an identifier char (the `\b` does the trailing side already).
    const prior = matchStart > 0 ? src[matchStart - 1]! : "";
    if (/[A-Za-z0-9_$]/.test(prior)) continue;
    const openBrace = re.lastIndex - 1;
    const closeBrace = findMatchingBrace(src, openBrace);
    if (closeBrace === -1) continue;
    const body = src.slice(openBrace + 1, closeBrace);
    const props = parseObjectBody(body);
    if (props === null) continue;
    out += src.slice(last, matchStart);
    out += emitParallelObject(props);
    last = closeBrace + 1;
    re.lastIndex = last;
  }
  out += src.slice(last);
  return out;
}

type ParallelProp = {
  /** The key text — either an identifier, a string literal (including
   *  quotes), or a computed `[expr]` form. */
  key: string;
  /** Whether the key is a plain identifier (so it can show up bare on
   *  both sides of the rewrite) or needs quoting in the output object. */
  identifierKey: string | null;
  value: string;
};

function parseObjectBody(body: string): ParallelProp[] | null {
  // Walk top-level entries of an object body. Each entry: KEY ':' VALUE.
  // KEY: identifier, "string", 'string', `template`, or [computed].
  // VALUE: any expression up to the next top-level `,` (or end of body).
  const props: ParallelProp[] = [];
  let i = 0;
  while (i < body.length) {
    // Skip leading whitespace.
    while (i < body.length && /\s/.test(body[i]!)) i++;
    if (i >= body.length) break;
    // Parse key.
    let key = "";
    let identifierKey: string | null = null;
    const c = body[i]!;
    if (c === '"' || c === "'") {
      // String literal key.
      const quote = c;
      const start = i;
      i++;
      while (i < body.length) {
        if (body[i] === "\\") {
          i += 2;
          continue;
        }
        if (body[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      key = body.slice(start, i);
    } else if (c === "[") {
      // Computed key — span up to matching `]`.
      const start = i;
      i++;
      let depth = 1;
      while (i < body.length && depth > 0) {
        const cc = body[i]!;
        if (cc === "[") depth++;
        else if (cc === "]") depth--;
        i++;
      }
      key = body.slice(start, i);
    } else if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      while (i < body.length && /[A-Za-z0-9_$]/.test(body[i]!)) i++;
      key = body.slice(start, i);
      identifierKey = key;
    } else {
      // Unrecognized key shape — bail.
      return null;
    }
    // Expect `:`.
    while (i < body.length && /\s/.test(body[i]!)) i++;
    if (body[i] !== ":") return null;
    i++;
    // Capture value up to next top-level `,`.
    let depth = 0;
    const valStart = i;
    while (i < body.length) {
      const cc = body[i]!;
      if (cc === "(" || cc === "[" || cc === "{") depth++;
      else if (cc === ")" || cc === "]" || cc === "}") depth--;
      else if (depth === 0 && cc === ",") break;
      // Skip strings/templates so commas inside them don't break the scan.
      if (cc === '"' || cc === "'") {
        const q = cc;
        i++;
        while (i < body.length) {
          if (body[i] === "\\") {
            i += 2;
            continue;
          }
          if (body[i] === q) {
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      if (cc === "`") {
        i++;
        while (i < body.length) {
          if (body[i] === "\\") {
            i += 2;
            continue;
          }
          if (body[i] === "`") {
            i++;
            break;
          }
          // Template interpolation: skip ${ … } using brace matching.
          if (body[i] === "$" && body[i + 1] === "{") {
            i += 2;
            let bd = 1;
            while (i < body.length && bd > 0) {
              if (body[i] === "{") bd++;
              else if (body[i] === "}") bd--;
              if (bd === 0) {
                i++;
                break;
              }
              i++;
            }
            continue;
          }
          i++;
        }
        continue;
      }
      i++;
    }
    const value = body.slice(valStart, i).trim();
    if (!value) return null;
    props.push({ key, identifierKey, value });
    if (i < body.length && body[i] === ",") {
      i++;
      continue;
    }
    break;
  }
  return props;
}

function emitParallelObject(props: ParallelProp[]): string {
  if (props.length === 0) {
    // Empty — `parallel {}` resolves to `{}`.
    return `Promise.all([]).then(() => ({}))`;
  }
  // Per-value error-chain pass for the same reason as the statement form
  // above: a value carrying `..!` can't be safely joined with `,` and
  // then handed to transformErrorChain.
  const valueArray = props.map(p => transformErrorChain(p.value)).join(", ");
  const tempNames = props.map((_, i) => `__pb${i}`).join(", ");
  const objectShape = props
    .map((p, i) => {
      const k = p.identifierKey ?? p.key;
      // For identifier keys, shorthand-eligible only when name matches the
      // temp name — ours never do, so always emit `key: __pbN`.
      return `${k}: __pb${i}`;
    })
    .join(", ");
  return `Promise.all([${valueArray}]).then(([${tempNames}]) => ({ ${objectShape} }))`;
}
