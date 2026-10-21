/** Dedicated loopback fixtures only; call before destructive queue or application queries. */
export function routineFixtureURL(kind: "admission" | "queue", env: Record<string, string | undefined> = process.env): string {
  const failure = () => new Error("Explicit routine proof opt-in and dedicated disposable loopback database required; connection overrides are forbidden");
  if (env[kind === "admission" ? "ROUTINE_ADMISSION_TEST" : "ROUTINE_QUEUE_TEST"] !== "1") throw failure();
  const raw = env.DATABASE_URL ?? "";
  let url: URL;
  try { url = new URL(raw); } catch { throw failure(); }
  const database = kind === "admission" ? "collective_review_routine_admission_test" : "collective_review_queue_test";
  const syntheticCredentials = (url.username === "routine_fixture" && url.password === "synthetic-fixture-only") ||
    (url.username === "fixture320" && url.password === "synthetic-review-only");
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1" || url.pathname !== `/${database}` ||
      !syntheticCredentials || !/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535 ||
      raw.includes("?") || raw.includes("#") || url.search || url.hash) throw failure();
  if (Object.keys(env).some(key => /^PG(?:HOST|HOSTADDR|PORT|DATABASE|USER|PASSWORD|OPTIONS|SERVICE|SERVICEFILE|SSLMODE|SSLROOTCERT|SSLCERT|SSLKEY|APPNAME|CONNECT_TIMEOUT|CLIENTENCODING)$/.test(key) && env[key])) throw failure();
  return url.href;
}
