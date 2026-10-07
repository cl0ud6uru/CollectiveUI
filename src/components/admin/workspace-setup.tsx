"use client";

import { useState, useTransition } from "react";
import { checkWorkspaceSetup } from "@/app/admin/workspace-setup-actions";
import { Button } from "@/components/ui/button";
import type { WorkspaceSetupReport } from "@/lib/sandbox/setup";
import { Badge, Card } from "./ui";

const compose = "docker compose -f docker-compose.yml -f docker-compose.sandbox.yml";
const operatorSteps = [
  { title: "1. Prepare the Linux Docker host", text: "Use the CollectiveUI checkout on the Docker host. Install and verify gVisor using the operator guide, and plan storage monitoring. Keep one sandboxd per Docker daemon.", command: "npm run workspace:check" },
  { title: "2. Add the private connection settings", text: "Generate a shared secret locally and put it in a restricted .env as SANDBOXD_SECRET. Put the host socket group ID in DOCKER_GID. Keep SANDBOXD_RUNTIME=runsc. The Compose add-on supplies SANDBOXD_URL to web and worker. Never paste secret values into this page.", command: "openssl rand -base64 32\nstat -c '%g' /var/run/docker.sock" },
  { title: "3. Build and start the supported Compose add-on", text: "Review the merged configuration privately first. Only sandboxd receives the Docker socket; its control network is internal. Run the start command during an approved maintenance window: it may rebuild and recreate services. For custom deployments, use your actual Compose files and project/env options.", command: `npm run sandbox:image\n${compose} config --quiet\n${compose} up -d --build\n${compose} exec sandboxd node src/sandboxd/index.ts --check` },
  { title: "4. Check here, assign access, then test a bot", text: "Run the setup check below. When ready, choose selected groups/people in Settings, turn on workspaces, confirm the audience and save. All admins are included. Add Workspace tools to an eligible native bot, then ask it to run printf 'workspace ready\\n' and approve that command. Verify the output and a file write/read before expanding access. External Hermes uses a separate execution path." },
];

function Command({ value }: { value: string }) {
  const [message, setMessage] = useState("");
  return <div className="space-y-2">
    <pre className="overflow-x-auto rounded-xl bg-surface-2 p-3 font-mono text-xs whitespace-pre-wrap break-words">{value}</pre>
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" onClick={async () => {
        try { await navigator.clipboard.writeText(value); setMessage("Commands copied."); }
        catch { setMessage("Copy unavailable. Select the commands above and copy them manually."); }
      }}>Copy commands</Button>
      <span role="status" className="text-xs text-muted">{message}</span>
    </div>
  </div>;
}

export function WorkspaceSetup({ report, enabled, onChecked }: { report: WorkspaceSetupReport; enabled: boolean; onChecked: (report: WorkspaceSetupReport) => void }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  return <Card className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="space-y-1">
        <h2 className="font-medium">Workspace setup</h2>
        <div className="flex flex-wrap gap-2">
          <Badge tone={report.ready && !failure ? "green" : "amber"}>{report.ready && !failure ? "Service ready" : "Setup needed"}</Badge>
          <Badge tone={enabled ? "blue" : "default"}>{enabled ? "Access enabled" : "Access off"}</Badge>
        </div>
      </div>
      <Button variant="outline" aria-expanded={open} aria-controls="workspace-setup-steps" onClick={() => setOpen(!open)}>{open ? "Hide setup steps" : "Easy setup"}</Button>
    </div>
    <p className="text-sm text-muted">Set up native bot workspaces in four steps. Checking readiness does not enable access. A host operator runs the installation commands.</p>
    {open && <div id="workspace-setup-steps" className="space-y-5 border-t border-border pt-4">
      {operatorSteps.map(step => <section key={step.title} className="space-y-2">
        <h3 className="text-sm font-medium">{step.title}</h3>
        <p className="text-sm text-muted">{step.text}</p>
        {step.command && <Command value={step.command} />}
      </section>)}
      <a className="inline-block text-sm underline" href="https://github.com/cl0ud6uru/CollectiveUI/blob/main/docs/operations.md#workspaces-sandboxed-commands" target="_blank" rel="noreferrer">Open the workspace operator guide</a>
    </div>}
    <ul className="space-y-3 text-sm" aria-label="Workspace readiness checks">
      {report.checks.map(check => <li key={check.id} className="flex items-start gap-3">
        <span className="shrink-0"><Badge tone={check.state === "pass" ? "green" : check.state === "fail" ? "red" : "default"}>{check.state === "pass" ? "Passed" : check.state === "fail" ? "Action needed" : "Waiting"}</Badge></span>
        <div className="min-w-0"><p className="font-medium">{check.label}</p><p className="text-xs text-muted">{check.detail}</p></div>
      </li>)}
    </ul>
    {report.hasWarnings && <p className="text-sm text-warn">sandboxd reported host warnings. Review its local --check output before rollout; detailed daemon output stays on the host.</p>}
    <div className="flex flex-wrap items-center gap-3">
      <Button disabled={pending} onClick={() => start(async () => {
        setFailure(null); setChecked(false);
        try { onChecked(await checkWorkspaceSetup()); setChecked(true); }
        catch { setFailure("Could not complete the check. Confirm you are still an admin, then retry or reload the page."); }
      })}>{pending ? "Checking…" : checked || failure ? "Retry setup check" : "Run setup check"}</Button>
      <p role="status" aria-live="polite" className="text-xs text-muted">{pending ? "Checking the portal connection and service prerequisites…" : checked ? report.ready ? "Prerequisites passed. Access still follows the saved settings. Bot command and file tests are the next step." : "Check complete. Resolve the steps marked Action needed, then retry." : `Last checked ${new Date(report.checkedAt).toLocaleString()}`}</p>
    </div>
    {failure && <p role="alert" className="text-sm text-danger">{failure}</p>}
  </Card>;
}
