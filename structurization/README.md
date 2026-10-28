# pi-structurization

基于 Pi 的验收抽取、目录 Agent、模板表样与验收项目识别业务包。
源码独立维护于 [ryandong8282/pi-structurization](https://github.com/ryandong8282/pi-structurization)，应用通过版本化 npm tarball 引用。

## 与上游 Pi 的关系

仓库根目录保留 Pi SDK fork 与上游历史。本目录是有自己的 `package.json`、lockfile、构建和测试的独立业务包，不参与 SDK 的统一版本发布。
首次迁移继续使用经过当前应用验证的 Pi SDK 1.2.0；同步 fork 的上游代码不会自动升级业务包的运行依赖。SDK 升级应单独验证并发布业务包新版本。

## 开发与验证

Node >=22.19.0。从本目录运行：

```powershell
npm ci --ignore-scripts
npm rebuild better-sqlite3
npm run build
npm run check
npm run test:unit
npm pack
```

`build` 保留现有 OAuth 身份兼容处理并复制运行期 skills；消费包的正常 `npm install` 也会执行该兼容处理。使用 `--ignore-scripts` 安装的消费者，应在启动应用前执行 `node --input-type=module -e "import 'pi-structurization/compatibility'"`。
纯回归测试使用本目录 `fixtures/`。依赖私人运行现场的回放仍按各测试的存在性检查跳过，不发布主应用的 PDF、运行数据库、配置或凭据。
研究脚本位于 `scripts/`，使用本包的 `tsx`；其本地资料路径需由操作者按实际环境提供。

## 独立验收识别开发入口

`npm run dev:acceptance -- --help`。此入口只依赖本目录的依赖，直接通过 `tsx` 导入本地 `src/batch.ts` 和 `src/editor-hierarchy-runner.ts`，不需要根目录 SDK 构建、`pi-test.ps1`、pdf_ex_code、服务端或浏览器。它调用现有 `runFullBatch()`，只有全批次满足原有通过条件后才调用 `runEditorHierarchy()`；无可抽取范围且有封存理由时不运行空层级。没有加入 OCR、成品发布或新的判定规则。

准备 Node >=22.19.0 和 **已完成 MinerU 转换的 Markdown**；PDF 可选。PDF-only 输入不受支持。输入、配置和运行目录可在任意本地位置；相对路径以启动时的工作目录为准。建议私人文件放在已忽略的 `.local/`，输出放在已忽略的 `data/`。

在仓库根目录进入业务包，首次安装：

```text
cd structurization
npm ci --ignore-scripts
node scripts/patch-pi-ai.mjs
npm rebuild better-sqlite3
```

`patch-pi-ai.mjs` 是已有 Pi 1.2.0 身份兼容处理，不构建业务 `dist/`。Linux 缺少匹配的 SQLite 预编译文件时，rebuild 需要编译工具链。整个开发循环不需要启动其他仓库。

### 模型运行配置

直接构造已有 `PiAgentRuntimeModelConfig`，交给现有 `configuredModel()` 协议适配。支持外部 JSON，格式是 `{ "stages": { ... }, "subscriptionAuthPath"?: "..." }`。`stages` 的阶段名为 `discovery`、`discovery_review`、`target_extraction`、`coverage_review`、`hierarchy`；每阶段字段如下：

```json
{
  "stages": {
    "discovery":        { "apiType": "openai", "endpoint": "https://your-provider.example/v1", "apiKey": "", "model": "your-model", "effort": "low" },
    "discovery_review": { "apiType": "openai", "endpoint": "https://your-provider.example/v1", "apiKey": "", "model": "your-model", "effort": "low" },
    "target_extraction":{ "apiType": "openai", "endpoint": "https://your-provider.example/v1", "apiKey": "", "model": "your-model", "effort": "low" },
    "coverage_review":  { "apiType": "openai", "endpoint": "https://your-provider.example/v1", "apiKey": "", "model": "your-model", "effort": "low" },
    "hierarchy":        { "apiType": "openai", "endpoint": "https://your-provider.example/v1", "apiKey": "", "model": "your-model", "effort": "low" }
  }
}
```

例如保存到 `.local/runtime.json`，以环境变量 `STRUCTURIZATION_API_KEY` 注入实际密钥。也可在外部私有配置文件中提供密钥；入口不保存配置副本、不打印配置或密钥。上面的空密钥必须被覆盖。网页保存格式不能直接传入；未知顶层字段或阶段字段会被拒绝。

配置优先级：

1. 配置文件位置：`--config` > `STRUCTURIZATION_CONFIG`；不自动加载 `.env`。
2. 每个字段：阶段环境变量 > 通用环境变量 > 文件内该阶段字段 > 默认值。
3. 仅 `authMode=api_key`、`effort=off` 有默认值。其余字段必须最终齐全，所有五个阶段都校验。

通用环境变量：`STRUCTURIZATION_API_TYPE` (`openai` / `anthropic`)、`STRUCTURIZATION_ENDPOINT`、`STRUCTURIZATION_API_KEY`、`STRUCTURIZATION_MODEL`、`STRUCTURIZATION_EFFORT`、`STRUCTURIZATION_AUTH_MODE`。
阶段覆盖例如 `STRUCTURIZATION_TARGET_EXTRACTION_MODEL`、`STRUCTURIZATION_DISCOVERY_REVIEW_EFFORT`。effort 支持 `off|minimal|low|medium|high|xhigh|max`。端点必须为 HTTP(S)，不能内嵌用户名、密码、查询参数或 fragment。

现有适配仍负责 OpenAI/Anthropic 协议、按模型识别 Responses/Completions 及工具兼容。`LLM_PRESET` / `LLM_PROTOCOL` 如已设置，仍可能影响该适配；比较实验时应保持一致。本入口不把 `LLM_*` 或网页配置隐式转换为运行配置，也不自动选择 SDK 默认模型。

已有 ChatGPT OAuth 可设置阶段 `authMode=chatgpt`、`apiType=openai`，并提供 `subscriptionAuthPath` 或 `STRUCTURIZATION_SUBSCRIPTION_AUTH_PATH` 指向 **现有外部凭据文件**；此入口不登录或新建凭据系统，不把该文件复制到输出。文件内相对 auth 路径相对配置文件；环境变量 auth 路径相对工作目录。OAuth 的 endpoint/model/effort 仍需填写，具体路由由现有订阅适配决定。本次离线验证未覆盖 OAuth 或真实供应商调用。

### 完整识别：Linux

以下命令假设密钥已由当前 shell/运行环境提供，避免把密钥写入命令历史。选择真实可用的端点和模型。

```bash
cd structurization  # 从仓库根目录执行一次
export STRUCTURIZATION_API_TYPE=openai
export STRUCTURIZATION_ENDPOINT=https://your-provider.example/v1
export STRUCTURIZATION_MODEL=your-model
export STRUCTURIZATION_EFFORT=low
# STRUCTURIZATION_API_KEY 已安全注入；也可 --config .local/runtime.json
npm run dev:acceptance -- full --markdown .local/source.md --pdf .local/source.pdf --out data/runs/full-001 --job roof-001
```

只有 Markdown 时移除 `--pdf .local/source.pdf`。默认 `--concurrency 1 --attempts 3`；可显式设置并发 1..50、尝试次数 1..20。尝试次数沿用原运行器含义，不覆盖其分类预算、网络重试和封存规则。`Ctrl+C` / `SIGTERM` 会传递 AbortSignal，等待现有运行器停止并保留现场，返回 130；普通失败返回 1。

### 完整识别：PowerShell

```powershell
Set-Location structurization
$env:STRUCTURIZATION_API_TYPE = 'openai'
$env:STRUCTURIZATION_ENDPOINT = 'https://your-provider.example/v1'
$env:STRUCTURIZATION_MODEL = 'your-model'
$env:STRUCTURIZATION_EFFORT = 'low'
# STRUCTURIZATION_API_KEY 已由环境安全提供
npm run dev:acceptance -- full --markdown .local/source.md --pdf .local/source.pdf --out data/runs/full-001 --job roof-001
$LASTEXITCODE
```

两种 shell 也都可使用 `npm run dev:acceptance -- full --config .local/runtime.json --markdown .local/source.md --out data/runs/full-002 --job roof-002`。

### 从封存 discovery 重新抽取指定目标

1. 等待原运行 discovery 封存，确认 `data/runs/full-001/jobs/roof-001/discovery/state.json` 的 `status=sealed`。后续抽取失败也可以使用有效 discovery。请先停止原任务，避免读取仍在变化的工件。
2. 从 `document-target-plan.json` 读取精确 `target_id`。Linux：

   ```bash
   node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync("data/runs/full-001/jobs/roof-001/discovery/document-target-plan.json","utf8")).targets.map(t=>({id:t.target_id,name:t.name})))'
   ```

   PowerShell：

   ```powershell
   (Get-Content data/runs/full-001/jobs/roof-001/discovery/document-target-plan.json -Raw | ConvertFrom-Json).targets | Select-Object target_id, name
   ```

3. 两种 shell 都可执行下列单行命令，用实际 target ID 替换示例。`--from` 指向上次的 **输出根目录**，`--job` 必须保持原值。每次 `--out` 必须全新且与原目录互不包含。

   ```text
   npm run dev:acceptance -- targets --from data/runs/full-001 --markdown .local/source.md --pdf .local/source.pdf --out data/runs/target-001 --job roof-001 --target TARGET_ID
   ```

   多目标重复 `--target TARGET_ID_2`。有原始 PDF 身份记录时必须提供同名同字节 PDF；原批次没使用 PDF 时不能在重跑中新增。Markdown 必须同文件名、同字节；不能换一份 OCR 文本或重写 job ID 来绕过检查。没有 batch 的独立 discovery 可用于 Markdown-only 重跑；无批次 PDF 哈希时拒绝使用 PDF。

入口按当前合同校验封存 manifest、plan、evidence、registry、seal、来源身份和事件前缀，然后逐字节迁移 discovery 白名单工件。封存 discovery state 保留溯源信息，但不复制/续用其模型会话文件。调用现有 `runFullBatch({ targetIds, freshTargetIds })` 在隔离目录新建目标证据、revision、selector 和模型会话。没有复制 batch、旧目标结果、目标草稿或凭据。

这是 **重新抽取**，不是恢复旧目标检查点。本入口没有 resume 命令，不会复用已有输出目录。重新抽取只复用封存的来源和发现结果；需要更改 discovery、源文或目标范围时，应重新执行 `full`。局部目标全部封存返回 0，但摘要为 `selected_targets_sealed`、`document_pipeline_completed=false`，不运行全书层级；其余目标 pending 导致生产 batch 的文档状态失败是预期现象。任何选中目标失败或等待新来源都返回非零。

### 查看轨迹、结果和迭代

运行终端显示阶段、discovery 状态、目标状态/尝试次数/失败原因、层级进展和报告位置。输出保留现有运行器全部工件，不执行正式发布：

- `summary.json`：实际输入路径/快照/哈希、参数、来源版本、Node 版本、源码/构建输入指纹、目标状态、总耗时及目标观测耗时、失败原因和产物路径列表。不会嵌入模型配置或凭据。
- `inputs/markdown/<原文件名>`、可选 `inputs/pdf/<原文件名>`：此次冻结输入，避免运行中编辑源文件。
- `jobs/<job>/batch.json`、`result.json`、`receipt.json`：生产批次状态、聚合结果、通过/失败回执。失败也可能已有局部 `result.json`，文件存在不代表成功。
- `jobs/<job>/discovery/`：`state.json`、`document-target-plan.json`、discovery selectors 和 `session.events.jsonl`。
- 目标 revision 目录：`state.json`、`working.target-selectors.json`、已有 session/event 文件及封存结果。具体路径以 `batch.json` 中 `targets[].workdir` 和摘要的 `artifacts` 为准。
- `jobs/<job>/hierarchy/`：通过抽取门槛后的层级计划、会话和封存工件。

Linux 跟踪某个目标：`tail -f <workdir>/session.events.jsonl`；PowerShell：`Get-Content <workdir>/session.events.jsonl -Wait`。完整工件目录结构不另建一套轨迹系统。源码指纹由已有 `computeImplementationFingerprints()` 计算，包含本地提示词、工具和运行器源码；它不是 Git commit，也不是已构建 dist 的证明。

修改 `src/acceptance-prompt-suite.ts`、`src/tools.ts`、`src/selector-feedback.ts` 或其他本地源码后，停止正在执行的任务，运行相关测试，再用新 `--out` 重跑上面的 `targets` 或 `full` 命令。下次启动直接加载源码；不必 build 或重启 Web 服务。单目标报告与原任务分开，可比较两次 `summary.json` 的指纹、参数、状态和轨迹。

```text
npm run check
npx --no-install vitest run tests/dev-acceptance.test.ts
npx --no-install vitest run tests/document-discovery.test.ts tests/confirmed-target-scope.test.ts tests/batch.test.ts
```

这些检查使用合成资料、已有合同和模拟运行器，不需要真实模型。机械校验/封存只说明满足当前程序合同，**不证明语义正确或完整**。真实识别还需要可用的 Markdown（可选对应 PDF）、五阶段模型配置/凭据和供应商网络连通性；不需要在此仓库接入 OCR 凭据。私人资料、配置和输出不可提交，入口不会自动提交任何文件。

## 消费接口

```typescript
import { runFullBatch, runEditorHierarchy, runTemplateAcceptanceAgent } from 'pi-structurization';
import { normalizeMineruDisplayText } from 'pi-structurization/text-normalization';
```

从原 `@pdf-extractor/pi-agent` 迁移只修改导入名，原公开导出、参数、事件、检查点与结果格式保持。`scripts/export-lot-split-pdf.py` 作为包资源导出，通过 `import.meta.resolve('pi-structurization/scripts/export-lot-split-pdf.py')` 定位。

调用方提供资料、工作目录、模型配置、取消信号及业务回调；Job 调度、SQL Server/SQLite 正式存储、成品归档与编辑稿仍由应用负责。`PDF_EX_CODEX_ROOT` 和工作目录的规范树查找约定保留。

## 发布和同步

1. 修改代码及回归测试，更新本包版本与 CHANGELOG，运行构建、检查和回归。
2. `npm pack` 生成只包含运行代码、类型、skills 和必要脚本的 `pi-structurization-<version>.tgz`。
3. 提交并推送至此仓库，以 `structurization-v<version>` 标记提交，将 tarball 上传到对应 GitHub Release。此标签不触发上游 SDK 的 `v*` 发布。
4. 消费工程用该 Release 的固定下载 URL 更新依赖，并提交自己的 `package-lock.json`；不跟随 main 或 latest 自动升级。

本地联调可在消费工程 `npm install --no-save --package-lock=false <tarball绝对路径>`，完成后用 `npm ci` 恢复锁定版本。

需要访问消费工程保存配置的实时回放脚本保留在消费工程 `scripts/pi/`。包的 `internal/*` 导出用于这些版本绑定的研究工具，不承诺内部模块的独立兼容性。
