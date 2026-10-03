import { createElement, type ReactElement } from "react";
import { Tooltip } from "radix-ui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/app/(chat)/settings/workspace-actions", () => ({ stopWorkspaceCommand: async () => ({ ok: true }) }));
import { BLOB_COLORS, bubbleTint } from "@/components/bots/bot-avatar";
import { AssistantMessage, splitBubbles, UserMessage } from "@/components/chat/message";
import { mergeBotLive, mostUrgent } from "@/components/chat/shell-context";
import { formatDuration, needsAction } from "@/components/chat/steps";
import { shortTime } from "@/components/sidebar/group-by-date";
import { Select } from "@/components/ui/select";
import { previewLine } from "@/lib/chat/preview";
import type { PortalUIMessage } from "@/lib/chat/store";

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Messages use the app's tooltips, which need the provider the app shell supplies. */
const html = (el: ReactElement) => renderToStaticMarkup(createElement(Tooltip.Provider, null, el));
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("bot chat colours", () => {
  it("tints every blob colour's bubbles with text that passes WCAG AA", () => {
    for (const color of Object.keys(BLOB_COLORS)) {
      const t = bubbleTint(`blob:circle:${color}`);
      if (t.bg.startsWith("var(")) continue; // ink: the theme's own fg/bg pair
      expect(contrast(t.bg, t.fg), color).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("uses ink for black and emoji avatars", () => {
    expect(bubbleTint("blob:pill:black")).toEqual({ bg: "var(--accent)", fg: "var(--accent-fg)" });
    expect(bubbleTint("🦊")).toEqual({ bg: "var(--accent)", fg: "var(--accent-fg)" });
  });
});

describe("roster details", () => {
  it("makes one readable preview line", () => {
    expect(previewLine("## Done\n\nI **checked** the [docs](https://x.y) and\n\n```js\ncode()\n```\nall good")).toBe("Done I checked the docs and all good");
    expect(previewLine("   ")).toBeNull();
    expect(previewLine("a".repeat(100), 20)).toBe(`${"a".repeat(19)}…`);
  });
  it("formats roster times like a messaging app", () => {
    const now = new Date(2026, 9, 1, 15, 0);
    expect(shortTime(new Date(2026, 9, 1, 9, 41).toISOString(), now)).toMatch(/^9:41\sAM$/);
    expect(shortTime(new Date(2026, 8, 30, 22, 0).toISOString(), now)).toBe("Yesterday");
    expect(shortTime(new Date(2026, 8, 27, 12, 0).toISOString(), now)).toBe("Sunday");
    expect(shortTime(new Date(2026, 2, 3).toISOString(), now)).toBe("Mar 3");
    expect(shortTime(new Date(2025, 2, 3).toISOString(), now)).toBe("Mar 3, 2025");
    expect(shortTime(null, now)).toBe("");
  });
});

describe("message layout", () => {
  it("splits chatty paragraphs into bubbles but keeps rich answers whole", () => {
    expect(splitBubbles("Hi there.\n\nI found three things.")).toEqual(["Hi there.", "I found three things."]);
    expect(splitBubbles("Steps:\n\n- one\n- two")).toHaveLength(1);
    expect(splitBubbles("Look:\n\n```js\nx\n```")).toHaveLength(1);
    expect(splitBubbles(Array.from({ length: 8 }, (_, i) => `p${i}`).join("\n\n"))).toHaveLength(1);
  });
  it("formats how long a reply worked", () => {
    expect(formatDuration(400)).toBe("1s");
    expect(formatDuration(35_000)).toBe("35s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(120_000)).toBe("2m");
    expect(formatDuration(3_780_000)).toBe("1h 3m");
  });

  const tool = (id: string, state: string, extra: object = {}) => ({ type: "tool-web_search", toolCallId: id, state, input: { query: id }, ...extra });
  const reply = (parts: unknown[], metadata = {}) => ({ id: "m1", role: "assistant", parts, metadata }) as unknown as PortalUIMessage;
  const render = (message: PortalUIMessage, opts: object = {}) =>
    html(createElement(AssistantMessage, { message, streaming: false, isLast: true, onApprove: () => {}, onDeny: () => {}, ...opts }));

  it("collapses a finished run of tool steps into one 'Worked for' line, across step boundaries", () => {
    const html = render(
      reply(
        [{ type: "step-start" }, tool("a", "output-available", { output: {} }), { type: "step-start" }, tool("b", "output-error", { errorText: "x" }), { type: "step-start" }, tool("c", "output-available", { output: {} }), { type: "text", text: "Done." }],
        { startedAt: 1_000, finishedAt: 36_000 },
      ),
    );
    expect(html).toContain("Worked for 35s");
    expect(html).toContain("1 failed");
    expect(html).not.toContain("Searched the web"); // the steps stay folded until opened
  });
  it("keeps a step that needs approval outside the folded group", () => {
    const ask = tool("d", "approval-requested", { approval: { id: "ap1" } });
    expect(needsAction(ask)).toBe(true);
    expect(needsAction(tool("e", "approval-requested", { approval: { id: "ap2", isAutomatic: true } }))).toBe(false);
    const html = render(reply([tool("a", "output-available", { output: {} }), tool("b", "output-available", { output: {} }), ask]));
    expect(html).toContain("2 steps");
    expect(html).toContain("Allow once");
  });
  it("shows bot replies as bubbles and group speakers by name", () => {
    const html = render(
      reply([
        { type: "data-speaker", data: { name: "Research Assistant", avatar: "blob:drop:blue" } },
        { type: "text", text: "On it.\n\nHanding over." },
        { type: "data-speaker", data: { name: "Directory Bot", avatar: "blob:hexagon:teal" } },
        { type: "text", text: "Found them." },
      ]),
      { variant: "bubbles" },
    );
    expect(html.match(/bg-bubble-bot/g)).toHaveLength(3);
    expect(html).toContain("Research Assistant");
    expect(html).toContain("Directory Bot");
  });
  it("colours your messages with the bot's tint in bot chats only", () => {
    const message = { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] } as unknown as PortalUIMessage;
    const tinted = html(createElement(UserMessage, { message, variant: "bubbles", tint: { bg: "#3472d8", fg: "#ffffff" } }));
    expect(tinted).toContain("background:#3472d8");
    const plain = html(createElement(UserMessage, { message }));
    expect(plain).toContain("bg-surface-2");
    expect(plain).not.toContain("background:");
  });
});

describe("Select", () => {
  it("renders a labelled dropdown trigger showing the chosen option", () => {
    const html = renderToStaticMarkup(
      createElement(Select, { value: "", "aria-label": "Default app", onChange: () => {} }, createElement("option", { value: "" }, "Organization default"), createElement("option", { value: "x" }, "Mock GPT")),
    );
    expect(html).toContain('aria-label="Default app"');
    expect(html).toContain('role="combobox"');
  });
});

describe("live roster status", () => {
  it("shows the most urgent of the server's and every open chat's status", () => {
    // An idle home (null) must not hide a side chat that waits for approval.
    expect(mostUrgent([null, "waiting", null])).toBe("waiting");
    expect(mostUrgent(["working", "waiting"])).toBe("waiting");
    expect(mostUrgent(["waiting", "working"])).toBe("waiting");
    expect(mostUrgent([undefined, "working"])).toBe("working");
    expect(mostUrgent([null, undefined])).toBeNull();
  });
  it("drops a preview override when it's set to undefined", () => {
    const live = mergeBotLive({}, { preview: "Hi" });
    expect(mergeBotLive(live, { preview: undefined })).toEqual({});
    expect(mergeBotLive(live, { preview: "Hi" })).toBe(live);
  });
});
