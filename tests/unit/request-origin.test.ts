import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertAuthOrigin } from "@/lib/auth/origin";
import { assertRequestContentType } from "@/lib/auth/mutation-request";
import { assertBrandingOrigin } from "@/lib/branding/logo";
import { assertPetOrigin } from "@/lib/pets/import";

const portal = "https://portal.example.test";
beforeEach(() => vi.stubEnv("AUTH_URL", portal));
afterEach(() => vi.unstubAllEnvs());

describe.each([
  { name: "shared", check: (req: Request) => assertAuthOrigin(req.headers) },
  { name: "branding", check: assertBrandingOrigin },
  { name: "pets", check: assertPetOrigin },
])("$name configured-origin boundary", ({ check }) => {
  const request = (origin = portal) => new Request("http://internal:3000/api/settings", {
    headers: { origin, host: "attacker.test", "x-forwarded-host": "attacker.test", "x-forwarded-proto": "https" },
  });
  it("accepts the exact public origin behind a proxy", () => expect(() => check(request())).not.toThrow());
  it.each([undefined, "", "not a URL", "null", "file:///tmp/portal", "data:text/html,test", "https://user:password@portal.example.test"])("fails closed for public URL %j", configured => {
    vi.stubEnv("AUTH_URL", configured);
    for (const origin of [portal, "http://internal:3000", "https://attacker.test", "null"])
      expect(() => check(request(origin))).toThrow(expect.objectContaining({ status: 403 }));
  });
  it.each(["", "null", `${portal}/`, `${portal}/path`, `${portal}?x=1`, `${portal}#fragment`, "https://user@portal.example.test", "https://sibling.example.test", `${portal}, https://attacker.test`])("rejects non-exact Origin %j", origin => {
    const req = request(origin); if (!origin) req.headers.delete("origin");
    expect(() => check(req)).toThrow(expect.objectContaining({ status: 403 }));
  });
  it("rejects inconsistent cross-site fetch metadata", () => {
    const req = request(); req.headers.set("sec-fetch-site", "cross-site");
    expect(() => check(req)).toThrow(expect.objectContaining({ status: 403 }));
  });
});

it.each(["application/jsonp", "application/json-patch+json", "text/plain", "application/json, text/plain", ""])("rejects media type %j without consuming the body", type => {
  const req = new Request(portal, { method: "POST", headers: { "content-type": type }, body: "{}" });
  expect(() => assertRequestContentType(req)).toThrow(expect.objectContaining({ status: 415 }));
  expect(req.bodyUsed).toBe(false);
});
it.each(["application/json", "APPLICATION/JSON; charset=utf-8"])("accepts JSON media type %j", type => {
  expect(() => assertRequestContentType(new Request(portal, { headers: { "content-type": type } }))).not.toThrow();
});
