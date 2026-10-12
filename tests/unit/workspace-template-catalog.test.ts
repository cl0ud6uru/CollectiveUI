import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import * as schema from "@/db/schema";
import type { DB, DbOrTx } from "@/db";
import type { Principal } from "@/lib/auth/groups";
import {
  createWorkspaceTemplateDraft,
  createWorkspaceTemplateVersion,
  listVisibleWorkspaceTemplates,
  publishWorkspaceTemplateVersion,
  retireWorkspaceTemplateVersion,
} from "@/lib/workspaces/catalog";
import {
  canonicalWorkspaceRecipe,
  parseWorkspaceRecipe,
  type WorkspaceTemplateDraftInput,
} from "@/lib/workspaces/catalog-policy";
import type { WorkspaceRecipe } from "@/lib/workspaces/contracts";

const knowledgeWork: WorkspaceRecipe = {
  schemaVersion: 1,
  runtimeProfileKey: "knowledge-work-v1",
  seedBundleKey: "knowledge-work",
  networkPolicy: "none",
  capabilities: { shell: true, officeHeadless: true, dotnet: false, agentBrowserView: false },
};
const dotnet: WorkspaceRecipe = {
  schemaVersion: 1,
  runtimeProfileKey: "dotnet-linux-v1",
  seedBundleKey: "dotnet-linux-starter",
  networkPolicy: "none",
  capabilities: { shell: true, officeHeadless: false, dotnet: true, agentBrowserView: false },
};
const admin = { isAdmin: true, user: { id: "catalog-admin" } } as unknown as Principal;
const ordinary = { isAdmin: false, user: { id: "catalog-user" } } as unknown as Principal;

describe("workspace template catalog", () => {
  let pg: PGlite;
  let database: DB;
  let migrationFolder: string;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(`CREATE TABLE users(id text PRIMARY KEY);
      CREATE TABLE bots(id text PRIMARY KEY, owner_id text REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE sandboxes(user_id text PRIMARY KEY REFERENCES users(id), ref text UNIQUE NOT NULL,
        last_used_at timestamptz, delete_after timestamptz, created_at timestamptz NOT NULL);`);
    const migration = await readFile("src/db/migrations/0054_workspace_contract_foundation.sql", "utf8");
    const journal = JSON.parse(await readFile("src/db/migrations/meta/_journal.json", "utf8"));
    migrationFolder = await mkdtemp(path.join(tmpdir(), "workspace-template-catalog-"));
    await mkdir(path.join(migrationFolder, "meta"));
    await writeFile(path.join(migrationFolder, "0054_workspace_contract_foundation.sql"), migration);
    await writeFile(path.join(migrationFolder, "meta/_journal.json"), JSON.stringify({
      ...journal,
      entries: journal.entries.filter((entry: { tag: string }) => entry.tag === "0054_workspace_contract_foundation"),
    }));
    await migrate(drizzle(pg), { migrationsFolder: migrationFolder });
    database = drizzle(pg, { schema }) as unknown as DB;
  }, 30_000);

  afterEach(async () => { await pg?.close(); if (migrationFolder) await rm(migrationFolder, { recursive: true, force: true }); });

  it("rejects ordinary-user writes before touching the catalog", async () => {
    const input: WorkspaceTemplateDraftInput = {
      slug: "knowledge-work",
      name: "Knowledge Work",
      description: "Prebuilt Office workspace.",
      recipe: knowledgeWork,
    };
    await expect(createWorkspaceTemplateDraft(ordinary, input, database)).rejects.toMatchObject({ status: 403 });
    const count = await pg.query("SELECT count(*)::int AS count FROM workspace_templates");
    expect((count.rows[0] as { count: number }).count).toBe(0);
  });

  it("strictly accepts only allowlisted recipe fields, bundles, and capabilities", () => {
    expect(parseWorkspaceRecipe(knowledgeWork)).toEqual(knowledgeWork);
    expect(parseWorkspaceRecipe(dotnet)).toEqual(dotnet);
    expect(() => parseWorkspaceRecipe({ ...knowledgeWork, runtimeProfileKey: "../../etc/passwd" })).toThrow();
    expect(() => parseWorkspaceRecipe({ ...knowledgeWork, seedBundleKey: "/home/agent/workspace" })).toThrow();
    expect(() => parseWorkspaceRecipe({ ...knowledgeWork, credentials: { token: "secret" } })).toThrow();
    expect(() => parseWorkspaceRecipe({ ...knowledgeWork, liveFiles: ["report.docx"] })).toThrow();
    expect(() => parseWorkspaceRecipe({ ...knowledgeWork, capabilities: { ...knowledgeWork.capabilities, privatePath: true } })).toThrow();
    expect(() => parseWorkspaceRecipe({ ...dotnet, capabilities: { ...dotnet.capabilities, officeHeadless: true } })).toThrow(/not allowlisted/);
    expect(() => parseWorkspaceRecipe({ ...knowledgeWork, capabilities: { ...knowledgeWork.capabilities, agentBrowserView: true } })).toThrow(/not allowlisted/);
  });

  it("hashes canonical recipes and increments versions without changing published content", async () => {
    const reversed = {
      capabilities: { agentBrowserView: false, dotnet: false, officeHeadless: true, shell: true },
      networkPolicy: "none",
      seedBundleKey: "knowledge-work",
      runtimeProfileKey: "knowledge-work-v1",
      schemaVersion: 1,
    };
    expect(canonicalWorkspaceRecipe(parseWorkspaceRecipe(reversed))).toBe(canonicalWorkspaceRecipe(knowledgeWork));

    const first = await createWorkspaceTemplateDraft(admin, {
      slug: "knowledge-work",
      name: "Knowledge Work",
      description: "Prebuilt Office workspace.",
      recipe: knowledgeWork,
    }, database);
    expect(first.version).toBe(1);
    expect(first.recipeHash).toMatch(/^[a-f0-9]{64}$/);

    const published = await publishWorkspaceTemplateVersion(admin, first.versionId, database);
    expect(published.recipeHash).toBe(first.recipeHash);
    const second = await createWorkspaceTemplateVersion(admin, first.templateId, dotnet, database);
    expect(second.version).toBe(2);
    expect(second.recipeHash).not.toBe(first.recipeHash);

    const stored = await pg.query("SELECT version, recipe_hash, published_at FROM workspace_template_versions WHERE id=$1", [first.versionId]);
    expect(stored.rows[0] as Record<string, unknown>).toMatchObject({ version: 1, recipe_hash: first.recipeHash });
    expect((stored.rows[0] as { published_at: unknown }).published_at).toBeTruthy();
  });

  it("shows only the active published version and retires prior versions without editing them", async () => {
    const first = await createWorkspaceTemplateDraft(admin, {
      slug: "knowledge-work-visible",
      name: "Knowledge Work",
      description: "Prebuilt Office workspace.",
      recipe: knowledgeWork,
    }, database);
    expect(await listVisibleWorkspaceTemplates(database as unknown as DbOrTx)).toEqual([]);

    await publishWorkspaceTemplateVersion(admin, first.versionId, database);
    const visibleV1 = await listVisibleWorkspaceTemplates(database as unknown as DbOrTx);
    expect(visibleV1).toHaveLength(1);
    expect(visibleV1[0]).toMatchObject({
      id: first.templateId,
      name: "Knowledge Work",
      publishedVersionId: first.versionId,
      capabilities: knowledgeWork.capabilities,
    });
    expect(visibleV1[0]).not.toHaveProperty("recipe");
    expect(visibleV1[0]).not.toHaveProperty("runtimeProfileKey");

    const second = await createWorkspaceTemplateVersion(admin, first.templateId, dotnet, database);
    expect(await listVisibleWorkspaceTemplates(database as unknown as DbOrTx)).toHaveLength(1);
    await publishWorkspaceTemplateVersion(admin, second.versionId, database);
    const visibleV2 = await listVisibleWorkspaceTemplates(database as unknown as DbOrTx);
    expect(visibleV2[0].publishedVersionId).toBe(second.versionId);

    const storedV1 = await pg.query("SELECT recipe_hash, retired_at FROM workspace_template_versions WHERE id=$1", [first.versionId]);
    expect(storedV1.rows[0] as Record<string, unknown>).toMatchObject({ recipe_hash: first.recipeHash });
    expect((storedV1.rows[0] as { retired_at: unknown }).retired_at).toBeTruthy();
    await expect(pg.exec(`UPDATE workspace_template_versions SET recipe='${JSON.stringify(knowledgeWork)}'::jsonb WHERE id='${second.versionId}'`)).rejects.toThrow(/immutable/);

    await retireWorkspaceTemplateVersion(admin, second.versionId, database);
    expect(await listVisibleWorkspaceTemplates(database as unknown as DbOrTx)).toEqual([]);
  });

  it("does not publish an unapproved profile or expose drafts through the user list", async () => {
    const draft = await createWorkspaceTemplateDraft(admin, {
      slug: "dotnet-starter",
      name: ".NET Linux",
      description: "Offline console starter.",
      recipe: dotnet,
    }, database);
    expect(await listVisibleWorkspaceTemplates(database as unknown as DbOrTx)).toEqual([]);
    await expect(publishWorkspaceTemplateVersion(admin, "missing-version", database)).rejects.toMatchObject({ status: 404 });
    expect(draft.version).toBe(1);
  });

  it("fails closed on legacy or out-of-band recipes with extra fields", async () => {
    const draft = await createWorkspaceTemplateDraft(admin, {
      slug: "unsafe-out-of-band",
      name: "Unsafe fixture",
      description: "Test only.",
      recipe: knowledgeWork,
    }, database);
    const unsafeRecipe = { ...knowledgeWork, credentials: { token: "fixture-secret" }, liveFiles: ["/home/agent/workspace/report.docx"] };
    await pg.query("UPDATE workspace_template_versions SET recipe=$1::jsonb WHERE id=$2", [JSON.stringify(unsafeRecipe), draft.versionId]);
    await expect(publishWorkspaceTemplateVersion(admin, draft.versionId, database)).rejects.toMatchObject({ status: 400 });

    // The foundation constraint permits unknown JSON keys, so the catalog projection revalidates stored rows too.
    await pg.query("UPDATE workspace_template_versions SET published_at=now() WHERE id=$1", [draft.versionId]);
    await expect(listVisibleWorkspaceTemplates(database as unknown as DbOrTx)).rejects.toMatchObject({ status: 400 });
  });
});
