# 要求关系最小实验

独立研究入口，不接入生产成品、selector 或发布流程。所有命令从仓库根目录运行；`cases.json` 的结构、源文行号和金标要求见 [最小业务抽取](README.minimal-extraction.md)。

```powershell
node --import tsx scripts/run-requirement-map.ts cases.json mortar data/NEW_OUTPUT gold.json direct muse-spark-1.3-contributor high 49152
```

输出目录必须不存在，父目录须存在。脚本读取 `data/config/acceptance-pi.json` 的 `global`，要求 endpoint 为 `https://opencode.ai/zen/go/v1`，不修改保存配置。模式必须显式传 `direct`（省略时的默认值不能通过本实验校验）；模型只接受 `muse-spark-1.3-contributor`。effort 可选 `low`/`high`，默认 `low`；输出预算默认 24576，可设为 1024–65536。一次任务最多 10 分钟，V1 正常两次模型调用，无自动重试。模型名称是脚本白名单，不保证上游仍提供服务。

1. recognition：识别带源行、条件、applies_to 的 facts；没有方法的要求仍保留。
2. projection：生成业务行，使用 supports 将字段映射到 fact id；排除项必须解释。
3. 程序检查 ID、源行及未处理的 fact，从原文取回引用。结果另存 extract.json；即使存在机械错误，也保留供审阅，错误在 mapping-audit.json 中，不代表生产可用。

**映射通过不代表语义覆盖。** applies_to 供模型判断，程序不验证条件蕴含；一个 fact 被使用也可能丢掉其中的条件。第一阶段遗漏的要求不会被 ID 检查发现。生成的 quote 来自源行，但源行是否支撑字段仍须核对。

2026-09-06 历史实测：本地 `data/requirement-map-20260906/report.md`。三个配对目标，新流程三次机械通过，但砂浆出现隔离层参数错用于面层及150延长米分支遗漏；尚未证明整体识别优于直接抽取。两次调用相对一次直接抽取有额外计算预算，不能把差异全部归因于中间表示。

## V2 条件复核实验

`run-requirement-map-v2.ts` 按对象和条件拆事实，再进行一次对照原文的语义复核（整表输出）。`run-requirement-map-v2-patch.ts` 保留同样前两阶段，复核只返回需要改的行；程序检查索引、保留未改行，再执行引用与映射检查。两者正常三次调用，仍不保证语义正确。

```powershell
node --import tsx scripts/run-requirement-map-v2-patch.ts cases.json mortar data/NEW_OUTPUT gold.json direct muse-spark-1.3-contributor high 49152
```

末尾可加已有 V2 输出目录，复用其 map/projection，只调用一次复核。程序要求源文、目标、识别契约及模型参数一致。回放不是独立端到端重跑；不自动修复 JSON 或循环重试。`extract.json` 是复核前，`review.json` 是复核后，`condition-review.json` 在 V2 中保存整表复核，在 V2 patch 中保存修改补丁，`review-mapping-audit.json` 是机械检查。

2026-09-06 历史记录：本地 `data/requirement-map-v2-20260906/report.md`。限定对象的提示及补丁规则不包含样本的数值答案；金标仅用于调用完成后的评估。

## 程序定位错误 → 一次返工

在上述命令的 REPLAY_DIR 后追加 `--repair-source-only`，隔离验证一个机制：对已有事实检测空白引用、越界/倒序/超过200行的定位；有错误才调用一次 Muse，修复补丁仅能写报错 fact 的起止行号。未报错事实和所有业务字段不变；找不到依据返回 unresolved，不删除事实。程序重新生成引用并检查，残留错误会非零退出。不运行语义复核，不循环重试，也不自动给源行加减偏移。

```powershell
node --import tsx scripts/run-requirement-map-v2-patch.ts cases.json rails data/NEW_OUTPUT gold.json direct muse-spark-1.3-contributor high 49152 data/FROZEN_V2 --repair-source-only
```

`map-before-repair.json` 保留原事实，`source-errors.json` 为实际反馈，`source-location-repair-submission.txt` 为原始返回，`source-repair.json` 记录补丁与残留错误，`map.json` 和 `extract.json` 为修复后的事实与派生引用。没有定位错误时跳过模型。非空但错误的引用不能被这项检查发现；通过仅表示消除了可确定的定位错误，不证明语义正确。

新输入的完整流程可在输出预算后追加 `--repair-source`（不传 REPLAY_DIR）：在识别后、投影前执行同一定位检测和至多一次返工，然后保留原来的投影及一次补丁语义复核。没有定位错误则仍为三次调用；有错误至多四次。`--repair-source-only` 仍只用于冻结输入回放。跨目标历史验证记录：本地 `data/requirement-map-transfer-20260906/`。

本文中的 `data/...` 报告是本地实验产物，不随仓库提交，不作为当前生产效果结论。离线检查可运行：

```powershell
npx vitest run --dir tests tests/requirement-map.test.ts tests/source-location-repair.test.ts
```
