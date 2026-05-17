// Tiny tokenizer that's just enough to recognize string / template-literal /
// comment regions so the rewriters don't fire inside them. Not a real JS
// parser — operates on raw character sequences and tracks state with a
// simple finite-state machine. Covers the cases that matter for Para
// surface-level rewrites.

export type Region = "code" | "line-comment" | "block-comment" | "string-d" | "string-s" | "string-t" | "regex";

export type Span = { start: number; end: number; region: Region };

/**
 * Scan source and return the list of contiguous spans by region. Adjacent
 * spans never share a region (consumers can use `region === "code"` as the
 * "this is real code, rewrites can apply here" gate).
 */
export function scanRegions(src: string): Span[] {
  const spans: Span[] = [];
  let i = 0;
  let region: Region = "code";
  let regionStart = 0;
  let templateDepth = 0; // depth of nested ${} inside template literals

  const push = (end: number, next: Region) => {
    if (end > regionStart) spans.push({ start: regionStart, end, region });
    regionStart = end;
    region = next;
  };

  // Track the previous non-whitespace character to decide whether `/` starts
  // a regex literal or is the division operator. Conservative: regex is only
  // recognized after a clearly-non-value-producing token; otherwise `/` is
  // division. Misclassification is OK as long as we don't false-positive
  // Para rewrites inside a regex (the regex region brackets it).
  let prevNonWs: string = "";
  const couldStartRegex = () => {
    const c = prevNonWs;
    if (c === "") return true; // start of file
    return /[=([{,;:!&|?+\-*/%~<>^]/.test(c);
  };

  while (i < src.length) {
    const c = src[i]!;
    const c2 = src[i + 1] ?? "";
    if (region === "code") {
      if (c === "/" && c2 === "/") {
        push(i, "line-comment");
        i += 2;
        continue;
      }
      if (c === "/" && c2 === "*") {
        push(i, "block-comment");
        i += 2;
        continue;
      }
      if (c === '"') {
        push(i, "string-d");
        i++;
        continue;
      }
      if (c === "'") {
        push(i, "string-s");
        i++;
        continue;
      }
      if (c === "`") {
        push(i, "string-t");
        templateDepth = 0;
        i++;
        continue;
      }
      if (c === "/" && couldStartRegex()) {
        push(i, "regex");
        i++;
        continue;
      }
      if (!/\s/.test(c)) prevNonWs = c;
      i++;
      continue;
    }
    if (region === "line-comment") {
      if (c === "\n") {
        push(i, "code");
        continue;
      }
      i++;
      continue;
    }
    if (region === "block-comment") {
      if (c === "*" && c2 === "/") {
        i += 2;
        push(i, "code");
        continue;
      }
      i++;
      continue;
    }
    if (region === "string-d") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        push(i, "code");
        continue;
      }
      i++;
      continue;
    }
    if (region === "string-s") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "'") {
        i++;
        push(i, "code");
        continue;
      }
      i++;
      continue;
    }
    if (region === "string-t") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "$" && c2 === "{") {
        // Template literal interpolation. Push a code span for the
        // interpolated expression, tracking braces so we can detect the
        // closing `}` of the placeholder rather than any nested object.
        i += 2;
        push(i, "code");
        let braceDepth = 1;
        // Re-enter the main loop in code mode, counting braces only at
        // depth 1; when we hit the matching `}`, switch back to template.
        while (i < src.length && braceDepth > 0) {
          // Recurse into inner state via a sub-scan for correctness.
          // Simpler: scan inline, treating any { as +1 and } as -1, but
          // ALSO recognizing nested strings/comments so we don't get
          // confused by braces inside them.
          const inner = src[i]!;
          const inner2 = src[i + 1] ?? "";
          if (inner === "{") {
            braceDepth++;
            i++;
            continue;
          }
          if (inner === "}") {
            braceDepth--;
            if (braceDepth === 0) {
              push(i, "string-t");
              i++;
              continue;
            }
            i++;
            continue;
          }
          // Skip strings/comments inside the interpolation so their braces
          // aren't counted.
          if (inner === '"' || inner === "'" || inner === "`") {
            const quote = inner;
            i++;
            while (i < src.length) {
              if (src[i] === "\\") {
                i += 2;
                continue;
              }
              if (src[i] === quote) {
                i++;
                break;
              }
              i++;
            }
            continue;
          }
          if (inner === "/" && inner2 === "/") {
            while (i < src.length && src[i] !== "\n") i++;
            continue;
          }
          if (inner === "/" && inner2 === "*") {
            i += 2;
            while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
            if (i < src.length) i += 2;
            continue;
          }
          i++;
        }
        templateDepth = 0;
        continue;
      }
      if (c === "`") {
        i++;
        push(i, "code");
        templateDepth = 0;
        continue;
      }
      i++;
      continue;
    }
    if (region === "regex") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "[") {
        // character class — consume until ]
        i++;
        while (i < src.length && src[i] !== "]") {
          if (src[i] === "\\") i++;
          i++;
        }
        if (i < src.length) i++;
        continue;
      }
      if (c === "/") {
        i++;
        // flag chars
        while (i < src.length && /[a-z]/i.test(src[i]!)) i++;
        push(i, "code");
        continue;
      }
      if (c === "\n") {
        // unterminated regex — treat the `/` as division retroactively by
        // bailing back to code at this newline.
        push(i, "code");
        continue;
      }
      i++;
      continue;
    }
  }
  push(src.length, region);
  return spans;
}

/**
 * Apply `mapper` to the contents of every "code" region in `src`, leaving
 * strings/comments/regexes untouched. Mapper receives the code chunk and
 * returns the rewritten chunk; lengths can differ.
 */
export function rewriteCodeRegions(src: string, mapper: (code: string) => string): string {
  const spans = scanRegions(src);
  let out = "";
  for (const span of spans) {
    const chunk = src.slice(span.start, span.end);
    out += span.region === "code" ? mapper(chunk) : chunk;
  }
  return out;
}

/**
 * Find the position of the `}` that matches the `{` at `openPos`, walking
 * through nested braces. Skips braces inside strings, comments, and regex
 * literals using the same scanner as `scanRegions`. Returns -1 if no match.
 *
 * Caller passes `src` (the full source) and the position of an opening `{`.
 * The returned position points at the matching `}`.
 */
export function findMatchingBrace(src: string, openPos: number): number {
  if (src[openPos] !== "{") return -1;
  const spans = scanRegions(src);
  // Index spans by start for fast lookup of which region a position is in.
  const regionAt = (pos: number): Region => {
    // Binary search would be faster; linear is fine for our sizes.
    for (const span of spans) {
      if (pos >= span.start && pos < span.end) return span.region;
    }
    return "code";
  };
  let depth = 1;
  let i = openPos + 1;
  while (i < src.length) {
    if (regionAt(i) !== "code") {
      // Skip to the end of the non-code region.
      const span = spans.find(s => i >= s.start && i < s.end)!;
      i = span.end;
      continue;
    }
    const c = src[i]!;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}
