/** CLI：serve / analyze / synth / report / export / compare / demo */
import * as path from "node:path";
import * as fs from "node:fs";
import { analyze, DEFAULT_PARAMS, type YinParams } from "./yin.js";
import { synthesize } from "./synth.js";
import { Store, defaultDbPath, PARAMS_VERSION } from "./db.js";
import { createServer, listen } from "./server.js";

function parseArgs(argv: string[]): { cmd: string; rest: Record<string, string>; positional: string[] } {
  const [cmd = "help", ...args] = argv;
  const rest: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        rest[key] = next;
        i++;
      } else {
        rest[key] = "true";
      }
    } else {
      positional.push(args[i]);
    }
  }
  return { cmd, rest, positional };
}

function buildParams(o: Record<string, string>, sampleRate: number): YinParams {
  return {
    sampleRate,
    fmin: o.fmin !== undefined ? Number(o.fmin) : DEFAULT_PARAMS.fmin,
    fmax: o.fmax !== undefined ? Number(o.fmax) : DEFAULT_PARAMS.fmax,
    threshold: o.threshold !== undefined ? Number(o.threshold) : DEFAULT_PARAMS.threshold,
    amplitudeThreshold:
      o.amplitudeThreshold !== undefined ? Number(o.amplitudeThreshold) : DEFAULT_PARAMS.amplitudeThreshold,
  };
}

function printResult(result: ReturnType<typeof analyze>): void {
  if (result.status === "invalid") {
    console.log(`状态: invalid  错误码: ${result.code}  说明: ${result.message}`);
    return;
  }
  console.log(`状态: ${result.status}`);
  console.log(`窗口均值(去均值前): ${result.mean.toExponential(4)}  去均值后RMS: ${result.rms.toExponential(4)}`);
  console.log(`比较长度 W=${result.windowLength}  延迟范围 [${result.tauMin}, ${result.tauMax}]  运算量上限≈${result.costEstimate} 次乘加`);
  if (result.status === "ok") {
    console.log(`选中延迟 tau=${result.tau}  基频=${result.frequency!.toFixed(3)} Hz  clarity=${result.clarity!.toFixed(4)}`);
    console.log(`阈值交点 tau=${result.thresholdCrossing}`);
  }
  if (result.bestObserved) {
    console.log(`最佳观察值: tau=${result.bestObserved.tau}  cmnd=${result.bestObserved.cmnd.toFixed(4)}`);
  }
  for (const n of result.notes) console.log(`说明: ${n}`);
}

const HELP = `用法: node src/cli.ts <命令> [选项]
命令:
  serve [--port N] [--db PATH]              启动 HTTP API（端口被占用时自动选空闲端口）
  synth [--freq 250] [--sr 8000] [--seconds 0.1] [--amp 0.5] [--dc 0] [--noise 0] [--seed 42] [--out FILE]
                                            生成可复现合成样本（JSON）
  analyze --file FILE | --synth [--freq F] [--sr N] [--fmin] [--fmax] [--threshold] [--amplitudeThreshold] [--db PATH]
                                            分析一段窗口并保存报告
  report --id N [--db PATH]                 读取历史报告（重启后可解释）
  tau --id N --tau T [--db PATH]            查询报告中某个延迟的曲线值
  compare --id N [--threshold T] [--fmin F] [--fmax G] [--db PATH]
                                            用不同阈值/频率范围重判同一窗口（生成新报告）
  export --id N [--format csv|json] [--out FILE] [--db PATH]
                                            导出原始差分曲线与归一化曲线
  demo                                      运行内置演示（250Hz 正弦 / 静音 / 常量偏置 / 无候选）
`;

async function main(): Promise<void> {
  const { cmd, rest, positional } = parseArgs(process.argv.slice(2));
  const dbPath = rest.db ?? defaultDbPath();

  if (cmd === "help" || cmd === "--help") {
    console.log(HELP);
    return;
  }

  if (cmd === "serve") {
    const store = new Store(dbPath);
    const server = createServer(store);
    const preferred = rest.port !== undefined ? Number(rest.port) : 0;
    const port = await listen(server, preferred);
    console.log(`YIN API 已启动: http://127.0.0.1:${port}  数据库: ${dbPath}  参数版本: ${PARAMS_VERSION}`);
    return;
  }

  if (cmd === "synth") {
    const { samples, sampleRate } = synthesize({
      sampleRate: rest.sr !== undefined ? Number(rest.sr) : undefined,
      frequency: rest.freq !== undefined ? Number(rest.freq) : undefined,
      seconds: rest.seconds !== undefined ? Number(rest.seconds) : undefined,
      amplitude: rest.amp !== undefined ? Number(rest.amp) : undefined,
      dcOffset: rest.dc !== undefined ? Number(rest.dc) : undefined,
      noise: rest.noise !== undefined ? Number(rest.noise) : undefined,
      seed: rest.seed !== undefined ? Number(rest.seed) : undefined,
    });
    const payload = JSON.stringify({ sampleRate, samples });
    if (rest.out) {
      fs.mkdirSync(path.dirname(path.resolve(rest.out)), { recursive: true });
      fs.writeFileSync(rest.out, payload);
      console.log(`已写出 ${samples.length} 个样本到 ${rest.out}（采样率 ${sampleRate}）`);
    } else {
      console.log(payload);
    }
    return;
  }

  if (cmd === "analyze") {
    let samples: number[];
    let sampleRate: number;
    if (rest.file) {
      const data = JSON.parse(fs.readFileSync(rest.file, "utf8"));
      samples = data.samples;
      sampleRate = rest.sr !== undefined ? Number(rest.sr) : data.sampleRate;
    } else {
      const synth = synthesize({
        sampleRate: rest.sr !== undefined ? Number(rest.sr) : undefined,
        frequency: rest.freq !== undefined ? Number(rest.freq) : undefined,
        seconds: rest.seconds !== undefined ? Number(rest.seconds) : undefined,
        amplitude: rest.amp !== undefined ? Number(rest.amp) : undefined,
        dcOffset: rest.dc !== undefined ? Number(rest.dc) : undefined,
        noise: rest.noise !== undefined ? Number(rest.noise) : undefined,
      });
      samples = synth.samples;
      sampleRate = synth.sampleRate;
    }
    const params = buildParams(rest, sampleRate);
    const result = analyze(samples, params);
    printResult(result);
    if (result.status !== "invalid") {
      const store = new Store(dbPath);
      const windowId = store.saveWindow(samples, params.sampleRate);
      const reportId = store.saveReport(windowId, params, result);
      console.log(`已保存: windowId=${windowId} reportId=${reportId} 数据库=${dbPath}`);
      store.close();
    }
    return;
  }

  if (cmd === "report" || cmd === "tau" || cmd === "compare" || cmd === "export") {
    const store = new Store(dbPath);
    const id = Number(rest.id);
    const report = store.getReport(id);
    if (!report) {
      console.log(`报告 ${id} 不存在`);
      store.close();
      process.exitCode = 1;
      return;
    }
    if (cmd === "report") {
      console.log(`报告 #${report.id}  窗口 #${report.windowId}  参数版本 ${report.paramsVersion}  创建于 ${report.createdAt}`);
      console.log(`参数: ${JSON.stringify(report.params)}`);
      printResult(report.result as ReturnType<typeof analyze>);
    } else if (cmd === "tau") {
      const r = report.result as import("./yin.js").YinResult;
      const tau = Number(rest.tau);
      if (!Number.isInteger(tau) || tau < 1 || tau > r.tauMax) {
        console.log(`错误码 E_TAU_RANGE: tau 需在 [1, ${r.tauMax}]`);
        process.exitCode = 1;
      } else {
        console.log(`tau=${tau}  diff=${r.diffCurve[tau - 1]}  cmnd=${r.cmndCurve[tau - 1]}  候选区间内=${tau >= r.tauMin && tau <= r.tauMax}  被选中=${r.tau === tau}`);
      }
    } else if (cmd === "compare") {
      const w = store.getWindow(report.windowId)!;
      const params = buildParams(rest, w.sampleRate);
      const result = analyze(w.samples, params);
      printResult(result);
      if (result.status !== "invalid") {
        const newId = store.saveReport(report.windowId, params, result);
        console.log(`重算生成新报告 reportId=${newId}（原报告 #${id} 与原始音频保持不变）`);
      }
    } else {
      const r = report.result as import("./yin.js").YinResult;
      const format = rest.format ?? "json";
      let text: string;
      if (format === "csv") {
        const lines = ["tau,diff,cmnd"];
        for (let i = 0; i < r.diffCurve.length; i++) lines.push(`${i + 1},${r.diffCurve[i]},${r.cmndCurve[i]}`);
        text = lines.join("\n");
      } else {
        text = JSON.stringify(
          {
            reportId: report.id,
            tauMin: r.tauMin,
            tauMax: r.tauMax,
            threshold: report.params.threshold,
            thresholdCrossing: r.thresholdCrossing,
            selectedTau: r.tau,
            diffCurve: r.diffCurve,
            cmndCurve: r.cmndCurve,
          },
          null,
          2
        );
      }
      if (rest.out) {
        fs.writeFileSync(rest.out, text);
        console.log(`已导出到 ${rest.out}`);
      } else {
        console.log(text);
      }
    }
    store.close();
    return;
  }

  if (cmd === "demo") {
    console.log("=== 演示 1: 8000 Hz 采样率、250 Hz 纯正弦（期望周期约 32 样本） ===");
    const s1 = synthesize({ sampleRate: 8000, frequency: 250, seconds: 0.1, amplitude: 0.5 });
    printResult(analyze(s1.samples, buildParams({}, s1.sampleRate)));

    console.log("\n=== 演示 2: 静音 ===");
    const s2 = synthesize({ amplitude: 0 });
    printResult(analyze(s2.samples, buildParams({}, s2.sampleRate)));

    console.log("\n=== 演示 3: 常量偏置（直流 0.3，无交流成分） ===");
    const s3 = synthesize({ amplitude: 0, dcOffset: 0.3 });
    printResult(analyze(s3.samples, buildParams({}, s3.sampleRate)));

    console.log("\n=== 演示 4: 强噪声，不满足阈值（应返回 no_candidate） ===");
    const s4 = synthesize({ amplitude: 0, noise: 0.8, seed: 7 });
    printResult(analyze(s4.samples, buildParams({}, s4.sampleRate)));
    return;
  }

  console.log(`未知命令: ${cmd}\n${HELP}`);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
