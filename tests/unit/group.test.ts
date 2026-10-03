import { describe, expect, it } from "vitest";
import { groupTranscript, initialQueue } from "@/lib/agent/group";
import { resolveMentions } from "@/lib/agent/mentions";
import type { PortalUIMessage } from "@/lib/chat/store";

const members = [
  { id: "r", name: "Researcher" },
  { id: "w", name: "Writer" },
  { id: "d", name: "Directory Bot" },
];

describe("resolveMentions", () => {
  it("finds mentions in order, with multi-word names", () => {
    expect(resolveMentions("@Writer draft it, then @Directory Bot check names", members)).toEqual(["w", "d"]);
    expect(resolveMentions("ask @directorybot", members)).toEqual(["d"]);
  });
  it("supports @everyone and ignores e-mail addresses and partial words", () => {
    expect(resolveMentions("@everyone update please", members)).toEqual(["r", "w", "d"]);
    expect(resolveMentions("mail bob@writer.com", members)).toEqual([]);
    expect(resolveMentions("@Writers unite", members)).toEqual([]);
  });
});

describe("group routing", () => {
  it("routes un-addressed messages to the lead", () => {
    expect(initialQueue("hello team", members)).toEqual(["r"]);
    expect(initialQueue("@Writer go", members)).toEqual(["w"]);
  });

  it("labels teammates' messages when building a bot's transcript", () => {
    const history: PortalUIMessage[] = [
      { id: "1", role: "user", parts: [{ type: "text", text: "Plan the launch" }] },
      {
        id: "2",
        role: "assistant",
        parts: [
          { type: "data-speaker", data: { botId: "r", name: "Researcher", avatar: null } },
          { type: "text", text: "Findings: X. @Writer please draft." },
          { type: "data-speaker", data: { botId: "w", name: "Writer", avatar: null } },
          { type: "text", text: "Draft: Y" },
        ] as PortalUIMessage["parts"],
      },
      { id: "3", role: "user", parts: [{ type: "text", text: "Shorter please" }] },
    ];
    const forWriter = groupTranscript(history, "w");
    expect(forWriter).toEqual([
      { role: "user", content: "Plan the launch\n\n[Researcher]: Findings: X. @Writer please draft." },
      { role: "assistant", content: "Draft: Y" },
      { role: "user", content: "Shorter please" },
    ]);
  });
});

it("keeps authorized inline image content while merging teammate and user turns", () => {
  const url = "data:image/png;base64,c3ludGhldGlj";
  const history: PortalUIMessage[] = [
    { id: "image", role: "user", parts: [{ type: "text", text: "Look" }, { type: "file", mediaType: "image/png", url }] },
    { id: "reply", role: "assistant", parts: [{ type: "text", text: "A teammate's observation" }] },
  ];
  const transcript = groupTranscript(history, "writer");
  expect(transcript).toHaveLength(1);
  expect(transcript[0].content).toEqual(expect.arrayContaining([{ type: "file", data: url, mediaType: "image/png" }]));
});
