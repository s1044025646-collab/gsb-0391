export const PARAM_VERSION = "yin-v1";
export const DEFAULT_THRESHOLD = 0.15;
export const DEFAULT_RMS_THRESHOLD = 1e-4;
export const MAX_SAMPLES = 1_000_000;

export type Status = "ok" | "silence" | "no_candidate" | "invalid_input";

export interface YinParams {
  sampleRate: number;
  fMin: number;
  fMax: number;
  threshold?: number;
  rmsThreshold?: number;
}

export interface TauPoint {
  tau: number;
  diff: number;
  cmnd: number;
}

export interface YinResult {
  status: Status;
  errorCode?: string;
  message?: string;
  paramVersion: string;
  sampleRate: number;
  fMin: number;
  fMax: number;
  threshold: number;
  rmsThreshold: number;
  tauMin: number;
  tauMax: number;
  windowLength: number;
  compareLength: number;
  mean: number;
  rms: number;
  tau?: number;
  frequency?: number;
  cmndAtTau?: number;
  bestTau?: number;
  bestCmnd?: number;
  crossings: { tau: number; cmnd: number }[];
  curve: TauPoint[];
  notes: string[];
}

export function validateInput(samples: unknown, p: YinParams): string | null {
  if (!Array.isArray(samples)) return "samples 必须是数组";
  if (samples.length === 0) return "samples 不能为空";
  if (samples.length > MAX_SAMPLES) return `samples 长度超过上限 ${MAX_SAMPLES}`;
  for (const s of samples) {
    if (typeof s !== "number" || !Number.isFinite(s)) return "采样必须为有限数值";
    if (s < -1 || s > 1) return "采样必须在 [-1, 1] 之间";
  }
  if (!Number.isFinite(p.sampleRate) || p.sampleRate <= 0) return "采样率必须为正数";
  if (!Number.isFinite(p.fMin) || !Number.isFinite(p.fMax) || p.fMin <= 0 || p.fMax <= 0)
    return "频率范围必须为正数";
  if (p.fMin >= p.fMax) return "fMin 必须小于 fMax";
  const nyquist = p.sampleRate / 2;
  if (p.fMax >= nyquist) return `fMax 必须低于奈奎斯特频率 ${nyquist}`;
  const th = p.threshold ?? DEFAULT_THRESHOLD;
  if (!(th > 0 && th < 1)) return "threshold 必须在 (0,1) 之间";
  const rt = p.rmsThreshold ?? DEFAULT_RMS_THRESHOLD;
  if (!(rt >= 0)) return "rmsThreshold 必须非负";
  const tauMin = Math.ceil(p.sampleRate / p.fMax);
  const tauMax = Math.floor(p.sampleRate / p.fMin);
  if (tauMax < tauMin) return "延迟范围为空：请检查频率范围";
  const w = samples.length - tauMax;
  if (w < 2) return `窗口太短：需要至少 tauMax+2 = ${tauMax + 2} 个样本，当前 ${samples.length}`;
  return null;
}

export function analyzeYin(samples: number[], p: YinParams): YinResult {
  const threshold = p.threshold ?? DEFAULT_THRESHOLD;
  const rmsThreshold = p.rmsThreshold ?? DEFAULT_RMS_THRESHOLD;
  const tauMin = Math.ceil(p.sampleRate / p.fMax);
  const tauMax = Math.floor(p.sampleRate / p.fMin);
  const n = samples.length;
  const w = n - tauMax;
  const notes: string[] = [
    `整数延迟估计，频率分辨率在高频端受限：tau 与 tau+1 之间无法区分`,
    `缺少基音或谐波过强时可能出现八度歧义；可信判断为启发式阈值，非统计正确率`,
  ];

  const invalid = validateInput(samples, p);
  const base: YinResult = {
    status: "ok",
    paramVersion: PARAM_VERSION,
    sampleRate: p.sampleRate,
    fMin: p.fMin,
    fMax: p.fMax,
    threshold,
    rmsThreshold,
    tauMin,
    tauMax,
    windowLength: n,
    compareLength: w,
    mean: 0,
    rms: 0,
    crossings: [],
    curve: [],
    notes,
  };
  if (invalid) {
    return { ...base, status: "invalid_input", errorCode: "E_INVALID_INPUT", message: invalid };
  }

  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const x = new Float64Array(n);
  let sq = 0;
  for (let i = 0; i < n; i++) { x[i] = samples[i] - mean; sq += x[i] * x[i]; }
  const rms = Math.sqrt(sq / n);
  base.mean = mean;
  base.rms = rms;

  if (rms < rmsThreshold) {
    return { ...base, status: "silence", errorCode: "E_SILENCE",
      message: `去均值后 RMS=${rms.toExponential(3)} 低于阈值 ${rmsThreshold}，判定为静音或近常量输入` };
  }

  const d = new Float64Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < w; j++) {
      const delta = x[j] - x[j + tau];
      sum += delta * delta;
    }
    d[tau] = sum;
  }

  const cmnd = new Float64Array(tauMax + 1);
  cmnd[1] = 1;
  let running = d[1];
  let zeroDenominator = true;
  for (let tau = 2; tau <= tauMax; tau++) {
    running += d[tau];
    cmnd[tau] = running === 0 ? 1 : (d[tau] * tau) / running;
    if (running !== 0) zeroDenominator = false;
  }
  if (zeroDenominator) {
    return { ...base, status: "silence", errorCode: "E_CONSTANT",
      message: "差分累计分母为零（窗口去均值后为常量），无法估计周期" };
  }

  const curve: TauPoint[] = [];
  for (let tau = 1; tau <= tauMax; tau++) curve.push({ tau, diff: d[tau], cmnd: cmnd[tau] });
  base.curve = curve;

  let bestTau = tauMin, bestCmnd = cmnd[tauMin];
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmnd[tau] < bestCmnd) { bestCmnd = cmnd[tau]; bestTau = tau; }
  }
  base.bestTau = bestTau;
  base.bestCmnd = bestCmnd;

  const crossings: { tau: number; cmnd: number }[] = [];
  let chosen: number | null = null;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmnd[tau] < threshold) {
      crossings.push({ tau, cmnd: cmnd[tau] });
      if (chosen === null) {
        let t = tau;
        while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
        chosen = t;
      }
    }
  }
  base.crossings = crossings;

  if (chosen === null) {
    return { ...base, status: "no_candidate", errorCode: "E_NO_CANDIDATE",
      message: `声明延迟范围内没有低于阈值 ${threshold} 的谷；最佳观察值 tau=${bestTau}, cmnd=${bestCmnd.toFixed(4)}（仅供参考，不是有效音高）` };
  }

  return {
    ...base,
    status: "ok",
    tau: chosen,
    frequency: p.sampleRate / chosen,
    cmndAtTau: cmnd[chosen],
  };
}
