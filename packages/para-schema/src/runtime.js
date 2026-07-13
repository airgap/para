/**
 * Portable `fromSchema` — the Para schema runtime for consumers that are NOT
 * running on ParaBun.
 *
 * ParaBun lowers `schema NAME = <body>` to `__paraSchemaDecl(...)`, whose
 * validator lives in the Bun fork (`parabun/src/runtime.bun.js`). Off that
 * runtime, ParaBun's own browser fallback is `__paraFromSchema = (s) => s` —
 * the IDENTITY function. A schema shipped to a browser or a Cloudflare Worker
 * therefore validates nothing at all.
 *
 * This module closes that hole: same JSON Schema dialect, same `Result` shape,
 * same error strings, no Bun. It is what makes a compiled Para schema usable as
 * a para-sync `parse` gate on the client and as a request gate on the edge.
 *
 * Two deliberate divergences from the Bun validator, both cases where it is
 * permissive by omission rather than by contract:
 *   - `type: "date"` is validated here. The Bun arm list has `timestamptz` but
 *     no `date`, so it falls through to "unknown type → permissive" — and
 *     `date` is exactly what lockstep's TSON conversion emits for every
 *     temporal column.
 *   - `additionalProperties: false` is enforced here. Bun ignores the keyword;
 *     a schema that never sets it is unaffected either way.
 * Every other arm accepts and rejects exactly what Bun's does, with the same
 * error string.
 *
 * Deliberately NOT ported from the Bun runtime:
 *   - the module-URL `$ref` registry, and with it the cycle/depth capability
 *     bits (`$cyclic` / `$depth`) and the escape-node check. Composition here
 *     is by EMBEDDING: a sub-schema that is itself a wrapped schema (has
 *     `.parse`) is delegated to. That covers nested models without a global
 *     registry, and it cannot express a cycle — which is the point.
 *   - the MessagePack codec (`encode`/`decode`).
 * A body carrying a string `$ref` throws rather than silently passing: a
 * reference that resolves to nothing must never read as "valid".
 */

const FORMATS = {
	email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
	uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	uri: /^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i,
	date: /^\d{4}-\d{2}-\d{2}$/,
	"date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/,
	ipv4: /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/,
	ipv6: /^([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}$|^([0-9a-f]{1,4}:){1,7}:$|^::([0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4}$|^([0-9a-f]{1,4}:){1,6}(:[0-9a-f]{1,4})+$/i,
};

const hide = (obj, key, value) =>
	Object.defineProperty(obj, key, { value, enumerable: false, writable: false, configurable: false });

/** A wrapped schema — anything carrying its own `parse`. */
const isWrapped = (s) => s != null && typeof s === "object" && typeof s.parse === "function";

/**
 * Validate `v` against JSON Schema body `s`. Returns `null` on success or a
 * human-readable error string. Arm order and error text mirror ParaBun's
 * `__paraFromSchemaEager` so a value that parses on Bun parses here.
 */
function validate(s, v) {
	if (s == null || typeof s !== "object") return null; // no constraint

	if (typeof s.$ref === "string") {
		throw new Error(
			`fromSchema: unresolved $ref "${s.$ref}" — the portable runtime has no module registry. ` +
				`Embed the referenced schema value directly instead of referencing it by name.`,
		);
	}

	// An embedded wrapped schema (a nested compiled model) validates itself.
	if (isWrapped(s)) {
		const r = s.parse(v);
		return r.tag === "Ok" ? null : r.error;
	}

	if (Array.isArray(s.anyOf)) {
		for (const arm of s.anyOf) if (validate(arm, v) === null) return null;
		return "no anyOf arm matched";
	}
	if ("const" in s) return v === s.const ? null : `expected ${JSON.stringify(s.const)}`;
	if (s.enum) {
		for (const e of s.enum) if (v === e) return null;
		return "expected one of " + JSON.stringify(s.enum);
	}

	const t = s.type;

	if (t === "string" || t === "varchar" || t === "text" || t === "char") {
		if (typeof v !== "string") return "expected string";
		if (s.minLength != null && v.length < s.minLength) return "shorter than minLength " + s.minLength;
		if (s.maxLength != null && v.length > s.maxLength) return "longer than maxLength " + s.maxLength;
		if (s.format && FORMATS[s.format] && !FORMATS[s.format].test(v)) return "expected format " + s.format;
		if (s.pattern && !new RegExp(s.pattern).test(v)) return "does not match pattern " + s.pattern;
		return null;
	}

	if (t === "integer" || t === "bigint" || t === "snowflake") {
		// Accept a BigInt (what a pg driver hands back) OR an integer-shaped
		// Number (what JSON.parse hands back). Bound checks coerce to whichever
		// shape `v` is: BigInt <-> BigInt is required, BigInt <-> Number is not.
		const isBig = typeof v === "bigint";
		if (!isBig && (typeof v !== "number" || !Number.isInteger(v))) return "expected integer";
		if (s.minimum != null && v < (isBig ? BigInt(s.minimum) : Number(s.minimum))) return "below minimum " + s.minimum;
		if (s.maximum != null && v > (isBig ? BigInt(s.maximum) : Number(s.maximum))) return "above maximum " + s.maximum;
		if (s.exclusiveMinimum != null && v <= (isBig ? BigInt(s.exclusiveMinimum) : Number(s.exclusiveMinimum)))
			return "must be > exclusiveMinimum " + s.exclusiveMinimum;
		if (s.exclusiveMaximum != null && v >= (isBig ? BigInt(s.exclusiveMaximum) : Number(s.exclusiveMaximum)))
			return "must be < exclusiveMaximum " + s.exclusiveMaximum;
		return null;
	}

	if (t === "number" || t === "numeric") {
		if (typeof v !== "number") return "expected number";
		if (s.minimum != null && v < s.minimum) return "below minimum " + s.minimum;
		if (s.maximum != null && v > s.maximum) return "above maximum " + s.maximum;
		if (s.exclusiveMinimum != null && v <= s.exclusiveMinimum) return "must be > exclusiveMinimum " + s.exclusiveMinimum;
		if (s.exclusiveMaximum != null && v >= s.exclusiveMaximum) return "must be < exclusiveMaximum " + s.exclusiveMaximum;
		return null;
	}

	if (t === "boolean" || t === "bool") return typeof v === "boolean" ? null : "expected boolean";
	if (t === "function") return typeof v === "function" ? null : "expected function";

	// `date` is what lockstep's TSON conversion emits for every temporal column
	// (date / timestamp / timestamptz). ParaBun's validator has no `date` arm, so
	// it falls through to permissive — a real hole for anything DB-derived.
	if (t === "date" || t === "timestamp" || t === "timestamptz") {
		if (v instanceof Date) return Number.isNaN(v.getTime()) ? "expected timestamp" : null;
		if (typeof v === "string") return Number.isNaN(Date.parse(v)) ? "expected timestamp" : null;
		return "expected timestamp";
	}

	if (t === "array") {
		if (!Array.isArray(v)) return "expected array";
		if (s.minItems != null && v.length < s.minItems) return "fewer than minItems " + s.minItems;
		if (s.maxItems != null && v.length > s.maxItems) return "more than maxItems " + s.maxItems;
		if (s.items)
			for (let i = 0; i < v.length; i++) {
				const e = validate(s.items, v[i]);
				if (e) return "item[" + i + "]: " + e;
			}
		return null;
	}

	// `type` is optional when `properties` is present — lockstep record models
	// omit it, and the dialect treats "has properties" as implicitly an object.
	if (t === "object" || (t == null && s.properties)) {
		if (typeof v !== "object" || v === null || Array.isArray(v)) return "expected object";
		if (s.required)
			for (const k of s.required) {
				if (v[k] === undefined || v[k] === null) return "missing required field " + k;
			}
		if (s.properties)
			for (const k in s.properties) {
				if (v[k] === undefined || v[k] === null) continue; // absent optional
				const e = validate(s.properties[k], v[k]);
				if (e) return k + ": " + e;
			}
		if (s.additionalProperties === false) {
			for (const k in v) if (!(s.properties && k in s.properties)) return "unexpected property " + k;
		}
		return null;
	}

	if (t === "jsonb" || t === "json") return null; // opaque by definition
	if (t === "enum") {
		if (Array.isArray(s.enum)) {
			for (const e of s.enum) if (v === e) return null;
			return "expected one of " + JSON.stringify(s.enum);
		}
		return null;
	}

	return null; // unknown type → permissive, as on ParaBun
}

/** Wrap a sub-schema so `User.profile.bio` navigation works. */
function wrapField(val) {
	if (isWrapped(val)) return val;
	if (val && typeof val === "object" && !Array.isArray(val)) {
		if (val.properties && typeof val.properties === "object") return fromSchema(val);
		if (val.type === "array" && val.items) {
			const out = Object.assign({}, val);
			Object.defineProperty(out, "element", {
				get: () => wrapField(val.items),
				enumerable: false,
				configurable: false,
			});
			return out;
		}
	}
	return val;
}

/**
 * Take a JSON Schema 2020-12 body (Para dialect: `bigint`, `varchar`, `text`,
 * `timestamptz`, `snowflake`, `numeric`, `jsonb`, `enum` are accepted type
 * tags) and return it decorated with `parse`, `validate`, `is`, and `schema`.
 *
 * The body's own keys are spread onto the result (enumerable, so `{...schema}`
 * still yields a plain JSON Schema); the added members are non-enumerable, so a
 * spread never drags a `parse` into a schema literal.
 */
export function fromSchema(body) {
	const result = Object.assign({}, body);

	const parse = (v) => {
		const e = validate(body, v);
		return e ? { tag: "Err", error: e } : { tag: "Ok", value: v };
	};

	hide(result, "parse", parse);
	// `validate` is an alias for `parse`, matching ParaBun. Both check an
	// already-decoded value; neither does JSON.parse.
	hide(result, "validate", parse);
	hide(result, "is", (v) => validate(body, v) === null);
	hide(result, "schema", body);
	hide(result, "$walk", (v) => validate(body, v));

	// Field navigation, only for an explicit object schema. A lockstep record
	// model omits `type: 'object'`, and adding accessors there would shadow the
	// body's own `type` / `required` / `items` keys.
	if (body && body.type === "object" && body.properties && typeof body.properties === "object") {
		for (const key in body.properties) {
			if (Object.prototype.hasOwnProperty.call(result, key)) continue;
			Object.defineProperty(result, key, {
				get: () => wrapField(body.properties[key]),
				enumerable: false,
				configurable: false,
			});
		}
	}

	return result;
}
