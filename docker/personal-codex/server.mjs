import { spawn } from 'node:child_process';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { prepareWorkspace } from './prepare-workspace.mjs';
const TOKEN_SOCKET = '/codex-home/.collective-codex-siwc.sock';
const TOKEN_LIMIT = 17_000;
async function syncTokenFromStdin() {
  let input = ''; for await (const chunk of process.stdin) { input += chunk.toString(); if (input.length > TOKEN_LIMIT) process.exit(2); }
  await exchangeTokenRequest(input);
}
function exchangeTokenRequest(body) {
  return new Promise((resolve, reject) => {
    const socket = connect(TOKEN_SOCKET);
    let replied = false;
    socket.setTimeout(8000, () => socket.destroy(new Error('SIWC control request timed out')));
    socket.once('error', reject);
    socket.once('data', data => {
      replied = data.toString() === 'ok';
      socket.destroy();
      replied ? resolve() : reject(new Error('SIWC control request rejected'));
    });
    socket.once('connect', () => socket.end(body));
    socket.once('close', () => { if (!replied) reject(new Error('SIWC control socket closed without acknowledgement')); });
  });
}
if (process.argv.length === 3 && process.argv[2] === '--sync-token') { await syncTokenFromStdin().then(() => process.exit(0), () => process.exit(3)); }
if (process.argv.length === 3 && process.argv[2] === '--clear-token') {
  await exchangeTokenRequest(JSON.stringify({ clear: true }));
  process.exit(0);
}
const stdio = process.argv.length === 3 && process.argv[2] === '--stdio';
if (process.argv.length > (stdio ? 3 : 2)) process.exit(1);
// Do not log native stdout/stderr: account errors can contain sensitive material.
chmodSync('/codex-home', 0o700);
chmodSync('/home/agent/workspace', 0o700);
prepareWorkspace();
// The credential is held only in this supervisor's memory and the app-server child's environment.
let accessToken;
let child;
const startAppServer = () => {
  child = spawn('codex', ['-c', 'projects={"/home/agent/workspace"={trust_level="untrusted"}}', '-c', 'notify=[]', '-c', 'features.hooks=false', '-c', 'features.shell_snapshot=false', '-c', 'features.memories=false', '-c', 'cli_auth_credentials_store="file"',
  '-c', 'web_search="disabled"', '-c', 'features.shell_tool=true', '-c', 'features.multi_agent=false',
  '-c', 'features.multi_agent_v2=false', '-c', 'features.plugins=false', '-c', 'features.plugin_hooks=false',
  '-c', 'features.enable_mcp_apps=false', '-c', 'features.image_generation=false',
  '-c', 'model_provider="openai_chatgpt_plan"', '-c', 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
  '-c', 'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"', '-c', 'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
  '-c', 'model_providers.openai_chatgpt_plan.wire_api="responses"', '-c', 'model_providers.openai_chatgpt_plan.requires_openai_auth=false',
  '-c', 'model_providers.openai_chatgpt_plan.supports_websockets=false',
  '-c', 'shell_environment_policy.inherit="none"', '-c', 'shell_environment_policy.filters.ACCESS_TOKEN="exclude"',
  'app-server', '--listen', stdio ? 'stdio://' : 'ws://127.0.0.1:4500'], {
    stdio: stdio ? 'inherit' : 'ignore', env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME,
      HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY,
      ...(accessToken ? { ACCESS_TOKEN: accessToken } : {}) },
  });
  child.on('exit', code => { if (!restarting) process.exit(code ?? 1); });
};
let restarting = false;
const tokenServer = createServer({ allowHalfOpen: true }, socket => {
  let body = ''; socket.on('data', chunk => { body += chunk.toString(); if (body.length > TOKEN_LIMIT) socket.destroy(); });
  socket.on('end', () => {
    try {
      const payload = JSON.parse(body);
      if (payload.clear === true) accessToken = undefined;
      else {
        if (typeof payload.accessToken !== 'string' || payload.accessToken.length < 1 || payload.accessToken.length > 16_384 ||
            typeof payload.credentialBinding !== 'string' || payload.credentialBinding.length !== 64) throw new Error();
        accessToken = payload.accessToken;
      }
      restarting = true;
      const stopped = child;
      let replied = false;
      const finish = () => {
        if (replied) return;
        replied = true; clearTimeout(killTimer); clearTimeout(failTimer);
        startAppServer(); restarting = false; socket.end('ok');
      };
      stopped.once('exit', finish);
      const killTimer = setTimeout(() => stopped.kill('SIGKILL'), 4000);
      const failTimer = setTimeout(() => process.exit(4), 8000);
      stopped.kill('SIGTERM');
      if (stopped.exitCode !== null || stopped.signalCode !== null) finish();
    } catch { socket.destroy(); }
  });
});
if (stdio) startAppServer();
else {
  const stale = (() => { try { return lstatSync(TOKEN_SOCKET); } catch { return null; } })();
  if (stale) {
    if (!stale.isSocket() || stale.uid !== process.getuid()) process.exit(1);
    unlinkSync(TOKEN_SOCKET);
  }
  tokenServer.listen(TOKEN_SOCKET, () => { chmodSync(TOKEN_SOCKET, 0o600); startAppServer(); });
}
const stop = signal => { tokenServer.close(() => { try { unlinkSync(TOKEN_SOCKET); } catch {} }); child?.kill(signal); };
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
