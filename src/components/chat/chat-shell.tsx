"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Sidebar } from "@/components/sidebar/sidebar";
import { AvatarRail } from "@/components/sidebar/avatar-rail";
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
        inert={!sidebarOpen}
        aria-hidden={!sidebarOpen}
        className={`hidden shrink-0 overflow-hidden transition-[width] duration-200 motion-reduce:transition-none md:block ${sidebarOpen ? "w-[300px]" : "w-0"}`}
      >
        <Sidebar />
      </div>
      {/* Collapsed rail */}
      {!sidebarOpen && <AvatarRail />}
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
