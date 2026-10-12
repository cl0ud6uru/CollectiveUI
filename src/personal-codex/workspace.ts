import type { ResolvedWorkspace, WorkspaceCapabilities } from '@/lib/workspaces/contracts';

/** Same canonical runtime path as private template instances; credentials live on a different mount. */
export const PERSONAL_CODEX_WORKSPACE: ResolvedWorkspace['workspaceRoot'] = '/home/agent/workspace';
export const PERSONAL_CODEX_CAPABILITIES: WorkspaceCapabilities = {
  shell: true, officeHeadless: false, dotnet: false, agentBrowserView: false,
};
