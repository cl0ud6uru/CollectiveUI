#!/usr/bin/env node
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { resolve, dirname, relative, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { load } from "./storage.mjs";
import { auth } from "./auth.mjs";
import { discovery, models, probe } from "./http.mjs";
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const help = `Standalone ChatGPT plan-use spike (Node 22+)
Usage: node cli.mjs <auth|models|probe|discover> [options]
  --help                      Show this help; never starts auth
  --credential-file PATH      Outside checkout; default ~/.config/collectiveui-spike/account.json
  --model SLUG                Required for probe; select from models
  --port PORT                 auth loopback port (default available port)
  --ssh-target USER@HOST      Print optional SSH loopback tunnel guidance
Auth prints Continue with ChatGPT URL, does not open a browser, and waits up to 3 minutes.
Expired credentials require auth; automatic refresh is not implemented.
`;
async function outsideCheckout(file) {
  let path = resolve(file);
  let suffix = [];
  while (true) {
    try {
      path = join(await realpath(path), ...suffix);
      break;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      suffix.unshift(path.split("/").at(-1));
      const parent = dirname(path);
      if (parent === path) throw e;
      path = parent;
    }
  }
  const rel = relative(checkout, path);
  if (
    rel === "" ||
    (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      rel !== ".." &&
      !isAbsolute(rel))
  )
    throw Error("Credential file must be outside checkout");
  return path;
}
export async function main(args, deps = {}) {
  const out = deps.out ?? console.log;
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean" },
      "credential-file": { type: "string" },
      model: { type: "string" },
      port: { type: "string" },
      "ssh-target": { type: "string" },
    },
  });
  const { values: v, positionals: p } = parsed;
  if (v.help || p.length === 0) {
    out(help);
    return;
  }
  if (p.length !== 1 || !["auth", "models", "probe", "discover"].includes(p[0]))
    throw Error("Unknown command; use --help");
  const cmd = p[0];
  if (
    v["ssh-target"] &&
    !/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/.test(v["ssh-target"])
  )
    throw Error("Invalid SSH target");
  if (
    v.port !== undefined &&
    (!/^\d+$/.test(v.port) || Number(v.port) > 65535 || Number(v.port) < 1)
  )
    throw Error("Invalid --port");
  if ((v.port || v["ssh-target"]) && cmd !== "auth")
    throw Error("Auth-only option");
  if (v.model && cmd !== "probe") throw Error("--model only applies to probe");
  if (cmd === "discover") {
    const d = await (deps.discovery ?? discovery)();
    out(JSON.stringify({ issuer: d.issuer, jwks_uri: d.jwks_uri }, null, 2));
    return;
  }
  const file = await outsideCheckout(
    v["credential-file"] ??
      join(homedir(), ".config", "collectiveui-spike", "account.json"),
  );
  if (cmd === "auth") {
    await (deps.auth ?? auth)(file, {
      port: v.port ? Number(v.port) : 0,
      onReady: (a) => {
        out("Continue with ChatGPT (open this URL yourself):");
        out(a.url);
        if (v["ssh-target"])
          out(
            `On your browser machine: ssh -N -L ${new URL(a.redirect).port}:127.0.0.1:${new URL(a.redirect).port} ${JSON.stringify(v["ssh-target"])}`,
          );
      },
    });
    out("Validated account saved. Run models, then probe --model SLUG.");
    return;
  }
  const c = await (deps.load ?? load)(file);
  const list = await (deps.models ?? models)(c);
  if (cmd === "models") {
    out(JSON.stringify(list, null, 2));
    return;
  }
  if (!v.model) throw Error("probe requires --model from models");
  if (!list.some((m) => m.slug === v.model))
    throw Error("Model is not account-visible");
  out(await (deps.probe ?? probe)(c, v.model));
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((e) => {
    const safe =
      /^(Unknown command|Invalid --port|Auth-only option|--model only|Credential file must|probe requires|Model is not|ChatGPT plan permission|Credentials expired|Upstream HTTP|Upstream request|Unexpected discovery|Expected account-visible|Saved account belongs|Authorization attempt|Authorization denied|Authorization validation|Unsafe credential|Storage directory)/.test(
        e.message,
      );
    console.error(
      safe
        ? e.message
        : "Command failed safely; check arguments, local file permissions, or restart auth.",
    );
    process.exitCode = 1;
  });
}
