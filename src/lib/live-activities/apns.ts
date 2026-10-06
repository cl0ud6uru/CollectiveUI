import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, type ClientHttp2Session } from "node:http2";
import { classifyResponse, pushToken, type ContentState, type DeliveryResult, payloadFor } from "./protocol";

export type APNsConfig = { teamId: string; keyId: string; bundleId: string; environment: "sandbox" | "production"; key: KeyObject };
/** Off by default. Credentials are supplied by an operator; never generated or persisted by the app. */
export function apnsConfig(): APNsConfig | null {
  if (process.env.LIVE_ACTIVITIES_ENABLED !== "true") return null;
  const teamId = process.env.APNS_TEAM_ID ?? "";
  const keyId = process.env.APNS_KEY_ID ?? "";
  const bundleId = process.env.APNS_BUNDLE_ID ?? "";
  const environment = process.env.APNS_ENVIRONMENT;
  if (!/^[A-Z0-9]{10}$/.test(teamId) || !/^[A-Z0-9]{10}$/.test(keyId) || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId)
    || !["sandbox", "production"].includes(environment ?? "") || !process.env.APNS_KEY_FILE) throw new Error("Live Activity APNs configuration is incomplete");
  try {
    const key = createPrivateKey(readFileSync(process.env.APNS_KEY_FILE));
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error();
    return { teamId, keyId, bundleId, environment: environment as APNsConfig["environment"], key };
  } catch { throw new Error("Live Activity APNs signing key is unavailable or invalid"); }
}

let cached: { config: APNsConfig; issued: number; jwt: string } | undefined;
export function providerToken(config: APNsConfig, now = Math.floor(Date.now() / 1000)) {
  if (cached?.config === config && now >= cached.issued && now - cached.issued < 3000) return cached.jwt;
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: config.keyId })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ iss: config.teamId, iat: now })).toString("base64url");
  const input = `${header}.${body}`;
  const signature = sign("sha256", Buffer.from(input), { key: config.key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  const jwt = `${input}.${signature}`;
  cached = { config, issued: now, jwt };
  return jwt;
}

/** Fixed Apple origins, HTTP/2, TLS verification on, bounded response/timeout. Errors never contain tokens or keys. */
export async function sendActivity(
  config: APNsConfig, token: string, state: ContentState, timestamp: number,
  dial: (origin: string) => ClientHttp2Session = connect,
): Promise<DeliveryResult> {
  if (!pushToken.safeParse(token).success) return "invalid-token";
  const payload = JSON.stringify(payloadFor(state, timestamp));
  if (Buffer.byteLength(payload) > 3000) return "configuration-error";
  return new Promise((resolve) => {
    let client: ClientHttp2Session;
    try { client = dial(config.environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com"); }
    catch { resolve("retry"); return; }
    let settled = false;
    const finish = (result: DeliveryResult) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); client.destroy(); resolve(result);
    };
    const timeout = setTimeout(() => finish("retry"), 8000);
    client.on("error", () => finish("retry"));
    try {
      const req = client.request({
        ":method": "POST", ":path": `/3/device/${token}`,
        authorization: `bearer ${providerToken(config)}`,
        "apns-topic": `${config.bundleId}.push-type.liveactivity`, "apns-push-type": "liveactivity",
        "apns-priority": "5", "apns-expiration": String(timestamp + 180),
      });
      let status = 0; let response = "";
      req.on("response", (headers) => { status = Number(headers[":status"]); });
      req.on("data", (data: Buffer) => { if (response.length + data.length > 2048) finish("configuration-error"); else response += data.toString(); });
      req.on("error", () => finish("retry"));
      req.on("end", () => {
        let reason = "";
        try { reason = JSON.parse(response).reason ?? ""; } catch { /* Never expose response text. */ }
        finish(classifyResponse(status, reason));
      });
      req.end(payload);
    } catch { finish("retry"); }
  });
}
