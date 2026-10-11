export type VoiceHistoryMessage = { id: string; role: string; text: string };

/** Keep complete messages: cutting a flat transcript can invent a role or a new request. */
export function voiceHistory(messages: readonly VoiceHistoryMessage[]): VoiceHistoryMessage[] {
  const selected: VoiceHistoryMessage[] = [];
  let remaining = 6000; // Conservative bound below Live's 8192-token startup limit.
  for (const message of messages.slice(-20).reverse()) {
    if (!["user", "assistant"].includes(message.role) || !message.text.trim()) continue;
    if (message.text.length > remaining) break;
    selected.unshift({ id: message.id, role: message.role, text: message.text });
    remaining -= message.text.length;
  }
  return selected;
}

export function liveHistory(messages: readonly VoiceHistoryMessage[]) {
  return voiceHistory(messages).map(message => ({ type: "message", role: message.role,
    content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text: message.text }] }));
}
