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
 * - Recursion through a type with no Para declaration is an error: the
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
  /** Plain acyclic JSON Schema body: feed to `__paraSchemaDecl` / `schema NAME from`. */
  schema: Record<string, unknown>;
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  // The `parabun` condition resolves `@lyku/para-schema` to its EXTENDED
  // variant, where constraint brands survive as intersection types. The
  // standard variant collapses brands to bare primitives and the
  // constraint payloads would be unrecoverable.
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  customConditions: ["parabun"],
  allowImportingTsExtensions: true,
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
  /** Named types currently being structurally expanded: a hit means
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
  // Anonymous object literals get the internal `__type` symbol, not a name.
  if (sym.name === "__type" || sym.name === "__object") return undefined;
  return sym;
};

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Read one literal constraint value out of a constraint-bag property type. */
const literalValue = (t: ts.Type, checker: ts.TypeChecker): unknown => {
  if (t.flags & ts.TypeFlags.StringLiteral) return (t as ts.StringLiteralType).value;
  if (t.flags & ts.TypeFlags.NumberLiteral) return (t as ts.NumberLiteralType).value;
  if (t.flags & ts.TypeFlags.BooleanLiteral) {
    return (t as unknown as { intrinsicName: string }).intrinsicName === "true";
  }
  if (t.flags & ts.TypeFlags.BigIntLiteral) {
    const lit = (t as ts.BigIntLiteralType).value;
    const big = BigInt((lit.negative ? "-" : "") + lit.base10Value);
    // JSON-safe: the validator coerces via BigInt(x) on either shape.
    return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(big)
      : big.toString();
  }
  if (checker.isTupleType(t)) {
    return checker.getTypeArguments(t as ts.TypeReference).map(el => literalValue(el, checker));
  }
  throw new Error(
    `para-extract: constraint value must be a literal type, got '${checker.typeToString(t)}'`,
  );
};

/** Extract { key: literal } pairs from a brand's constraint bag type. */
const readConstraintBag = (bag: ts.Type, ctx: Ctx): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  // Alphabetical for byte-determinism of emitted bodies.
  const props = [...ctx.checker.getPropertiesOfType(bag)].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const prop of props) {
    const t = ctx.checker.getTypeOfSymbol(prop);
    if (t.flags & ts.TypeFlags.Undefined) continue;
    out[prop.name] = literalValue(t, ctx.checker);
  }
  return out;
};

/**
 * Merge brand constraints onto the lowered base schema in the Para
 * validator's dialect: `integer: true` switches the number type to
 * "integer"; `const: x` becomes `enum: [x]` (the validator's covered
 * subset has enum, not const); everything else copies through.
 */
const applyBrandConstraints = (
  base: Record<string, unknown>,
  constraints: Record<string, unknown>,
): Record<string, unknown> => {
  const out = { ...base };
  for (const [key, value] of Object.entries(constraints)) {
    if (key === "integer") {
      if (value === true && out.type === "number") out.type = "integer";
      continue;
    }
    if (key === "const") {
      // Intersect with an existing literal base (TS normalizes
      // `boolean & Brand` into per-literal arms: `false & {const: true}`
      // is uninhabited and must collapse to an empty enum, not `[true]`).
      out.enum = Array.isArray(out.enum) ? out.enum.filter(v => v === value) : [value];
      continue;
    }
    out[key] = value;
  }
  return out;
};

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

    // All-literal unions collapse to a single deduplicated enum
    // (brand-expanded boolean arms can repeat or be uninhabited).
    if (lowered.every(l => Array.isArray((l as { enum?: unknown[] }).enum))) {
      return { enum: [...new Set(lowered.flatMap(l => (l as { enum: unknown[] }).enum))] };
    }
    if (lowered.length === 1) return lowered[0];
    return { anyOf: lowered };
  }

  // ── intersections: decl markers, constraint brands, object merges ──────
  if (type.isIntersection()) {
    // Para declaration marker: FromDecl<T, Name> = T & { [__paraDeclBrand]: Name }.
    // The type IS the data shape of an existing Para declaration: link to
    // its registry node, never re-derive (recursion plan §3 / step 5).
    for (const m of type.types) {
      const props = checker.getPropertiesOfType(m);
      if (props.length === 1 && props[0].name.startsWith("__@") && props[0].name.includes("paraDeclBrand")) {
        const nameType = checker.getTypeOfSymbol(props[0]);
        if (!(nameType.flags & ts.TypeFlags.StringLiteral)) {
          throw new Error(
            `para-extract: FromDecl name must be a string literal, got '${checker.typeToString(nameType)}'`,
          );
        }
        const declRef = (nameType as ts.StringLiteralType).value;
        if (isRoot) {
          throw new Error(
            `para-extract: '${ctx.declName}' resolves to FromDecl<…, "${declRef}">. It already IS the Para declaration '${declRef}'; reference that declaration instead of re-extracting it`,
          );
        }
        return { $ref: "#" + declRef };
      }
    }

    // Para constraint brand: Brand<T, B> = T & { [__schemaBrand]: B }.
    // The phantom member is an object type whose single property is the
    // unique-symbol brand key; its TYPE is the constraint bag, carried as
    // literal types (StringOf<{ minLength: 3 }> etc.).
    let bag: ts.Type | undefined;
    const rest: ts.Type[] = [];
    for (const m of type.types) {
      const props = checker.getPropertiesOfType(m);
      // Unique-symbol property names mangle to `__@<escaped>@<id>`, and TS
      // escapes the brand key's leading `__` to `___`: match structurally.
      if (props.length === 1 && props[0].name.startsWith("__@") && props[0].name.includes("schemaBrand")) {
        bag = checker.getTypeOfSymbol(props[0]);
      } else {
        rest.push(m);
      }
    }
    if (bag && rest.length === 1) {
      const base = lower(rest[0], ctx) as Record<string, unknown>;
      return applyBrandConstraints(base, readConstraintBag(bag, ctx));
    }
    // Plain intersection: merge object members (properties ∪, required ∪).
    const lowered = rest.map(m => lower(m, ctx)) as Array<Record<string, unknown>>;
    if (lowered.every(l => l.type === "object")) {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const l of lowered) {
        Object.assign(properties, l.properties as Record<string, unknown>);
        for (const r of (l.required as string[]) ?? []) if (!required.includes(r)) required.push(r);
      }
      return { type: "object", properties, required };
    }
    throw new Error(
      `para-extract: unsupported intersection '${checker.typeToString(type)}' (only constraint brands and object-type merges lower in v1)`,
    );
  }

  // ── objects ──────────────────────────────────────────────────────────────
  if (flags & ts.TypeFlags.Object) {
    if (named) {
      if (named.name === "Date") return { type: "timestamptz" };
      if (named.name === "ReadonlyArray") {
        const relem = checker.getTypeArguments(type as ts.TypeReference)[0];
        return { type: "array", items: relem ? lower(relem, ctx) : {} };
      }
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
      // Degrade: the Para validator has no prefixItems. Permissive array.
      return { type: "array" };
    }

    const props = checker.getPropertiesOfType(type);
    if (props.length === 0 && type.getCallSignatures().length > 0) {
      return { type: "function" };
    }

    // Recursion through a named type with no Para declaration cannot be
    // represented: the registry has no node for the `$ref` to land on.
    if (named) {
      if (ctx.expanding.has(named)) {
        throw new Error(
          `para-extract: recursive TS type '${named.name}' has no Para declaration: ` +
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
