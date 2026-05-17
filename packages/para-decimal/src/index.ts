// @para/decimal — self-contained exact-decimal arithmetic.
//
// Backs the Para `0.1d` numeric-literal suffix. Each `Nd` literal lowers to
// `__paraDec("N")` (string form of the source — never the parsed JS Number,
// since the whole point is to skip the float roundtrip). Subsequent
// arithmetic uses explicit method calls because JS doesn't allow operator
// overloading: `0.1d.plus(0.2d).eq(0.3d)` is `true`.
//
// Internal representation: `{ coef: bigint, exp: number }` where the value
// equals `coef * 10^exp`. So `0.1` is `{ coef: 1n, exp: -1 }`, `0.0825` is
// `{ coef: 825n, exp: -4 }`, and `100` is `{ coef: 100n, exp: 0 }` (we
// don't auto-renormalize trailing zeros — that's only done in toString).
//
// NaN / Infinity are deliberately NOT supported. Decimal arithmetic is
// supposed to be deterministic: division by zero throws, period. Users
// who want NaN have Number.

export type RoundingMode =
  | "HALF_EVEN" // banker's rounding — round to nearest even on .5 (default)
  | "HALF_UP" // round away from zero on .5
  | "HALF_DOWN" // round toward zero on .5
  | "UP" // always away from zero
  | "DOWN" // always toward zero (truncate)
  | "FLOOR" // toward -∞
  | "CEILING"; // toward +∞

export type DivideOptions = {
  /** Maximum significant digits in the result. Defaults to 20. */
  precision?: number;
  /** How to round the last digit when long division can't terminate. Defaults to `"HALF_EVEN"`. */
  roundingMode?: RoundingMode;
};

export type DecimalInput = string | number | bigint | Decimal;

const ZERO = 0n;
const ONE = 1n;
const TEN = 10n;
const NEG_ONE = -1n;

/** Cached `10n ** BigInt(n)` — common in scale alignment. */
const POW10_CACHE: bigint[] = [];
function pow10(n: number): bigint {
  if (n < 0) throw new RangeError(`pow10: n must be non-negative, got ${n}`);
  if (POW10_CACHE[n] !== undefined) return POW10_CACHE[n]!;
  // Fill the cache up to n.
  if (POW10_CACHE.length === 0) POW10_CACHE.push(ONE);
  while (POW10_CACHE.length <= n) {
    POW10_CACHE.push(POW10_CACHE[POW10_CACHE.length - 1]! * TEN);
  }
  return POW10_CACHE[n]!;
}

function absBig(x: bigint): bigint {
  return x < ZERO ? -x : x;
}

function signBig(x: bigint): -1 | 0 | 1 {
  return x < ZERO ? -1 : x > ZERO ? 1 : 0;
}

/** Count of base-10 digits in `|x|`. Zero has 1 digit. */
function digitCount(x: bigint): number {
  if (x === ZERO) return 1;
  let n = absBig(x);
  let c = 0;
  // Halving-ish doubling for bigints: jump by ~16 digits at a time.
  const STEP = pow10(16);
  while (n >= STEP) {
    n /= STEP;
    c += 16;
  }
  while (n > ZERO) {
    n /= TEN;
    c += 1;
  }
  return c;
}

/** Parse a string like `"-1.5e3"` or `"42"` into a `{ coef, exp }` pair. */
function parseString(s: string): { coef: bigint; exp: number } {
  const trimmed = s.trim();
  if (trimmed.length === 0) throw new SyntaxError(`Decimal: empty string`);
  // Accept an optional leading sign, followed by digits and an optional `.`
  // and an optional `e±N` exponent. We hand-roll this because the JS Number
  // grammar is too permissive (NaN, Infinity, hex, leading 0 octal) and
  // BigInt is too restrictive (no fractional part).
  let i = 0;
  let sign: bigint = ONE;
  if (trimmed[i] === "+") {
    i++;
  } else if (trimmed[i] === "-") {
    sign = NEG_ONE;
    i++;
  }
  const intStart = i;
  while (i < trimmed.length && trimmed[i]! >= "0" && trimmed[i]! <= "9") i++;
  const intEnd = i;
  let fracStart = i;
  let fracEnd = i;
  if (trimmed[i] === ".") {
    i++;
    fracStart = i;
    while (i < trimmed.length && trimmed[i]! >= "0" && trimmed[i]! <= "9") i++;
    fracEnd = i;
  }
  if (intStart === intEnd && fracStart === fracEnd) {
    throw new SyntaxError(`Decimal: invalid numeric string ${JSON.stringify(s)}`);
  }
  let exponent = 0;
  if (i < trimmed.length && (trimmed[i] === "e" || trimmed[i] === "E")) {
    i++;
    let expSign = 1;
    if (trimmed[i] === "+") i++;
    else if (trimmed[i] === "-") {
      expSign = -1;
      i++;
    }
    const expStart = i;
    while (i < trimmed.length && trimmed[i]! >= "0" && trimmed[i]! <= "9") i++;
    if (i === expStart) {
      throw new SyntaxError(`Decimal: invalid exponent in ${JSON.stringify(s)}`);
    }
    exponent = expSign * parseInt(trimmed.slice(expStart, i), 10);
  }
  if (i !== trimmed.length) {
    throw new SyntaxError(`Decimal: trailing garbage in ${JSON.stringify(s)}`);
  }
  const intPart = trimmed.slice(intStart, intEnd);
  const fracPart = trimmed.slice(fracStart, fracEnd);
  // Combine integer + fractional digits, BigInt-parse the result, and
  // shift exp by the fractional length.
  const combined = (intPart || "0") + fracPart;
  const coef = sign * (combined.length > 0 ? BigInt(combined) : ZERO);
  const exp = exponent - fracPart.length;
  return { coef, exp };
}

/** Convert a JS Number to a Decimal via its string representation. */
function fromNumber(n: number): { coef: bigint; exp: number } {
  if (!Number.isFinite(n)) {
    throw new RangeError(`Decimal: NaN / Infinity not supported (got ${n})`);
  }
  // Number.prototype.toString gives the shortest round-trippable form for
  // most finite values — good enough for our purposes. (Users who need
  // exact decimal control should pass a string.)
  return parseString(n.toString());
}

/** Round `coef` (a non-negative bigint) down by `drop` digits. Returns the rounded coef. */
function roundCoef(coef: bigint, drop: number, mode: RoundingMode, sign: -1 | 0 | 1): bigint {
  if (drop <= 0) return coef;
  const divisor = pow10(drop);
  const q = coef / divisor;
  const r = coef - q * divisor;
  if (r === ZERO) return q;
  const half = divisor / 2n;
  const isExactlyHalf = r === half && divisor % 2n === ZERO;
  // Decide whether to round up (away from zero in the |coef| sense).
  let roundUp: boolean;
  switch (mode) {
    case "DOWN":
      roundUp = false;
      break;
    case "UP":
      roundUp = true;
      break;
    case "HALF_UP":
      roundUp = r >= half + (divisor % 2n === ZERO ? ZERO : ONE) || isExactlyHalf || r > half;
      break;
    case "HALF_DOWN":
      roundUp = r > half;
      break;
    case "HALF_EVEN":
      if (r > half) roundUp = true;
      else if (r < half) roundUp = false;
      else if (isExactlyHalf) roundUp = q % 2n !== ZERO;
      else roundUp = false;
      break;
    case "FLOOR":
      // Toward -∞ — for positive sign that's truncate, for negative round away.
      roundUp = sign < 0;
      break;
    case "CEILING":
      // Toward +∞ — for positive sign round away, for negative truncate.
      roundUp = sign > 0;
      break;
    default: {
      const _exhaustive: never = mode;
      throw new RangeError(`Decimal: unknown rounding mode ${_exhaustive}`);
    }
  }
  return roundUp ? q + ONE : q;
}

export class Decimal {
  // Hidden brand so cross-realm Decimal-shaped objects can still be detected.
  static readonly #brand: unique symbol = Symbol("para.decimal");
  // The actual brand value carried by every instance — referenced via
  // hasOwnProperty in `Decimal.isDecimal` for fast cross-realm checks.
  readonly #isDecimal = true;
  readonly coef: bigint;
  readonly exp: number;

  // Direct construction is private — clients call `Decimal.from(…)`. We
  // can't use a `private constructor` (TS-only) at runtime so we accept
  // the args but rely on convention.
  constructor(coef: bigint, exp: number) {
    if (typeof coef !== "bigint") {
      throw new TypeError(`Decimal: coef must be bigint (got ${typeof coef})`);
    }
    if (!Number.isInteger(exp)) {
      throw new TypeError(`Decimal: exp must be an integer (got ${exp})`);
    }
    this.coef = coef;
    this.exp = exp;
  }

  static from(input: DecimalInput): Decimal {
    if (input instanceof Decimal) return input;
    if (typeof input === "string") {
      const { coef, exp } = parseString(input);
      return new Decimal(coef, exp);
    }
    if (typeof input === "number") {
      const { coef, exp } = fromNumber(input);
      return new Decimal(coef, exp);
    }
    if (typeof input === "bigint") {
      return new Decimal(input, 0);
    }
    throw new TypeError(`Decimal: unsupported input type ${typeof input}`);
  }

  static isDecimal(x: unknown): x is Decimal {
    return x instanceof Decimal;
  }

  /** Align two decimals to a common (more-negative) exponent. Returns coefs at that scale. */
  static #align(a: Decimal, b: Decimal): { coefA: bigint; coefB: bigint; exp: number } {
    if (a.exp === b.exp) return { coefA: a.coef, coefB: b.coef, exp: a.exp };
    if (a.exp < b.exp) {
      const shift = b.exp - a.exp;
      return { coefA: a.coef, coefB: b.coef * pow10(shift), exp: a.exp };
    }
    const shift = a.exp - b.exp;
    return { coefA: a.coef * pow10(shift), coefB: b.coef, exp: b.exp };
  }

  plus(other: DecimalInput): Decimal {
    const o = Decimal.from(other);
    const { coefA, coefB, exp } = Decimal.#align(this, o);
    return new Decimal(coefA + coefB, exp);
  }

  minus(other: DecimalInput): Decimal {
    const o = Decimal.from(other);
    const { coefA, coefB, exp } = Decimal.#align(this, o);
    return new Decimal(coefA - coefB, exp);
  }

  times(other: DecimalInput): Decimal {
    const o = Decimal.from(other);
    return new Decimal(this.coef * o.coef, this.exp + o.exp);
  }

  dividedBy(other: DecimalInput, opts?: DivideOptions): Decimal {
    const o = Decimal.from(other);
    if (o.coef === ZERO) {
      throw new RangeError(`Decimal: division by zero`);
    }
    if (this.coef === ZERO) {
      return new Decimal(ZERO, 0);
    }
    const precision = Math.max(1, opts?.precision ?? 20);
    const mode: RoundingMode = opts?.roundingMode ?? "HALF_EVEN";
    // Sign handled separately so the rounding logic can work in absolute
    // values consistently.
    const sign: -1 | 0 | 1 = (signBig(this.coef) * signBig(o.coef)) as -1 | 0 | 1;
    const a = absBig(this.coef);
    const b = absBig(o.coef);
    // Divide |a / b| with precision+1 significant digits, then round to
    // exactly precision. Compute how many extra factors of 10 we must
    // multiply the dividend by to land at precision+1 digits in the
    // quotient. The integer-quotient `q = (a * 10^k) / b` has approximately
    // `digitCount(a) + k - digitCount(b) + 1` digits, so set `k` so that
    // count is `precision + 1`.
    const targetDigits = precision + 1;
    const aDigits = digitCount(a);
    const bDigits = digitCount(b);
    // Initial guess; then refine if off-by-one.
    let k = Math.max(0, targetDigits - (aDigits - bDigits) - 1);
    // We may need to bump k up by 1 if the resulting quotient is shorter
    // than targetDigits (this happens when leading digits of a < b).
    let scaled = a * pow10(k);
    let q = scaled / b;
    while (digitCount(q) < targetDigits) {
      k += 1;
      scaled *= TEN;
      q = scaled / b;
    }
    // q now has at least targetDigits. If MORE, drop the surplus by
    // rounding (HALF_EVEN — the precision-1-digits we keep are exact;
    // any surplus came from the long-division remainder being 0).
    while (digitCount(q) > targetDigits) {
      // Surplus digits — happens when our k overshot. Round down by
      // dropping (digits - targetDigits) least-significant digits using
      // the requested rounding mode, since we may be discarding nonzero
      // tail bits.
      q = roundCoef(q, digitCount(q) - targetDigits, mode, sign);
    }
    // Now round from precision+1 down to precision digits.
    q = roundCoef(q, 1, mode, sign);
    // Resulting exponent: `(this.coef / o.coef) * 10^(this.exp - o.exp)`,
    // and we multiplied `this.coef` by `10^k` and divided once more by 10
    // (the rounding step), so the final exponent shift is `-(k - 1)`.
    // After the rounding step we lost one digit of magnitude, so net `k - 1`
    // factors of 10 went into the integer quotient — subtract that to get
    // the true result exponent.
    let resultExp = this.exp - o.exp - (k - 1);
    // Strip trailing zeros from q: when the division terminates exactly
    // (e.g. 1/4 = 0.25), the long-division loop pads the rest of the
    // precision with zeros that we don't want in the canonical
    // representation. Cap the strip at exp = 0 so we don't turn 1.50 into
    // 1.5 by mistake — wait, we DO want that for divisions, but not for
    // explicit `Decimal.from("1.50")`. In division the precision is an
    // implementation detail and trailing zeros are noise; in user-supplied
    // inputs they're significant. So it's correct to strip here all the
    // way through positive exponents, then clamp at the natural integer
    // boundary by bumping exp toward zero.
    while (q !== ZERO && q % TEN === ZERO) {
      q /= TEN;
      resultExp += 1;
    }
    const signedCoef = sign < 0 ? -q : q;
    return new Decimal(signedCoef, resultExp);
  }

  /** Shorter alias for `.dividedBy`. */
  div(other: DecimalInput, opts?: DivideOptions): Decimal {
    return this.dividedBy(other, opts);
  }

  neg(): Decimal {
    return new Decimal(-this.coef, this.exp);
  }

  abs(): Decimal {
    return new Decimal(absBig(this.coef), this.exp);
  }

  /** Compare: -1 if `this < other`, 0 if equal, 1 if greater. */
  compareTo(other: DecimalInput): -1 | 0 | 1 {
    const o = Decimal.from(other);
    const { coefA, coefB } = Decimal.#align(this, o);
    if (coefA < coefB) return -1;
    if (coefA > coefB) return 1;
    return 0;
  }

  eq(other: DecimalInput): boolean {
    return this.compareTo(other) === 0;
  }

  lt(other: DecimalInput): boolean {
    return this.compareTo(other) === -1;
  }

  gt(other: DecimalInput): boolean {
    return this.compareTo(other) === 1;
  }

  lte(other: DecimalInput): boolean {
    const c = this.compareTo(other);
    return c <= 0;
  }

  gte(other: DecimalInput): boolean {
    const c = this.compareTo(other);
    return c >= 0;
  }

  isZero(): boolean {
    return this.coef === ZERO;
  }

  isNegative(): boolean {
    return this.coef < ZERO;
  }

  isPositive(): boolean {
    return this.coef > ZERO;
  }

  /** Exact-decimal string. Trailing zeros from the original representation are preserved. */
  toString(): string {
    if (this.coef === ZERO) {
      // Zero is canonical: "0" regardless of exp. We could preserve "0.00"
      // for an exp of -2 but that requires more bookkeeping; users who
      // need that can `.toFixed(n)` (not implemented in v1).
      return "0";
    }
    const negative = this.coef < ZERO;
    const digits = absBig(this.coef).toString();
    if (this.exp === 0) {
      return negative ? "-" + digits : digits;
    }
    if (this.exp > 0) {
      // Append exp zeros: 12 with exp=3 → "12000".
      return (negative ? "-" : "") + digits + "0".repeat(this.exp);
    }
    // exp < 0 — insert decimal point.
    const point = digits.length + this.exp;
    let body: string;
    if (point > 0) {
      body = digits.slice(0, point) + "." + digits.slice(point);
    } else {
      body = "0." + "0".repeat(-point) + digits;
    }
    return negative ? "-" + body : body;
  }

  /** Lossy: convert to JS Number via the string representation. */
  toNumber(): number {
    return parseFloat(this.toString());
  }

  /** Lossy: convert to bigint by truncating the fractional part. */
  toBigInt(): bigint {
    if (this.exp >= 0) return this.coef * pow10(this.exp);
    // exp < 0: divide off the fractional digits (truncates toward zero).
    const div = pow10(-this.exp);
    const sign = this.coef < ZERO ? NEG_ONE : ONE;
    return sign * (absBig(this.coef) / div);
  }

  /** Custom toJSON returns the canonical string — JSON has no decimal type. */
  toJSON(): string {
    return this.toString();
  }
}

/**
 * Runtime helper invoked by the `Nd` literal lowering. Always called with a
 * string argument — never with a parsed JS Number, since the whole point of
 * the literal is to skip the float roundtrip.
 */
export function __paraDec(source: string): Decimal {
  return Decimal.from(source);
}

export default Decimal;
