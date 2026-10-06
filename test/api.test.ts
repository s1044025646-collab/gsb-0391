import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Store } from "../src/db.js";
import { createServer, listen } from "../src/server.js";
import { synthesize } from "../src/synth.js";
import type { Server } from "node:http";

let server: Server;
let base: string;
let store: Store;
let tmpDir: string;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yin-test-"));
  store = new Store(path.join(tmpDir, "test.db"));
  server = createServer(store);
  const port = await listen(server, 0);
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function post(p: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test("API: 保存窗口、分析、查询延迟、比较、导出、历史、重启后可解释", async () => {
  const { samples, sampleRate } = synthesize({ frequency: 250 });

  const w = await post("/windows", { samples, sampleRate });
  assert.equal(w.status, 201);
  assert.ok(w.json.windowId > 0);

  const a = await post("/analyze", { samples, sampleRate });
  assert.equal(a.status, 200);
  assert.equal(a.json.result.status, "ok");
  const reportId = a.json.reportId;
  assert.ok(reportId > 0);

  const tauRes = await fetch(`${base}/reports/${reportId}/tau/32`);
  const tauJson = await tauRes.json();
  assert.equal(tauRes.status, 200);
  assert.equal(tauJson.tau, 32);
  assert.ok(typeof tauJson.cmnd === "number");

  const badTau = await fetch(`${base}/reports/${reportId}/tau/99999`);
  assert.equal(badTau.status, 400);
  assert.equal((await badTau.json()).code, "E_TAU_RANGE");

  const cmp = await fetch(`${base}/reports/${reportId}/compare?threshold=0.3`);
  const cmpJson = await cmp.json();
  assert.equal(cmp.status, 200);
  assert.equal(cmpJson.params.threshold, 0.3);

  const csv = await fetch(`${base}/reports/${reportId}/export?format=csv`);
  const text = await csv.text();
  assert.ok(text.startsWith("tau,diff,cmnd"));

  const hist = await fetch(`${base}/reports`);
  const histJson = await hist.json();
  assert.ok(histJson.reports.length >= 1);

  const bad = await post("/analyze", { samples: [0.1, 2.0], sampleRate: 8000 });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.result.code, "E_SAMPLE_RANGE");

  store.close();
  const store2 = new Store(path.join(tmpDir, "test.db"));
  const r = store2.getReport(reportId);
  assert.ok(r !== null);
  assert.equal(r!.paramsVersion, "yin-int-v1");
  assert.equal((r!.result as any).status, "ok");
  store2.close();
  store = new Store(path.join(tmpDir, "test.db"));
});
