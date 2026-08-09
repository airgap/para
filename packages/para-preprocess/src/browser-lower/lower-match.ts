// @ts-nocheck: Para browser-lowering pass (canonical home; consumed by Parascape + E)
 function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }
/**
 * Lower Para `match SUBJECT { p1 => r1, p2 => r2, _ => default }` to an
 * equivalent JS expression. The all-literal-patterns case is what the
 * demos use; we lower to a `((__pm) => __pm === p1 ? r1 : __pm === p2
 * ? r2 : default)(SUBJECT)` ternary chain. Non-literal patterns
 * (Ok/Err/Some/None, destructure, guards) would need the parabun
 * zig-side lowering: out of scope for the browser live-compile
 * pipeline, which is what the editable demos use.
 *
 * Brace-aware: subjects can be complex expressions ending at `{`; each
 * arm is split on top-level commas (depth-tracked across `{}/[]/()`
 * and through string/template literals). Strings, template literals,
 * and `// + /* … *\/` comments are skipped so a `match` literal inside
 * a string isn't mis-rewritten.
 */
function lowerMatch(src) {
  const out = [];
  let i = 0;
  const len = src.length;
  while (i < len) {
    // Pass through strings / template literals / comments verbatim.
    const c = src[i];
    if (c === '"' || c === "'") {
      const start = i;
      i++;
      while (i < len && src[i] !== c) {
        if (src[i] === "\\") i++;
        i++;
      }
      out.push(src.slice(start, i + 1));
      i++;
      continue;
    }
    if (c === "`") {
      const start = i;
      i++;
      while (i < len) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "`") {
          i++;
          break;
        }
        if (src[i] === "$" && src[i + 1] === "{") {
          // Recurse into ${…}
          let depth = 1;
          i += 2;
          while (i < len && depth > 0) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") depth--;
            i++;
          }
          continue;
        }
        i++;
      }
      out.push(src.slice(start, i));
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
    // `match` keyword: must be a standalone identifier, NOT a member
    // access (`str.match(/re/)`) or a longer name. The keyword form is
    // always `match SUBJECT {`, so the char before must not glue to an
    // identifier or be a `.` (member access), and the char after must be
    // whitespace separating `match` from its subject, which also rules
    // out the `.match(`/`match(` method-call shape.
    if (src.startsWith("match", i) && !/[\w$.]/.test(_nullishCoalesce(src[i - 1], () => ( ""))) && /\s/.test(_nullishCoalesce(src[i + 5], () => ( "")))) {
      // Walk the subject expression up to the `{` that opens the arms.
      // Bracket-balanced; skip over (...) and [...] so a paren-grouped
      // subject like `match (a + b) { … }` stays in one piece.
      let j = i + 5;
      while (j < len && /\s/.test(src[j])) j++;
      const subjectStart = j;
      // `match` here is a variable binding/assignment, not the keyword: a real
      // match subject (`match SUBJECT { … }`) never starts with `=`, and the
      // keyword form never follows a binding keyword. Without this guard the
      // subject walk below runs forward to an unrelated `{` (e.g. a later
      // `$effect(() => { … })`) and swallows the span, corrupting statements like
      // `let match = $state<T | undefined>(…)`. Mirror in editors/lsp/pui-transform.ts.
      if (
        src[subjectStart] === "=" ||
        /\b(?:let|const|var)\s+$/.test(src.slice(Math.max(0, i - 7), i))
      ) {
        out.push(c);
        i++;
        continue;
      }
      let depth = 0;
      while (j < len) {
        const k = src[j];
        if (k === "(" || k === "[") depth++;
        else if (k === ")" || k === "]") depth--;
        else if (k === "{" && depth === 0) break;
        else if (k === '"' || k === "'" || k === "`") {
          // skip strings
          const q = k;
          j++;
          while (j < len && src[j] !== q) {
            if (src[j] === "\\") j++;
            j++;
          }
        }
        j++;
      }
      if (j >= len || src[j] !== "{") {
        // Not a match expression (e.g. a bare `match` identifier).
        out.push(c);
        i++;
        continue;
      }
      const subject = src.slice(subjectStart, j).trim();
      const braceOpen = j;
      // Find the matching `}`.
      let bd = 1;
      let k = braceOpen + 1;
      while (k < len && bd > 0) {
        const ch = src[k];
        if (ch === '"' || ch === "'") {
          const q = ch;
          k++;
          while (k < len && src[k] !== q) {
            if (src[k] === "\\") k++;
            k++;
          }
        } else if (ch === "`") {
          // template literal: skip
          k++;
          while (k < len && src[k] !== "`") {
            if (src[k] === "\\") k++;
            k++;
          }
        } else if (ch === "{") bd++;
        else if (ch === "}") bd--;
        k++;
      }
      const armsBody = src.slice(braceOpen + 1, k - 1);
      // Split arms on top-level commas.
      const arms = [];
      let buf = "";
      let d = 0;
      for (let m = 0; m < armsBody.length; m++) {
        const ch = armsBody[m];
        if (ch === '"' || ch === "'") {
          const q = ch;
          buf += ch;
          m++;
          while (m < armsBody.length && armsBody[m] !== q) {
            if (armsBody[m] === "\\") {
              buf += armsBody[m];
              m++;
            }
            buf += armsBody[m];
            m++;
          }
          buf += _nullishCoalesce(armsBody[m], () => ( ""));
          continue;
        }
        if (ch === "{" || ch === "(" || ch === "[") d++;
        else if (ch === "}" || ch === ")" || ch === "]") d--;
        if (ch === "," && d === 0) {
          if (buf.trim()) arms.push(buf.trim());
          buf = "";
          continue;
        }
        buf += ch;
      }
      if (buf.trim()) arms.push(buf.trim());
      // Each arm: `PATTERN => RESULT`. Find the `=>` that's NOT inside
      // a nested arrow / paren / brace.
      let dflt = "undefined";
      const cases = [];
      for (const arm of arms) {
        let armDepth = 0;
        let sep = -1;
        for (let m = 0; m < arm.length - 1; m++) {
          const ch = arm[m];
          if (ch === "{" || ch === "(" || ch === "[") armDepth++;
          else if (ch === "}" || ch === ")" || ch === "]") armDepth--;
          else if (ch === "=" && arm[m + 1] === ">" && armDepth === 0) {
            sep = m;
            break;
          }
        }
        if (sep === -1) continue;
        const pat = arm.slice(0, sep).trim();
        const res = arm.slice(sep + 2).trim();
        if (pat === "_") dflt = res;
        else cases.push([pat, res]);
      }
      const ternary = cases.reduceRight((acc, [p, r]) => `__pm === ${p} ? ${r} : ${acc}`, dflt);
      out.push(`((__pm) => ${ternary})(${subject})`);
      i = k;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
}



/**
 * Svelte preprocess that lowers `match` in `<script>` blocks of .pui
 * files. Runs BEFORE parabunPreprocess in svelte.config.js so the
 * (still-published-as-stub-only) match keyword is gone by the time
 * Bun.Transpiler / Svelte's parser sees the source.
 */
export default function lowerMatchPreprocess() {
  return {
    name: "lower-match",
    script({ content, filename }) {
      if (!_optionalChain([filename, 'optionalAccess', _ => _.endsWith, 'call', _2 => _2(".pui")])) return;
      if (!/\bmatch\s+[^\s]/.test(content)) return;
      const out = lowerMatch(content);
      if (out === content) return;
      return { code: out };
    },
  };
}

export { lowerMatch };
