import { generateText } from "ai";
import type { AiApp } from "@/db/schema";
import { resolveModel } from "./resolve";
import type { UsageScope } from "./usage";

export type TitleContext = { userId: string; conversationId: string; botId?: string | null; usage?: UsageScope };

export async function generateTitle(app: AiApp, userText: string, ctx: TitleContext): Promise<string> {
  const { model } = await resolveModel(app, { purpose: "title", ...ctx });
  const { text } = await generateText({
    model,
    instructions:
      "Write a short title (max 6 words) for a chat that starts with the user's message below. Reply with the title only — no quotes or punctuation at the end.",
    prompt: userText.slice(0, 2000),
    maxOutputTokens: 30,
    temperature: 0.3,
  });
  return text.replace(/^["'\s#*]+|["'\s.]+$/g, "").slice(0, 80) || "New chat";
}
