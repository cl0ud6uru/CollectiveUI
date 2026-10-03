"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { PanelLeft, Search, SquarePen } from "lucide-react";
import { Sidebar } from "@/components/sidebar/sidebar";
import { Tip } from "@/components/ui/tooltip";
import { SearchDialog } from "./search-dialog";
import { useShell } from "./shell-context";

export function ChatShell({ children }: { children: React.ReactNode }) {
  const { sidebarOpen, setSidebarOpen, mobileOpen, setMobileOpen, setSearchOpen } = useShell();
  const router = useRouter();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        router.push("/");
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        setSidebarOpen(!sidebarOpen);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, setSearchOpen, setSidebarOpen, sidebarOpen]);

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      {/* Desktop sidebar */}
      <div
        className={`hidden shrink-0 overflow-hidden transition-[width] duration-200 md:block ${sidebarOpen ? "w-[260px]" : "w-0"}`}
      >
        <Sidebar />
      </div>
      {/* Collapsed rail */}
      {!sidebarOpen && (
        <div className="hidden w-[52px] shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar py-3 md:flex">
          <Tip label="Open sidebar" side="right">
            <button onClick={() => setSidebarOpen(true)} className="rounded-lg p-2 text-muted hover:bg-hover hover:text-fg" aria-label="Open sidebar">
              <PanelLeft className="h-5 w-5" />
            </button>
          </Tip>
          <Tip label="New chat" side="right">
            <button onClick={() => router.push("/")} className="rounded-lg p-2 text-muted hover:bg-hover hover:text-fg" aria-label="New chat">
              <SquarePen className="h-5 w-5" />
            </button>
          </Tip>
          <Tip label="Search chats" side="right">
            <button onClick={() => setSearchOpen(true)} className="rounded-lg p-2 text-muted hover:bg-hover hover:text-fg" aria-label="Search chats">
              <Search className="h-5 w-5" />
            </button>
          </Tip>
        </div>
      )}
      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 shadow-xl">
            <Sidebar />
          </div>
        </div>
      )}
      <main className="relative flex min-w-0 flex-1 flex-col">{children}</main>
      <SearchDialog />
    </div>
  );
}
