import { sha256Json } from './canonical.js';
import { PROMPT_SUITE_VERSION, TARGET_SELECTOR_PROTOCOLS } from './acceptance-prompt-suite.js';
import type { Agent } from '@earendil-works/pi-agent-core';

const contract = { prompt_protocol_version: PROMPT_SUITE_VERSION, authoring_protocols: TARGET_SELECTOR_PROTOCOLS };
const fingerprint = sha256Json(contract);
const block = `<selector_session_contract fingerprint="${fingerprint}">\n${JSON.stringify(contract)}\n</selector_session_contract>`;

/** Inspect the actual retained model messages, never a durable "read" flag.
 * A new/compacted context must receive its own copy; an unchanged context can
 * reuse the exact version already supplied by runtime or a real tool result. */
export function selectorSessionContractContext(prompt: string, messages: readonly unknown[], sealOnly = false) {
  const hasContract = messages.some(value => {
    if (!value || typeof value !== 'object') return false;
    const message = value as { role?: string; content?: unknown };
    const texts = typeof message.content === 'string' ? [message.content]
      : Array.isArray(message.content) ? message.content.flatMap(part =>
        part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []) : [];
    if (message.role === 'user' && texts.some(text => text.includes(block))) return true;
    if (message.role !== 'toolResult') return false;
    // SDK details are UI metadata, not model-visible protocol delivery.
    const candidates = texts.flatMap(text => { try { return [JSON.parse(text)]; } catch { return []; } });
    return candidates.some(candidate => candidate && typeof candidate === 'object'
      && sha256Json({ prompt_protocol_version: candidate.prompt_protocol_version,
        authoring_protocols: candidate.authoring_protocols }) === fingerprint);
  });
  return { prompt_protocol_version: PROMPT_SUITE_VERSION, contract_fingerprint: fingerprint,
    delivery: sealOnly ? 'validated_seal_bypass' : hasContract ? 'retained_context' : 'provided_in_user_message',
    prompt: sealOnly || hasContract ? prompt : `${block}\n运行时已提供当前版本作者协议；当前工具 Schema 约束新写入。复用本会话已提供的协议，不必为同一字段反复读取完整契约。\n\n${prompt}` };
}

/** Pi 1.2.0 calls convertToLlm after context transformation on every model
 * request, including prompt-time compaction and overflow agent.continue().
 * Check its converted, model-visible output rather than pre-prompt history.
 * The fallback is request-local: it never edits checkpoints or SDK history. */
export function installSelectorSessionContractBoundary(
  agent: Pick<Agent, 'convertToLlm'>,
  sealOnly: () => boolean | Promise<boolean>,
  onDelivery?: (delivery: Omit<ReturnType<typeof selectorSessionContractContext>, 'prompt'>) => void | Promise<void>,
): void {
  const convert = agent.convertToLlm;
  agent.convertToLlm = async messages => {
    const converted = await convert(messages);
    const context = selectorSessionContractContext('', converted, await sealOnly());
    const { prompt, ...delivery } = context;
    await onDelivery?.(delivery);
    return context.delivery === 'provided_in_user_message'
      ? [...converted, { role: 'user' as const, content: [{ type: 'text' as const, text: prompt }], timestamp: Date.now() }]
      : converted;
  };
}
