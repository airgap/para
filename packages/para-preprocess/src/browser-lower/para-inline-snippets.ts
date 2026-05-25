// @ts-nocheck — Para browser-lowering pass (canonical home; consumed by Parascape + E)
 function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }











































const innermostScope = (state) => _nullishCoalesce(state.eachStack[state.eachStack.length - 1], () => ( state.moduleScope));
const mintName = (state) => `__para_attr_${++state.counter}`;

const ATTR_BOUNDARY_PREV = /^([=:,([?]|=>)$/;

// ─── low-level skippers ────────────────────────────────────────────────

function skipString(src, at, quote) {
  let i = at + 1;
  const len = src.length;
  while (i < len && src[i] !== quote) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    i++;
  }
  return i + 1;
}

function skipTemplate(src, at) {
  let i = at + 1;
  const len = src.length;
  while (i < len) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === "`") return i + 1;
    if (src[i] === "$" && src[i + 1] === "{") {
      i = skipBalancedBrace(src, i + 2);
      continue;
    }
    i++;
  }
  return i;
}

function skipBalancedBrace(src, at) {
  let i = at;
  let depth = 1;
  const len = src.length;
  while (i < len && depth > 0) {
    const c = src[i];
    if (c === "'" || c === '"') {
      i = skipString(src, i, c);
      continue;
    }
    if (c === "`") {
      i = skipTemplate(src, i);
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < len && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < len && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  return i;
}

/** Match the `}` for the `{` already consumed by the caller. */
function matchExprEnd(src, start) {
  const end = skipBalancedBrace(src, start);
  return end > 0 && src[end - 1] === "}" ? end - 1 : -1;
}

function matchParenEnd(src, start) {
  let i = start;
  let depth = 1;
  const len = src.length;
  while (i < len) {
    const c = src[i];
    if (c === "'" || c === '"') {
      i = skipString(src, i, c);
      continue;
    }
    if (c === "`") {
      i = skipTemplate(src, i);
      continue;
    }
    if (c === "(" || c === "{" || c === "[") {
      depth++;
      i++;
      continue;
    }
    if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0 && c === ")") return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * Skip a complete JSX/Svelte element starting at `at` (src[at] === '<').
 * Handles self-closing tags, attribute-value `{…}` expressions, nested
 * children, and matching `</Tag>` closers. Returns index AFTER `>`.
 */
function skipJsxElement(src, at) {
  const len = src.length;
  const nameMatch = /^<\s*([A-Za-z][\w.-]*)/.exec(src.slice(at));
  if (!nameMatch) return at + 1;
  const tagName = nameMatch[1];
  let i = at + nameMatch[0].length;
  let selfClosed = false;
  while (i < len) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i = skipString(src, i, c);
      continue;
    }
    if (c === "{") {
      i = skipBalancedBrace(src, i + 1);
      continue;
    }
    if (c === "/" && src[i + 1] === ">") {
      selfClosed = true;
      i += 2;
      break;
    }
    if (c === ">") {
      i++;
      break;
    }
    i++;
  }
  if (selfClosed) return i;
  const closeTag = `</${tagName}`;
  while (i < len) {
    if (src.startsWith(closeTag, i)) {
      const end = src.indexOf(">", i);
      return end === -1 ? len : end + 1;
    }
    if (src[i] === "<" && /[A-Za-z]/.test(_nullishCoalesce(src[i + 1], () => ( "")))) {
      i = skipJsxElement(src, i);
      continue;
    }
    if (src[i] === "{") {
      i = skipBalancedBrace(src, i + 1);
      continue;
    }
    i++;
  }
  return i;
}

function readArrowPrefix(src, at) {
  const len = src.length;
  let i = at;
  while (i < len && /\s/.test(src[i])) i++;
  if (src[i] !== "(") return null;
  const parenEnd = matchParenEnd(src, i + 1);
  if (parenEnd === -1) return null;
  const paramsRaw = src.slice(i + 1, parenEnd);
  let j = parenEnd + 1;
  while (j < len && /\s/.test(src[j])) j++;
  if (src[j] !== "=" || src[j + 1] !== ">") return null;
  j += 2;
  while (j < len && /\s/.test(src[j])) j++;
  return { paramsRaw, bodyStart: j };
}

function startsJsxAt(src, at) {
  let i = at;
  while (i < src.length && /\s/.test(src[i])) i++;
  return src[i] === "<" && /[A-Za-z]/.test(_nullishCoalesce(src[i + 1], () => ( "")));
}

// ─── core scanners ─────────────────────────────────────────────────────

/**
 * Walk a JS expression body and lift any inline JSX literals at
 * expression-starting positions. The JSX body itself is processed via
 * `processMarkup` so nested attribute lifts compose naturally.
 *
 * Returns the rewritten body. Lifted snippet declarations are pushed
 * onto state.moduleScope.lifted (or the innermost each scope).
 */
function processJsExpression(src, state) {
  const out = [];
  const len = src.length;
  let i = 0;
  let lastSignificant = ""; // last non-whitespace char emitted
  while (i < len) {
    const c = src[i];
    if (c === "'" || c === '"') {
      const end = skipString(src, i, c);
      out.push(src.slice(i, end));
      i = end;
      lastSignificant = _nullishCoalesce(src[end - 1], () => ( ""));
      continue;
    }
    if (c === "`") {
      const end = skipTemplate(src, i);
      out.push(src.slice(i, end));
      i = end;
      lastSignificant = "`";
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      const end = nl === -1 ? len : nl;
      out.push(src.slice(i, end));
      i = end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? len : end + 2;
      out.push(src.slice(i, stop));
      i = stop;
      continue;
    }
    // Param form `(args) => <JSX>` — only when in expression-start
    // position (so we don't mis-lift `f(...)` calls).
    const atBoundary =
      lastSignificant === "" ||
      ATTR_BOUNDARY_PREV.test(lastSignificant) ||
      lastSignificant === "(" ||
      lastSignificant === "[" ||
      lastSignificant === "{" ||
      lastSignificant === ">";
    if (c === "(" && atBoundary) {
      const arrow = readArrowPrefix(src, i);
      if (arrow && startsJsxAt(src, arrow.bodyStart)) {
        let jsxStart = arrow.bodyStart;
        while (jsxStart < len && /\s/.test(src[jsxStart])) jsxStart++;
        const jsxEnd = skipJsxElement(src, jsxStart);
        const body = src.slice(jsxStart, jsxEnd);
        const id = mintName(state);
        const processedBody = processMarkup(body, state);
        innermostScope(state).lifted.push(`{#snippet ${id}(${arrow.paramsRaw})}${processedBody}{/snippet}`);
        // Inline the snippet-marker assignment in the use site so it
        // runs BEFORE the consumer (e.g. <Table>) receives the value.
        // Pure side effect + return-self via the comma operator —
        // the consumer ends up with the same snippet reference, now
        // carrying `.__para_snippet = true`. Lets <Table>'s cell-render
        // path distinguish snippet from plain `(item)=>string` in
        // minified prod builds without relying on Function#toString.
        out.push(`(${id}.__para_snippet = true, ${id})`);
        i = jsxEnd;
        lastSignificant = "d"; // identifier-ish (so next `,` etc. behaves)
        continue;
      }
    }
    // Inline bare JSX at an expression boundary
    if (c === "<" && /[A-Za-z]/.test(_nullishCoalesce(src[i + 1], () => ( ""))) && atBoundary) {
      const end = skipJsxElement(src, i);
      const body = src.slice(i, end);
      const id = mintName(state);
      const processedBody = processMarkup(body, state);
      innermostScope(state).lifted.push(`{#snippet ${id}()}${processedBody}{/snippet}`);
      out.push(`(${id}.__para_snippet = true, ${id})`);
      i = end;
      lastSignificant = "d";
      continue;
    }
    out.push(c);
    i++;
    if (!/\s/.test(c)) lastSignificant = c;
  }
  return out.join("");
}

/**
 * Walk markup. Recognizes:
 *   • `<script>`, `<style>`, `<!-- … -->` — pass through verbatim
 *   • `{#each … as …}` / `{/each}` — open / close lift scope
 *   • `\sIDENT={…}` attribute body — hand off to processJsExpression
 *
 * Generated snippets from each handler land in `state.moduleScope` or
 * the innermost open each scope (the latter emitted just before the
 * `{/each}` close).
 */
function processMarkup(source, state) {
  const out = [];
  const len = source.length;
  let i = 0;
  while (i < len) {
    if (source.startsWith("<script", i)) {
      const close = source.indexOf("</script>", i);
      const end = close === -1 ? len : close + "</script>".length;
      out.push(source.slice(i, end));
      i = end;
      continue;
    }
    if (source.startsWith("<style", i)) {
      const close = source.indexOf("</style>", i);
      const end = close === -1 ? len : close + "</style>".length;
      out.push(source.slice(i, end));
      i = end;
      continue;
    }
    if (source.startsWith("<!--", i)) {
      const close = source.indexOf("-->", i + 4);
      const end = close === -1 ? len : close + 3;
      out.push(source.slice(i, end));
      i = end;
      continue;
    }
    // {#each …} — push a scope.
    if (source.startsWith("{#each", i)) {
      const end = source.indexOf("}", i);
      if (end === -1) {
        out.push(source[i]);
        i++;
        continue;
      }
      out.push(source.slice(i, end + 1));
      state.eachStack.push({ lifted: [] });
      i = end + 1;
      continue;
    }
    // {/each} — flush this scope's snippets just BEFORE the close,
    // so they live inside the each body and can refer to its
    // iteration bindings.
    if (source.startsWith("{/each}", i)) {
      const scope = state.eachStack.pop();
      if (scope && scope.lifted.length > 0) {
        out.push("\n");
        out.push(scope.lifted.join("\n"));
        out.push("\n");
      }
      out.push("{/each}");
      i += "{/each}".length;
      continue;
    }

    // `\sIDENT={…}` attribute trigger.
    const c = source[i];
    if (/[\s\n]/.test(c) || c === "(" || c === ",") {
      const tail = source.slice(i);
      const m = /^[\s\n]+([A-Za-z_$][\w$]*)\s*=\s*\{/.exec(tail);
      if (m) {
        const nameStart = i + m[0].indexOf(m[1]);
        const braceOpen = i + m[0].length;
        const braceClose = matchExprEnd(source, braceOpen);
        if (braceClose !== -1) {
          const body = source.slice(braceOpen, braceClose);
          const rewritten = processJsExpression(body, state);
          out.push(source.slice(i, nameStart));
          out.push(`${m[1]}={${rewritten}}`);
          i = braceClose + 1;
          continue;
        }
      }
    }
    out.push(c);
    i++;
  }
  return out.join("");
}

function lowerInlineSnippets(source) {
  const state = {
    counter: 0,
    moduleScope: { lifted: [] },
    eachStack: [],
  };
  const out = processMarkup(source, state);
  if (state.moduleScope.lifted.length === 0 && out === source) return source;
  return out + "\n\n" + state.moduleScope.lifted.join("\n");
}

export default function paraInlineSnippets() {
  return {
    name: "para-inline-snippets",
    markup({ content, filename }) {
      if (!_optionalChain([filename, 'optionalAccess', _ => _.endsWith, 'call', _2 => _2(".pui")])) return;
      const out = lowerInlineSnippets(content);
      if (out === content) return;
      return { code: out };
    },
  };
}

export { lowerInlineSnippets };
