import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { enabled, newRef, run, startSandboxd } from "./harness";

const root = fileURLToPath(new URL("../..", import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, "docker/workspace-templates/manifest.json"), "utf8")) as {
  schemaVersion: number;
  profiles: Array<{
    key: string;
    templateSlug: string;
    name: string;
    imageRef: string | null;
    imageRefStatus: "build_required" | "recorded";
    baseImageRef: string;
    dockerfile: string;
    seedBundle: { key: string; root?: string; files: Array<{ path: string } | string> };
    networkPolicy: string;
    capabilities: Record<string, boolean>;
    sdk?: { packageVersion: string; sdkVersion: string; runtimeVersion: string; distribution: string };
  }>;
};

function profile(key: string) {
  const found = manifest.profiles.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`Missing workspace starter profile ${key}`);
  return found;
}

describe("reviewed workspace starter image definitions", () => {
  it("pins the Linux base and declares only the two reviewed, offline profiles", () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.profiles.map(({ key }) => key)).toEqual(["knowledge-work", "dotnet-linux"]);
    for (const item of manifest.profiles) {
      expect(item.imageRef === null || /^sha256:[a-f0-9]{64}$/.test(item.imageRef)).toBe(true);
      expect(item.imageRefStatus).toBe(item.imageRef === null ? "build_required" : "recorded");
      expect(item.baseImageRef).toMatch(/@sha256:[a-f0-9]{64}$/);
      expect(item.networkPolicy).toBe("none");
      expect(item.capabilities.agentBrowserView).toBe(false);
      expect(readFileSync(resolve(root, item.dockerfile), "utf8")).toMatch(/HEALTHCHECK/);
    }
    expect(profile("knowledge-work").name).toBe("Knowledge Work");
    expect(profile("knowledge-work").templateSlug).toBe("knowledge-work");
    expect(profile("knowledge-work").capabilities).toEqual({
      shell: true,
      officeHeadless: true,
      dotnet: false,
      agentBrowserView: false,
    });
    expect(profile("dotnet-linux").capabilities).toEqual({
      shell: true,
      officeHeadless: false,
      dotnet: true,
      agentBrowserView: false,
    });
  });

  it("keeps the .NET starter Linux-only, SDK-pinned and locked", () => {
    const dotnet = profile("dotnet-linux");
    expect(dotnet.sdk).toMatchObject({
      packageVersion: "10.0.112-1",
      sdkVersion: "10.0.112",
      runtimeVersion: "10.0.12",
      distribution: "Debian 12 bookworm",
    });
    const dockerfile = readFileSync(resolve(root, dotnet.dockerfile), "utf8");
    expect(dotnet.seedBundle.root).toBe("docker/workspace-templates/dotnet-linux/starter");
    const project = readFileSync(resolve(root, dotnet.seedBundle.root!, "Starter.csproj"), "utf8");
    const source = readFileSync(resolve(root, dotnet.seedBundle.root!, "Program.cs"), "utf8");
    const lock = JSON.parse(readFileSync(resolve(root, dotnet.seedBundle.root!, "packages.lock.json"), "utf8")) as {
      dependencies: Record<string, Record<string, { resolved: string; contentHash: string }>>;
    };
    expect(dockerfile).toContain("DOTNET_SDK_PACKAGE_VERSION=10.0.112-1");
    expect(dockerfile).toContain("dotnet restore Starter.csproj --locked-mode");
    expect(dockerfile).toContain("dotnet build Starter.csproj --no-restore");
    expect(dockerfile).toContain("--source https://api.nuget.org/v3/index.json");
    expect(project).toContain("<TargetFramework>net10.0</TargetFramework>");
    expect(project).not.toMatch(/net[1-9][0-9]?\d-windows|Microsoft\.NETFramework|net4\d/);
    expect(source).toContain("Newtonsoft.Json");
    expect(lock.dependencies["net10.0"]["Newtonsoft.Json"]).toMatchObject({
      resolved: "13.0.3",
      contentHash: "mbJSvHfRxfX3tR/U6n1WU+mWHXswYc+SB/hkOpx8yZZe68hNZGfymJu0cjsaJEkVzCMqePiU6LdIyogqfIn7kg==",
    });
  });

  it("reuses the existing Office helpers and initializes seeds without overwriting user files", () => {
    const knowledge = profile("knowledge-work");
    const dockerfile = readFileSync(resolve(root, knowledge.dockerfile), "utf8");
    expect(dockerfile).toContain("docker/sandbox/office-requirements.txt");
    expect(dockerfile).toContain("docker/sandbox/office-convert");
    expect(dockerfile).toContain("docker/sandbox/office-check");
    expect(dockerfile).toContain("USER 1000:1000");
    expect(dockerfile).toContain("cp -Rn /opt/workspace-template/starter/. /home/agent/workspace/");
    const dotnet = readFileSync(resolve(root, profile("dotnet-linux").dockerfile), "utf8");
    expect(dotnet).toContain("USER 1000:1000");
    expect(dotnet).toContain("cp -Rn /opt/workspace-template/starter/. /home/agent/workspace/");
    expect(dotnet).toContain("cp -Rn /opt/workspace-template/nuget/. /home/agent/.nuget/packages/");
  });
});

(enabled && profile("knowledge-work").imageRef ? describe : describe.skip)("Knowledge Work image in a read-only-rootfs sandbox", () => {
  it("runs Knowledge Work as uid 1000, converts Office files, and preserves edits across restart", async () => {
    const item = profile("knowledge-work");
    const h = await startSandboxd({
      SANDBOXD_IMAGE: item.imageRef!,
      SANDBOXD_MEMORY_MB: "2048",
      SANDBOXD_PIDS: "256",
      SANDBOXD_TMP_MB: "512",
      SANDBOXD_MAX_EXEC_SECONDS: "180",
    });
    try {
      const ref = newRef();
      const ready = await run(h, ref, "id -u; stat -c '%a:%u:%g' /opt/portal/office-convert; touch /tmp/template-writable; if touch /etc/template-readonly 2>/dev/null; then exit 91; fi; rm /tmp/template-writable; /opt/portal/office-check", { timeoutMs: 30_000 });
      expect(ready, ready.out + ready.err).toMatchObject({ code: 0, reason: "exited" });
      expect(ready.out).toContain("1000\n755:0:0\n");
      expect(ready.out).toContain('"ok": true');

      const source = readFileSync(resolve(root, "tests/fixtures/office-files.py"));
      await h.client.writeFile(ref, { isolation: "any", path: "office-files.py", contentB64: source.toString("base64") });
      const converted = await run(h, ref, "/opt/office/bin/python /home/agent/workspace/office-files.py", { timeoutMs: 150_000 });
      expect(converted, converted.out + converted.err).toMatchObject({ code: 0, reason: "exited" });
      expect(converted.out).toContain('"originals_preserved": true');

      const edit = Buffer.from("user-edited README\n").toString("base64");
      await h.client.writeFile(ref, { isolation: "any", path: "README.md", contentB64: edit });
      await h.client.stop(ref);
      await h.client.start(ref, "any");
      const persisted = await h.client.readFile(ref, { isolation: "any", path: "README.md", maxBytes: 1024 });
      expect(persisted?.bytes.toString()).toBe("user-edited README\n");
    } finally {
      await h.close();
    }
  });

});

(enabled && profile("dotnet-linux").imageRef ? describe : describe.skip)(".NET Linux image in a read-only-rootfs sandbox", () => {
  it("builds and runs the locked .NET starter offline from a fresh persistent home", async () => {
    const item = profile("dotnet-linux");
    const h = await startSandboxd({
      SANDBOXD_IMAGE: item.imageRef!,
      SANDBOXD_MEMORY_MB: "2048",
      SANDBOXD_PIDS: "256",
      SANDBOXD_TMP_MB: "512",
      SANDBOXD_MAX_EXEC_SECONDS: "180",
    });
    try {
      const ref = newRef();
      const ready = await run(h, ref, "id -u; stat -c '%a:%u:%g' /opt/portal/run-agent; touch /tmp/template-writable; if touch /etc/template-readonly 2>/dev/null; then exit 91; fi; rm /tmp/template-writable; dotnet --version; test -s Starter.csproj; test -s packages.lock.json", { timeoutMs: 30_000 });
      expect(ready, ready.out + ready.err).toMatchObject({ code: 0, reason: "exited" });
      expect(ready.out).toContain("1000\n755:0:0\n10.0.112\n");
      for (const path of ["Starter.csproj", "Program.cs", "packages.lock.json"]) {
        expect(await h.client.readFile(ref, { isolation: "any", path, maxBytes: 16 * 1024 })).not.toBeNull();
      }

      const built = await run(h, ref, "dotnet build Starter.csproj --no-restore --configuration Release", { timeoutMs: 150_000 });
      expect(built, built.out + built.err).toMatchObject({ code: 0, reason: "exited" });
      const executed = await run(h, ref, "dotnet run --project Starter.csproj --no-restore --configuration Release --no-build", { timeoutMs: 90_000 });
      expect(executed, executed.out + executed.err).toMatchObject({ code: 0, reason: "exited" });
      expect(executed.out).toContain('"targetFramework":"net10.0"');
      expect(executed.out).toContain('"package":"13.0.0.0"');

      const scratch = Buffer.from("persisted across restart\n").toString("base64");
      await h.client.writeFile(ref, { isolation: "any", path: "restart-check.txt", contentB64: scratch });
      await h.client.stop(ref);
      await h.client.start(ref, "any");
      const persisted = await h.client.readFile(ref, { isolation: "any", path: "restart-check.txt", maxBytes: 1024 });
      expect(persisted?.bytes.toString()).toBe("persisted across restart\n");
      const rerun = await run(h, ref, "dotnet run --project Starter.csproj --no-restore --configuration Release --no-build", { timeoutMs: 90_000 });
      expect(rerun, rerun.out + rerun.err).toMatchObject({ code: 0, reason: "exited" });
      expect(rerun.out).toContain('"targetFramework":"net10.0"');
    } finally {
      await h.close();
    }
  });

});

(enabled ? describe : describe.skip)("workspace image admission errors", () => {
  it("reports an absent pinned image without creating a sandbox", async () => {
    const h = await startSandboxd({ SANDBOXD_IMAGE: "collectiveui/workspace-template-missing:never-built" });
    try {
      await expect(h.client.start(newRef(), "any")).rejects.toMatchObject({ code: "image_missing" });
    } finally {
      await h.close();
    }
  });
});
