import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, validateInput, DEFAULT_PARAMS, type YinResult } from "../src/yin.js";
import { synthesize } from "../src/synth.js";

const SR = 8000;

function params(over: Record<string, number> = {}) {
  return {
    sampleRate: SR,
    fmin: DEFAULT_PARAMS.fmin,
    fmax: DEFAULT_PARAMS.fmax,
    threshold: DEFAULT_PARAMS.threshold,
    amplitudeThreshold: DEFAULT_PARAMS.amplitudeThreshold,
    ...over,
  };
}

test("250Hz 正弦在 tau≈32 处出谷", () => {
  const { samples } = synthesize({ sampleRate: SR, frequency: 250, seconds: 0.1, amplitude: 0.5 });
  const r = analyze(samples, params()) as YinResult;
  assert.equal(r.status, "ok");
  assert.ok(Math.abs(r.tau! - 32) <= 1, `tau=${r.tau}`);
  assert.ok(Math.abs(r.frequency! - 250) <= SR / 31 - SR / 32 + 1);
});

test("整周期短序列：手工周期序列可估计", () => {
  const samples: number[] = [];
  for (let i = 0; i < 64; i++) samples.push([0, 1, 0, -1][i % 4]);
  const r = analyze(samples, params({ fmin: 800, fmax: 3000 })) as YinResult;
  assert.equal(r.status, "ok");
  assert.equal(r.tau, 4);
  assert.equal(r.frequency, 2000);
});

test("手工核对差分值", () => {
  const samples = [0, 1, 0, -1, 0, 1, 0, -1, 0, 1, 0, -1];
  const r = analyze(samples, params({ fmin: 800, fmax: 3000 })) as YinResult;
  // 均值 0；W = 12 - tauMax = 12 - 10 = 2
  assert.equal(r.windowLength, 2);
  // d(1) = (0-1)^2 + (1-0)^2 = 2
  assert.equal(r.diffCurve[0], 2);
  // d(2) = (0-0)^2 + (1-(-1))^2 = 4
  assert.equal(r.diffCurve[1], 4);
  // d(4) = (0-0)^2 + (1-1)^2 = 0
  assert.equal(r.diffCurve[3], 0);
  // cmnd(1) = 2*1/2 = 1
  assert.equal(r.cmndCurve[0], 1);
  // cmnd(2) = 4*2/(2+4) = 4/3
  assert.ok(Math.abs(r.cmndCurve[1] - 4 / 3) < 1e-12);
});

test("直流偏置不变性：去均值后结果一致", () => {
  const a = synthesize({ frequency: 250, amplitude: 0.4, dcOffset: 0 });
  const b = synthesize({ frequency: 250, amplitude: 0.4, dcOffset: 0.3 });
  const ra = analyze(a.samples, params()) as YinResult;
  const rb = analyze(b.samples, params()) as YinResult;
  assert.equal(ra.status, "ok");
  assert.equal(rb.status, "ok");
  assert.equal(ra.tau, rb.tau);
  assert.ok(Math.abs(rb.mean - 0.3) < 0.01);
});

test("幅度缩放不变性（强度足够时）", () => {
  for (const amp of [0.1, 0.5, 0.9]) {
    const { samples } = synthesize({ frequency: 440, amplitude: amp });
    const r = analyze(samples, params()) as YinResult;
    assert.equal(r.status, "ok");
    assert.ok(Math.abs(r.tau! - Math.round(SR / 440)) <= 1, `amp=${amp} tau=${r.tau}`);
  }
});

test("静音与常量偏置判为 silent，不产生 NaN", () => {
  const silence = new Array(800).fill(0);
  const r1 = analyze(silence, params()) as YinResult;
  assert.equal(r1.status, "silent");
  const dc = new Array(800).fill(0.5);
  const r2 = analyze(dc, params()) as YinResult;
  assert.equal(r2.status, "silent");
  assert.ok(!Number.isNaN(r2.rms));
});

test("纯噪声无候选时返回 no_candidate 且不冒充音高", () => {
  const { samples } = synthesize({ amplitude: 0, noise: 0.9, seed: 123 });
  const r = analyze(samples, params()) as YinResult;
  assert.ok(r.status === "no_candidate" || r.status === "ok");
  if (r.status === "no_candidate") {
    assert.equal(r.frequency, null);
    assert.ok(r.bestObserved !== null);
  }
});

test("非法输入：采样率、样本越界、NaN、过短窗口、频率边界", () => {
  const ok = new Array(800).fill(0).map((_, i) => Math.sin(i / 5));
  assert.equal((analyze(ok, params({ sampleRate: -1 })) as any).code, "E_SAMPLE_RATE");
  assert.equal((analyze(ok, params({ sampleRate: NaN })) as any).code, "E_SAMPLE_RATE");
  assert.equal((analyze([0.5, 1.5, 0], params()) as any).code, "E_SAMPLE_RANGE");
  assert.equal((analyze([0.5, NaN, 0], params()) as any).code, "E_SAMPLE_VALUE");
  assert.equal((analyze([0.1, 0.2], params()) as any).code, "E_WINDOW_SHORT");
  assert.equal((analyze(ok, params({ fmax: 4000 })) as any).code, "E_FREQ_NYQUIST");
  assert.equal((analyze(ok, params({ fmin: 500, fmax: 100 })) as any).code, "E_FREQ_RANGE");
  assert.equal((analyze(ok, params({ fmin: 0 })) as any).code, "E_FREQ_RANGE");
  assert.equal((analyze(ok, params({ threshold: 1.5 })) as any).code, "E_THRESHOLD");
});

test("频率边界：fmin/fmax 恰好对应可估频率", () => {
  const { samples } = synthesize({ frequency: 250, seconds: 0.2 });
  const r = analyze(samples, params({ fmin: 240, fmax: 260 })) as YinResult;
  assert.equal(r.status, "ok");
  assert.ok(r.frequency! >= 240 && r.frequency! <= 260);
});

test("低于候选区间的延迟参与累计分母", () => {
  const samples: number[] = [];
  for (let i = 0; i < 128; i++) samples.push([0, 1, 0, -1][i % 4]);
  const r = analyze(samples, params({ fmin: 300, fmax: 1000 })) as YinResult;
  assert.equal(r.tauMin, 8);
  assert.equal(r.diffCurve[3], 0);
  assert.equal(r.status, "ok");
  assert.equal(r.tau, 8);
});

test("validateInput 拒绝空数组", () => {
  assert.equal(validateInput([], params())!.code, "E_SAMPLES_TYPE");
});
