/**
 * 单音 YIN 基频估计核心。
 *
 * 算法（整数延迟版本，无抛物线细化）：
 *  1. 去除窗口均值，按去均值后的 RMS 判断静音 / 近常量。
 *  2. 延迟范围 tau ∈ [ceil(sr/fmax), floor(sr/fmin)]，比较长度 W = N - tauMax。
 *  3. 差分函数 d(tau) = sum_{j=0..W-1} (x[j] - x[j+tau])^2，对 tau = 1..tauMax 全部计算
 *     （低于候选区间的延迟也参与累计分母）。
 *  4. 累积均值归一化 cmnd(tau) = d(tau) * tau / sum_{k=1..tau} d(k)。
 *  5. 在候选区间内找首个 cmnd < threshold 的谷，再沿下降趋势走到局部最小。
 *  6. 频率 = sr / tau（整数延迟）。
 */

export type YinStatus = "ok" | "silent" | "no_candidate" | "invalid";

export interface YinParams {
  sampleRate: number;
  fmin: number;
  fmax: number;
  /** 周期阈值：cmnd 低于该值才认为存在可信周期 */
  threshold: number;
  /** 幅度阈值：去均值后 RMS 低于该值判为静音 / 近常量 */
  amplitudeThreshold: number;
}

export const DEFAULT_PARAMS = {
  fmin: 50,
  fmax: 2000,
  threshold: 0.15,
  amplitudeThreshold: 1e-4,
} as const;

export interface YinError {
  status: "invalid";
  code: string;
  message: string;
}

export interface YinResult {
  status: Exclude<YinStatus, "invalid">;
  /** 去均值前窗口均值 */
  mean: number;
  /** 去均值后 RMS */
  rms: number;
  /** 比较长度 W = N - tauMax */
  windowLength: number;
  tauMin: number;
  tauMax: number;
  /** 选中的整数延迟（仅 ok 时有值） */
  tau: number | null;
  /** 基频 Hz = sr / tau（仅 ok 时有值） */
  frequency: number | null;
  /** 选中点的归一化值（可信度参考，非统计正确率） */
  clarity: number | null;
  /** 候选区间内观察到的最小 cmnd（无候选时也可用于诊断） */
  bestObserved: { tau: number; cmnd: number } | null;
  /** 阈值交点：cmnd 首次低于 threshold 的 tau（无则 null） */
  thresholdCrossing: number | null;
  /** 完整曲线（tau 从 1 开始，下标 0 对应 tau=1） */
  diffCurve: number[];
  cmndCurve: number[];
  /** 运算量上限：差分约 W*tauMax 次乘加 */
  costEstimate: number;
  notes: string[];
}

export function validateInput(
  samples: unknown,
  params: YinParams
): YinError | null {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { status: "invalid", code: "E_SAMPLES_TYPE", message: "samples 必须是非空数组" };
  }
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { status: "invalid", code: "E_SAMPLE_VALUE", message: `样本[${i}] 不是有限数值` };
    }
    if (v < -1 || v > 1) {
      return { status: "invalid", code: "E_SAMPLE_RANGE", message: `样本[${i}]=${v} 超出 [-1, 1]` };
    }
  }
  const { sampleRate, fmin, fmax, threshold, amplitudeThreshold } = params;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    return { status: "invalid", code: "E_SAMPLE_RATE", message: "采样率必须为正数" };
  }
  const nyquist = sampleRate / 2;
  if (!Number.isFinite(fmin) || !Number.isFinite(fmax) || fmin <= 0 || fmax <= 0) {
    return { status: "invalid", code: "E_FREQ_RANGE", message: "频率范围必须为正" };
  }
  if (fmin >= fmax) {
    return { status: "invalid", code: "E_FREQ_RANGE", message: "fmin 必须小于 fmax" };
  }
  if (fmax >= nyquist) {
    return { status: "invalid", code: "E_FREQ_NYQUIST", message: `fmax 必须低于奈奎斯特频率 ${nyquist}` };
  }
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
    return { status: "invalid", code: "E_THRESHOLD", message: "周期阈值必须在 (0, 1) 内" };
  }
  if (!Number.isFinite(amplitudeThreshold) || amplitudeThreshold < 0) {
    return { status: "invalid", code: "E_AMP_THRESHOLD", message: "幅度阈值必须为非负数" };
  }
  const tauMin = Math.ceil(sampleRate / fmax);
  const tauMax = Math.floor(sampleRate / fmin);
  if (tauMax < 2 || tauMin > tauMax) {
    return { status: "invalid", code: "E_TAU_RANGE", message: "延迟范围为空（频率范围过窄或采样率过低）" };
  }
  const W = samples.length - tauMax;
  if (W < 2) {
    return {
      status: "invalid",
      code: "E_WINDOW_SHORT",
      message: `数据不足：N=${samples.length}，tauMax=${tauMax}，需要 N >= tauMax + 2`,
    };
  }
  return null;
}

export function analyze(samples: number[], params: YinParams): YinResult | YinError {
  const err = validateInput(samples, params);
  if (err) return err;

  const N = samples.length;
  const { sampleRate, threshold, amplitudeThreshold } = params;
  const tauMin = Math.ceil(sampleRate / params.fmax);
  const tauMax = Math.floor(sampleRate / params.fmin);
  const W = N - tauMax;

  // 去均值
  let mean = 0;
  for (const v of samples) mean += v;
  mean /= N;
  const x = new Float64Array(N);
  let sq = 0;
  for (let i = 0; i < N; i++) {
    x[i] = samples[i] - mean;
    sq += x[i] * x[i];
  }
  const rms = Math.sqrt(sq / N);

  const base: Omit<YinResult, "status"> = {
    mean,
    rms,
    windowLength: W,
    tauMin,
    tauMax,
    tau: null,
    frequency: null,
    clarity: null,
    bestObserved: null,
    thresholdCrossing: null,
    diffCurve: [],
    cmndCurve: [],
    costEstimate: W * tauMax,
    notes: [],
  };

  if (rms < amplitudeThreshold) {
    return {
      ...base,
      status: "silent",
      notes: [
        `去均值后 RMS=${rms.toExponential(3)} 低于幅度阈值 ${amplitudeThreshold}，判为静音或近常量输入`,
      ],
    };
  }

  // 差分函数，tau = 1..tauMax（低于候选区间的也计算，供累计分母使用）
  const diff = new Float64Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < W; j++) {
      const d = x[j] - x[j + tau];
      sum += d * d;
    }
    diff[tau] = sum;
  }

  // 累积均值归一化
  const cmnd = new Float64Array(tauMax + 1);
  let running = 0;
  let zeroDenominator = true;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += diff[tau];
    if (running > 0) zeroDenominator = false;
    cmnd[tau] = running > 0 ? (diff[tau] * tau) / running : 1;
  }

  const diffCurve: number[] = [];
  const cmndCurve: number[] = [];
  for (let tau = 1; tau <= tauMax; tau++) {
    diffCurve.push(diff[tau]);
    cmndCurve.push(cmnd[tau]);
  }

  if (zeroDenominator) {
    // 全常量窗口（去均值后全零已被静音分支拦截；此处防御）
    return {
      ...base,
      status: "silent",
      diffCurve,
      cmndCurve,
      notes: ["差分分母全程为零（近常量窗口），不产生 NaN，判为不可估计"],
    };
  }

  // 候选区间内找首个低于阈值的谷，再走到局部最小
  let chosen: number | null = null;
  let crossing: number | null = null;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmnd[tau] < threshold) {
      crossing = tau;
      let t = tau;
      while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
      chosen = t;
      break;
    }
  }

  // 最佳观察值（诊断用）
  let bestTau = tauMin;
  for (let tau = tauMin + 1; tau <= tauMax; tau++) {
    if (cmnd[tau] < cmnd[bestTau]) bestTau = tau;
  }
  const bestObserved = { tau: bestTau, cmnd: cmnd[bestTau] };

  if (chosen === null) {
    return {
      ...base,
      status: "no_candidate",
      bestObserved,
      diffCurve,
      cmndCurve,
      notes: [
        `候选区间 [${tauMin}, ${tauMax}] 内无 cmnd < ${threshold} 的谷，返回不可估计`,
        `最佳观察值 tau=${bestTau}, cmnd=${cmnd[bestTau].toFixed(4)}（仅诊断，非有效音高）`,
      ],
    };
  }

  const frequency = sampleRate / chosen;
  const resolutionHz = Math.abs(sampleRate / chosen - sampleRate / (chosen + 1));
  return {
    ...base,
    status: "ok",
    tau: chosen,
    frequency,
    clarity: cmnd[chosen],
    bestObserved,
    thresholdCrossing: crossing,
    diffCurve,
    cmndCurve,
    notes: [
      `整数延迟 tau=${chosen}，频率=${frequency.toFixed(3)} Hz，该延迟处频率分辨率约 ±${resolutionHz.toFixed(3)} Hz`,
      "clarity 为启发式可信参考，不是统计正确率；高频、缺基音或强谐波时可能出现八度歧义",
    ],
  };
}
