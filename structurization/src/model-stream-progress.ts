import { ToolRecordStreamGuard, type StreamRecordTypeIssue } from './tool-record-stream.js';

/** Transport/argument protection only: no document semantics or total-output size limit. */
export const MAX_TOOL_PADDING_CHARACTERS = 8192;
export const MAX_REPETITIVE_TEXT_TAIL_CHARACTERS = 8192;
const MAX_STREAM_RECOVERIES = 2;

export class ModelStreamNoProgressError extends Error {
  readonly code = 'model_stream_no_progress';
  constructor(readonly paddingCharacters: number, readonly toolName: string, idleMs?: number) {
    super(idleMs
      ? `模型连续 ${idleMs / 1000} 秒仅返回空白/空增量，没有有效输出；中止异常流，保留已完成操作与工作文件。`
      : `模型 ${toolName || '工具调用'} 参数连续输出 ${paddingCharacters} 个无效空白，达到 ${MAX_TOOL_PADDING_CHARACTERS} 字符保护阈值；中止异常流，保留已完成操作与工作文件。`);
    this.name = 'ModelStreamNoProgressError';
  }
}

export class ModelStreamArgumentShapeError extends Error {
  readonly code = 'model_stream_argument_shape_invalid';
  constructor(readonly toolName: string, readonly issue: StreamRecordTypeIssue) {
    super(`工具 ${toolName} 参数 ${issue.path} 实际为字符串（${issue.actual.length} 字符），契约要求对象。该调用已中止、未执行；不要续写或重复该字符串。保留已保存草稿，用可用只读工具确认当前记录，再调用 ${toolName}，在该数组位置提交 schema 要求的完整对象；不要修改不可变原文或编译产物。`);
    this.name = 'ModelStreamArgumentShapeError';
  }
}

export class ModelStreamRepetitiveTextError extends Error {
  readonly code = 'model_stream_repetitive_text';
  readonly toolName = '';
  constructor(readonly symbol: string, readonly tailCharacters: number) {
    super(`助手文本连续输出 ${tailCharacters} 个仅含重复符号 ${JSON.stringify(symbol)} 及空白的尾部字符，达到 ${MAX_REPETITIVE_TEXT_TAIL_CHARACTERS} 字符保护阈值；该文本不是工具回执。中止异常流并保留已保存操作和工作文件，不续写这段符号；先用可用只读工具核对最新有效结果，再用真实工具继续未完成任务。`);
    this.name = 'ModelStreamRepetitiveTextError';
  }
}

export function isModelStreamProtectionError(error: unknown): error is ModelStreamNoProgressError | ModelStreamArgumentShapeError | ModelStreamRepetitiveTextError {
  return error instanceof ModelStreamNoProgressError || error instanceof ModelStreamArgumentShapeError || error instanceof ModelStreamRepetitiveTextError;
}

export type StreamToolContract = { name: string; parameters: unknown };

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' ? value as RecordValue : {};
type JsonProgress = { inString: boolean; escaped: boolean; invalidString: boolean; padding: number };

/** Inspect deltas in O(delta.length), without retaining the growing tool arguments. */
export class ModelStreamProgressGuard {
  private readonly calls = new Map<number, JsonProgress>();
  private readonly recordGuards = new Map<number, ToolRecordStreamGuard>();
  private readonly textTails = new Map<number, { symbol: string; characters: number }>();
  private paddingOnly: { characters: number; toolName: string } | undefined;

  constructor(private readonly tools: readonly StreamToolContract[] = []) {}

  idleFailure(idleMs: number): ModelStreamNoProgressError | undefined {
    return this.paddingOnly ? new ModelStreamNoProgressError(this.paddingOnly.characters, this.paddingOnly.toolName, idleMs) : undefined;
  }

  private progress(useful: boolean, chars: number, toolName = ''): boolean {
    this.paddingOnly = useful ? undefined : { characters: (this.paddingOnly?.characters ?? 0) + chars, toolName };
    return useful;
  }

  observe(value: unknown): boolean {
    const event = record(value);
    if (event.type === 'message_start' || event.type === 'message_end' || event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      this.calls.clear();
      this.recordGuards.clear();
      this.textTails.clear();
      this.paddingOnly = undefined;
    }
    if (event.type !== 'message_update') return true;
    const update = record(event.assistantMessageEvent);
    if (typeof update.delta !== 'string') return true;
    if (update.type === 'text_delta') {
      const index = Number(update.contentIndex ?? 0);
      let tail = this.textTails.get(index);
      for (const char of update.delta) {
        if (tail && (char === tail.symbol || /\s/u.test(char))) tail.characters += char.length;
        else tail = /[\p{P}\p{S}]/u.test(char) ? { symbol: char, characters: char.length } : undefined;
        if (tail && tail.characters >= MAX_REPETITIVE_TEXT_TAIL_CHARACTERS) {
          throw new ModelStreamRepetitiveTextError(tail.symbol, tail.characters);
        }
      }
      if (tail) this.textTails.set(index, tail);
      else this.textTails.delete(index);
    }
    if (update.type !== 'toolcall_delta') return this.progress(update.delta.trim().length > 0, update.delta.length);
    const index = Number(update.contentIndex ?? 0);
    let state = this.calls.get(index);
    if (!state) {
      state = { inString: false, escaped: false, invalidString: false, padding: 0 };
      this.calls.set(index, state);
    }
    const message = record(event.message);
    const block = record(Array.isArray(message.content) ? message.content[index] : undefined);
    const toolName = String(block.name ?? update.toolName ?? '');
    let records = this.recordGuards.get(index);
    if (!records) {
      const contract = this.tools.find(tool => tool.name === toolName);
      if (contract) {
        records = new ToolRecordStreamGuard(contract.parameters);
        this.recordGuards.set(index, records);
      }
    }
    const shapeIssue = records?.inspect(block.arguments);
    if (shapeIssue) throw new ModelStreamArgumentShapeError(toolName, shapeIssue);
    let progress = false;
    for (const char of update.delta) {
      const control = char === '\r' || char === '\n' || char === '\t';
      // Raw line breaks/tabs inside JSON strings are invalid (legitimate ones are escaped).
      // Once the literal is malformed, its following padding cannot count as useful string data.
      if (state.inString && control) state.invalidString = true;
      const padding = (char === ' ' || control) && (!state.inString || state.invalidString);
      if (padding) {
        state.padding += 1;
        if (state.padding >= MAX_TOOL_PADDING_CHARACTERS) {
          throw new ModelStreamNoProgressError(state.padding, String(block.name ?? update.toolName ?? ''));
        }
      } else {
        state.padding = 0;
        progress = true;
      }
      if (state.inString) {
        if (state.escaped) state.escaped = false;
        else if (char === '\\') state.escaped = true;
        else if (char === '"') { state.inString = false; state.invalidString = false; }
      } else if (char === '"') state.inString = true;
    }
    return this.progress(progress, update.delta.length, String(block.name ?? update.toolName ?? ''));
  }
}

export type StreamRecoveryEvent = {
  state: 'retrying' | 'exhausted'; attempt: number; maxAttempts: number;
  reason: string; code: string; toolName: string; paddingCharacters: number;
  argumentIssue?: StreamRecordTypeIssue;
  textTail?: { symbol: string; characters: number };
};

/** One budget for the whole Pi session, not a fresh budget per continuation prompt. */
export function createStreamRecoveryRunner(options: {
  signal?: AbortSignal;
  onRecovery(event: StreamRecoveryEvent): Promise<void>;
}) {
  let attempts = 0;
  return async function run<T extends { kind: string; error?: unknown }>(
    originalPrompt: string, prompt: (message: string) => Promise<T>,
  ): Promise<T> {
    let message = originalPrompt;
    while (true) {
      options.signal?.throwIfAborted();
      const result = await prompt(message); // Caller waits for abort AND prompt settlement before returning.
      options.signal?.throwIfAborted();
      if (result.kind !== 'failed' || !isModelStreamProtectionError(result.error)) return result;
      const error = result.error;
      const exhausted = attempts >= MAX_STREAM_RECOVERIES;
      if (!exhausted) attempts += 1;
      await options.onRecovery({ state: exhausted ? 'exhausted' : 'retrying', attempt: attempts, maxAttempts: MAX_STREAM_RECOVERIES,
        reason: error.message, code: error.code, toolName: error.toolName,
        paddingCharacters: error instanceof ModelStreamNoProgressError ? error.paddingCharacters : 0,
        ...(error instanceof ModelStreamArgumentShapeError ? { argumentIssue: error.issue } : {}),
        ...(error instanceof ModelStreamRepetitiveTextError ? { textTail: { symbol: error.symbol, characters: error.tailCharacters } } : {}) });
      options.signal?.throwIfAborted();
      if (exhausted) return { ...result, error: new Error(`异常输出已达 ${attempts} 次自动恢复上限，停止空转，草稿和日志保留。请检查模型/代理后再继续；不要删除原件或重写已完成内容。${error.message}`) };
      message = `${originalPrompt}\n\n运行保护：${error.message}\n上一轮异常输出已中止且等待结束。原任务说明中的初始阶段或空白状态可能已过时，以当前工作文件和最新工具结果为准。Pi 不会重放被中止的助手响应，截断的工具参数不得执行。保留已完成的工具操作、已有草稿和脚本；先用当前可用的只读工具检查本任务工作文件与最新有效工具结果，再从未完成处继续，不要重新提取整份文档、删除草稿或修改 source/。重新生成当前需要的有效工具参数；语言、脚本和批量策略仍由你选择。`;
    }
  };
}
