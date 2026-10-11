import path from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { expect, it } from "vitest";

// Chat eagerly loads the AI SDK while VoiceAvatar dynamically loads AvatarLayers.
// Exercise the bundled modules: direct Node imports don't catch deferred Zod init.
it.each([false, true])("initializes chat and lazy avatar schemas (minify=%s)", async minify => {
  const root = path.resolve(import.meta.dirname, "../..");
  const result = await build({
    absWorkingDir: root,
    stdin: {
      contents: `
        import { DefaultChatTransport } from "ai";
        import { VoiceBridge } from "@/lib/voice/bridge";
        globalThis.transport = new DefaultChatTransport();
        globalThis.bridge = VoiceBridge;
        globalThis.avatarReady = import("@/lib/voice/avatar-layers").then(({ AvatarLayers }) => typeof AvatarLayers);
      `,
      resolveDir: root,
      loader: "ts",
    },
    bundle: true, write: false, platform: "browser", format: "iife", minify,
    alias: { "@": path.join(root, "src") },
  });
  const context = {
    TransformStream, TextDecoder, TextEncoder, URL,
    transport: undefined as unknown,
    bridge: undefined as unknown,
    avatarReady: undefined as Promise<string> | undefined,
  };
  runInNewContext(result.outputFiles[0].text, context);
  expect(context.transport).toBeDefined();
  expect(context.bridge).toBeTypeOf("function");
  await expect(context.avatarReady).resolves.toBe("function");
});
