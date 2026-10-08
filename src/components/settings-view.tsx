"use client";

import { CodexAllowance } from "@/components/settings/codex-allowance";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { Pin, Trash2 } from "lucide-react";
import {
  archiveConversation,
  clearMemories,
  deleteAllConversations,
  deleteMemory,
  revokeToolGrant,
  saveMemory,
  setMemoryPinned,
  updatePrefs,
} from "@/app/(chat)/actions";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ChatGPTConnection, type ChatGPTConnectionView } from "@/components/settings/chatgpt-connection";
import { WorkspacePanel } from "@/components/settings/workspace-panel";
import { StartTargetSelect } from "@/components/start-target-select";
import type { WorkspaceView } from "@/lib/sandbox/view";
import type { UserPrefs } from "@/db/schema";
import { cn } from "@/lib/utils";

const TABS = ["General", "Security", "Personalization", "Memory", "Approvals", "Connected accounts", "Workspace", "Data controls"] as const;
type Tab = (typeof TABS)[number];
const tabSlug = (tab: Tab) => tab.toLowerCase().replaceAll(" ", "-");

export function SettingsView({
  prefs,
  apps,
  bots,
  memories,
  archived,
  grants,
  user,
  chatgpt,
  workspace,
  security,
  hermes,
  teamConnections,
}: {
  prefs: UserPrefs;
  apps: { id: string; name: string }[];
  bots: { id: string; name: string }[];
  memories: { id: string; content: string; pinned: boolean }[];
  archived: { id: string; title: string; updatedAt: string }[];
  grants: { botId: string; toolName: string; botName: string }[];
  user: { name: string; upn: string; authSource: string };
  /** Null when this person can't connect a ChatGPT plan and has no connection (the tab is hidden). */
  chatgpt: ChatGPTConnectionView | null;
  /** Null when workspaces are off (the tab is hidden). */
  workspace: WorkspaceView | null;
  security: ReactNode;
  hermes: ReactNode;
  /** Retained own Team account cleanup; only present when the actor has saved accounts. */
  teamConnections?: ReactNode;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { theme, setTheme } = useTheme();
  const tabs = TABS.filter((t) => (t !== "Connected accounts" || chatgpt || hermes || teamConnections) && (t !== "Workspace" || workspace));
  const selected = TABS.find(t => tabSlug(t) === searchParams.get("tab")) ?? "General";
  // A tab can disappear (e.g. Connected accounts after disconnecting): fall back instead of showing an empty pane.
  const tab: Tab = tabs.includes(selected) ? selected : "General";
  const section = searchParams.get("section");
  const sectionsNav = useRef<HTMLElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      // Keep the selected section visible in the horizontal mobile menu.
      const nav = sectionsNav.current;
      const active = nav?.querySelector('[aria-current="page"]');
      if (nav && active) {
        const menu = nav.getBoundingClientRect(), item = active.getBoundingClientRect();
        if (item.left < menu.left) nav.scrollLeft -= menu.left - item.left;
        else if (item.right > menu.right) nav.scrollLeft += item.right - menu.right;
      }
      if (tab !== "Connected accounts" || (section !== "personal-hermes" && section !== "remote-hermes")) return;
      const title = document.getElementById(`${section}-title`);
      title?.focus({ preventScroll: true });
      const scroller = title?.closest<HTMLElement>('[data-page-scroll]');
      if (title && scroller) {
        scroller.scrollTop += title.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [tab, section]);
  const [instructions, setInstructions] = useState(prefs.customInstructions ?? "");
  const [pending, start] = useTransition();
  const [newMemory, setNewMemory] = useState("");
  function selectTab(next: Tab) {
    if (next === tab) return;
    const params = new URLSearchParams(searchParams.toString());
    if (next === "General") params.delete("tab");
    else params.set("tab", tabSlug(next));
    params.delete("section");
    const query = params.toString();
    // Keep settings state while making sections refreshable and navigable with Back/Forward.
    window.history.pushState(null, "", `/settings${query ? `?${query}` : ""}`);
  }

  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <nav ref={sectionsNav} aria-label="Settings sections" className="flex shrink-0 gap-1 overflow-x-auto md:w-44 md:flex-col">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => selectTab(t)}
            aria-current={tab === t ? "page" : undefined}
            className={cn("min-h-11 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm", tab === t ? "bg-hover font-medium" : "text-muted hover:bg-hover")}
          >
            {t}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 space-y-6">
        {/* Preserve one-time recovery codes if someone switches settings sections before saving them. */}
        <div hidden={tab !== "Security"}>{security}</div>
        {tab === "General" && <CodexAllowance />}
        {tab === "General" && (
          <>
            <Field label="Theme">
              <Select aria-label="Theme" value={theme ?? "system"} onChange={(e) => setTheme(e.target.value)}>
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </Select>
            </Field>
            <Field label="Start new chats with" hint="Your choice overrides the organization default. Otherwise, use the coordinator when enabled, then the organization’s model or bot. A chosen bot starts a fresh chat; selecting it in the sidebar opens its home.">
              <StartTargetSelect
                value={prefs}
                apps={apps}
                bots={bots}
                emptyLabel="Organization default"
                onChange={(next) => start(async () => {
                  try { await updatePrefs(next); toast.success("Saved"); }
                  catch (err) { toast.error(err instanceof Error ? err.message : "Could not save your default."); }
                })}
              />
            </Field>
            <div className="rounded-xl border border-border p-4 text-sm">
              <div className="font-medium">{user.name}</div>
              <div className="text-muted">{user.upn}</div>
              <div className="mt-1 text-xs text-subtle">Signed in with {user.authSource === "entra" ? "Microsoft Entra ID" : user.authSource === "local" ? "local account" : "company directory (LDAP)"}</div>
            </div>
            <div className="text-sm text-muted">
              Keyboard shortcuts: <kbd className="rounded bg-surface-2 px-1">Ctrl/⌘ K</kbd> search ·{" "}
              <kbd className="rounded bg-surface-2 px-1">Ctrl/⌘ Shift O</kbd> new chat · <kbd className="rounded bg-surface-2 px-1">Ctrl/⌘ Shift S</kbd> toggle sidebar
            </div>
          </>
        )}

        {tab === "Personalization" && (
          <>
            <Field label="Custom instructions" hint="What should the assistant know about you, and how should it respond? Applies to every chat and bot.">
              <Textarea rows={8} value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={4000} />
            </Field>
            <Button disabled={pending} onClick={() => start(async () => { await updatePrefs({ customInstructions: instructions }); toast.success("Saved"); })}>
              Save
            </Button>
            <label className="flex items-center justify-between rounded-xl border border-border p-4 text-sm">
              <span>
                <span className="block font-medium">Memory</span>
                <span className="text-muted">Let assistants remember useful details across chats.</span>
              </span>
              <Switch
                defaultChecked={prefs.memoryEnabled !== false}
                onCheckedChange={(v) => start(async () => { await updatePrefs({ memoryEnabled: v }); toast.success(v ? "Memory on" : "Memory off"); })}
              />
            </label>
          </>
        )}

        {tab === "Personalization" && <label className="flex items-center justify-between rounded-xl border border-border p-4 text-sm">
          <span><span className="block font-medium">Bot learning</span><span className="text-muted">Learn personal preferences and reusable bot procedures from completed work. Requires Memory to be on.</span></span>
          <Switch defaultChecked={prefs.learningEnabled !== false} onCheckedChange={v => start(async () => { await updatePrefs({ learningEnabled: v }); toast.success(v ? "Bot learning on" : "Bot learning off"); })} />
        </label>}

        {tab === "Memory" && (
          <>
            <p className="text-sm text-muted">Shared memory, available to every assistant and bot. Bots also keep their own memories (see each bot&apos;s page).</p>
            <div className="space-y-2">
              {memories.map((m) => (
                <div key={m.id} className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm">
                  <span className="flex-1">{m.content}</span>
                  <button
                    onClick={async () => { await setMemoryPinned(m.id, !m.pinned); router.refresh(); }}
                    className={cn("rounded-lg p-1.5 hover:bg-hover", m.pinned ? "text-accent" : "text-muted")}
                    aria-label="Pin memory"
                  >
                    <Pin className="h-4 w-4" />
                  </button>
                  <button onClick={async () => { await deleteMemory(m.id); router.refresh(); }} className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-danger" aria-label="Delete memory">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
              {!memories.length && <p className="text-sm text-subtle">Nothing remembered yet.</p>}
            </div>
            <form
              className="flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!newMemory.trim()) return;
                await saveMemory({ content: newMemory });
                setNewMemory("");
                router.refresh();
              }}
            >
              <Input value={newMemory} onChange={(e) => setNewMemory(e.target.value)} placeholder="Add a memory…" />
              <Button type="submit" variant="outline">Add</Button>
            </form>
            {memories.length > 0 && (
              <Button variant="ghost" className="text-danger" onClick={async () => { if (confirm("Delete all memories?")) { await clearMemories(); router.refresh(); } }}>
                Clear all memory
              </Button>
            )}
          </>
        )}

        {tab === "Approvals" && (
          <>
            <p className="text-sm text-muted">Actions you chose to &quot;Always allow&quot;. Revoke to be asked again. Admin-enforced approvals always ask.</p>
            <div className="divide-y divide-border rounded-xl border border-border text-sm">
              {grants.map((g) => (
                <div key={g.botId + g.toolName} className="flex items-center gap-3 px-3 py-2">
                  <span className="font-medium">{g.botName}</span>
                  <span className="font-mono text-xs text-muted">{g.toolName}</span>
                  <Button variant="ghost" size="sm" className="ml-auto" onClick={async () => { await revokeToolGrant(g.botId, g.toolName); router.refresh(); }}>
                    Revoke
                  </Button>
                </div>
              ))}
              {!grants.length && <p className="p-3 text-subtle">No standing approvals.</p>}
            </div>
          </>
        )}

        {tab === "Connected accounts" && <>{chatgpt && <ChatGPTConnection view={chatgpt} />}{hermes}{teamConnections}</>}
        {tab === "Workspace" && workspace && <WorkspacePanel view={workspace} />}
        {tab === "Data controls" && (
          <>
            <div>
              <h3 className="mb-2 text-sm font-medium">Archived chats</h3>
              <div className="divide-y divide-border rounded-xl border border-border text-sm">
                {archived.map((a) => (
                  <div key={a.id} className="flex items-center gap-3 px-3 py-2">
                    <Link href={`/c/${a.id}`} className="flex-1 truncate hover:underline">{a.title}</Link>
                    <Button variant="ghost" size="sm" onClick={async () => { await archiveConversation(a.id, false); router.refresh(); }}>
                      Unarchive
                    </Button>
                  </div>
                ))}
                {!archived.length && <p className="p-3 text-subtle">No archived chats.</p>}
              </div>
            </div>
            <Button
              variant="danger"
              onClick={async () => {
                if (!confirm("Delete ALL your chats? This cannot be undone.")) return;
                await deleteAllConversations();
                router.push("/");
              }}
            >
              Delete all chats
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
