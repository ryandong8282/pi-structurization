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
