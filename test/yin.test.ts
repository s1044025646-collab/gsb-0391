import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeYin } from "../src/yin.js";
import { synth } from "../src/synth.js";

const SR = 8000;
const P = { sampleRate: SR, fMin: 50, fMax: 1000 };

test("250Hz 正弦在 tau=32 处出谷", () => {
  const r = analyzeYin(synth("sine", { sampleRate: SR, frequency: 250, length: 1024 }), P);
  assert.equal(r.status, "ok");
  assert.equal(r.tau, 32);
  assert.ok(Math.abs(r.frequency! - 250) < SR / 32 - SR / 33);
});

test("手工周期序列核对差分值", () => {
  // 周期 4 的序列 [1,0,-1,0,...]，去均值后不变
  const seq: number[] = [];
  for (let i = 0; i < 32; i++) seq.push([1, 0, -1, 0][i % 4]);
  const r = analyzeYin(seq, { sampleRate: 8000, fMin: 100, fMax: 1000 });
  // tauMax = 80 > 31，窗口 32 太短，改用更低 fMin
  assert.equal(r.status, "invalid_input");
  const r2 = analyzeYin(seq, { sampleRate: 8000, fMin: 500, fMax: 1000 });
  // tauMin=8, tauMax=16, W=16; d[4] 不在范围内，但可手工核对曲线
  // 手工计算 d[8]: sum_{j=0..15} (x[j]-x[j+8])^2 = 0 (周期4整除8)
  const pt8 = r2.curve.find(c => c.tau === 8)!;
  assert.equal(pt8.diff, 0);
  // d[2]: x[j]-x[j+2] = [2,0,-2,0] 循环, 每项平方 4 或 0, W=16 → 8*4=32
  const pt2 = r2.curve.find(c => c.tau === 2)!;
  assert.equal(pt2.diff, 32);
  // d[1]: x[j]-x[j+1] = [1,1,-1,-1] 循环, 每项平方 1, W=16 → 16
  const pt1 = r2.curve.find(c => c.tau === 1)!;
  assert.equal(pt1.diff, 16);
});

test("直流偏置不变性", () => {
  const a = analyzeYin(synth("sine", { sampleRate: SR, frequency: 250, length: 1024, dcOffset: 0 }), P);
  const b = analyzeYin(synth("sine", { sampleRate: SR, frequency: 250, length: 1024, dcOffset: 0.3 }), P);
  assert.equal(a.tau, b.tau);
  assert.ok(Math.abs(a.rms - b.rms) < 1e-12);
});

test("幅度缩放不变性（强度足够时）", () => {
  const a = analyzeYin(synth("sine", { sampleRate: SR, frequency: 250, length: 1024, amplitude: 0.8 }), P);
  const b = analyzeYin(synth("sine", { sampleRate: SR, frequency: 250, length: 1024, amplitude: 0.05 }), P);
  assert.equal(a.tau, b.tau);
});

test("静音与常量", () => {
  assert.equal(analyzeYin(synth("silence", { sampleRate: SR, length: 1024 }), P).status, "silence");
  assert.equal(analyzeYin(synth("constant", { sampleRate: SR, length: 1024, amplitude: 0.3 }), P).status, "silence");
});

test("噪声不冒充音高", () => {
  const r = analyzeYin(synth("noise", { sampleRate: SR, length: 1024, amplitude: 0.5 }), P);
  assert.notEqual(r.status, "ok");
  assert.equal(r.status, "no_candidate");
  assert.ok(r.bestTau != null);
});

test("非法输入", () => {
  assert.equal(analyzeYin([0, NaN, 0], P).status, "invalid_input");
  assert.equal(analyzeYin([2, 0, 0], P).status, "invalid_input");
  assert.equal(analyzeYin(new Array(1024).fill(0.1), { ...P, sampleRate: -1 }).status, "invalid_input");
  assert.equal(analyzeYin(new Array(1024).fill(0.1), { ...P, sampleRate: 0 }).status, "invalid_input");
  assert.equal(analyzeYin(new Array(1024).fill(0.1), { ...P, fMax: 5000 }).status, "invalid_input"); // 超奈奎斯特
  assert.equal(analyzeYin(new Array(1024).fill(0.1), { ...P, fMin: 900, fMax: 100 }).status, "invalid_input");
});

test("过短窗口拒绝", () => {
  const r = analyzeYin(new Array(100).fill(0.1), P); // tauMax=160 > 100
  assert.equal(r.status, "invalid_input");
  assert.match(r.message!, /窗口太短/);
});

test("频率边界：fMax 对应 tauMin 边界", () => {
  // 1000Hz 正弦, sr=8000, 周期=8 = tauMin
  const r = analyzeYin(synth("sine", { sampleRate: SR, frequency: 1000, length: 1024 }), P);
  assert.equal(r.status, "ok");
  assert.equal(r.tau, 8);
});

test("整周期短序列", () => {
  // 周期 10 的短序列，恰好整数个周期
  const seq: number[] = [];
  for (let i = 0; i < 200; i++) seq.push(0.5 * Math.sin((2 * Math.PI * i) / 10));
  const r = analyzeYin(seq, { sampleRate: 8000, fMin: 100, fMax: 2000 });
  assert.equal(r.status, "ok");
  assert.equal(r.tau, 10);
});
