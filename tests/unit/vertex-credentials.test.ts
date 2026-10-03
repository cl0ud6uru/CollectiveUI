import { describe, expect, it, vi } from "vitest";

const captured: Record<string, unknown>[] = [];
vi.mock("@ai-sdk/google-vertex/anthropic", () => ({
  createGoogleVertexAnthropic: (opts: Record<string, unknown>) => {
    captured.push(opts);
    return () => ({ specificationVersion: "v4" });
  },
}));

import { vertexAnthropic } from "@/lib/llm/providers/vertex-anthropic";

describe("Vertex AI credentials", () => {
  it("passes explicit service account credentials and project/location (never ADC)", async () => {
    await vertexAnthropic.create({
      appId: "v",
      appName: "V",
      kind: "vertex-anthropic",
      baseUrl: null,
      config: { project: "my-proj-1", location: "europe-west1", reasoning: false, promptCaching: true },
      secret: { type: "service-account", clientEmail: "sa@x.iam.gserviceaccount.com", privateKey: "-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n" },
    });
    const opts = captured.at(-1)!;
    expect(opts.project).toBe("my-proj-1");
    expect(opts.location).toBe("europe-west1");
    expect(opts.baseURL).toBeUndefined();
    expect((opts.googleAuthOptions as { credentials: object }).credentials).toEqual({
      type: "service_account",
      client_email: "sa@x.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n",
    });
  });
});
