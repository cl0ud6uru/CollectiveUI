import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { GATEWAY_BOOTSTRAP, NATIVE_SETTLEMENT_INSTALL } from '@/local-hermes/gateway-bootstrap';

function probe(caseCode: string, rejectIsolation = false) {
  // Isolated modules model the pinned API without loading real credentials/native storage.
  const fixture = String.raw`
import sys, types, threading, json
bootstrap = types.ModuleType("hermes_bootstrap")
bootstrap.harden_import_path = lambda: None
sys.modules["hermes_bootstrap"] = bootstrap
server = types.ModuleType("tui_gateway.server")
server._methods = {}
server._sessions = {"owned-session": {"history_lock": threading.Lock(), "running": False}}
server._session_uses_compute_host = lambda session: False
server._turn_isolation_enabled = lambda: sys.argv[2] == "isolated"
def open_requests(sid):
    with server._sessions[sid]["history_lock"]:
        return []
server._open_requests = open_requests
server._ok = lambda rid, result: {"jsonrpc": "2.0", "id": rid, "result": result}
server._err = lambda rid, code, message: {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}
gateway = types.ModuleType("tui_gateway")
gateway.server = server
sys.modules["tui_gateway"] = gateway
sys.modules["tui_gateway.server"] = server
retirement = types.SimpleNamespace(count=1)
retirement.active_count = lambda: retirement.count
module = types.ModuleType("hermes_cli.backend_retirement")
module.retirement = retirement
sys.modules["hermes_cli.backend_retirement"] = module
exec(json.loads(sys.argv[1]))
method = server._methods["collective.session.settled"]
params = {"session_id": "owned-session"}
`;
  const result = spawnSync('python3', ['-B', '-c', `${fixture}\n${caseCode}`, JSON.stringify(NATIVE_SETTLEMENT_INSTALL), rejectIsolation ? "isolated" : "inline"], { encoding: 'utf8', timeout: 5000 });
  if (rejectIsolation) {
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Controller requires in-process native turn execution');
    return result.stdout;
  }
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}
describe('pinned native controller worker settlement proof', () => {
  it('registers only the fixed extension before launching the official gateway', () => {
    expect(GATEWAY_BOOTSTRAP).toContain('runpy.run_module("tui_gateway.entry", run_name="__main__")');
    expect(probe('print(json.dumps(list(server._methods)))')).toEqual(['collective.session.settled']);
  });
  it('refuses process isolation before starting the native gateway', () => {
    expect(probe('print("must not reach gateway entry")', true)).toBe('');
  });
  it('does not settle the idle-looking post-complete worker before followups unwind', () => {
    const results = probe(String.raw`
results = []
retirement.count = 2  # observer + original worker; running=False before its followup
results.append(method(1, params)["result"]["settled"])
server._sessions["owned-session"]["running"] = True
retirement.count = 3  # observer + original + successor; parent has not exited yet
results.append(method(2, params)["result"]["settled"])
retirement.count = 2  # observer + successor
results.append(method(3, params)["result"]["settled"])
server._sessions["owned-session"]["running"] = False
retirement.count = 2  # successor completed text, still in cleanup
results.append(method(4, params)["result"]["settled"])
retirement.count = 1  # all native worker scopes have unwound
results.append(method(5, params)["result"]["settled"])
print(json.dumps(results))`);
    expect(results).toEqual([false, false, false, false, true]);
  });
  it.each(['running', 'queued_prompt', 'queued_prompts', '_closing', '_finalized'])('blocks settlement with %s pending', field => {
    expect(probe(`server._sessions["owned-session"][${JSON.stringify(field)}] = True\nprint(json.dumps(method(1, params)["result"]["settled"]))`)).toBe(false);
  });
  it('blocks human requests, other RPC reservations, missing observer scope and compute-host isolation', () => {
    expect(probe(String.raw`
results=[]
server._open_requests = lambda sid: [{"id": "pending"}]
results.append(method(1, params)["result"]["settled"])
server._open_requests = lambda sid: []
retirement.count=2
results.append(method(1, params)["result"]["settled"])
retirement.count=0
results.append(method(1, params)["result"]["settled"])
retirement.count=1
server._session_uses_compute_host = lambda session: True
results.append(method(1, params)["result"]["settled"])
print(json.dumps(results))`)).toEqual([false, false, false, false]);
  });
  it('fails closed without exposing unreadable ledgers or private exception text', () => {
    expect(probe(String.raw`
def fail(sid): raise RuntimeError("synthetic-private-value")
server._open_requests = fail
print(json.dumps(method(1, params)))`)).toEqual({jsonrpc:'2.0',id:1,result:{session_id:'owned-session',settled:false}});
  });
  it('requires a live known session and rejects additional fields/path identities', () => {
    expect(probe(String.raw`
print(json.dumps([
method(1, {"session_id":"unknown"})["result"]["settled"],
"error" in method(2,{"session_id":"../escape"}),
"error" in method(3,{"session_id":"owned-session","value":"synthetic-secret"})
]))`)).toEqual([false,true,true]);
  });
});
