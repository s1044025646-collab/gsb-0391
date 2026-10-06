/** 本机合成样本生成：固定参数可复现，不依赖外部音频。 */

export interface SynthOptions {
  sampleRate: number;
  frequency: number;
  seconds: number;
  amplitude: number;
  /** 直流偏置 */
  dcOffset: number;
  /** 谐波：[谐波次数, 相对幅度] */
  harmonics: Array<[number, number]>;
  /** 伪随机噪声幅度（固定种子，可复现） */
  noise: number;
  seed: number;
}

export const DEFAULT_SYNTH: SynthOptions = {
  sampleRate: 8000,
  frequency: 250,
  seconds: 0.1,
  amplitude: 0.5,
  dcOffset: 0,
  harmonics: [],
  noise: 0,
  seed: 42,
};

/** 简单可复现的 LCG 伪随机数 */
function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff - 0.5;
  };
}

export function synthesize(opts: Partial<SynthOptions> = {}): { samples: number[]; sampleRate: number } {
  const o: SynthOptions = { ...DEFAULT_SYNTH };
  for (const [k, v] of Object.entries(opts)) {
    if (v !== undefined) (o as unknown as Record<string, unknown>)[k] = v;
  }
  const n = Math.round(o.sampleRate * o.seconds);
  const rand = lcg(o.seed);
  const samples: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / o.sampleRate;
    let v = o.amplitude * Math.sin(2 * Math.PI * o.frequency * t);
    for (const [h, a] of o.harmonics) {
      v += o.amplitude * a * Math.sin(2 * Math.PI * o.frequency * h * t);
    }
    v += o.dcOffset + o.noise * rand();
    // 截断到 [-1, 1]
    samples[i] = Math.max(-1, Math.min(1, v));
  }
  return { samples, sampleRate: o.sampleRate };
}
