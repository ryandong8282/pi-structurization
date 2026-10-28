---
name: word-reading
description: Read an attached DOCX natively, including paragraph styles, numbering definitions, table cells and merges, with headers and footers kept separate from body content.
---

# Word 原生结构阅读

`list_document_sources` 告知是否附带原始 DOCX。没有原件时不能从 PDF 反推出 Word 样式，继续使用 PDF 能力即可。
`read_word_document(query?, offset?, part?)` 按文档顺序返回段落块。省略 part 默认只读 word/document.xml；选择返回的其他 part 可读页眉、页脚、脚注或尾注。query 是文本子串匹配，不是语义搜索。next_offset 用于继续读取。

首次调用在本任务内流式生成结构索引和必要的 XML 原件副本。`structure.json` 记录 part、数量及数据文件名；同目录的 `blocks.jsonl`、`styles.jsonl` 分别每行存放一个完整段落或样式，适合逐行处理大文件。用 read 或脚本读取返回路径中的样式和 numbering 定义；段落保留 styleId、numId、ilvl、outlineLevel，表格段落保留单元格位置、gridSpan/vMerge 及嵌套关系，不将合并单元格复制成多个同名节点。

这些是 OOXML 事实，不是已经识别好的目录。自动编号可能不在段落文字中；根据编号定义及段落顺序判断，不能把缺失编号当成无编号，也不能自行猜补。原始 XML 保留域、修订、文本框等复杂信息；结构摘要不是排版引擎，遇到特殊内容须检查 XML 或 PDF 图像。阅读文本视图包含插入、排除删除，原件不被修改。

DOCX 没有可靠的固定页码，工具不会编造 Word 与 PDF 的页码映射。附带文件也不自动保证是同一版本：语义上需核对。最终交付仍以 PDF 物理页及可核验引文为准，必要时回查图像。
