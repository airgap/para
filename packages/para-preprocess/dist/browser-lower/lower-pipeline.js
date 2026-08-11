// @ts-nocheck: Para browser-lowering pass (canonical home; consumed by Parascape + E)
function _nullishCoalesce(lhs, rhsFn) {
    if (lhs != null) {
        return lhs;
    }
    else {
        return rhsFn();
    }
}
function _optionalChain(ops) {
    let lastAccessLHS = undefined;
    let value = ops[0];
    let i = 1;
    while (i < ops.length) {
        const op = ops[i];
        const fn = ops[i + 1];
        i += 2;
        if ((op === "optionalAccess" || op === "optionalCall") && value == null) {
            return undefined;
        }
        if (op === "access" || op === "optionalAccess") {
            lastAccessLHS = value;
            value = fn(value);
        }
        else if (op === "call" || op === "optionalCall") {
            value = fn((...args) => value.call(lastAccessLHS, ...args));
            lastAccessLHS = undefined;
        }
    }
    return value;
}
const isIdentStart = c => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
const isIdentCont = c => isIdentStart(c) || (c >= "0" && c <= "9");
// Skip a quoted string starting at `i` (which points at the opening
// quote). Returns the offset of the character AFTER the closing quote.
function skipString(src, i) {
    const q = src[i];
    i++;
    while (i < src.length) {
        const c = src[i];
        if (c === "\\") {
            i += 2;
            continue;
        }
        if (c === q)
            return i + 1;
        i++;
    }
    return i;
}
// Skip a template literal starting at the backtick. Handles `${ … }`
// interpolations recursively so a pipeline inside an interpolation
// isn't found by mistake.
function skipTemplate(src, i) {
    i++; // past `
    while (i < src.length) {
        const c = src[i];
        if (c === "\\") {
            i += 2;
            continue;
        }
        if (c === "`")
            return i + 1;
        if (c === "$" && src[i + 1] === "{") {
            i = skipBalanced(src, i + 1); // past `}`
            continue;
        }
        i++;
    }
    return i;
}
// Skip a balanced bracket pair starting at `i` (opening bracket).
// Recurses through strings/templates/comments inside. Returns the
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
            while (i < src.length && src[i] !== "\n")
                i++;
            continue;
        }
        if (c === "/" && src[i + 1] === "*") {
            i += 2;
            while (i < src.length - 1 && !(src[i] === "*" && src[i + 1] === "/"))
                i++;
            i += 2;
            continue;
        }
        if (c === "(" || c === "[" || c === "{")
            depth++;
        else if (c === ")" || c === "]" || c === "}")
            depth--;
        i++;
    }
    return i;
}
// Find the offset of the FIRST `|>` token in `src` that isn't
// inside a string / template literal / comment. Brackets are NOT
// skipped: a pipeline can validly appear inside `()` (grouping or
// IIFE), `{}` (function / block body), or `[]` (array element).
// Returns -1 if none.
function findTopLevelPipe(src) {
    let i = 0;
    while (i < src.length) {
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
            while (i < src.length && src[i] !== "\n")
                i++;
            continue;
        }
        if (c === "/" && src[i + 1] === "*") {
            i += 2;
            while (i < src.length - 1 && !(src[i] === "*" && src[i + 1] === "/"))
                i++;
            i += 2;
            continue;
        }
        if (c === "|" && src[i + 1] === ">")
            return i;
        i++;
    }
    return -1;
}
// Walk backward from `pipePos` to find the start of the LHS expression.
// Stops at statement terminators (`;` `\n` at top level following a
// terminator), unbalanced open brackets, and the keywords / operators
// that can't legally appear inside a pipeline LHS.
function findLHSStart(src, pipePos) {
    // Walk backward from pipePos - 1, tracking bracket depth (depth
    // INCREASES as we go back through closing brackets, decreases at
    // opening brackets). When we see an opening bracket with depth=0,
    // the LHS started AFTER that bracket: return one past the bracket.
    let i = pipePos - 1;
    let depth = 0;
    // Skip trailing whitespace just before `|>`.
    while (i >= 0 && /\s/.test(src[i]))
        i--;
    // Now walk back through the expression body.
    const stopAtTopLevel = new Set([";", ",", "?", ":"]);
    while (i >= 0) {
        const c = src[i];
        // Closing bracket → enter that bracketed group
        if (c === ")" || c === "]" || c === "}") {
            depth++;
            i--;
            continue;
        }
        if (c === "(" || c === "[" || c === "{") {
            if (depth === 0)
                return i + 1; // LHS starts right after this open bracket
            depth--;
            i--;
            continue;
        }
        if (depth > 0) {
            i--;
            continue;
        }
        // At depth 0: check string / template (skip backward through them).
        if (c === '"' || c === "'") {
            // walk back to the matching opening quote
            const q = c;
            i--;
            while (i >= 0) {
                if (src[i] === q && src[i - 1] !== "\\") {
                    i--;
                    break;
                }
                i--;
            }
            continue;
        }
        if (c === "`") {
            // walk back through ${} interpolations is complex, assume the
            // template is opaque and just find its matching backtick.
            i--;
            while (i >= 0 && src[i] !== "`")
                i--;
            i--;
            continue;
        }
        if (stopAtTopLevel.has(c))
            return i + 1;
        // `=` ends LHS unless it's part of `==` `===` `!=` `<=` `>=`
        if (c === "=") {
            const prev = src[i - 1];
            if (prev === "=" || prev === "!" || prev === "<" || prev === ">") {
                // == / === / != / <= / >= are operators, continue past them
                i--;
                continue;
            }
            // Assignment: LHS starts after this `=`
            return i + 1;
        }
        // Keywords that bound the LHS: return / await / yield / => / `in` / `of`
        // Check if the previous chars form one of these: scan back over
        // an identifier and compare.
        if (isIdentCont(c)) {
            let j = i;
            while (j >= 0 && isIdentCont(src[j]))
                j--;
            const word = src.slice(j + 1, i + 1);
            if (word === "return" ||
                word === "await" ||
                word === "yield" ||
                word === "throw" ||
                word === "typeof" ||
                word === "new" ||
                word === "delete" ||
                word === "void" ||
                word === "in" ||
                word === "of" ||
                word === "instanceof") {
                return i + 1; // LHS starts AFTER this keyword
            }
            i = j;
            continue;
        }
        // Arrow `=>`: already handled by `=` case via the equal sign,
        // but `>` alone here means a comparison.
        i--;
    }
    return 0;
}
// Walk forward from `start` to find the END of the RHS expression.
// Consumes an identifier path, an optional argument list, then any
// trailing `.foo(…)` / `[…]` accesses.
function findRHSEnd(src, start) {
    let i = start;
    // skip leading whitespace
    while (i < src.length && /\s/.test(src[i]))
        i++;
    // leading-`.` shorthand: consume the dotted chain
    if (src[i] === ".") {
        // consume `.ident(.ident…)?(args)?` chain
        while (i < src.length) {
            // skip ws
            while (i < src.length && /\s/.test(src[i]))
                i++;
            if (src[i] === ".") {
                i++;
                while (i < src.length && isIdentCont(src[i]))
                    i++;
                continue;
            }
            if (src[i] === "(" || src[i] === "[") {
                i = skipBalanced(src, i);
                continue;
            }
            break;
        }
        return i;
    }
    // identifier (possibly dotted) followed by optional call
    if (!isIdentStart(_nullishCoalesce(src[i], () => "")))
        return i;
    while (i < src.length && isIdentCont(src[i]))
        i++;
    // dotted path `a.b.c`
    while (src[i] === ".") {
        i++;
        while (i < src.length && isIdentCont(src[i]))
            i++;
    }
    // optional call arguments
    while (i < src.length) {
        const c = src[i];
        if (c === "(" || c === "[") {
            i = skipBalanced(src, i);
            continue;
        }
        if (c === ".") {
            i++;
            while (i < src.length && isIdentCont(src[i]))
                i++;
            continue;
        }
        break;
    }
    return i;
}
// Given a piped LHS and RHS source slice, produce the lowered call
// expression. RHS is one of:
//   .method(args…)   →  (lhs).method(args…)
//   .prop            →  (lhs).prop
//   fn(args…)        →  fn(lhs, args…)            (default placeholder
//                                                  is first arg)
//   fn(_, args…)     →  fn(lhs, args…)            (explicit underscore)
//   fn               →  fn(lhs)
// True iff `lhs` doesn't need an extra `( … )` wrap before a method
// call appended to it. The rule: `.` and `()` and `[]` bind tighter
// than anything else, so a chain that's ONLY identifiers, dotted
// accesses, calls, and subscripts can take a `.method()` suffix
// directly. Composite expressions (`a + b`, ternaries, etc.) need
// wrapping because `.method()` would bind too tightly. This matters
// for fusion: a chain like `x.a().b().c()` collapses into a single
// fusable run, but `((x.a()).b()).c()` looks like three separate
// one-call chains and fusion gives up.
function lhsBindsTight(lhs) {
    const t = lhs.trim();
    if (t.length === 0)
        return false;
    let i = 0;
    // First token must be an identifier or a parenthesised expression.
    if (t[i] === "(") {
        const end = skipBalanced(t, i);
        if (end < 0)
            return false;
        i = end;
    }
    else if (isIdentStart(t[i] ?? "")) {
        while (i < t.length && isIdentCont(t[i]))
            i++;
    }
    else {
        return false;
    }
    // After the head: any sequence of `.ident`, `(args)`, `[idx]`.
    while (i < t.length) {
        const c = t[i];
        if (c === ".") {
            i++;
            while (i < t.length && isIdentCont(t[i]))
                i++;
            continue;
        }
        if (c === "(" || c === "[") {
            const end = skipBalanced(t, i);
            if (end < 0)
                return false;
            i = end;
            continue;
        }
        // Anything else (operator, whitespace, etc.) → not tight.
        return false;
    }
    return true;
}
function fold(lhs, rhs) {
    const rhsT = rhs.trim();
    if (rhsT.startsWith(".")) {
        return lhsBindsTight(lhs) ? `${lhs}${rhsT}` : `(${lhs})${rhsT}`;
    }
    // Find `(` start of arg list, if any. The identifier path itself
    // can contain `.` (a.b.c).
    let i = 0;
    while (i < rhsT.length && (isIdentCont(rhsT[i]) || rhsT[i] === "."))
        i++;
    const name = rhsT.slice(0, i);
    const rest = rhsT.slice(i).trim();
    if (!rest.startsWith("(")) {
        // bare identifier
        return `${name}(${lhs})`;
    }
    // strip outer parens, splice lhs in
    const inner = rest.slice(1, -1).trim();
    if (inner.length === 0)
        return `${name}(${lhs})`;
    // Replace standalone `_` placeholder with lhs if present.
    const placeholderRe = /(^|[\s,(])_(?=$|[\s,)])/;
    if (placeholderRe.test(inner)) {
        return `${name}(${inner.replace(placeholderRe, (_m, lead) => `${lead}${lhs}`)})`;
    }
    return `${name}(${lhs}, ${inner})`;
}
// Locate every pipeline CHAIN in the source and return its bounds
// plus the lowered form, so the demo viewer can attach a hover
// tooltip showing what `expr |> fn(args) |> .method()` fuses to.
//
// We group adjacent `|>` occurrences by shared LHS-start: every
// `|>` in the chain `a |> b |> c` walks back to the same statement
// start (since findLHSStart stops at statement / assignment / arrow
// boundaries, not at `|>` itself). The chain range is
// [first-LHS-start, last-RHS-end], and the lowered form is
// `lowerPipeline(src.slice(start, end))`.
export function findPipelineChains(src) {
    const sites = [];
    let scan = 0;
    while (true) {
        const rel = findTopLevelPipe(src.slice(scan));
        if (rel < 0)
            break;
        const pipe = scan + rel;
        sites.push({
            pipe,
            lhs: findLHSStart(src, pipe),
            rhs: findRHSEnd(src, pipe + 2),
        });
        scan = pipe + 2;
    }
    const groups = [];
    for (const s of sites) {
        const last = groups[groups.length - 1];
        if (last && last.start === s.lhs) {
            last.end = Math.max(last.end, s.rhs);
        }
        else {
            groups.push({ start: s.lhs, end: s.rhs });
        }
    }
    return groups.map(g => {
        const original = src.slice(g.start, g.end);
        return {
            start: g.start,
            end: g.end,
            original: original.trim(),
            lowered: lowerPipeline(original).trim(),
        };
    });
}
export function lowerPipeline(src) {
    // Iterative left-most-pipe lowering. Each pass rewrites one `|>`;
    // the result is fed back in until no top-level pipes remain.
    for (let safety = 0; safety < 256; safety++) {
        const pos = findTopLevelPipe(src);
        if (pos < 0)
            return src;
        const lhsStart = findLHSStart(src, pos);
        const rhsEnd = findRHSEnd(src, pos + 2);
        const lhs = src.slice(lhsStart, pos).trim();
        const rhs = src.slice(pos + 2, rhsEnd);
        if (lhs.length === 0 || rhs.trim().length === 0) {
            // Malformed: bail out to avoid infinite loop.
            return src;
        }
        const folded = fold(lhs, rhs);
        src = src.slice(0, lhsStart) + folded + src.slice(rhsEnd);
    }
    return src;
}
// PreprocessorGroup that wraps lowerPipeline. Runs on every script
// block (both `<script lang="pts">` and `<script lang="ts">` so a
// scenario can pipe in either dialect). Markup currently isn't
// scanned: pipelines in event handler attributes (`onclick={a |> b}`)
// would need a markup pass; defer until a demo actually wants that.
export default function lowerPipelinePreprocess() {
    return {
        name: "lower-pipeline",
        script({ content, filename }) {
            if (!_optionalChain([filename, "optionalAccess", _ => _.endsWith, "call", _2 => _2(".pui")]) &&
                !_optionalChain([filename, "optionalAccess", _3 => _3.endsWith, "call", _4 => _4(".svelte")]))
                return;
            if (!content.includes("|>"))
                return;
            const out = lowerPipeline(content);
            if (out === content)
                return;
            return { code: out };
        },
    };
}
export { lowerPipelinePreprocess };
