import { SandboxdClient, SandboxError } from './client';
import { workspaceConfigState, workspaceSetupReport } from './setup';

/** Read-only sandboxd health check shared by the portal and the Node worker. */
export async function readWorkspaceSetup(allowRunc: Parameters<typeof workspaceSetupReport>[0]['allowRunc']) {
  const config = workspaceConfigState(process.env);
  if (config !== 'configured') return workspaceSetupReport({ config, allowRunc });
  try {
    // Fresh infrastructure config on each check; don't retain a cached not-configured client after an operator change.
    const client = new SandboxdClient({ url: process.env.SANDBOXD_URL!, secret: process.env.SANDBOXD_SECRET! });
    return workspaceSetupReport({ config, allowRunc, health: await client.health(15_000) });
  } catch (err) {
    return workspaceSetupReport({ config, allowRunc, errorCode: err instanceof SandboxError ? err.code : 'unreachable' });
  }
}
