# 识别能力对照（独立实验入口）

本入口用人工指定的 Markdown 目标比较输入方式和模型，不运行生产 selector Harness，不进行 OCR、自动发现、成品发布或跨进程恢复。业务行合同基于最小抽取 V3，但本脚本另有检查范围修正规则，不能假定两者提示完全相同。生产入口见 [包说明](../README.md)。

## 运行与参数

从仓库根目录运行，先安装仓库依赖。`cases.json`、`gold.json` 和源文行号要求见 [最小业务抽取](README.minimal-extraction.md)。输出目录必须不存在，父目录必须存在。

```powershell
node --import tsx scripts/run-recognition-comparison.ts cases.json plaster data/NEW_OUTPUT gold.json direct muse-spark-1.3-contributor high 49152
```

前四个位置参数为 cases、case label、新输出目录、gold，之后依次为：

| 参数 | 默认值与允许值 |
| --- | --- |
| mode | 默认 `read-review`；允许 `direct`、`read-review` |
| model | 默认 `muse-spark-1.3-contributor`；还允许 `gpt-5.6-luna`、`kimi-k3`、`glm-5.3` |
| effort | 默认 `low`；允许 `low`、`high` |
| maxTokens | 默认 24576；允许 1024–65536 的整数 |
| 补充规则文件 | 可选第 9 个位置参数，仅 `direct` 支持，追加到本次用户输入 |

脚本读取 `data/config/acceptance-pi.json` 的 `global`，要求 endpoint 为 `https://opencode.ai/zen/go/v1`，复用已有连接信息但不修改保存配置。模型名称是实验脚本白名单，不保证上游仍提供服务。模型、effort、输出预算与补充规则均是实验变量，须分别记录。

- `direct` 默认把完整 Markdown（含条文说明）交给模型，一次回答，无工具、无机械纠错、无复核。
- `read-review` 提供目标原文和全文标题索引，允许自主补读和机械纠错，再独立复核。每阶段最多 12 请求，单任务最多 10 分钟；`extract` 与 `review` 是同一次任务的两个观察点。
- `--batch-submit` 改变 `direct` 的提交方式和预算，具体见下文。

`input.json` 记录本次输入与参数，`extract-submission-N.txt` 保存无工具调用回合的完整回答，`events.jsonl` 包含用量、回答、工具参数与实际发送的非敏感 `requestSettings`。`direct` 的 `failure.json` 可能只是引用机械校验失败，人工识别审阅仍应检查首次原始回答，不能把失败状态直接当作语义能力零分，也不能混淆首次回答与修正结果。

Kimi K3 和 GLM-5.3 走 Chat Completions，并保留工具回合的 `reasoning_content`；`reasoning_effort` 采用本次选择的 `low` 或 `high`。GLM 还启用 `thinking`，适配层移除不兼容的 `clear_thinking` 字段。以 `events.jsonl` 的实际请求设置为准；提供方决定内部思考量，跨模型设置相同不代表计算量相同。

## 可选实验开关

开关放在 maxTokens 或补充规则文件之后。没有补充规则文件时可以直接追加开关，无需空占位。

`--shared-prefix` 仅支持 `direct`：编号全文、补充规则和输出 schema 组成跨目标相同前缀，目标信息放末尾；system 规则保持不变。发送按源文 hash 固定的 `x-opencode-session` 和明确 User-Agent，`input.json` 保存 `sharedPrefixHash`。缓存是否生效以 `events.jsonl` 的 `cacheRead` 为准，不保证命中。该布局会改变目标位置，不能把与旧实验的差异全部归因于缓存。

`--batch-submit` 仅支持 `direct`：启用 `save_rows`/`finish_rows` 工具，使用业务行格式和字面引用检查，不引入 selector/compiler 合同。每批 1–16 行，整批通过后原子保存 `draft.json`，同一 key 的后续提交替换已有行。`finish_rows` 从磁盘组装结果，模型只提交 `uncertainties`。本模式保持会话上下文，最多 48 轮、20 分钟，可进行局部协议纠错，没有独立语义复核。工具参数及失败保存在 `events.jsonl`/`tool-results.jsonl`；使用不同 key 造成的重复或遗漏仍需语义审阅。

```powershell
node --import tsx scripts/run-recognition-comparison.ts cases.json plaster data/NEW_BATCH_OUTPUT gold.json direct muse-spark-1.3-contributor high 49152 --batch-submit
```

机械通过不证明识别完整，单次样本也没有统计稳定性保证。金标探针仅覆盖选定断言，主报告仍须说明未覆盖的条件、字段和来源问题。

## 历史试验记录

以下均为 2026-09-06 的本地产物，不随仓库提交，不作为当前生产效果结论：

- `data/recognition-comparison-20260906/`：模型/effort 对照、输入扰动、完整目标人工核对与原始响应。
- `data/shared-requirements-20260906/report.md`：补充规则的适用前文展开对照，未成为生产默认。
- `data/gb50202-stability-20260906/report.md`：同文重复、跨目标共享前缀试验。
- `data/gb50202-inspection-scope-20260906/report.md`：检查范围纠正试验。当前实验合同明确保留原文明示的检查/检验/试验/验收要求，不能因阶段或方法未单列而删除；方法留空、条件和数量保留，无法无损合入时单列。纯施工描述不自动成行。

离线检查：

```powershell
npx vitest run --dir tests tests/minimal-extraction.test.ts tests/business-row-draft.test.ts tests/shared-source-prompt.test.ts
```
