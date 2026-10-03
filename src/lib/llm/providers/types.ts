import type { EmbeddingModel, LanguageModel } from "ai";
import type { AnyProviderConfig, EnabledKind } from "../catalog";
import type { AppSecret } from "../secrets";

export type ChatModel = Exclude<LanguageModel, string>;
export type EmbedModel = Exclude<EmbeddingModel, string>;

/** Everything a provider needs to build models. Never read from the environment. */
export type ProviderContext = {
  /** Used for provider naming/caching only. */
  appId: string;
  appName: string;
  kind: EnabledKind;
  /** Normalized base URL, or null for the vendor default. */
  baseUrl: string | null;
  config: AnyProviderConfig;
  /** Undefined only for OpenAI-compatible apps without a key. */
  secret: AppSecret | undefined;
  /** Tests inject a recording fetch; production uses the providers' own wrappers. */
  fetch?: typeof fetch;
  /** Test hook for Vertex AI (skips minting a Google access token). */
  generateAuthToken?: () => Promise<string | null>;
};

export type ProviderInstance = {
  chat(modelId: string): ChatModel;
  embedding?: (modelId: string) => EmbedModel;
};

export type ProviderImpl = { create(ctx: ProviderContext): Promise<ProviderInstance> };
