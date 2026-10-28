type EventRecord = Record<string, unknown>;
const record = (value: unknown): EventRecord => value !== null && typeof value === 'object' ? value as EventRecord : {};

/** Capture compact public deltas, coalesced without repeating the SDK's cumulative message. */
export function createCatalogOutputStream(emit: (event: unknown) => void) {
  let pending: { type: string; message: EventRecord; assistantMessageEvent: EventRecord } | undefined;
  let key = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (pending) emit(pending);
    pending = undefined;
  };
  return {
    capture(value: unknown): boolean {
      const event = record(value);
      if (event.type !== 'message_update') { flush(); return false; }
      const message = record(event.message);
      const update = record(event.assistantMessageEvent);
      if (message.role !== 'assistant' || !['text_delta', 'thinking_delta', 'toolcall_delta'].includes(String(update.type)) || typeof update.delta !== 'string') return true;
      const block = record(Array.isArray(message.content) ? message.content[Number(update.contentIndex)] : undefined);
      const delta = {
        type: update.type, contentIndex: update.contentIndex, delta: update.delta,
        ...(update.type === 'toolcall_delta' ? { toolCallId: block.id, toolName: block.name } : {}),
      };
      const nextKey = `${message.timestamp}:${update.contentIndex}:${update.type}:${block.id ?? ''}`;
      if (pending && key !== nextKey) flush();
      if (pending) pending.assistantMessageEvent.delta = String(pending.assistantMessageEvent.delta) + update.delta;
      else {
        key = nextKey;
        pending = { type: 'message_update', message: { role: 'assistant', timestamp: message.timestamp }, assistantMessageEvent: delta };
        timer = setTimeout(flush, 180);
      }
      return true;
    },
    flush,
  };
}
