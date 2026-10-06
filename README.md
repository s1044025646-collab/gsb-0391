# 单音 YIN 基频估计后端（API + CLI）

离线、单音、单窗口的 YIN 基频估计服务。输入一段单声道归一化采样数组、采样率与期望频率范围，判断该窗口是否具有足够可信的周期，返回候选基频、整数周期与判断依据。

只做后端：不录音、不读麦克风、不识别歌词/曲谱，不做多音分离、混响评估与实时跟踪，也不会把任意噪声强行判成某个音高。

## 环境要求

- Windows 本地运行，Node.js >= 22.5（使用内置 `node:sqlite`，无需原生编译、Docker、WSL 或任何在线服务）
- 安装依赖：`npm install`

## 常用命令

```powershell
npm run build     # 编译 TypeScript 到 dist/
npm test          # 编译并运行全部测试
npm start         # 启动 HTTP API（--port 指定端口，被占用时自动选空闲端口）
npm run demo      # 内置演示：250Hz 正弦 / 静音 / 常量偏置 / 无候选噪声
npm run cli -- <命令>   # 直接调用 CLI（需先 build）
```

CLI 命令一览（`node dist/src/cli.js help` 查看完整说明）：

- `serve [--port N] [--db PATH]`：启动 API，默认端口 0（系统自动分配空闲端口）
- `synth [--freq 250] [--sr 8000] [--seconds 0.1] [--amp 0.5] [--dc 0] [--noise 0] [--seed 42] [--out FILE]`：生成可复现合成样本（固定种子 LCG，无外部音频）
- `analyze --file F | --synth [--fmin --fmax --threshold --amplitudeThreshold]`：分析并保存报告
- `report --id N`：读取历史报告（重启后仍可解释，含参数版本）
- `tau --id N --tau T`：查询报告中某个延迟的差分/归一化值
- `compare --id N [--threshold T] [--fmin F] [--fmax G]`：用不同阈值/频率范围重判同一窗口，生成新报告，不覆盖原始音频与旧结论
- `export --id N [--format csv|json] [--out FILE]`：导出原始差分曲线与归一化曲线
- `demo`：运行四个内置演示

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/windows` | 保存窗口 `{samples, sampleRate}` |
| POST | `/analyze` | 分析 `{samples}` 或 `{windowId}`，可带 `sampleRate/fmin/fmax/threshold/amplitudeThreshold` |
| GET | `/reports` | 历史报告列表 |
| GET | `/reports/:id` | 完整报告（含曲线、参数版本、判断依据） |
| GET | `/reports/:id/tau/:tau` | 查询某个延迟的曲线值（越界返回 `E_TAU_RANGE`） |
| GET | `/reports/:id/compare?threshold=&fmin=&fmax=` | 不同参数重判同一窗口 |
| GET | `/reports/:id/export?format=csv|json` | 导出曲线 |

## 算法说明

1. 去均值：先减去窗口均值，再按去均值后的 RMS 与 `amplitudeThreshold`（默认 1e-4）比较，判定静音/近常量（`silent`）。
2. 延迟范围：`tauMin = ceil(采样率/fmax)`，`tauMax = floor(采样率/fmin)`，固定比较长度 `W = N - tauMax`。
3. 差分函数：`d(tau) = sum_{j=0..W-1} (x[j] - x[j+tau])^2`，对 `tau = 1..tauMax` 全部计算——低于候选区间的延迟也参与累计分母，不漏算。
4. 累积均值归一化：`cmnd(tau) = d(tau)*tau / sum_{k=1..tau} d(k)`。分母为零（全常量窗口）时明确判为不可估计，不产生 NaN。
5. 选谷：在 `[tauMin, tauMax]` 内找首个 `cmnd < threshold`（默认 0.15）的点（阈值交点），再沿下降趋势走到局部最小，得到整数延迟 `tau`，频率 = 采样率 / tau。无满足阈值的谷时返回 `no_candidate`，附最佳观察值仅供诊断，不冒充有效音高。
6. 整数延迟，无抛物线细化，无 FFT。

## 阈值意义

- `threshold`（周期阈值，默认 0.15）：cmnd 低于该值才认为周期可信。越小越严格，漏检增多；越大越宽松，误检增多。
- `amplitudeThreshold`（幅度阈值，默认 1e-4）：去均值后 RMS 低于该值判为静音/近常量。两个阈值分别保存、分别可调。

## 结果状态与错误码

状态：`ok`（有效估计）、`silent`（静音/近常量）、`no_candidate`（无候选）、`invalid`（输入非法）。

错误码：`E_SAMPLES_TYPE`、`E_SAMPLE_VALUE`（非有限数）、`E_SAMPLE_RANGE`（超出正负 1）、`E_SAMPLE_RATE`、`E_FREQ_RANGE`、`E_FREQ_NYQUIST`（fmax 须低于奈奎斯特）、`E_THRESHOLD`、`E_AMP_THRESHOLD`、`E_TAU_RANGE`、`E_WINDOW_SHORT`（N 须 >= tauMax + 2）。

## 公开的限制

- 报告中公开窗口长度 W、延迟范围 `[tauMin, tauMax]` 与运算量上限（约 `W * tauMax` 次乘加）。
- 整数延迟导致高频处频率分辨率粗（报告给出选中延迟处的分辨率，例如 8000Hz/250Hz 时约 7.6Hz）。
- 缺少基音或谐波较强时可能选中谐波周期，出现八度歧义；`clarity` 只是启发式可信参考，不是统计正确率。
- 只分析给定的一段窗口，不做跨窗口跟踪。

## 数据与可解释性

- SQLite 数据库默认在项目内 `data/yin.db`，保存原始采样数组、采样率、参数版本（`yin-int-v1`）与完整结果（含两条曲线）。
- 重算（`compare`）创建新报告，不覆盖原始音频数组或旧结论；重启后 `report --id` 可完整解释原报告。
- 报告包含原始差分曲线、归一化曲线、阈值交点与最终选谷，导出 CSV 后无需图形即可逐行核对。

## 演示

`npm run demo` 输出四个场景：8000Hz 采样率下 250Hz 纯正弦在 tau=32（周期 32 样本）处出谷；静音与常量偏置判为 `silent`；强噪声不满足阈值判为 `no_candidate`。

## 测试

`npm test` 覆盖：整周期短序列、不同幅度、直流偏置、非法采样率、过短窗口、频率边界、手工周期序列独立核对差分值、纯音整数延迟误差、去均值后的偏置不变性、强度足够时的幅度缩放不变性，以及 API 全链路（保存/分析/查询/比较/导出/历史/重启后可解释）。
