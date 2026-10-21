import { isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingAccountView, SpendingSnapshot } from "@/lib/billing/contracts";

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[], cleanups: [] as (() => void)[] }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[index], (next: unknown) => { hooks.slots[index] = typeof next === "function" ? next(hooks.slots[index]) : next; }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
  useCallback: (callback: unknown, deps: unknown[]) => {
    const index = hooks.cursor++;
    const prior = hooks.slots[index] as { callback: unknown; deps: unknown[] } | undefined;
    if (!prior || deps.some((value, i) => !Object.is(value, prior.deps[i]))) hooks.slots[index] = { callback, deps };
    return (hooks.slots[index] as { callback: unknown }).callback;
  },
  useEffect: (effect: EffectCallback, deps: unknown[]) => {
    const index = hooks.cursor++;
    const prior = hooks.slots[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (prior && deps.every((value, i) => Object.is(value, prior.deps[i]))) return;
    prior?.cleanup?.();
    const slot = { deps, cleanup: undefined as (() => void) | undefined };
    hooks.slots[index] = slot;
    hooks.effects.push(() => { const cleanup = effect(); if (typeof cleanup === "function") { slot.cleanup = cleanup; hooks.cleanups.push(cleanup); } });
  },
}));
vi.mock("@/app/admin/spending/actions", () => ({ saveBillingConfiguration: vi.fn() }));
import { SpendingDashboard } from "@/components/admin/spending-dashboard";
import { Button } from "@/components/ui/button";

type Element = ReactElement<{ children?: ReactNode; disabled?: boolean; "aria-label"?: string; role?: string; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void }>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...nodes(element.props.children)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement(node)) return text((node as Element).props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
const base = new Date("2026-10-15T12:00:00Z").getTime();
const account = (id: string, lastAttemptAt: string | null, enabled = true): BillingAccountView => ({
  id, name: id, organization: `org-${id}`, enabled, showHealthBar: false, snapshot: null, lastAttemptAt, lastError: null,
});
function renderer(initial: BillingAccountView[]) {
  return () => {
    hooks.cursor = 0;
    const tree = SpendingDashboard({ initial });
    for (const effect of hooks.effects.splice(0)) effect();
    return tree;
  };
}
function refreshButton(tree: ReactNode) {
  return nodes(tree).find(node => node.type === Button && /^(Refresh|Refreshing)/.test(text(node)))!;
}
function select(tree: ReactNode, id: string) {
  nodes(tree).find(node => node.props["aria-label"] === "Billing account")!.props.onChange!({ target: { value: id } });
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(base);
  hooks.slots = []; hooks.cursor = 0; hooks.effects = []; hooks.cleanups = [];
  // Keep automatic reads off while exercising the manual control and its real timer effect.
  vi.stubGlobal("document", { visibilityState: "hidden", addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => { for (const cleanup of hooks.cleanups) cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("provider refresh cooldown with a controlled clock", () => {
  it("disables at 59,999ms and enables exactly at 60,000ms using the saved account attempt", () => {
    const render = renderer([account("one", new Date(base).toISOString())]);
    expect(text(refreshButton(render()))).toBe("Refresh in 60s");
    expect(refreshButton(render()).props.disabled).toBe(true);
    vi.advanceTimersByTime(59_999);
    expect(text(refreshButton(render()))).toBe("Refresh in 1s");
    expect(refreshButton(render()).props.disabled).toBe(true);
    vi.advanceTimersByTime(1);
    expect(text(refreshButton(render()))).toBe("Refresh provider data");
    expect(refreshButton(render()).props.disabled).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses each selected account's own attempt and keeps disabled accounts unavailable", () => {
    const render = renderer([account("one", new Date(base).toISOString()), account("two", new Date(base - 50_000).toISOString()), account("off", null, false)]);
    select(render(), "two"); expect(text(refreshButton(render()))).toBe("Refresh in 10s");
    select(render(), "off"); expect(refreshButton(render()).props.disabled).toBe(true);
    select(render(), "one"); expect(text(refreshButton(render()))).toBe("Refresh in 60s");
  });

  it("retains a local cooldown after a concurrent-tab 429, prevents duplicate pending requests and permits retry at the boundary", async () => {
    const render = renderer([account("one", null), account("two", null)]);
    let finish!: (response: { ok: boolean; json: () => Promise<unknown> }) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve as typeof finish; }));
    const button = refreshButton(render()); button.props.onClick!();
    expect(text(refreshButton(render()))).toBe("Refreshing…");
    expect(refreshButton(render()).props.disabled).toBe(true);
    button.props.onClick!(); expect(fetch).toHaveBeenCalledTimes(1);
    finish({ ok: false, json: async () => ({ error: "Wait a minute before refreshing again." }) }); await settle();
    expect(text(nodes(render()).find(node => node.props.role === "alert"))).toContain("Wait a minute");
    expect(text(refreshButton(render()))).toBe("Refresh in 60s");
    select(render(), "two"); expect(refreshButton(render()).props.disabled).toBe(false);
    select(render(), "one"); expect(refreshButton(render()).props.disabled).toBe(true);
    vi.advanceTimersByTime(59_999); expect(refreshButton(render()).props.disabled).toBe(true);
    vi.advanceTimersByTime(1); expect(refreshButton(render()).props.disabled).toBe(false);
  });

  it("uses the later authoritative attempt returned on success and restarts the cooldown", async () => {
    const render = renderer([account("one", null)]);
    const snapshot: SpendingSnapshot = { organization: "org-one", month: "2026-10", start: 1790812800, through: base / 1000, refreshedAt: new Date(base).toISOString(),
      costsStatus: "known", amounts: [], daily: [], breakdownStatus: "known", projects: [], projectLimits: {},
      organizationLimit: { status: "unknown", amount: null, currency: null, enforcement: null } };
    const updated = { ...account("one", new Date(base + 20_000).toISOString()), snapshot };
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => [updated] } as Response);
    refreshButton(render()).props.onClick!(); await settle();
    expect(text(nodes(render()).find(node => node.props.role === "status"))).toContain("Provider costs updated");
    expect(text(refreshButton(render()))).toBe("Refresh in 80s");
    vi.advanceTimersByTime(79_999); expect(refreshButton(render()).props.disabled).toBe(true);
    vi.advanceTimersByTime(1); expect(refreshButton(render()).props.disabled).toBe(false);
  });
});
