---
name: mineru-reading
description: Read complete preconverted Markdown and its source index; conversion and shared caching are already handled by the backend, without runtime MinerU calls.
---

# 读取已转换的完整 Markdown

后端在 Pi 启动前完成所有输入材料的转换。先读取 `source/markdown/index.json`，或调用 `list_document_sources`，取得每份原件对应的 `full.md`、分块页范围和原始 JSON 路径。整份 Markdown 已在磁盘，无需在上下文中一次装入全文；可以用 read 或本地脚本全文检索、分段分析、建立索引。

MinerU、网络上传和跨任务缓存都是后端职责。不再提供运行时转换工具，不通过 bash 自行转换、安装解析器、访问缓存根目录或查找凭据。

PDF 的合并文件保留物理页段标记与相对图片路径，但原始 JSON 的 page_idx 仍须核对基准，不能直接假定为全书页码。Word 没有与上传 PDF 相同的固定分页，不能把它的页号当作 PDF 证据。

转换材料不是已识别好的目录，标题格式与表格仍由你语义判断。标题可能断行：断行标题常只有第一行被标为标题，其余行成为紧邻的普通段落；从标题批量建索引或生成条目时，一并检查紧邻续行并用原页核对合并，标题级别不等于标题完整性。文本可能有误，出处争议通过 open_catalog_page(image=true/layout=true) 回查原 PDF，遵守 DELIVERY.md；不得修改源材料来通过验证。source/ 只读，作者脚本和草稿另存。

表格的一行可同时包含父级、子级及多个条目，不能将这些层级写成互斥分支而漏掉同一行的下级；父级跨行合并或在续表重复出现时，应保留其上下文并继续检查本行其余单元格，不能把整行当重复项删除。解析策略仍由你选择，但核查依据必须来自原文而不是生成结果：对照来源清单检查分组首行、续表首行、末行及并列项是否都在树中，重复父级去重不应吞掉新的子级。HTML 长表格可能整张表仅占一行，读取被截断时继续读取剩余内容，不把工具截断当成表格结束。
