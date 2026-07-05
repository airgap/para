/**
 * Checker-driven TS → Para schema extractor.
 *
 * Build-order steps 1–3 of para-ts-extractor-plan.md: program/checker
 * skeleton, structural lowering (objects / primitives / optionals /
 * arrays / literal unions / template literals), and recursion → registry
 * `$ref` emission with mutual-recursion linkage via `siblings`.
 *
 * Rules (recursion plan §3):
 * - TS-derived schemas are pure structure, always acyclic-capable-none.
 *   Capability modifiers live on the wrapping Para declaration.
 * - Self-references lower to module-relative `{ $ref: "#<declName>" }`;
 *   references to types listed in `siblings` lower to their Para
 *   declaration's `$ref` and are never re-derived (non-propagation).
 * - Recursion through a type with no Para declaration is an error — the
 *   registry has no node to point at.
 * - Determinism: two extractions of the same type yield byte-identical
 *   bodies (property order = source declaration order).
 */
import ts from "typescript";

export interface ExtractOptions {
  /** Path to the .ts / .d.ts file declaring the type. */
  file: string;
  /** Exported interface / type-alias name to extract. */
  typeName: string;
  /**
   * Para declaration name wrapping this extraction (`schema NAME = ts<…>`).
   * Self-references become `{ $ref: "#NAME" }`. Defaults to `typeName`.
   */
  declName?: string;
  /**
   * Other TS types (by name) that have their own Para declarations in the
   * same module: TS type name → Para declaration name. References link to
   * the existing registry node instead of re-deriving.
   */
  siblings?: Record<string, string>;
  /** Reuse an existing program for batch extraction. */
  program?: ts.Program;
}

export interface ExtractResult {
  /** Plain acyclic JSON Schema body — feed to `__paraSchemaDecl` / `schema NAME from`. */
  schema: Record<string, unknown>;
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  noEmit: true,
};

export function createExtractorProgram(files: string[]): ts.Program {
  return ts.createProgram(files, COMPILER_OPTIONS);
}

export function extractType(opts: ExtractOptions): ExtractResult {
  const program = opts.program ?? createExtractorProgram([opts.file]);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(opts.file);
  if (!sf) throw new Error(`para-extract: cannot load source file '${opts.file}'`);

  const moduleSymbol = checker.getSymbolAtLocation(sf);
  if (!moduleSymbol) {
    throw new Error(`para-extract: '${opts.file}' has no module exports (add an export to the file)`);
  }
  const exportSym = checker
    .getExportsOfModule(moduleSymbol)
    .find(s => s.name === opts.typeName);
  if (!exportSym) {
    throw new Error(`para-extract: type '${opts.typeName}' is not exported from '${opts.file}'`);
  }

  const rootSym = resolveAlias(checker, exportSym);
  const rootType = checker.getDeclaredTypeOfSymbol(rootSym);
  const ctx: Ctx = {
    checker,
    declName: opts.declName ?? opts.typeName,
    rootSym,
    siblings: opts.siblings ?? {},
    expanding: new Set(),
  };
  return { schema: lower(rootType, ctx, true) as Record<string, unknown> };
}

interface Ctx {
  checker: ts.TypeChecker;
  declName: string;
  rootSym: ts.Symbol;
  siblings: Record<string, string>;
  /** Named types currently being structurally expanded — a hit means
   *  recursion through a type with no Para declaration. */
  expanding: Set<ts.Symbol>;
}

const resolveAlias = (checker: ts.TypeChecker, sym: ts.Symbol): ts.Symbol =>
  sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;

/** The symbol a type is "named by", if any: alias first, then declaration symbol. */
const namedSymbolOf = (type: ts.Type): ts.Symbol | undefined => {
  if (type.aliasSymbol) return type.aliasSymbol;
  const sym = type.getSymbol();
  if (!sym) return undefined;
  // Anonymous object literals get the internal `__type` symbol — not a name.
  if (sym.name === "__type" || sym.name === "__object") return undefined;
  return sym;
};

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const HOLE_PATTERNS: Partial<Record<number, string>> = {
  [ts.TypeFlags.String]: ".*",
  [ts.TypeFlags.Number]: "-?\\d+(?:\\.\\d+)?",
  [ts.TypeFlags.BigInt]: "-?\\d+",
};

function lower(type: ts.Type, ctx: Ctx, isRoot = false): unknown {
  const { checker } = ctx;
  const flags = type.flags;

  // ── named-type routing (before any structural work) ────────────────────
  // The root call expands its own type; every LATER sighting of the root
  // symbol is a self-reference and becomes the registry `$ref`.
  const named = namedSymbolOf(type);
  if (named && !isRoot) {
    if (named === ctx.rootSym) return { $ref: "#" + ctx.declName };
    const sibling = ctx.siblings[named.name];
    if (sibling !== undefined) return { $ref: "#" + sibling };
  }

  // ── primitives / literals ───────────────────────────────────────────────
  if (flags & ts.TypeFlags.Boolean) return { type: "boolean" }; // before union: boolean = true|false internally
  if (flags & ts.TypeFlags.StringLiteral) return { enum: [(type as ts.StringLiteralType).value] };
  if (flags & ts.TypeFlags.NumberLiteral) return { enum: [(type as ts.NumberLiteralType).value] };
  if (flags & ts.TypeFlags.BooleanLiteral) {
    return { enum: [(type as unknown as { intrinsicName: string }).intrinsicName === "true"] };
  }
  if (flags & ts.TypeFlags.BigIntLiteral) {
    const lit = (type as ts.BigIntLiteralType).value;
    return { enum: [BigInt((lit.negative ? "-" : "") + lit.base10Value)] };
  }
  if (flags & ts.TypeFlags.String) return { type: "string" };
  if (flags & ts.TypeFlags.Number) return { type: "number" };
  if (flags & ts.TypeFlags.BigInt) return { type: "bigint" };
  if (flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return { enum: [null] };
  if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {};

  if (flags & ts.TypeFlags.TemplateLiteral) {
    const tl = type as ts.TemplateLiteralType;
    let pattern = "^" + escapeRegex(tl.texts[0]);
    for (let i = 0; i < tl.types.length; i++) {
      pattern += HOLE_PATTERNS[tl.types[i].flags & (ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.BigInt)] ?? ".*";
      pattern += escapeRegex(tl.texts[i + 1]);
    }
    return { type: "string", pattern: pattern + "$" };
  }

  // ── unions ───────────────────────────────────────────────────────────────
  if (type.isUnion()) {
    // Fold TS's internal true|false pair back into `boolean`.
    const members: ts.Type[] = [];
    let sawTrue = false;
    let sawFalse = false;
    for (const m of type.types) {
      if (m.flags & ts.TypeFlags.BooleanLiteral) {
        if ((m as unknown as { intrinsicName: string }).intrinsicName === "true") sawTrue = true;
        else sawFalse = true;
        continue;
      }
      members.push(m);
    }
    const lowered = members.map(m => lower(m, ctx));
    if (sawTrue && sawFalse) lowered.push({ type: "boolean" });
    else if (sawTrue) lowered.push({ enum: [true] });
    else if (sawFalse) lowered.push({ enum: [false] });

    // All-literal unions collapse to a single enum.
    if (lowered.every(l => Array.isArray((l as { enum?: unknown[] }).enum))) {
      return { enum: lowered.flatMap(l => (l as { enum: unknown[] }).enum) };
    }
    if (lowered.length === 1) return lowered[0];
    return { anyOf: lowered };
  }

  // ── objects ──────────────────────────────────────────────────────────────
  if (flags & ts.TypeFlags.Object) {
    if (named) {
      if (named.name === "Date") return { type: "timestamptz" };
      if (["Map", "Set", "WeakMap", "WeakSet"].includes(named.name)) {
        throw new Error(
          `para-extract: '${named.name}' fields are not extractable in v1 (no JSON representation in the Para schema dialect)`,
        );
      }
    }

    if (checker.isArrayType(type)) {
      const elem = (type as ts.TypeReference).typeArguments?.[0];
      return { type: "array", items: elem ? lower(elem, ctx) : {} };
    }
    if (checker.isTupleType(type)) {
      // Degrade: the Para validator has no prefixItems — permissive array.
      return { type: "array" };
    }

    const props = checker.getPropertiesOfType(type);
    if (props.length === 0 && type.getCallSignatures().length > 0) {
      return { type: "function" };
    }

    // Recursion through a named type with no Para declaration cannot be
    // represented — the registry has no node for the `$ref` to land on.
    if (named) {
      if (ctx.expanding.has(named)) {
        throw new Error(
          `para-extract: recursive TS type '${named.name}' has no Para declaration — ` +
            `declare it (\`schema ${named.name} = ts<…>\`) and list it in \`siblings\``,
        );
      }
      ctx.expanding.add(named);
    }
    try {
      // Determinism: source declaration order.
      const ordered = [...props].sort((a, b) => {
        const da = a.declarations?.[0];
        const db = b.declarations?.[0];
        if (!da || !db) return 0;
        const fa = da.getSourceFile().fileName;
        const fb = db.getSourceFile().fileName;
        return fa === fb ? da.pos - db.pos : fa < fb ? -1 : 1;
      });

      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const prop of ordered) {
        const decl = prop.declarations?.[0] ?? ctx.rootSym.declarations![0];
        let propType = checker.getTypeOfSymbolAtLocation(prop, decl);
        let optional = (prop.flags & ts.SymbolFlags.Optional) !== 0;

        // `T | undefined` / `T | null` behave as optional under the Para
        // validator (null/undefined are "absent"): strip them from the
        // emitted type and leave the field out of `required`.
        if (propType.isUnion()) {
          const kept = propType.types.filter(m => {
            if (m.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) {
              optional = true;
              return false;
            }
            return true;
          });
          if (kept.length === 1) propType = kept[0];
          else if (kept.length < propType.types.length) {
            propType = (checker as unknown as { getUnionType(types: ts.Type[]): ts.Type }).getUnionType
              ? (checker as unknown as { getUnionType(types: ts.Type[]): ts.Type }).getUnionType(kept)
              : propType;
          }
        }

        properties[prop.name] = lower(propType, ctx);
        if (!optional) required.push(prop.name);
      }
      return { type: "object", properties, required };
    } finally {
      if (named) ctx.expanding.delete(named);
    }
  }

  throw new Error(`para-extract: unsupported TS type '${checker.typeToString(type)}' (flags ${flags})`);
}
