"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { Sidebar } from "@/components/sidebar/sidebar";
import { AvatarRail } from "@/components/sidebar/avatar-rail";
import { SearchDialog } from "./search-dialog";
import { useShell } from "./shell-context";

export function ChatShell({ children }: { children: React.ReactNode }) {
  const { sidebarOpen, setSidebarOpen, mobileOpen, setMobileOpen, setSearchOpen } = useShell();
  const router = useRouter();
  const mobileDrawer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mobileOpen) return;

    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
    const focusDrawer = requestAnimationFrame(() => {
      mobileDrawer.current?.querySelector<HTMLElement>('[aria-label="Close sidebar"]')?.focus();
    });
    const focusable = () => Array.from(mobileDrawer.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []).filter((element) => element.getClientRects().length > 0 && !element.closest("[inert], [aria-hidden='true']"));

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        mobileDrawer.current?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !mobileDrawer.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !mobileDrawer.current?.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(focusDrawer);
      document.removeEventListener("keydown", onKeyDown, true);
      if (opener?.isConnected) requestAnimationFrame(() => opener.focus());
    };
  }, [mobileOpen, setMobileOpen]);

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
        inert={!sidebarOpen || mobileOpen}
        aria-hidden={!sidebarOpen || mobileOpen}
        className={`hidden shrink-0 overflow-hidden transition-[width] duration-200 motion-reduce:transition-none md:block ${sidebarOpen ? "w-[300px]" : "w-0"}`}
      >
        <Sidebar />
      </div>
      {/* Collapsed rail */}
      {!sidebarOpen && <div inert={mobileOpen} aria-hidden={mobileOpen}><AvatarRail /></div>}
      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Main navigation drawer">
          <div aria-hidden="true" className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div ref={mobileDrawer} tabIndex={-1} className="absolute inset-y-0 left-0 shadow-xl">
            <Sidebar />
          </div>
        </div>
      )}
      <main inert={mobileOpen} aria-hidden={mobileOpen} className="relative flex min-w-0 flex-1 flex-col">{children}</main>
      <SearchDialog />
    </div>
  );
}
