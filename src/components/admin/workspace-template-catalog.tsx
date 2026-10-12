"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Card } from "@/components/admin/ui";
import {
  createWorkspaceTemplateDraft,
  createWorkspaceTemplateVersion,
  publishWorkspaceTemplateVersion,
  retireWorkspaceTemplateVersion,
} from "@/app/admin/workspace-templates/actions";
import type { WorkspaceRecipe } from "@/lib/workspaces/contracts";
import type { WorkspaceCatalogProfileOption, WorkspaceRuntimeProfileKey } from "@/lib/workspaces/catalog-policy";
import type { WorkspaceTemplateAdminItem } from "@/lib/workspaces/catalog";

const KNOWLEDGE_WORK_RECIPE: WorkspaceRecipe = {
  schemaVersion: 1,
  runtimeProfileKey: "knowledge-work-v1",
  seedBundleKey: "knowledge-work",
  networkPolicy: "none",
  capabilities: { shell: true, officeHeadless: true, dotnet: false, agentBrowserView: false },
};

type Capability = keyof WorkspaceRecipe["capabilities"];
const CAPABILITIES: Array<{ key: Capability; label: string }> = [
  { key: "shell", label: "Shell" },
  { key: "officeHeadless", label: "Headless Office" },
  { key: "dotnet", label: ".NET" },
  { key: "agentBrowserView", label: "Agent browser view" },
];

function RecipeFields({
  id,
  profiles,
  initialRecipe,
}: {
  id: string;
  profiles: WorkspaceCatalogProfileOption[];
  initialRecipe: WorkspaceRecipe;
}) {
  const [profileKey, setProfileKey] = useState<WorkspaceRuntimeProfileKey>(initialRecipe.runtimeProfileKey as WorkspaceRuntimeProfileKey);
  const [seedBundleKey, setSeedBundleKey] = useState(initialRecipe.seedBundleKey ?? "");
  const [capabilities, setCapabilities] = useState(initialRecipe.capabilities);
  const profile = profiles.find((candidate) => candidate.key === profileKey) ?? profiles[0];

  return (
    <fieldset className="space-y-3 rounded-xl border border-border p-3">
      <legend className="px-1 text-sm font-medium">Recipe</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="block text-sm font-medium" htmlFor={`${id}-profile`}>Runtime profile</label>
          <select
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            id={`${id}-profile`}
            name="runtimeProfileKey"
            value={profileKey}
            onChange={(event) => {
              const next = profiles.find((candidate) => candidate.key === event.currentTarget.value);
              if (!next) return;
              setProfileKey(next.key);
              setSeedBundleKey(next.seedBundleKeys[0] ?? "");
            }}
          >
            {profiles.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <label className="block text-sm font-medium" htmlFor={`${id}-seed`}>Bundled starter files</label>
          <select
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            id={`${id}-seed`}
            name="seedBundleKey"
            value={seedBundleKey}
            onChange={(event) => setSeedBundleKey(event.currentTarget.value)}
          >
            <option value="">None</option>
            {profile.seedBundleKeys.map((key) => <option key={key} value={key}>{key}</option>)}
          </select>
        </div>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Available capabilities</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {CAPABILITIES.map(({ key, label }) => {
            const allowed = profile.capabilities[key];
            return (
              <label key={key} className={`flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm ${allowed ? "cursor-pointer" : "text-muted"}`}>
                <input
                  type="checkbox"
                  name={key}
                  checked={allowed && capabilities[key]}
                  disabled={!allowed}
                  onChange={(event) => setCapabilities((current) => ({ ...current, [key]: event.currentTarget.checked }))}
                />
                <span>{label}{!allowed ? " (not available)" : ""}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <p className="text-xs text-muted">Network access: none. Recipes contain only allowlisted profile and bundled starter keys.</p>
    </fieldset>
  );
}

export function WorkspaceTemplateCatalog({
  templates,
  profiles,
}: {
  templates: WorkspaceTemplateAdminItem[];
  profiles: WorkspaceCatalogProfileOption[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [failure, setFailure] = useState("");
  const hasKnowledgeWork = templates.some((template) => template.slug === "knowledge-work");

  async function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>, success: string) {
    setPending(true);
    setFeedback("");
    setFailure("");
    try {
      const result = await action();
      if (!result.ok) {
        setFailure(result.error);
        return;
      }
      setFeedback(success);
      router.refresh();
    } catch {
      setFailure("The catalog could not be updated. Confirm you are still an admin and try again.");
    } finally {
      setPending(false);
    }
  }

  function submitForm(
    event: React.FormEvent<HTMLFormElement>,
    action: (form: FormData) => Promise<{ ok: true } | { ok: false; error: string }>,
    success: string,
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(() => action(form), success);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Workspace templates</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Create reusable recipes for signed-in users to choose from. Publishing makes a recipe visible in the internal catalog; it does not share files or credentials.
        </p>
      </header>

      <div className="space-y-2" aria-live="polite">
        {feedback && <p role="status" className="text-sm text-success">{feedback}</p>}
        {failure && <p role="alert" className="text-sm text-danger">{failure}</p>}
      </div>

      <Card className="space-y-4">
        <div>
          <h2 className="text-lg font-medium">Knowledge Work</h2>
          <p className="mt-1 text-sm text-muted">Prebuilt Office template · slug <code>knowledge-work</code>. The name, slug, profile, and recipe are fixed for this starter.</p>
        </div>
        <form className="space-y-4" onSubmit={(event) => submitForm(event, createWorkspaceTemplateDraft, "Knowledge Work draft created.")}>
          <input type="hidden" name="name" value="Knowledge Work" />
          <input type="hidden" name="slug" value="knowledge-work" />
          <input type="hidden" name="runtimeProfileKey" value="knowledge-work-v1" />
          <input type="hidden" name="seedBundleKey" value="knowledge-work" />
          <input type="hidden" name="shell" value="on" />
          <input type="hidden" name="officeHeadless" value="on" />
          <div className="space-y-1">
            <label className="block text-sm font-medium" htmlFor="knowledge-work-description">Description</label>
            <textarea className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" id="knowledge-work-description" name="description" defaultValue="Prebuilt Office workspace for writing, spreadsheets, and presentations." maxLength={500} rows={2} />
          </div>
          <p className="text-xs text-muted">Shell and headless Office are enabled. Network access is none; agent browser view and .NET are unavailable.</p>
          {hasKnowledgeWork
            ? <p className="text-sm text-muted">Knowledge Work is already in the catalog. Use its version controls below.</p>
            : <button className="rounded-lg bg-fg px-4 py-2 text-sm font-medium text-background disabled:cursor-not-allowed disabled:opacity-60" type="submit" disabled={pending}>
                {pending ? "Saving…" : "Create Knowledge Work draft"}
              </button>}
        </form>
      </Card>

      <Card className="space-y-4">
        <div>
          <h2 className="text-lg font-medium">Create another template</h2>
          <p className="mt-1 text-sm text-muted">Choose a runtime profile from the operator allowlist. Recipe fields reject extra paths, files, credentials, and capabilities.</p>
        </div>
        <form className="space-y-4" onSubmit={(event) => submitForm(event, createWorkspaceTemplateDraft, "Template draft created.")}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="block text-sm font-medium" htmlFor="custom-template-name">Template name</label>
              <input className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" id="custom-template-name" name="name" maxLength={80} required />
            </div>
            <div className="space-y-1">
              <label className="block text-sm font-medium" htmlFor="custom-template-slug">Slug</label>
              <input className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" id="custom-template-slug" name="slug" pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={80} required aria-describedby="custom-template-slug-help" />
              <p id="custom-template-slug-help" className="text-xs text-muted">Lowercase letters, numbers, and single hyphens.</p>
            </div>
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-medium" htmlFor="custom-template-description">Description</label>
            <textarea className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" id="custom-template-description" name="description" maxLength={500} rows={2} />
          </div>
          <RecipeFields id="new-custom-template" profiles={profiles} initialRecipe={{ ...KNOWLEDGE_WORK_RECIPE, seedBundleKey: null }} />
          <button className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-hover disabled:opacity-60" type="submit" disabled={pending}>{pending ? "Saving…" : "Create template draft"}</button>
        </form>
      </Card>

      <section aria-labelledby="catalog-heading" className="space-y-3">
        <div>
          <h2 id="catalog-heading" className="text-lg font-medium">Catalog drafts and versions</h2>
          <p className="mt-1 text-sm text-muted">Published versions are immutable. Retiring a version removes it from new selections and keeps existing instances pinned.</p>
        </div>
        {templates.length === 0 ? (
          <Card><p className="text-sm text-muted">No workspace templates yet. Create the Knowledge Work draft above to begin.</p></Card>
        ) : (
          <div className="space-y-4">
            {templates.map((template) => {
              const initialRecipe = template.versions[0]?.recipe ?? KNOWLEDGE_WORK_RECIPE;
              return (
                <Card key={template.id} className="space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-base font-semibold">{template.name}</h3>
                      <p className="text-xs text-muted"><code>{template.slug}</code></p>
                      {template.description && <p className="mt-1 max-w-3xl text-sm text-muted">{template.description}</p>}
                    </div>
                    <Badge tone={template.activeVersionId ? "green" : "amber"}>{template.activeVersionId ? "Available in picker" : "No published version"}</Badge>
                  </div>

                  <ul className="divide-y divide-border rounded-xl border border-border" aria-label={`${template.name} versions`}>
                    {template.versions.map((version) => {
                      const state = version.retiredAt ? "Retired" : version.publishedAt ? "Published" : "Draft";
                      return (
                        <li key={version.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">Version {version.version}</span>
                              <Badge tone={state === "Published" ? "green" : state === "Retired" ? "default" : "amber"}>{state}</Badge>
                              <span className="text-xs text-muted">{version.recipe.runtimeProfileKey}</span>
                            </div>
                            <p className="mt-1 break-all font-mono text-[11px] text-muted">SHA-256 {version.recipeHash}</p>
                            <p className="text-xs text-muted">
                              {version.recipe.seedBundleKey ? `Starter: ${version.recipe.seedBundleKey}` : "No starter files"} · {version.recipe.networkPolicy} network
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {!version.publishedAt && <button className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-hover disabled:opacity-60" type="button" disabled={pending} onClick={() => void run(() => publishWorkspaceTemplateVersion(version.id), `Version ${version.version} published to the catalog.`)}>Publish to catalog</button>}
                            {version.publishedAt && !version.retiredAt && <button className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-hover disabled:opacity-60" type="button" disabled={pending} onClick={() => void run(() => retireWorkspaceTemplateVersion(version.id), `Version ${version.version} retired from new selections.`)}>Retire from picker</button>}
                          </div>
                        </li>
                      );
                    })}
                  </ul>

                  <details>
                    <summary className="cursor-pointer text-sm font-medium">Create a new draft version</summary>
                    <form className="mt-3 space-y-4" onSubmit={(event) => submitForm(event, createWorkspaceTemplateVersion, `New draft version for ${template.name} created.`)}>
                      <input type="hidden" name="templateId" value={template.id} />
                      <RecipeFields id={`version-${template.id}`} profiles={profiles} initialRecipe={initialRecipe} />
                      <button className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-hover disabled:opacity-60" type="submit" disabled={pending}>{pending ? "Saving…" : "Create draft version"}</button>
                    </form>
                  </details>
                </Card>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
