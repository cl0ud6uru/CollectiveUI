import { OPENROUTER_BASE_URL, type EnabledKind } from "../catalog";
import { anthropic } from "./anthropic";
import { azure } from "./azure";
import { bedrock } from "./bedrock";
import { hermes } from "./hermes";
import { openai } from "./openai";
import { openaiCompatible } from "./openai-compatible";
import type { ProviderImpl } from "./types";
import { vertexAnthropic } from "./vertex-anthropic";

/** The only place provider SDKs are imported (enforced by ESLint and tests/unit/policy-guards.test.ts). */
export const PROVIDERS: Record<EnabledKind, ProviderImpl> = {
  "openai-compatible": openaiCompatible,
  openrouter: { create: ctx => openaiCompatible.create({ ...ctx, baseUrl: OPENROUTER_BASE_URL }) },
  openai,
  azure,
  anthropic,
  bedrock,
  "vertex-anthropic": vertexAnthropic,
  hermes,
};

/** Runs on a person's own ChatGPT plan, so it's built per turn by resolveModel rather than from app credentials. */
export { chatgpt } from "./chatgpt";

export type { ChatModel, EmbedModel, ProviderContext, ProviderInstance } from "./types";
