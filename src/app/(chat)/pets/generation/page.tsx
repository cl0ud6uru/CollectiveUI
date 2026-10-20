import { PetGenerationBuilder } from "@/components/admin/pet-generation-builder";
import { getPetGenerationMemberPageData } from "@/lib/pets/generation";
import { requirePagePrincipal } from "@/lib/session";

export default async function PetGenerationPage() {
  const p = await requirePagePrincipal();
  const initial = await getPetGenerationMemberPageData(p);
  return <main className="mx-auto w-full max-w-5xl space-y-4 px-4 py-6">
    <h1 className="text-2xl font-semibold">Create a private Codex Pet</h1>
    {initial.allowed
      ? <PetGenerationBuilder initial={{ settings: initial.settings, connections: [], memberMode: true, assignableBots: initial.assignableBots }} />
      : <p className="rounded-xl border border-border p-4 text-sm text-muted">AI pet generation is not enabled for your account. An administrator controls provider setup and group access.</p>}
  </main>;
}
