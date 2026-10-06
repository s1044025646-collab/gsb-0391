/** HTTP API：保存窗口、分析、查询延迟、比较参数、导出曲线、读取历史。 */
import * as http from "node:http";
import * as net from "node:net";
import { analyze, DEFAULT_PARAMS, type YinParams, type YinResult } from "./yin.js";
import { Store } from "./db.js";

function send(res: http.ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function parseParams(q: Record<string, string | undefined>, body: Record<string, unknown>): YinParams {
  const num = (v: unknown): number | undefined =>
    v === undefined || v === null ? undefined : Number(v);
  return {
    sampleRate: num(body.sampleRate ?? q.sampleRate) ?? NaN,
    fmin: num(body.fmin ?? q.fmin) ?? DEFAULT_PARAMS.fmin,
    fmax: num(body.fmax ?? q.fmax) ?? DEFAULT_PARAMS.fmax,
    threshold: num(body.threshold ?? q.threshold) ?? DEFAULT_PARAMS.threshold,
    amplitudeThreshold:
      num(body.amplitudeThreshold ?? q.amplitudeThreshold) ?? DEFAULT_PARAMS.amplitudeThreshold,
  };
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const q: Record<string, string | undefined> = {};
      url.searchParams.forEach((v, k) => (q[k] = v));
      const parts = url.pathname.split("/").filter(Boolean);
      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/windows") {
        const body = JSON.parse(await readBody(req));
        if (!Array.isArray(body.samples) || typeof body.sampleRate !== "number") {
          return send(res, 400, { code: "E_BAD_REQUEST", message: "需要 samples 数组与 sampleRate" });
        }
        const id = store.saveWindow(body.samples, body.sampleRate);
        return send(res, 201, { windowId: id });
      }
      if (req.method === "POST" && url.pathname === "/analyze") {
        const body = JSON.parse(await readBody(req));
        let samples: unknown = body.samples;
        let sampleRate = body.sampleRate;
        if (samples === undefined && body.windowId !== undefined) {
          const w = store.getWindow(Number(body.windowId));
          if (!w) return send(res, 404, { code: "E_NOT_FOUND", message: "窗口不存在" });
          samples = w.samples;
          sampleRate = sampleRate ?? w.sampleRate;
        }
        const params = parseParams({}, { ...body, sampleRate });
        const result = analyze(samples as number[], params);
        let windowId: number | null = null;
        let reportId: number | null = null;
        if (result.status !== "invalid") {
          windowId = store.saveWindow(samples as number[], params.sampleRate);
          reportId = store.saveReport(windowId, params, result);
        }
        return send(res, result.status === "invalid" ? 400 : 200, { windowId, reportId, params, result });
      }
      if (req.method === "GET" && url.pathname === "/reports") {
        return send(res, 200, { reports: store.listReports(Number(q.limit ?? 50)) });
      }
      if (req.method === "GET" && parts[0] === "reports" && parts.length === 2) {
        const r = store.getReport(Number(parts[1]));
        if (!r) return send(res, 404, { code: "E_NOT_FOUND", message: "报告不存在" });
        return send(res, 200, r);
      }
      if (req.method === "GET" && parts[0] === "reports" && parts[2] === "tau" && parts.length === 4) {
        const r = store.getReport(Number(parts[1]));
        if (!r) return send(res, 404, { code: "E_NOT_FOUND", message: "报告不存在" });
        const result = r.result as YinResult;
        const tau = Number(parts[3]);
        if (!Number.isInteger(tau) || tau < 1 || tau > result.tauMax) {
          return send(res, 400, { code: "E_TAU_RANGE", message: `tau 需在 [1, ${result.tauMax}]` });
        }
        return send(res, 200, {
          reportId: r.id,
          tau,
          diff: result.diffCurve[tau - 1],
          cmnd: result.cmndCurve[tau - 1],
          inCandidateRange: tau >= result.tauMin && tau <= result.tauMax,
          selected: result.tau === tau,
        });
      }
      if (req.method === "GET" && parts[0] === "reports" && parts[2] === "compare") {
        const r = store.getReport(Number(parts[1]));
        if (!r) return send(res, 404, { code: "E_NOT_FOUND", message: "报告不存在" });
        const w = store.getWindow(r.windowId);
        if (!w) return send(res, 404, { code: "E_NOT_FOUND", message: "窗口不存在" });
        const params = parseParams(q, { ...r.params, ...q, sampleRate: w.sampleRate });
        const result = analyze(w.samples, params);
        return send(res, result.status === "invalid" ? 400 : 200, { baseReportId: r.id, params, result });
      }
      if (req.method === "GET" && parts[0] === "reports" && parts[2] === "export") {
        const r = store.getReport(Number(parts[1]));
        if (!r) return send(res, 404, { code: "E_NOT_FOUND", message: "报告不存在" });
        const result = r.result as YinResult;
        if (q.format === "csv") {
          const lines = ["tau,diff,cmnd"];
          for (let i = 0; i < result.diffCurve.length; i++) {
            lines.push(`${i + 1},${result.diffCurve[i]},${result.cmndCurve[i]}`);
          }
          res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
          return res.end(lines.join("\n"));
        }
        return send(res, 200, {
          reportId: r.id,
          tauMin: result.tauMin,
          tauMax: result.tauMax,
          threshold: r.params.threshold,
          thresholdCrossing: result.thresholdCrossing,
          selectedTau: result.tau,
          diffCurve: result.diffCurve,
          cmndCurve: result.cmndCurve,
        });
      }
      send(res, 404, { code: "E_NOT_FOUND", message: "未知路由" });
    } catch (e) {
      send(res, 500, { code: "E_INTERNAL", message: String(e) });
    }
  });
}

/** 选择空闲端口：优先期望端口，被占用时让系统分配。 */
export function listen(server: http.Server, preferredPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && preferredPort !== 0) {
        const probe = net.createServer();
        probe.once("error", reject);
        probe.listen(0, () => {
          const port = (probe.address() as net.AddressInfo).port;
          probe.close(() => {
            server.listen(port, () => resolve(port));
          });
        });
      } else {
        reject(err);
      }
    });
    server.listen(preferredPort, () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}
