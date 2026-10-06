import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.js";
import { analyzeYin } from "../src/yin.js";
import { synth } from "../src/synth.js";
import { startServer } from "../src/server.js";

test("存储：保存窗口与报告，重算不覆盖", () => {
  const store = new Store(":memory:");
  const samples = synth("sine", { sampleRate: 8000, frequency: 250, length: 512 });
  const wid = store.saveWindow(8000, samples);
  const w = store.getWindow(wid)!;
  assert.deepEqual(w.samples, samples);
  const r1 = analyzeYin(samples, { sampleRate: 8000, fMin: 50, fMax: 1000 });
  const id1 = store.saveReport(wid, {}, r1);
  const r2 = analyzeYin(samples, { sampleRate: 8000, fMin: 50, fMax: 1000, threshold: 0.1 });
  const id2 = store.saveReport(wid, {}, r2);
  assert.notEqual(id1, id2);
  assert.equal(store.getReport(id1)!.result.paramVersion, "yin-v1");
  assert.equal(store.listReports().length, 2);
  store.close();
});

test("API：端到端", async () => {
  const store = new Store(":memory:");
  const { server, port } = await startServer(store, 0);
  const base = `http://127.0.0.1:${port}`;
  const samples = synth("sine", { sampleRate: 8000, frequency: 250, length: 512 });

  const wres = await fetch(`${base}/windows`, { method: "POST", body: JSON.stringify({ sampleRate: 8000, samples }) });
  const { windowId } = await wres.json() as { windowId: number };
  assert.ok(windowId > 0);

  const ares = await fetch(`${base}/analyze`, {
    method: "POST", body: JSON.stringify({ windowId, fMin: 50, fMax: 1000 }),
  });
  const { reportId, result } = await ares.json() as { reportId: number; result: { status: string; tau: number } };
  assert.equal(result.status, "ok");
  assert.equal(result.tau, 32);

  const tauRes = await fetch(`${base}/reports/${reportId}/tau/32`);
  const pt = await tauRes.json() as { tau: number; cmnd: number };
  assert.equal(pt.tau, 32);
  assert.ok(pt.cmnd < 0.15);

  const exp = await fetch(`${base}/reports/${reportId}/export?format=csv`);
  assert.match(await exp.text(), /tau,diff,cmnd/);

  const cmp = await fetch(`${base}/compare`, {
    method: "POST", body: JSON.stringify({ samples, sampleRate: 8000, fMin: 50, fMax: 1000, thresholds: [0.1, 0.2] }),
  });
  const { comparisons } = await cmp.json() as { comparisons: unknown[] };
  assert.equal(comparisons.length, 2);

  const hist = await fetch(`${base}/reports`);
  const { reports } = await hist.json() as { reports: unknown[] };
  assert.ok(reports.length >= 1);

  const bad = await fetch(`${base}/analyze`, { method: "POST", body: JSON.stringify({ samples: [NaN], sampleRate: 8000, fMin: 50, fMax: 100 }) });
  assert.equal(bad.status, 422);

  server.close();
  store.close();
});
