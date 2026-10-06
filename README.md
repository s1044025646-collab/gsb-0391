# 单音 YIN 基频估计后端（TypeScript + Node.js + SQLite）

离线、单窗口、单音的 YIN 基频估计服务。输入一段单声道归一化采样数组、采样率和期望频率范围，
判断该窗口是否具有足够可信的周期，返回候选基频、整数周期（延迟 tau）与完整判断依据。
不录音、不读麦克风、不做多音分离、不做实时跟踪，也不会把任意噪声强行判成音高。

## 环境要求

- Windows 本地，Node.js >= 22.5（使用内置 `node:sqlite`，无原生依赖、无外部服务）
- 仅开发依赖：typescript、tsx、@types/node

## 快速开始

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 运行全部测试（算法 + 存储 + API 端到端）
npm run demo      # 四个内置演示：250Hz 正弦 / 静音 / 常量偏置 / 白噪声
npm start         # 启动 API 服务（默认自动选择空闲端口）
```

CLI 直接使用：

```powershell
node dist/cli.js serve --port 8080          # 指定端口；省略则选空闲端口
node dist/cli.js synth --kind sine --freq 250 --len 1024 --amp 0.5 --dc 0 --seed 42 --sr 8000
node dist/cli.js analyze --windowId 1 --fmin 50 --fmax 1000 --threshold 0.15
node dist/cli.js analyze --kind sine --freq 250 --fmin 50 --fmax 1000   # 不保存窗口直接分析
node dist/cli.js report 1                    # 查看报告（重启后仍可解释）
node dist/cli.js report 1 --tau 32           # 查询某个延迟的 diff/cmnd
node dist/cli.js report 1 --export csv       # 导出整条曲线（csv 或 json）
node dist/cli.js history                     # 历史报告列表
```

数据库默认在项目内 `data/yin.db`，可用环境变量 `YIN_DB` 覆盖。

## 算法说明

1. **去均值**：先减去窗口均值，消除直流偏置；按去均值后的 RMS 判断静音/近常量
   （RMS 阈值 `rmsThreshold`，默认 1e-4，与周期阈值 `threshold` 分别保存、独立配置）。
2. **差分函数**：候选延迟 tau 从 `ceil(sr/fMax)` 到 `floor(sr/fMin)`，固定比较长度
   `W = N - tauMax`。对每个 tau 计算 `d(tau) = sum_{j=0..W-1} (x[j] - x[j+tau])^2`。
3. **累积均值归一化（CMND）**：`d'(tau) = d(tau) * tau / sum_{k=1..tau} d(k)`。
   低于候选区间的 tau（1..tauMin-1）照常参与累计分母，不漏算。
   分母为零（去均值后全常量）时明确返回 `silence`，不产生 NaN。
4. **选谷**：在 `[tauMin, tauMax]` 内找首个 `d'(tau) < threshold`（默认 0.15）的延迟，
   沿下降趋势走到局部最小值作为整数周期；频率 = `sr / tau`。
   没有任何低于阈值的谷时返回 `no_candidate`，只附最佳观察值，不冒充有效音高。
5. 不做抛物线细化、不使用 FFT，纯整数延迟。

### 阈值意义

- `threshold`（CMND 阈值）：越小越严格。0 表示完全周期；0.15 是 YIN 论文常用值。
  它是启发式判据，**不是统计正确率**。
- `rmsThreshold`（幅度阈值）：去均值后 RMS 低于它即判静音/近常量，避免把数值噪声当信号。

### 公开的限制

- 整数延迟 → 频率分辨率受限，高频端尤其明显（如 sr=8000、tau=8 与 tau=9 之间相差 111 Hz）。
- 缺少基音或谐波过强时可能出现八度歧义（选到 2 倍或 1/2 周期）。
- 报告中的 `notes` 字段会随每次分析附带这些限制说明。
- 运算量约 `O(tauMax * W)`，每次报告都公开窗口长度、延迟范围和该上限；采样数上限 100 万。

## API

全部 JSON，错误统一返回 `{ errorCode, message }`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| POST | `/windows` | 保存窗口 `{sampleRate, samples}` → `{windowId}` |
| POST | `/analyze` | 分析 `{windowId}` 或 `{samples, sampleRate}` + `fMin/fMax[/threshold/rmsThreshold]`，每次生成新报告 |
| GET | `/reports` | 历史报告列表 |
| GET | `/reports/:id` | 报告全文（含曲线、交点、选谷、判断依据） |
| GET | `/reports/:id/tau/:tau` | 查询某个延迟的 diff/cmnd |
| GET | `/reports/:id/export?format=csv\|json` | 导出曲线 |
| POST | `/compare` | 同一窗口比较多个 `thresholds` 或 `fRanges` |

### 状态与错误码

- `ok`：有效估计（含 `tau`、`frequency`、`cmndAtTau`）
- `silence`（`E_SILENCE` / `E_CONSTANT`）：静音、近常量或差分分母为零
- `no_candidate`（`E_NO_CANDIDATE`）：无低于阈值的谷，附最佳观察值
- `invalid_input`（`E_INVALID_INPUT`，HTTP 422）：采样非有限数、超出 [-1,1]、
  采样率非正、频率范围非正或达到奈奎斯特、窗口不足以形成比较长度等

## 存储

SQLite 两张表：`windows`（原始采样数组，永不修改）与 `reports`（参数、参数版本
`yin-v1`、完整结果 JSON）。重新分析同一窗口只会插入新报告，不覆盖原始音频与旧结论，
重启后可用 `report <id>` 完整解释历史报告。

## 合成样本

`node dist/cli.js synth` 与 `--kind` 支持 `sine / harmonic / silence / constant / noise`，
参数（频率、幅度、直流偏置、种子）固定即可复现，不依赖任何外部音频或在线接口。

## 测试

`npm test` 覆盖：整周期短序列、不同幅度、直流偏置不变性、幅度缩放不变性、
非法采样率/非法采样/超奈奎斯特、过短窗口、频率边界（tau=tauMin）、
手工周期序列逐项核对差分值、噪声不冒充音高、存储不覆盖、API 端到端。
