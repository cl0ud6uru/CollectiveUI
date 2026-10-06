/**
 * Model layer. Every model call in the portal goes through resolveModel() (chat) or embedTexts() (embeddings):
 * credentials come from the database, never the environment, and every call lands in the usage ledger.
 * Client components must import only "@/lib/llm/catalog".
 */
// A plain string model id would silently go to the Vercel AI Gateway using environment credentials.
// Make that impossible: the default provider refuses everything.
const refuse = (): never => {
  throw new Error("Models must be created with resolveModel() from @/lib/llm, not by id.");
};
const g = globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown };
g.AI_SDK_DEFAULT_PROVIDER ??= { specificationVersion: "v4", languageModel: refuse, embeddingModel: refuse, imageModel: refuse };

export { utilityApp, embeddingApp } from "./apps";
export { embedTexts, type EmbedContext } from "./embeddings";
export { ProviderConfigError, ProviderUnavailableError } from "./errors";
export { isUserFacingError, userFacingMessage } from "./chatgpt/errors";
export type { BillingSource, ModelPurpose, ProviderKind } from "./kinds";
export { capabilitiesFor, providerContextFor, resolveEmbeddingModel, resolveModel } from "./resolve";
export type { InstructionStyle, ModelCapabilities, ResolvedModel, ResolveModelOptions } from "./resolve";
export { testConnection, type ConnectionTestInput, type ConnectionTestResult } from "./test-connection";
export { generateTitle, type TitleContext } from "./title";
export { newUsageScope, restoreUsageAfterRollback, type UsageScope } from "./usage";
