"use client";

import { UserPicker, type UserOption } from "@/components/user-picker";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus, Trash2, X } from "lucide-react";
import { deleteGroup, saveGroup, type GroupInput } from "@/app/admin/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge, Table, Td } from "./ui";

type Mapping = GroupInput["mappings"][number];
type Group = GroupInput & { id: string };

function GroupDialog({ group, known, users, onClose }: { group: Partial<Group> | null; known: Mapping[]; users: UserOption[]; onClose: () => void }) {
  const router = useRouter();
  const [g, setG] = useState<Partial<Group>>(group ?? { mappings: [], isAdmin: false, canCreateBots: true });
  const [src, setSrc] = useState<"entra" | "ldap">("ldap");
  const [ext, setExt] = useState("");
  const [pending, start] = useTransition();
  const mappings = g.mappings ?? [];

  function addMapping() {
    const id = ext.trim();
    if (!id) return;
    const k = known.find((x) => x.source === src && x.externalId.toLowerCase() === id.toLowerCase());
    setG({ ...g, mappings: [...mappings, { source: src, externalId: id, displayName: k?.displayName ?? null }] });
    setExt("");
  }

  return (
    <Dialog open={!!group} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={g.id ? `Edit ${g.name}` : "New group"} className="max-w-2xl">
        <div className="space-y-4">
          <Field label="Name">
            <Input value={g.name ?? ""} onChange={(e) => setG({ ...g, name: e.target.value })} placeholder="Legal team" />
          </Field>
          <Field label="Description">
            <Input value={g.description ?? ""} onChange={(e) => setG({ ...g, description: e.target.value })} />
          </Field>
          <label className="flex items-center justify-between rounded-xl border border-border px-3 py-2 text-sm">
            Members are portal admins
            <Switch checked={!!g.isAdmin} onCheckedChange={(v) => setG({ ...g, isAdmin: v })} />
          </label>
          <label className="flex items-center justify-between rounded-xl border border-border px-3 py-2 text-sm">
            Members can create bots (when bot creation is limited to groups)
            <Switch checked={!!g.canCreateBots} onCheckedChange={(v) => setG({ ...g, canCreateBots: v })} />
          </label>
          <div>
            <div className="mb-1.5 text-sm font-medium">Directory groups</div>
            <div className="space-y-1.5">
              {mappings.map((m, i) => (
                <div key={i} className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5 text-sm">
                  <Badge tone={m.source === "entra" ? "blue" : "amber"}>{m.source === "entra" ? "Entra" : "LDAP"}</Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{m.externalId}</span>
                  {m.displayName && <span className="text-xs text-muted">{m.displayName}</span>}
                  <button onClick={() => setG({ ...g, mappings: mappings.filter((_, j) => j !== i) })} aria-label="Remove mapping" className="text-muted hover:text-danger">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <Select aria-label="Directory source" value={src} onChange={(e) => setSrc(e.target.value as "entra" | "ldap")} className="w-28">
                <option value="ldap">LDAP</option>
                <option value="entra">Entra</option>
              </Select>
              <Input
                list="known-groups"
                value={ext}
                onChange={(e) => setExt(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addMapping())}
                placeholder={src === "entra" ? "Group object ID (GUID)" : "CN=AI Users,OU=Groups,DC=corp,DC=com"}
              />
              <Button variant="outline" onClick={addMapping}>
                Add
              </Button>
              <datalist id="known-groups">
                {known
                  .filter((k) => k.source === src)
                  .map((k) => (
                    <option key={k.externalId} value={k.externalId}>
                      {k.displayName ?? ""}
                    </option>
                  ))}
              </datalist>
            </div>
            <p className="mt-1 text-xs text-muted">Suggestions come from groups seen on users who have signed in.</p>
          </div>
          <Field label="Individual users" hint="These users receive the group’s permissions alongside members of its directory groups.">
            <UserPicker users={users} value={g.memberIds ?? []} onChange={memberIds => setG({ ...g, memberIds })} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={pending || !g.name}
              onClick={() =>
                start(async () => {
                  try {
                    await saveGroup({
                      id: g.id,
                      name: g.name!,
                      description: g.description,
                      isAdmin: !!g.isAdmin,
                      canCreateBots: !!g.canCreateBots,
                      mappings,
                      memberIds: g.memberIds ?? [],
                    });
                    toast.success("Group saved");
                    onClose();
                    router.refresh();
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Save failed");
                  }
                })
              }
            >
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function GroupsAdmin({ groups, known, users }: { groups: Group[]; known: Mapping[]; users: UserOption[] }) {
  const router = useRouter();
  const [edit, setEdit] = useState<Partial<Group> | null>(null);
  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button onClick={() => setEdit({ mappings: [], isAdmin: false, canCreateBots: true })}>
          <Plus className="h-4 w-4" /> New group
        </Button>
      </div>
      <Table head={["Name", "Directory groups", "Individual users", "Permissions", ""]}>
        {groups.map((g) => (
          <tr key={g.id} className="cursor-pointer hover:bg-hover/50" onClick={() => setEdit(g)}>
            <Td>
              <div className="font-medium">{g.name}</div>
              <div className="text-xs text-muted">{g.description}</div>
            </Td>
            <Td className="text-xs text-muted">
              {g.mappings.map((m) => m.displayName ?? m.externalId).join(", ") || <span>None</span>}
            </Td>
            <Td className="text-xs text-muted">{g.memberIds?.length ?? 0} users</Td>
            <Td className="space-x-1">
              {g.isAdmin && <Badge tone="red">admin</Badge>}
              {g.canCreateBots && <Badge>create bots</Badge>}
            </Td>
            <Td>
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!confirm(`Delete group ${g.name}?`)) return;
                  await deleteGroup(g.id);
                  router.refresh();
                }}
                className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-danger"
                aria-label={`Delete ${g.name}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </Td>
          </tr>
        ))}
        {!groups.length && (
          <tr>
            <Td colSpan={5} className="py-8 text-center text-muted">
              No groups yet.
            </Td>
          </tr>
        )}
      </Table>
      <GroupDialog key={edit?.id ?? (edit ? "new" : "none")} group={edit} known={known} users={users} onClose={() => setEdit(null)} />
    </div>
  );
}
