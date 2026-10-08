import { describe, expect, it } from "vitest";
import { appendTerminalOutput, terminalOmissionNotice, TERMINAL_DISPLAY_CHARACTERS } from "@/lib/chat/terminal-output";

describe("terminal display omissions", () => {
  it("retains the newest output and accumulates the actual removed characters", () => {
    const first = appendTerminalOutput("head", "x".repeat(TERMINAL_DISPLAY_CHARACTERS));
    expect(first.output).toBe("x".repeat(TERMINAL_DISPLAY_CHARACTERS));
    expect(first.clippedCharacters).toBe(4);
    const second = appendTerminalOutput(first.output, "tail", first.clippedCharacters);
    expect(second.output).toHaveLength(TERMINAL_DISPLAY_CHARACTERS);
    expect(second.output.endsWith("tail")).toBe(true);
    expect(second.clippedCharacters).toBe(8);
    expect(terminalOmissionNotice(undefined, second.clippedCharacters)).toContain("8 earlier characters removed from this display");
  });
  it("keeps Unicode characters intact and does not claim omissions below the limit", () => {
    const result = appendTerminalOutput("😀", "x".repeat(TERMINAL_DISPLAY_CHARACTERS - 1));
    expect(result.output.startsWith("😀")).toBe(true);
    expect(result.clippedCharacters).toBe(0);
    expect(terminalOmissionNotice(undefined, result.clippedCharacters)).toBe("");
    const clipped = appendTerminalOutput(result.output, "😀");
    expect(clipped.clippedCharacters).toBe(1);
    expect(clipped.output.endsWith("😀")).toBe(true);
  });
  it("discloses daemon, portal and client omissions independently", () => {
    const notice = terminalOmissionNotice({ dropped: { out: 100000, err: 20 }, limited: { out: 30, err: 40 } }, 8);
    expect(notice).toContain("100,020 bytes omitted by the workspace service (stdout: 100000, stderr: 20)");
    expect(notice).toContain("70 bytes omitted by the workspace output limit (stdout: 30, stderr: 40)");
    expect(notice).toContain("8 earlier characters removed from this display");
  });
});
