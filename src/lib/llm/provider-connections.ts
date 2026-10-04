import { eq } from "drizzle-orm";
import { db } from "@/db";
import { providerConnections } from "@/db/schema";
import { HttpError } from "@/lib/authz";
import { ProviderUnavailableError } from "./errors";
import { decrypt, encrypt } from "@/lib/crypto";
import { CONFIG_SCHEMAS, normalizeBaseUrl, type AnyProviderConfig, type ProviderConnectionView } from "./catalog";

export const providerConnectionAad = (id: string) => `provider_connections.secret_enc|${id}`;
export const sealProviderCredential = (id: string, secret: string) => encrypt(secret, providerConnectionAad(id));
export const openProviderCredential = (connection: { id: string; credentialEnc: string }) => decrypt(connection.credentialEnc, providerConnectionAad(connection.id));
export type ProviderConnection = typeof providerConnections.$inferSelect;

/** Explicit whitelist for the admin UI. Never serialize a database credential row. */
export function providerConnectionView(c: ProviderConnection): ProviderConnectionView {
  return { id: c.id, name: c.name, provider: c.provider, baseUrl: c.baseUrl, organization: c.organization, project: c.project,
    enabled: c.enabled, createdBy: c.createdBy, updatedAt: c.updatedAt.toISOString() };
}


/** Endpoints and billing selectors are immutable on a saved connection. Model-specific flags stay on the model. */
export function connectionConfig(c: ProviderConnection, config: unknown): AnyProviderConfig {
  const model = CONFIG_SCHEMAS.openai.parse(config);
  return { ...model, organization: c.organization ?? undefined, project: c.project ?? undefined };
}

/** Do not let a model form send a saved key to a different endpoint or billing destination. */
export function assertConnectionTarget(c: ProviderConnection, provider: string, baseUrl: string | null | undefined, config: unknown) {
  if (provider !== c.provider) throw new HttpError(400, "This saved connection is for OpenAI API models only.");
  const url = normalizeBaseUrl("openai", baseUrl);
  const parsed = CONFIG_SCHEMAS.openai.safeParse(config);
  if (!url.ok || !parsed.success || url.value !== c.baseUrl ||
    (parsed.data.organization || null) !== c.organization || (parsed.data.project || null) !== c.project) {
    throw new HttpError(400, "The endpoint, organization and project must match the saved provider connection. Select it again or create a separate connection.");
  }
}

/** Throws a user-facing 409 (shown in chat and background runs instead of a generic error) when unusable. */
export async function activeProviderConnection(id: string): Promise<ProviderConnection> {
  const [connection] = await db.select().from(providerConnections).where(eq(providerConnections.id, id));
  if (!connection || !connection.enabled) throw new ProviderUnavailableError("The saved provider connection is unavailable or disabled. Ask an admin to check it.");
  return connection;
}
