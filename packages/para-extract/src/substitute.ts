/**
 * Source-to-source substitution of `ts<import('./x').T>` extraction
 * directives (para-ts-extractor-plan.md step 6, build-step side).
 *
 * Two site forms in `.pts` source:
 *   fresh:       schema NAME = ts<import("SPEC").TYPE>
 *   substituted: schema NAME = /* ts<import("SPEC").TYPE> *​/ { …body… }
 *
 * Both rewrite to the substituted form with a freshly extracted body, so
 * the directive survives as a comment marker and re-running refreshes the
 * committed body (same philosophy as scripts/codegen.ts: generated
 * artifacts are committed, the tool keeps them in sync, `--check` fails
 * on drift). Extraction is deterministic, so substitution is idempotent.
 *
 * All ts-sites in one file automatically become each other's `siblings`,
 * so mutual recursion across two directives links through registry
 * `$ref`s without any manual wiring.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createExtractorProgram, extractType } from "./index.ts";

export interface TsSite {
  declName: string;
  specifier: string;
  typeName: string;
}

export interface SubstituteResult {
  code: string;
  changed: boolean;
  sites: TsSite[];
}

// Matches `schema[ (config) ] NAME =` followed by either the bare
// directive or the substituted comment marker.
const SITE_RE =
  /\b(schema(?:\s*\([^)]*\))?\s+([A-Za-z_$][\w$]*)\s*=\s*)(ts\s*<\s*import\s*\(\s*(['"])([^'"]+)\4\s*\)\s*\.\s*([A-Za-z_$][\w$]*)\s*>|\/\*\s*ts<import\((['"])([^'"]+)\7\)\.([A-Za-z_$][\w$]*)>\s*\*\/)/g;

/** Resolve an import specifier from a directive against the source file. */
const resolveSpecifier = (spec: string, fromFile: string): string => {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, base + ".ts", base + ".d.ts", resolve(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`para-extract: cannot resolve '${spec}' from '${fromFile}'`);
};

/** Serialize an extracted body as a JS object literal (bigint-safe). */
export const emitJs = (v: unknown): string => {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      return JSON.stringify(v);
    case "number":
    case "boolean":
      return String(v);
    case "bigint":
      return `${v}n`;
    case "object": {
      if (Array.isArray(v)) return `[${v.map(emitJs).join(", ")}]`;
      const entries = Object.entries(v as Record<string, unknown>).map(([k, val]) => {
        const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
        return `${key}: ${emitJs(val)}`;
      });
      return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
    }
    default:
      throw new Error(`para-extract: cannot serialize ${typeof v} in schema body`);
  }
};

/** Length of the balanced `{ … }` starting at `start` (which must be `{`). */
const balancedObjectEnd = (code: string, start: number): number => {
  let depth = 0;
  let i = start;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      i++;
      while (i < code.length && code[i] !== q) {
        if (code[i] === "\\") i++;
        i++;
      }
    } else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  throw new Error("para-extract: unbalanced braces after substitution marker");
};

export function substituteSource(source: string, filePath: string): SubstituteResult {
  interface RawSite extends TsSite {
    start: number; // start of the directive/marker (after the `NAME = ` prefix)
    end: number; // end of the directive, or of the marker + old body
  }
  const raw: RawSite[] = [];
  for (const m of source.matchAll(SITE_RE)) {
    const declName = m[2];
    const fresh = m[5] !== undefined;
    const specifier = fresh ? m[5] : m[8];
    const typeName = fresh ? m[6] : m[9];
    const start = m.index! + m[1].length;
    let end = m.index! + m[0].length;
    if (!fresh) {
      // Marker form: consume the previously substituted body too.
      const bodyStart = source.indexOf("{", end);
      if (bodyStart === -1) throw new Error("para-extract: marker without a following body");
      end = balancedObjectEnd(source, bodyStart);
    }
    raw.push({ declName, specifier, typeName, start, end });
  }
  if (raw.length === 0) return { code: source, changed: false, sites: [] };

  // One program over every referenced file; every other site in this
  // module is a sibling declaration.
  const files = [...new Set(raw.map(s => resolveSpecifier(s.specifier, filePath)))];
  const program = createExtractorProgram(files);

  let out = "";
  let cursor = 0;
  for (const site of raw) {
    const siblings: Record<string, string> = {};
    for (const other of raw) {
      if (other !== site) siblings[other.typeName] = other.declName;
    }
    const { schema } = extractType({
      file: resolveSpecifier(site.specifier, filePath),
      typeName: site.typeName,
      declName: site.declName,
      siblings,
      program,
    });
    const marker = `/* ts<import("${site.specifier}").${site.typeName}> */`;
    out += source.slice(cursor, site.start) + marker + " " + emitJs(schema);
    cursor = site.end;
  }
  out += source.slice(cursor);
  return {
    code: out,
    changed: out !== source,
    sites: raw.map(({ declName, specifier, typeName }) => ({ declName, specifier, typeName })),
  };
}
