/** Public terminal omission metadata. Server counts are bytes; display counts are Unicode characters. */
export type TerminalOmissions = { dropped: { out: number; err: number }; limited: { out: number; err: number } };
export type CommandEvent = { type: string; text?: string; code?: number; reason?: string; truncated?: boolean; stream?: "out" | "err"; bytes?: number; source?: "daemon" | "limit" } & Partial<TerminalOmissions>;
export const TERMINAL_DISPLAY_CHARACTERS = 256 * 1024;

export function appendTerminalOutput(output: string, text: string, clippedCharacters = 0) {
  const combined = output + text;
  if (combined.length <= TERMINAL_DISPLAY_CHARACTERS) return { output: combined, clippedCharacters };
  const characters = Array.from(combined);
  const omitted = Math.max(0, characters.length - TERMINAL_DISPLAY_CHARACTERS);
  return { output: characters.slice(omitted).join(""), clippedCharacters: clippedCharacters + omitted };
}

export function terminalOmissionNotice(omissions?: TerminalOmissions, clippedCharacters = 0) {
  const notices: string[] = [];
  if (omissions) {
    const dropped = omissions.dropped.out + omissions.dropped.err;
    const limited = omissions.limited.out + omissions.limited.err;
    if (dropped) notices.push(`${dropped.toLocaleString("en-US")} bytes omitted by the workspace service (stdout: ${omissions.dropped.out}, stderr: ${omissions.dropped.err}).`);
    if (limited) notices.push(`${limited.toLocaleString("en-US")} bytes omitted by the workspace output limit (stdout: ${omissions.limited.out}, stderr: ${omissions.limited.err}).`);
  }
  if (clippedCharacters) notices.push(`Showing the most recent ${TERMINAL_DISPLAY_CHARACTERS.toLocaleString("en-US")} characters; ${clippedCharacters.toLocaleString("en-US")} earlier characters removed from this display.`);
  return notices.join(" ");
}
