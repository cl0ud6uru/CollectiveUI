import { spawn } from 'node:child_process';
import { chmodSync } from 'node:fs';
// Do not log native stdout/stderr: account errors can contain sensitive material.
chmodSync('/codex-home', 0o700);
chmodSync('/home/agent/workspace', 0o700);
const child = spawn('codex', ['-c', 'projects={"/home/agent/workspace"={trust_level="untrusted"}}', '-c', 'notify=[]', '-c', 'features.hooks=false', '-c', 'features.shell_snapshot=false', '-c', 'features.memories=false', '-c', 'forced_login_method="chatgpt"', '-c', 'cli_auth_credentials_store="file"',
  '-c', 'web_search="disabled"', '-c', 'features.shell_tool=true', '-c', 'features.multi_agent=false',
  '-c', 'features.multi_agent_v2=false', '-c', 'features.plugins=false', '-c', 'features.plugin_hooks=false',
  '-c', 'features.enable_mcp_apps=false', '-c', 'features.image_generation=false',
  'app-server', '--listen', 'ws://127.0.0.1:4500'], { stdio: 'ignore' });
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
child.on('exit', code => process.exit(code ?? 1));
