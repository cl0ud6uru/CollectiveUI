import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enabled, newRef, run, startSandboxd, type Harness } from "./harness";

/**
 * G4 (P5): what a command inside a sandbox can and can't reach. Runs under the runtime sandboxd picks
 * (SANDBOX_TEST_RUNTIME=runc|auto); assertions that differ between runc and gVisor are runtime-aware.
 */
const suite = enabled ? describe : describe.skip;

suite("sandbox isolation", () => {
  let h: Harness;
  let a: string;
  let b: string;
  let runtime: string | null;
  const sh = (ref: string, cmd: string, timeoutMs = 30_000) => run(h, ref, cmd, { timeoutMs });

  beforeAll(async () => {
    h = await startSandboxd();
    a = newRef();
    b = newRef();
    await sh(a, "true");
    await sh(b, "echo top-secret > secret-b.txt");
    runtime = (await h.client.state(a)).runtime;
  });
  afterAll(async () => {
    await h?.close();
  });

  it("runs as uid 1000 with no capabilities", async () => {
    const r = await sh(a, "id -u; id -g; grep -E '^(CapEff|CapPrm|CapBnd|NoNewPrivs|Seccomp):' /proc/self/status");
    const [uid, gid] = r.out.split("\n");
    expect([uid, gid]).toEqual(["1000", "1000"]);
    const field = (k: string) => new RegExp(`^${k}:\\s*(\\S+)`, "m").exec(r.out)?.[1];
    expect(parseInt(field("CapEff") ?? "x", 16)).toBe(0);
    expect(parseInt(field("CapPrm") ?? "x", 16)).toBe(0);
    if (runtime === "runc") {
      expect(field("NoNewPrivs")).toBe("1");
      expect(field("Seccomp")).toBe("2"); // Docker's default seccomp profile is active
    }
  });

  it("can only write to /tmp, /dev/shm and its home", async () => {
    const r = await sh(
      a,
      `for p in /usr/x /etc/x /opt/portal/x /x /var/x; do touch $p 2>/dev/null && echo "WROTE $p"; done
       for p in /tmp/x /dev/shm/x /home/agent/x /home/agent/workspace/x; do touch $p && echo "ok $p"; done
       stat -c '%u:%g' /home/agent /home/agent/workspace`,
    );
    expect(r.out).not.toContain("WROTE");
    expect(r.out).toContain("ok /tmp/x\nok /dev/shm/x\nok /home/agent/x\nok /home/agent/workspace/x");
    expect(r.out).toContain("1000:1000\n1000:1000");
  });

  it("can't touch the helpers, Docker, or the reserved Claude home", async () => {
    const r = await sh(
      a,
      `test -e /var/run/docker.sock && echo SOCKET; test -w /opt/portal/run-agent && echo HELPER_WRITABLE
       ls /home/claude 2>&1 | head -1; cat /proc/1/environ 2>/dev/null | tr '\\0' '\\n' | grep -i -E 'secret|token|key' || true`,
    );
    expect(r.out).not.toContain("SOCKET");
    expect(r.out).not.toContain("HELPER_WRITABLE");
    expect(r.out).toMatch(/Permission denied/);
  });

  it("has no network: only loopback, no DNS, no host, gateway, metadata or other services", async () => {
    const r = await sh(
      a,
      `tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '
       python3 - <<'PY'
import socket
for host, port in [("172.17.0.1", 3000), ("172.17.0.1", 5432), ("172.17.0.1", 4200), ("10.0.0.1", 80), ("169.254.169.254", 80), ("1.1.1.1", 443), ("127.0.0.1", 4200)]:
    s = socket.socket(); s.settimeout(2)
    try:
        s.connect((host, port)); print("REACHED", host, port)
    except OSError:
        pass
    finally:
        s.close()
try:
    socket.getaddrinfo("example.com", 443); print("DNS_WORKS")
except OSError:
    pass
PY`,
    );
    expect(r.out.split("\n")[0]).toBe("lo");
    expect(r.out.split("\n").filter((l) => /^[a-z0-9]+$/.test(l) && l !== "lo")).toEqual([]);
    expect(r.out).not.toContain("REACHED");
    expect(r.out).not.toContain("DNS_WORKS");
  });

  it("can't see another person's sandbox", async () => {
    const r = await sh(a, "find / -xdev -name secret-b.txt 2>/dev/null; ls /home; true");
    expect(r.out).not.toContain("secret-b.txt");
    expect((await sh(b, "cat secret-b.txt")).out).toBe("top-secret\n");
  });

  it("holds the file size limit", async () => {
    const r = await sh(a, "head -c 20000000 /dev/zero > big.bin; echo status=$?; stat -c %s big.bin; rm -f big.bin");
    expect(r.out).toMatch(/status=(1|153)/);
    expect(Number(r.out.trim().split("\n").at(-1))).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it("contains a fork bomb and a memory hog without affecting other sandboxes", async () => {
    const bomb = await sh(
      a,
      `python3 - <<'PY'
import os, time
n = 0
try:
    while n < 5000:
        if os.fork() == 0:
            time.sleep(5); os._exit(0)
        n += 1
except OSError as e:
    print("fork failed after", n, e.errno)
PY`,
      60_000,
    ).catch((e) => ({ out: String(e), reason: "error" }));
    if (runtime === "runc") expect(bomb.out).toMatch(/fork failed after \d+ 11/); // EAGAIN at the pids limit
    const hog = await sh(a, "python3 -c \"b = bytearray(1024 * 1024 * 1024); print('ALLOCATED')\"; echo exit=$?", 60_000).catch((e) => ({ out: String(e) }));
    expect(hog.out).not.toContain("ALLOCATED");
    // The other sandbox is unaffected, and the first one recovers (restarted if it died).
    expect((await sh(b, "echo alive")).out).toBe("alive\n");
    expect((await sh(a, "echo recovered")).out).toBe("recovered\n");
  });

  it("reports the isolation it runs under", async () => {
    const health = await h.client.health();
    expect(runtime).toBe(health.gvisor.available ? "runsc" : "runc");
    if (runtime === "runsc") expect((await sh(a, "uname -r")).out).toMatch(/gvisor/);
  });
});
