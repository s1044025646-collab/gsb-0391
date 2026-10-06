import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Store } from "./db.js";
import { analyzeYin, YinParams } from "./yin.js";

function send(res: ServerResponse, code: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error("请求体不是合法 JSON"), { code: "E_BAD_JSON" }); }
}

export function startServer(store: Store, port = 0) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });

      if (req.method === "POST" && url.pathname === "/windows") {
        const b = (await readBody(req)) as { sampleRate?: number; samples?: number[] };
        if (typeof b.sampleRate !== "number" || !Array.isArray(b.samples))
          return send(res, 400, { errorCode: "E_INVALID_INPUT", message: "需要 sampleRate 与 samples" });
        const id = store.saveWindow(b.sampleRate, b.samples);
        return send(res, 201, { windowId: id });
      }

      if (req.method === "POST" && url.pathname === "/analyze") {
        const b = (await readBody(req)) as {
          windowId?: number; samples?: number[]; sampleRate?: number;
          fMin?: number; fMax?: number; threshold?: number; rmsThreshold?: number;
        };
        let samples = b.samples, sampleRate = b.sampleRate;
        let windowId: number | null = null;
        if (b.windowId != null) {
          const w = store.getWindow(b.windowId);
          if (!w) return send(res, 404, { errorCode: "E_NOT_FOUND", message: `窗口 ${b.windowId} 不存在` });
          samples = w.samples; sampleRate = sampleRate ?? w.sampleRate; windowId = b.windowId;
        }
        if (!samples || sampleRate == null || b.fMin == null || b.fMax == null)
          return send(res, 400, { errorCode: "E_INVALID_INPUT", message: "需要 samples(或 windowId)、sampleRate、fMin、fMax" });
        const params: YinParams = { sampleRate, fMin: b.fMin, fMax: b.fMax, threshold: b.threshold, rmsThreshold: b.rmsThreshold };
        const result = analyzeYin(samples, params);
        const reportId = store.saveReport(windowId, params, result);
        return send(res, result.status === "invalid_input" ? 422 : 200, { reportId, result });
      }

      if (req.method === "GET" && parts[0] === "reports" && parts.length === 1) {
        return send(res, 200, { reports: store.listReports() });
      }

      if (req.method === "GET" && parts[0] === "reports" && parts[1]) {
        const id = Number(parts[1]);
        const r = store.getReport(id);
        if (!r) return send(res, 404, { errorCode: "E_NOT_FOUND", message: `报告 ${id} 不存在` });
        if (parts[2] === "tau" && parts[3]) {
          const tau = Number(parts[3]);
          const pt = r.result.curve.find(c => c.tau === tau);
          if (!pt) return send(res, 404, { errorCode: "E_NOT_FOUND", message: `延迟 ${tau} 不在范围内` });
          return send(res, 200, { reportId: id, ...pt });
        }
        if (parts[2] === "export") {
          const fmt = url.searchParams.get("format") ?? "json";
          if (fmt === "csv") {
            const csv = "tau,diff,cmnd\n" + r.result.curve.map(c => `${c.tau},${c.diff},${c.cmnd}`).join("\n");
            res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
            return res.end(csv);
          }
          return send(res, 200, { reportId: id, curve: r.result.curve, crossings: r.result.crossings });
        }
        return send(res, 200, { reportId: id, ...r });
      }

      if (req.method === "POST" && url.pathname === "/compare") {
        const b = (await readBody(req)) as {
          samples: number[]; sampleRate: number; fMin: number; fMax: number;
          thresholds?: number[]; fRanges?: { fMin: number; fMax: number }[];
        };
        if (!Array.isArray(b.samples)) return send(res, 400, { errorCode: "E_INVALID_INPUT", message: "需要 samples" });
        const runs: unknown[] = [];
        for (const t of b.thresholds ?? [])
          runs.push({ threshold: t, result: analyzeYin(b.samples, { ...b, threshold: t }) });
        for (const fr of b.fRanges ?? [])
          runs.push({ fRange: fr, result: analyzeYin(b.samples, { ...b, ...fr }) });
        return send(res, 200, { comparisons: runs });
      }

      return send(res, 404, { errorCode: "E_NOT_FOUND", message: "未知路由" });
    } catch (err) {
      const e = err as Error & { code?: string };
      return send(res, 400, { errorCode: e.code ?? "E_INTERNAL", message: e.message });
    }
  });
  return new Promise<{ server: typeof server; port: number }>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : port });
    });
  });
}
