"use client";

import { revokeUserSessions } from "@/app/admin/users/local-actions";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MoreHorizontal } from "lucide-react";
import { setBotEnabled, setUserAdmin, setUserDisabled } from "@/app/admin/actions";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";

function useAct() {
  const router = useRouter();
  return async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  };
}

export function UserRowActions({ userId, isAdmin, disabled }: { userId: string; isAdmin: boolean; disabled: boolean }) {
  const act = useAct();
  return (
    <Menu>
      <MenuTrigger asChild>
        <button className="rounded-lg p-1.5 text-muted hover:bg-hover" aria-label="User actions">
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem onSelect={() => act(() => revokeUserSessions(userId), "Sessions revoked")}>Revoke sessions</MenuItem>
        <MenuItem onSelect={() => act(() => setUserAdmin(userId, !isAdmin), isAdmin ? "Admin removed" : "Admin granted")}>
          {isAdmin ? "Remove admin" : "Make admin"}
        </MenuItem>
        <MenuItem danger={!disabled} onSelect={() => act(() => setUserDisabled(userId, !disabled), disabled ? "User enabled" : "User disabled")}>
          {disabled ? "Enable user" : "Disable user"}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export function BotEnableToggle({ botId, enabled }: { botId: string; enabled: boolean }) {
  const act = useAct();
  return (
    <button
      className="rounded-full border border-border px-3 py-1 text-xs hover:bg-hover"
      onClick={() => act(() => setBotEnabled(botId, !enabled), enabled ? "Bot disabled" : "Bot enabled")}
    >
      {enabled ? "Disable" : "Enable"}
    </button>
  );
}
