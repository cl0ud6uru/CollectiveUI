import { expect, test } from "@playwright/test";
test.skip(process.env.AUTH_PROVIDERS_BROWSER !== "1", "Requires the isolated combined-provider server with synthetic Entra client configuration");
test("combined provider availability and Microsoft OIDC authorization keep working", async ({ page, request }) => {
  const providers = await (await request.get("/api/auth/providers")).json();
  expect(Object.keys(providers).sort()).toEqual(["ldap", "local", "microsoft-entra-id"]);
  await page.goto("/login");
  await expect(page.getByLabel("Local username or email")).toBeVisible();
  await expect(page.getByLabel("Company username")).toBeHidden();
  await page.getByRole("button", { name: "Sign in with company username" }).click();
  await expect(page.getByLabel("Company username")).toBeVisible();
  // Auth.js uses the loopback discovery fixture. Intercept navigation before it reaches Microsoft.
  await page.route("https://login.microsoftonline.com/**/authorize?**", route => route.fulfill({ contentType: "text/html", body: "<h1>Synthetic OIDC authorization destination</h1>" }));
  await page.getByRole("button", { name: "Continue with Microsoft" }).click();
  await expect(page).toHaveURL(/login\.microsoftonline\.com\/.*\/authorize/);
  const url = new URL(page.url());
  expect(url.searchParams.get("client_id")).toBe("00000000-0000-0000-0000-000000000001");
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBeTruthy();
  expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3102/api/auth/callback/microsoft-entra-id");
});
