/**
 * Exact fixed-point decimal arithmetic for money, quantities, prices and rates.
 *
 * Values are bigint "atoms" at a fixed scale of 10^-12. Every value crossing an
 * API or storage boundary is a validated decimal string. Floating point is never
 * used to settle balances or fees (plan section 4). Rounding is always explicit.
 */
export type Dec = bigint;

export const SCALE = 12;
const UNIT = 10n ** BigInt(SCALE);
export const ZERO: Dec = 0n;
export const ONE: Dec = UNIT;

const DEC_RE = /^-?\d+(\.\d+)?$/;

/** Parse a decimal string exactly. Rejects exponents, NaN and more than 12 fractional digits. */
export function dec(s: string | number): Dec {
  const str = typeof s === 'number' ? numToString(s) : s.trim();
  if (!DEC_RE.test(str)) throw new Error(`invalid decimal: ${JSON.stringify(s)}`);
  const neg = str.startsWith('-');
  const [i, f = ''] = (neg ? str.slice(1) : str).split('.');
  if (f.length > SCALE) {
    // Allow extra zeros only; any other extra precision is an error.
    if (/[^0]/.test(f.slice(SCALE))) throw new Error(`decimal exceeds ${SCALE} fractional digits: ${str}`);
  }
  const v = BigInt(i!) * UNIT + BigInt((f.slice(0, SCALE) || '0').padEnd(SCALE, '0'));
  return neg ? -v : v;
}

/** Integers and short literals only; never use for computed floats. */
function numToString(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`non-finite number: ${n}`);
  if (Number.isInteger(n)) return n.toFixed(0);
  const s = n.toString();
  if (/e/i.test(s)) throw new Error(`number needs a decimal string: ${n}`);
  return s;
}

/** Canonical decimal string: no trailing fractional zeros, "0" for zero. */
export function str(v: Dec, minFraction = 0): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const i = a / UNIT;
  let f = (a % UNIT).toString().padStart(SCALE, '0').replace(/0+$/, '');
  if (f.length < minFraction) f = f.padEnd(minFraction, '0');
  const out = f ? `${i}.${f}` : `${i}`;
  return neg && a !== 0n ? `-${out}` : out;
}

/** Approximate float for display and statistics only. */
export function toNumber(v: Dec): number {
  return Number(v) / Number(UNIT);
}

export type Rounding = 'floor' | 'ceil' | 'halfEven' | 'trunc';

function divRound(n: bigint, d: bigint, mode: Rounding): bigint {
  if (d === 0n) throw new Error('division by zero');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const q = n / d; // truncates toward zero
  const r = n % d;
  if (r === 0n) return q;
  switch (mode) {
    case 'trunc':
      return q;
    case 'floor':
      return n < 0n ? q - 1n : q;
    case 'ceil':
      return n > 0n ? q + 1n : q;
    case 'halfEven': {
      const twice = 2n * (r < 0n ? -r : r);
      const away = n < 0n ? q - 1n : q + 1n;
      if (twice > d) return away;
      if (twice < d) return q;
      return q % 2n === 0n ? q : away;
    }
  }
}

export function mul(a: Dec, b: Dec, mode: Rounding = 'halfEven'): Dec {
  return divRound(a * b, UNIT, mode);
}

export function div(a: Dec, b: Dec, mode: Rounding = 'halfEven'): Dec {
  return divRound(a * UNIT, b, mode);
}

/** Quantize to a multiple of `step` (e.g. base_increment 0.00000001). */
export function quantize(v: Dec, step: Dec, mode: Rounding): Dec {
  if (step <= 0n) throw new Error('step must be positive');
  return divRound(v, step, mode) * step;
}

export const min = (a: Dec, b: Dec): Dec => (a < b ? a : b);
export const max = (a: Dec, b: Dec): Dec => (a > b ? a : b);
export const abs = (a: Dec): Dec => (a < 0n ? -a : a);

/** Basis points of `part` relative to `whole`, as a float (statistics/limits only). */
export function bps(part: Dec, whole: Dec): number {
  return whole === 0n ? Infinity : (toNumber(part) / toNumber(whole)) * 10_000;
}

/** Fees are charged in USD, rounded UP to the nearest 0.00000001 USD (documented convention). */
export const FEE_STEP: Dec = dec('0.00000001');
