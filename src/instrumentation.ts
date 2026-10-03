export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { warnAboutVendorEnv } = await import("@/lib/env-guard");
    warnAboutVendorEnv("web");
  }
}
