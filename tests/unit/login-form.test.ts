import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/app/login/actions", () => ({ localLogin: async () => null, ldapLogin: async () => null, entraLogin: async () => {} }));
import { LoginForm } from "@/app/login/login-form";

const render = (entra: boolean, ldap: boolean) => renderToStaticMarkup(createElement(LoginForm, { entra, ldap, callbackUrl: "/bots" }));
describe("login provider combinations", () => {
  it("keeps Microsoft as the only option for Entra-only installations", () => {
    const html = render(true, false);
    expect(html).toContain("Continue with Microsoft");
    expect(html).not.toContain('name="username"');
    expect(html).toContain('name="callbackUrl" value="/bots"');
  });
  it("labels and displays company credentials for LDAP-only installations", () => {
    const html = render(false, true);
    expect(html).toContain('for="username"');
    expect(html).toContain('for="password"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).not.toContain('hidden=""');
    expect(html).not.toContain("Continue with Microsoft");
  });
  it("collapses LDAP behind an accessible toggle when both providers are enabled", () => {
    const html = render(true, true);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="company-login"');
    expect(html).toContain('id="company-login" hidden=""');
    expect(html).toContain("Continue with Microsoft");
  });
  it("explains unavailable sign-in without leaking deployment details", () => {
    const html = render(false, false);
    expect(html).toContain("Please contact your administrator");
    expect(html).not.toContain("<form");
  });
});

it("renders all eight combinations without exposing a disabled local form", () => {
  for (const local of [true, false]) for (const entra of [true, false]) for (const ldap of [true, false]) {
    const html = renderToStaticMarkup(createElement(LoginForm, { local, entra, ldap, callbackUrl: "/bots" }));
    expect(html.includes("Local username or email")).toBe(local);
    expect(html.includes("Continue with Microsoft")).toBe(entra);
    expect(html.includes("Company username")).toBe(ldap);
  }
});
