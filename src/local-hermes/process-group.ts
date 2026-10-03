import { readFile, readdir } from "node:fs/promises";

/** Linux /proc lets us distinguish live group members from already-dead zombies awaiting PID 1. */
export async function groupHasLiveMembers(groupId: number) {
  for (const pid of (await readdir("/proc")).filter(p => /^\d+$/.test(p))) {
    try {
      const raw = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === groupId && fields[0] !== "Z" && fields[0] !== "X") return true;
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error; // ownership visibility is required to declare Stop complete
    }
  }
  return false;
}
const signal = (group: number, sig: NodeJS.Signals) => {
  try { process.kill(-group, sig); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
};
/** Only called with the process group created by our own detached spawn, never a PID from disk or HTTP. */
export async function stopOwnedGroup(group: number) {
  signal(group, "SIGTERM");
  const deadline = Date.now() + 3000;
  while (await groupHasLiveMembers(group)) {
    if (Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, 50));
  }
  if (!(await groupHasLiveMembers(group))) return;
  signal(group, "SIGKILL");
  const killedDeadline = Date.now() + 2000;
  while (await groupHasLiveMembers(group)) {
    if (Date.now() >= killedDeadline) throw new Error("Owned Hermes processes did not exit. Profile ownership remains locked; operator reconciliation is required.");
    await new Promise(r => setTimeout(r, 50));
  }
}
