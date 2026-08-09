// @ts-nocheck: Para browser-lowering pass (canonical home; consumed by Parascape + E)
// Para Lang: `async { … }` block expressions.
//
//   async { STMTS }   →   (async () => { STMTS })()
//
// An async block runs its body in an async IIFE and evaluates to the
// resulting Promise. It's the shorthand for the ubiquitous
// `(async () => { … })()` pattern: fire-and-forget async work from a
// sync context, or `await async { … }` to inline-await a block.
//
//   // fire-and-forget from a sync handler
//   onClick={() => { async { await save(); refresh(); }; }}
//
//   // value form: `data` is a Promise
//   const data = async { const r = await fetch(url); return r.json(); };
//
//   // awaited inline
//   const json = await async { return (await fetch(url)).json(); };
//
// Why this is safe to claim: `async` must be followed by `function`,
// `(`, or an arrow parameter in valid JS/TS: `async {` is a syntax
// error today, so there's no construct to collide with. (Modelled on
// Rust's `async { … }` block, which produces a Future the same way
// this produces a Promise.)
//
// Detection is bracket / string / template / comment aware, and
// recurses into the block body so nested `async { … }` blocks lower
// too. We are careful NOT to touch:
//   async function … {       : `async` followed by `function`
//   async () => { … }        : `async` followed by `(`
//   async x => { … }         : `async` followed by an identifier
//   { async foo() {} }        : object/class async METHOD shorthand
//                                (`async` followed by the method name)
//   someAsync, asyncThing     : `async` as part of a longer identifier

const isIdentStart = c => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
const isIdentCont = c => isIdentStart(c) || (c >= "0" && c <= "9");

function skipString(src, i) {
  const q = src[i];
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === q) return i + 1;
    i++;
  }
  return i;
}

function skipTemplate(src, i) {
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") return i + 1;
    if (c === "$" && src[i + 1] === "{") {
      i = skipBalanced(src, i + 1);
      continue;
    }
    i++;
  }
  return i;
}

// Skip a balanced bracket pair starting at `i` (an opening bracket),
// recursing through strings / templates / comments. Returns the
// offset AFTER the closing bracket.
function skipBalanced(src, i) {
  const open = src[i];
  const close = open === "(" ? ")" : open === "[" ? "]" : "}";
  let depth = 1;
  i++;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i = skipString(src, i);
      continue;
    }
    if (c === "`") {
      i = skipTemplate(src, i);
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length - 1 && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    i++;
  }
  return i;
}

export function lowerAsyncBlock(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    // Pass strings / templates / comments through verbatim.
    if (c === '"' || c === "'") {
      const e = skipString(src, i);
      out += src.slice(i, e);
      i = e;
      continue;
    }
    if (c === "`") {
      const e = skipTemplate(src, i);
      out += src.slice(i, e);
      i = e;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const start = i;
      while (i < src.length && src[i] !== "\n") i++;
      out += src.slice(start, i);
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < src.length - 1 && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      out += src.slice(start, i);
      continue;
    }
    // `async` keyword as a standalone word.
    if (
      c === "a" &&
      src.startsWith("async", i) &&
      !isIdentCont(i > 0 ? src[i - 1] : "") &&
      !isIdentCont(src[i + 5] ?? "")
    ) {
      let j = i + 5;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === "{") {
        const bodyEnd = skipBalanced(src, j); // offset after `}`
        const body = src.slice(j + 1, bodyEnd - 1);
        // Recurse so nested async blocks inside the body lower too.
        out += `(async () => {${lowerAsyncBlock(body)}})()`;
        i = bodyEnd;
        continue;
      }
      // `async` not followed by `{`: a real async function /
      // arrow / method / identifier. Emit the keyword and keep
      // scanning from after it (so its body isn't re-examined as
      // a fresh top-level token, which is harmless but wasteful).
      out += "async";
      i += 5;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Svelte PreprocessorGroup. Script-only, .pui / .svelte only.
export default function lowerAsyncBlockPreprocess() {
  return {
    name: "lower-async-block",
    script({ content, filename }) {
      if (!filename?.endsWith(".pui") && !filename?.endsWith(".svelte")) return;
      if (!/\basync\s*\{/.test(content)) return;
      const out = lowerAsyncBlock(content);
      if (out === content) return;
      return { code: out };
    },
  };
}

export { lowerAsyncBlockPreprocess };
