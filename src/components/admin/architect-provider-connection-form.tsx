"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { SAVED_PROVIDER_LABELS, type SavedProviderKind } from "@/lib/llm/catalog";
import { saveArchitectProviderConnectionDraft } from "@/app/admin/provider-draft-actions";

export type ArchitectProviderConnectionDraftView = {
  id: string;
  provider: SavedProviderKind;
  name: string;
  baseUrl: string | null;
  organization: string | null;
  project: string | null;
  expiresAt: string;
};

export function ArchitectProviderConnectionForm({ draft }: { draft: ArchitectProviderConnectionDraftView }) {
  const router = useRouter();
  const [apiKey, setApiKey] = useState("");
  const [pending, startTransition] = useTransition();
  return <section className="mb-8 rounded-xl border border-primary/40 bg-muted/20 p-4" aria-labelledby="architect-provider-setup-heading">
    <h2 id="architect-provider-setup-heading" className="text-lg font-semibold">Finish adding {draft.name}</h2>
    <p className="mt-1 text-sm text-muted">Prepared by The Architect for {SAVED_PROVIDER_LABELS[draft.provider]}. Enter the credential here; it goes directly to the server, is encrypted at rest, and is never returned to the chat, audit log, or form. This one-use form expires {new Date(draft.expiresAt).toLocaleString()}.</p>
    <dl className="my-3 grid gap-1 text-sm sm:grid-cols-2">
      <div><dt className="inline text-muted">Endpoint: </dt><dd className="inline break-all">{draft.baseUrl ?? "Provider default"}</dd></div>
      {draft.organization && <div><dt className="inline text-muted">Organization: </dt><dd className="inline">{draft.organization}</dd></div>}
      {draft.project && <div><dt className="inline text-muted">Project: </dt><dd className="inline">{draft.project}</dd></div>}
    </dl>
    <form className="max-w-xl space-y-3" onSubmit={event => {
      event.preventDefault();
      const submitted = apiKey;
      startTransition(async () => {
        try {
          await saveArchitectProviderConnectionDraft(draft.id, submitted);
          setApiKey("");
          toast.success("Provider connection saved. It is not assigned to a model.");
          router.replace("/admin/apps");
          router.refresh();
        } catch {
          toast.error("Could not save this credential form. It may have expired or your administrator session may have changed.");
        }
      });
    }}>
      <Field label="API key" hint="The key is sent only to this server action over the authenticated Admin session. It is not stored in the setup draft.">
        <Input aria-label="Provider API key" type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-1p-ignore data-lpignore="true" maxLength={4000} required />
      </Field>
      <p className="text-sm text-muted">Saving creates an enabled provider connection, but does not assign a model, run a connection test, or make a provider request.</p>
      <div className="flex gap-2">
        <Button type="submit" disabled={pending || !apiKey}>Save encrypted connection</Button>
        <Button type="button" variant="outline" disabled={pending} onClick={() => router.replace("/admin/apps")}>Cancel</Button>
      </div>
    </form>
  </section>;
}
