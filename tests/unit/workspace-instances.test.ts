import { describe, expect, it } from "vitest";
import { admitWorkspaceRecipe } from "@/lib/workspaces/instance-policy";
import { effectiveProfileLimits, getWorkspaceRuntimeProfile } from "@/sandboxd/profiles";
import type { WorkspaceRecipe } from "@/lib/workspaces/contracts";

const TEST_IMAGE_ID = `sha256:${"b".repeat(64)}`;
const installedProfiles = ["knowledge-work-v1", "dotnet-linux-v1"].map(key => ({ key, installed: true, imageId: TEST_IMAGE_ID }));
const admit = (input: unknown) => admitWorkspaceRecipe(input, installedProfiles);

const recipe = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  runtimeProfileKey: "knowledge-work-v1",
  seedBundleKey: "knowledge-work-v1",
  networkPolicy: "none",
  capabilities: { shell: true, officeHeadless: true, dotnet: false, agentBrowserView: false },
  ...over,
}) as WorkspaceRecipe;

describe("private workspace profile admission", () => {
  it("resolves only server-installed profile keys and checks recipe capabilities against the profile", () => {
    expect(admit(recipe()).profile.imageRef).toBe(TEST_IMAGE_ID);
    expect(() => admit(recipe({ runtimeProfileKey: "../../host" }))).toThrow(/invalid recipe/i);
    expect(() => admit(recipe({ runtimeProfileKey: "knowledge-work" }))).toThrow(/not installed/i);
    expect(() => admit(recipe({ runtimeProfileKey: "client-image" }))).toThrow(/not installed/i);
    expect(() => admit(recipe({ capabilities: { shell: true, officeHeadless: true, dotnet: true, agentBrowserView: false } }))).toThrow(/capability/i);
    expect(() => admit(recipe({ seedBundleKey: "knowledge-work" }))).toThrow(/starter bundle/i);
    expect(admit(recipe({
      runtimeProfileKey: "dotnet-linux-v1",
      seedBundleKey: "dotnet-linux-v1",
      capabilities: { shell: true, officeHeadless: false, dotnet: true, agentBrowserView: false },
    })).profile.seedBundleKey).toBe("dotnet-linux-v1");
  });

  it("does not admit a build-required or digest-missing image", () => {
    expect(() => admitWorkspaceRecipe(recipe())).toThrow(/does not report an installed/i);
    expect(() => admitWorkspaceRecipe(recipe(), [{ key: "knowledge-work-v1", installed: false, imageId: TEST_IMAGE_ID }])).toThrow(/does not report an installed/i);
    expect(() => admitWorkspaceRecipe(recipe(), [{ key: "knowledge-work-v1", installed: true, imageId: "mutable:tag" }])).toThrow(/does not report an installed/i);
    expect(getWorkspaceRuntimeProfile("knowledge-work-v1")!.imageRef).toBeNull();
  });

  it("rejects recipe image, privilege, mount, and network injection fields", () => {
    expect(() => admit(recipe({ image: "attacker/image:latest" }))).toThrow(/invalid recipe/i);
    expect(() => admit(recipe({ privileged: true }))).toThrow(/invalid recipe/i);
    expect(() => admit(recipe({ mounts: ["/host"] }))).toThrow(/invalid recipe/i);
    expect(() => admit(recipe({ networkPolicy: "host" }))).toThrow(/invalid recipe/i);
  });

  it("lowers profile ceilings to daemon-configured limits and leaves legacy at daemon limits", () => {
    const daemon = { memoryMb: 4096, cpus: 8, pids: 2048, nofile: 8192, fsizeMb: 8192, tmpMb: 1024, shmMb: 128 };
    const profile = getWorkspaceRuntimeProfile("knowledge-work-v1")!;
    expect(effectiveProfileLimits(daemon, profile.maxLimits)).toEqual({
      memoryMb: 2048, cpus: 2, pids: 512, nofile: 4096, fsizeMb: 4096, tmpMb: 512, shmMb: 64,
    });
    expect(effectiveProfileLimits(daemon, getWorkspaceRuntimeProfile("legacy", "custom-legacy-image")!.maxLimits)).toEqual(daemon);
  });
});
