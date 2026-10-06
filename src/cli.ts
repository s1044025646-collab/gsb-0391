import { join } from "node:path";
import { Store } from "./db.js";
import { analyzeYin, YinParams } from "./yin.js";
import { synth, WaveKind } from "./synth.js";
import { startServer } from "./server.js";

const DB_PATH = process.env.YIN_DB ?? join(process.cwd(), "data", "yin.db");

function args(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[k] = v;
    }
  }
  return out;
}

function printSummary(id: number, r: ReturnType<typeof analyzeYin>) {
  console.log(`报告 #${id}  状态: ${r.status}${r.message ? "  (" + r.message + ")" : ""}`);
  console.log(`  窗口长度=${r.windowLength}  比较长度 W=${r.compareLength}  延迟范围=[${r.tauMin}, ${r.tauMax}]  运算量约 O(tauMax*W)=${r.tauMax * r.compareLength}`);
  console.log(`  均值=${r.mean.toExponential(3)}  去均值RMS=${r.rms.toExponential(3)}  阈值=${r.threshold}  RMS阈值=${r.rmsThreshold}`);
  if (r.status === "ok") console.log(`  基频=${r.frequency!.toFixed(2)} Hz  周期 tau=${r.tau} 样本  cmnd=${r.cmndAtTau!.toFixed(4)}`);
  if (r.bestTau != null) console.log(`  最佳观察值 tau=${r.bestTau} cmnd=${r.bestCmnd!.toFixed(4)}`);
  if (r.crossings.length) console.log(`  阈值交点: ${r.crossings.map(c => `tau=${c.tau}(${c.cmnd.toFixed(3)})`).join(", ")}`);
  for (const n of r.notes) console.log(`  注意: ${n}`);
}

function samplesFromArgs(a: Record<string, string>): { samples: number[]; sampleRate: number } {
  const sr = Number(a.sr ?? 8000);
  const kind = (a.kind ?? "sine") as WaveKind;
  return {
    samples: synth(kind, {
      sampleRate: sr,
      frequency: Number(a.freq ?? 250),
      length: Number(a.len ?? 1024),
      amplitude: Number(a.amp ?? 0.5),
      dcOffset: Number(a.dc ?? 0),
      seed: Number(a.seed ?? 42),
    }),
    sampleRate: sr,
  };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);
  const store = new Store(DB_PATH);

  switch (cmd) {
    case "serve": {
      const { port } = await startServer(store, Number(a.port ?? 0));
      console.log(`YIN 服务已启动: http://127.0.0.1:${port}  (数据库: ${DB_PATH})`);
      return;
    }
    case "synth": {
      const { samples, sampleRate } = samplesFromArgs(a);
      const id = store.saveWindow(sampleRate, samples);
      console.log(`已保存窗口 #${id}: kind=${a.kind ?? "sine"} sr=${sampleRate} len=${samples.length}`);
      break;
    }
    case "analyze": {
      let samples: number[], sampleRate: number, windowId: number | null = null;
      if (a.windowId) {
        const w = store.getWindow(Number(a.windowId));
        if (!w) { console.error(`窗口 ${a.windowId} 不存在`); process.exit(1); }
        samples = w.samples; sampleRate = Number(a.sr ?? w.sampleRate); windowId = Number(a.windowId);
      } else {
        ({ samples, sampleRate } = samplesFromArgs(a));
      }
      const params: YinParams = {
        sampleRate,
        fMin: Number(a.fmin ?? 50),
        fMax: Number(a.fmax ?? 1000),
        threshold: a.threshold ? Number(a.threshold) : undefined,
        rmsThreshold: a.rmsThreshold ? Number(a.rmsThreshold) : undefined,
      };
      const result = analyzeYin(samples, params);
      const id = store.saveReport(windowId, params, result);
      printSummary(id, result);
      break;
    }
    case "report": {
      const id = Number(rest[0]);
      const r = store.getReport(id);
      if (!r) { console.error(`报告 ${id} 不存在`); process.exit(1); }
      if (a.tau) {
        const pt = r.result.curve.find(c => c.tau === Number(a.tau));
        console.log(pt ? `tau=${pt.tau} diff=${pt.diff} cmnd=${pt.cmnd}` : `延迟 ${a.tau} 不在范围内`);
      } else if (a.export) {
        if (a.export === "csv") {
          console.log("tau,diff,cmnd");
          for (const c of r.result.curve) console.log(`${c.tau},${c.diff},${c.cmnd}`);
        } else {
          console.log(JSON.stringify(r.result.curve));
        }
      } else {
        printSummary(id, r.result);
      }
      break;
    }
    case "history": {
      for (const r of store.listReports()) console.log(`#${r.id}  ${r.createdAt}  窗口=${r.windowId ?? "-"}  状态=${r.status}`);
      break;
    }
    case "demo": {
      const sr = 8000;
      const cases: [string, number[], YinParams][] = [
        ["250Hz 正弦 (期望 tau≈32)", synth("sine", { sampleRate: sr, frequency: 250, length: 1024, amplitude: 0.5 }),
          { sampleRate: sr, fMin: 50, fMax: 1000 }],
        ["静音", synth("silence", { sampleRate: sr, length: 1024 }),
          { sampleRate: sr, fMin: 50, fMax: 1000 }],
        ["常量偏置 0.3", synth("constant", { sampleRate: sr, length: 1024, amplitude: 0.3 }),
          { sampleRate: sr, fMin: 50, fMax: 1000 }],
        ["白噪声 (不应满足阈值)", synth("noise", { sampleRate: sr, length: 1024, amplitude: 0.5 }),
          { sampleRate: sr, fMin: 50, fMax: 1000 }],
      ];
      for (const [name, samples, params] of cases) {
        console.log(`\n=== ${name} ===`);
        const result = analyzeYin(samples, params);
        const id = store.saveReport(null, params, result);
        printSummary(id, result);
      }
      break;
    }
    default:
      console.log(`用法: node dist/cli.js <命令>
  serve [--port N]            启动 API 服务（默认自动选择空闲端口）
  synth --kind sine --freq 250 --len 1024 --amp 0.5 --dc 0 --seed 42 --sr 8000
  analyze [--windowId N | --kind ...] --fmin 50 --fmax 1000 [--threshold 0.15]
  report <id> [--tau N] [--export csv|json]
  history                     列出历史报告
  demo                        运行四个内置演示`);
  }
  store.close();
}

main().catch(e => { console.error(e); process.exit(1); });
