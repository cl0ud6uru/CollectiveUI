"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, AppWindow, ArrowLeft, BarChart3, Bot, PawPrint, Plug, Settings, Terminal, Users, UsersRound, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/admin", label: "Usage", icon: BarChart3 },
  { href: "/admin/apps", label: "Connections", icon: AppWindow },
  { href: "/admin/hermes", label: "Managed Hermes", icon: Bot },
  { href: "/admin/groups", label: "Groups", icon: UsersRound },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/bots", label: "Bots", icon: Bot },
  { href: "/admin/pets", label: "Pets", icon: PawPrint },
  { href: "/admin/tools", label: "Bots & tools", icon: Wrench },
  { href: "/admin/mcp", label: "MCP servers", icon: Plug },
  { href: "/admin/sandboxes", label: "Workspaces", icon: Terminal },
  { href: "/admin/activity", label: "Activity", icon: Activity },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

export function AdminNav({ appName }: { appName: string }) {
  const pathname = usePathname();
  return (
    <nav className="min-w-0 shrink-0 border-b border-border bg-sidebar md:h-full md:w-[240px] md:border-b-0 md:border-r">
      <div className="flex items-center gap-2 px-4 py-4">
        <Link href="/" className="flex min-w-0 max-w-full items-center gap-2 rounded-lg px-1 py-1 text-sm text-muted hover:text-fg">
          <ArrowLeft className="h-4 w-4 shrink-0" /> <span className="truncate">Back to {appName}</span>
        </Link>
      </div>
      <div className="px-4 pb-2 text-xs font-medium uppercase tracking-wide text-subtle">Admin</div>
      <div className="flex gap-1 overflow-x-auto px-2 pb-3 md:flex-col md:overflow-visible">
        {ITEMS.map(({ href, label, icon: Icon }) => {
          const active = href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn("flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm hover:bg-hover", active && "bg-hover font-medium")}
            >
              <Icon className="h-4 w-4" /> {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
