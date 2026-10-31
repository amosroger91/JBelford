/**
 * Backtest-overfitting diagnostics.
 *
 *  - Probability of Backtest Overfitting (PBO) via Combinatorially Symmetric
 *    Cross-Validation (CSCV): Bailey, Borwein, López de Prado & Zhu (2014),
 *    "The Probability of Backtest Overfitting".
 *  - Probabilistic and Deflated Sharpe Ratio: Bailey & López de Prado (2014),
 *    "The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest
 *    Overfitting and Non-Normality".
 *
 * Both work on a matrix of per-period returns: one column per parameter
 * combination ("trial"), one row per time period.
 */
import type { TradeRecord } from '../core/types';

const EULER_GAMMA = 0.5772156649015329;

// ---------- normal distribution ----------

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf, |err| < 1.5e-7). */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Inverse standard normal CDF (Acklam's algorithm, rel. err ~1e-9). */
export function normInv(p: number): number {
  if (!(p > 0 && p < 1)) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    return NaN;
  }
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - lo) return -normInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

// ---------- moments ----------

export function moments(x: number[]): { mean: number; std: number; skew: number; kurt: number } {
  const n = x.length;
  if (n === 0) return { mean: 0, std: 0, skew: 0, kurt: 3 };
  const mean = x.reduce((s, v) => s + v, 0) / n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const v of x) {
    const d = v - mean;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m3 /= n;
  m4 /= n;
  const std = Math.sqrt(m2);
  // A constant series has undefined higher moments; treat it as normal.
  if (std === 0) return { mean, std: 0, skew: 0, kurt: 3 };
  return { mean, std, skew: m3 / std ** 3, kurt: m4 / m2 ** 2 };
}

/** Per-period (non-annualized) Sharpe ratio; 0 for a constant series. */
export function sharpe(x: number[]): number {
  const m = moments(x);
  return m.std > 0 ? m.mean / m.std : 0;
}

// ---------- returns matrix ----------

/**
 * Bucket trade P&L into fixed periods (by close time). Periods without trades
 * count as 0 return, which is what holding cash earned.
 */
export function periodReturns(trades: TradeRecord[], startTs: number, endTs: number, periodMs: number): number[] {
  const n = Math.max(1, Math.ceil((endTs - startTs) / periodMs));
  const out = new Array<number>(n).fill(0);
  for (const t of trades) {
    const i = Math.min(n - 1, Math.max(0, Math.floor((t.closedAt - startTs) / periodMs)));
    out[i]! += t.netPnl;
  }
  return out;
}

// ---------- PBO via CSCV ----------

function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const rec = (start: number) => {
    if (cur.length === k) {
      out.push([...cur]);
      return;
    }
    for (let i = start; i <= n - (k - cur.length); i++) {
      cur.push(i);
      rec(i + 1);
      cur.pop();
    }
  };
  rec(0);
  return out;
}

export interface PboResult {
  /** Probability that the in-sample winner ranks below the median out-of-sample. */
  pbo: number;
  splits: number;
  blocks: number;
  /** Logits of the IS-winner's OOS relative rank, one per split. */
  logits: number[];
  /** Fraction of splits where the IS winner lost money out-of-sample. */
  probOosLoss: number;
}

/**
 * CSCV. `matrix[t][n]` = return of trial n in period t. Rows are cut into `S`
 * contiguous blocks; for every way of choosing S/2 blocks as in-sample, the
 * best in-sample trial's out-of-sample rank is recorded. The performance
 * metric is total return over the subset (robust when many periods are 0).
 */
export function probabilityOfBacktestOverfitting(matrix: number[][], S = 8): PboResult {
  const T = matrix.length;
  const N = matrix[0]?.length ?? 0;
  if (N < 2) throw new Error('PBO needs at least 2 trials');
  if (S % 2 !== 0 || S < 2) throw new Error('S must be an even number >= 2');
  if (T < S) throw new Error(`PBO needs at least S=${S} periods, got ${T}`);

  const blockOf = (t: number) => Math.min(S - 1, Math.floor((t * S) / T));
  // Per-block totals for each trial.
  const blockSum: number[][] = Array.from({ length: S }, () => new Array<number>(N).fill(0));
  for (let t = 0; t < T; t++) {
    const b = blockOf(t);
    for (let n = 0; n < N; n++) blockSum[b]![n]! += matrix[t]![n]!;
  }

  const logits: number[] = [];
  let oosLoss = 0;
  for (const isBlocks of combinations(S, S / 2)) {
    const inIs = new Set(isBlocks);
    const isPerf = new Array<number>(N).fill(0);
    const oosPerf = new Array<number>(N).fill(0);
    for (let b = 0; b < S; b++) {
      const target = inIs.has(b) ? isPerf : oosPerf;
      for (let n = 0; n < N; n++) target[n]! += blockSum[b]![n]!;
    }
    let best = 0;
    for (let n = 1; n < N; n++) if (isPerf[n]! > isPerf[best]!) best = n;
    // Relative rank of the IS winner out-of-sample, ties averaged, in (0, 1).
    const v = oosPerf[best]!;
    let below = 0;
    let equal = 0;
    for (let n = 0; n < N; n++) {
      if (oosPerf[n]! < v) below++;
      else if (oosPerf[n]! === v) equal++;
    }
    const rank = below + (equal + 1) / 2; // 1..N
    const omega = rank / (N + 1);
    logits.push(Math.log(omega / (1 - omega)));
    if (v < 0) oosLoss++;
  }
  return {
    pbo: logits.filter((l) => l <= 0).length / logits.length,
    splits: logits.length,
    blocks: S,
    logits,
    probOosLoss: oosLoss / logits.length,
  };
}

// ---------- Probabilistic / Deflated Sharpe ----------

/**
 * Probability that the true Sharpe exceeds `srBenchmark`, given an observed
 * per-period Sharpe over T periods with the given skew and (non-excess) kurtosis.
 */
export function probabilisticSharpe(sr: number, srBenchmark: number, T: number, skew: number, kurt: number): number {
  if (T < 2) return 0.5;
  const denom = 1 - skew * sr + ((kurt - 1) / 4) * sr * sr;
  if (!(denom > 0)) return sr > srBenchmark ? 1 : 0;
  return normCdf(((sr - srBenchmark) * Math.sqrt(T - 1)) / Math.sqrt(denom));
}

/** Expected maximum Sharpe across N independent zero-skill trials with Sharpe variance `varSr`. */
export function expectedMaxSharpe(N: number, varSr: number): number {
  if (N < 2 || varSr <= 0) return 0;
  return Math.sqrt(varSr) * ((1 - EULER_GAMMA) * normInv(1 - 1 / N) + EULER_GAMMA * normInv(1 - 1 / (N * Math.E)));
}

export interface DsrResult {
  /** Index of the trial with the highest full-sample Sharpe. */
  bestTrial: number;
  sharpe: number;
  /** Sharpe a pure-luck winner would be expected to reach given N trials. */
  benchmarkSharpe: number;
  /** P(true Sharpe > 0) ignoring the number of trials. */
  psr: number;
  /** P(true Sharpe > 0) after deflating for N trials. Want > 0.95. */
  dsr: number;
  trials: number;
  periods: number;
  skew: number;
  kurtosis: number;
}

export function deflatedSharpe(matrix: number[][]): DsrResult {
  const T = matrix.length;
  const N = matrix[0]?.length ?? 0;
  if (N < 1 || T < 2) throw new Error('DSR needs at least 1 trial and 2 periods');
  const cols = Array.from({ length: N }, (_, n) => matrix.map((row) => row[n]!));
  const srs = cols.map(sharpe);
  let best = 0;
  for (let n = 1; n < N; n++) if (srs[n]! > srs[best]!) best = n;
  const varSr = moments(srs).std ** 2;
  const sr0 = expectedMaxSharpe(N, varSr);
  const m = moments(cols[best]!);
  return {
    bestTrial: best,
    sharpe: srs[best]!,
    benchmarkSharpe: sr0,
    psr: probabilisticSharpe(srs[best]!, 0, T, m.skew, m.kurt),
    dsr: probabilisticSharpe(srs[best]!, sr0, T, m.skew, m.kurt),
    trials: N,
    periods: T,
    skew: m.skew,
    kurtosis: m.kurt,
  };
}
