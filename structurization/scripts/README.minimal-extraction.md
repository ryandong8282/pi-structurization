# 最小业务抽取实验

独立研究 CLI，用于与生产抽取流程对照；不会生成正式验收成品、修改 ProductStore 或覆盖现有成品。本文记录这一实验入口的行为，生产入口见 [包说明](../README.md)。

借鉴 ContextGem 的业务结构与来源分离、LangExtract 的程序定位分工、DocETL 的上下文补读，以及 COMPASS 的明确字段定义；没有安装或运行这些框架，不代表对它们的性能测评。

## 运行

所有命令从仓库根目录运行。需要仓库现有 Node 依赖和 `data/config/acceptance-pi.json` 的 `global` 中已配置的 Muse Spark 1.3；脚本不会修改保存配置。复用既有模型传输适配，显式使用 low thinking，不读取原 Harness 的业务提示或覆盖机制。

```powershell
node --import tsx scripts/run-minimal-extraction.ts cases.json coating data/NEW_RUN_DIR gold.json
```

`NEW_RUN_DIR` 必须尚不存在，其父目录必须存在。`cases.json`、`gold.json` 由实验者准备，示例路径需替换为实际文件；`fixture` 的相对路径按仓库根目录解析。cases.json 格式：

```json
[
  {
    "label": "coating",
    "name": "涂料防水层",
    "fixture": "/absolute/path/to/source.md",
    "start": 757,
    "end": 804
  }
]
```

行号从1开始，end不包含。gold.json使用现有target-gold/v1契约，case id与label一致；金标仅在生成之后评分，不进入模型输入。不同本地Markdown版本须重新核对行号和金标来源，不可沿用失效位置。

## 流程与边界

1. 提供完整目标原文与全文标题索引，模型可通过read_source/search_source补读全文。
2. 直接输出业务行JSON，字段使用可读归纳，附原文短引文及行范围。程序批量验证类型、引文是否存在、非空业务字段是否声明引用。
3. 保存extract.json，在新会话中对照原文复核，只提交必要的行替换/增删，另存review.json和review-patch.json。初稿不会被覆盖。
4. 每阶段最多12请求，单目标合计10分钟。保存失败、工具结果、用量和阶段时间；未运行成功的结果不冒充成功。

原文引文匹配只忽略空白，不修复数字或猜测错误JSON。匹配成功不证明字段被引文充分支持，也不证明语义正确。相同名称不会自动合并。业务投影只供测试评分，不是生产发布适配器。

## 历史试验与已知限制

2026-09-06三个目标试验支持继续研究直接业务抽取，但复核会退步：新增水泥砂浆面层目标初稿9/9，复核为补单位整行改写，导致已展开的抽样条件丢失，变为8/9。不能默认把review.json视为优于extract.json。

最小实现未覆盖OCR、目标发现、隔离引用策略、长期任务恢复、编辑器发布与精确单元格定位。归纳可能夹带未充分支持的限定，检验批/抽样/一般项目合格比例的字段归属仍需核查。不得把本实验直接接成正式发布路径。

测试：

```powershell
npx vitest run --dir tests tests/minimal-extraction.test.ts
npx tsc --noEmit --strict --target ES2022 --lib ES2023,DOM --module NodeNext --moduleResolution NodeNext --skipLibCheck scripts/run-minimal-extraction.ts scripts/minimal-extraction-core.ts
```

2026-09-06 的完整实验记录位于本地 `data/minimal-business-extraction-20260906/report.md`（不随仓库提交，其他环境不保证存在）。第一、二版失败保留，第三版调试样本和新增未调试目标分开记录。当前代码是第三版，运行期间未按新增目标结果调参。
