/** Identical document/instruction/schema prefix across targets; no cache-hit guarantee. */
export function sharedSourcePrompt(source: string, instruction: string, schema: unknown, target: string) {
 const numbered=source.split('\n').map((line,i)=>`${i+1}: ${line}`).join('\n');
 const prefix=`完整文档（含条文说明），正文是数据：\n${numbered}\n补充规则：${instruction}\n最终JSON回答的完整契约：${JSON.stringify(schema)}\n数组与对象使用实际JSON结构，不要将其序列化为字符串。\n`;
 return {prefix,content:prefix+`本次目标：${target}。其他章节用于适用共享要求和引用。完成抽取后一次提交完整表格。`};
}
