// Disposable UI fixture backend. Production authorization is covered separately by mcp-apps.test.ts.
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { createMcpAppSandbox } from '../../../scripts/mcp-app-sandbox.mjs';
import { ticketDraftMarkup, ticketDraftResult } from './ticket-draft.mjs';

const host = 'http://127.0.0.1:3197', sandboxUrl = 'http://127.0.0.1:3198/sandbox';
const bundle = async entry => (await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"test"' }, tsconfig: 'tsconfig.json' })).outputFiles[0].text;
const [hostJS, appJS, ticketJS] = await Promise.all([bundle('tests/fixtures/mcp-apps/host.tsx'), bundle('tests/fixtures/mcp-apps/standard.ts'), bundle('tests/fixtures/mcp-apps/ticket-draft.ts')]);
const markup = '<h2>Synthetic rows</h2><form><label>Filter <input name="filter"></label><button>Apply filter</button></form><table><thead><tr><th>Label</th></tr></thead><tbody></tbody></table><button id="save">Save row</button><button id="fail">Fail tool</button><button id="network">Check network</button><p id="status">Starting</p><p id="private"></p><p id="isolation"></p>';
const legacyJS = `
  function render(){document.querySelector('tbody').innerHTML=''; for(const r of window.openai.toolOutput?.rows??[]){const tr=document.createElement('tr'),td=document.createElement('td');td.textContent=r.label;tr.append(td);document.querySelector('tbody').append(tr)}document.getElementById('private').textContent=window.openai.toolResponseMetadata?.privateMarker??'';document.getElementById('status').textContent='Ready'}
  window.addEventListener('openai:set_globals',render);render();
  document.querySelector('form').onsubmit=async(e)=>{e.preventDefault();const r=await window.openai.callTool('refresh',{filter:document.querySelector('input').value});window.openai.toolOutput=r.structuredContent;render();document.getElementById('status').textContent='Filtered'};
  document.getElementById('save').onclick=async()=>{document.getElementById('status').textContent='Waiting';try{await window.openai.callTool('save',{label:'Synthetic row'});document.getElementById('status').textContent='Saved'}catch{document.getElementById('status').textContent='Denied'}};
  document.getElementById('fail').onclick=async()=>{try{await window.openai.openExternal({href:'https://example.invalid'});}catch{document.getElementById('status').textContent='Unsupported'}};
`;
const result = { content: [{ type: 'text', text: 'Synthetic result' }], structuredContent: { rows: [{ label: 'Alpha' }, { label: 'Beta' }] }, _meta: { privateMarker: 'SYNTHETIC_BROWSER_COMPONENT_ONLY' } };
let actions = new Map(), calls = [], compatibility = false, revoked = false, loadError = false, ticket = false;
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const app = createServer(async (req, res) => {
  if (req.url === '/__control' && req.method === 'POST') {
    const input = JSON.parse(await new Response(req).text());
    if (input.reset) { actions = new Map(); calls = []; revoked = false; loadError = false; compatibility = input.compatibility ?? false; ticket = input.ticket ?? false; }
    if (input.revoke) revoked = true; if (input.loadError) loadError = true;
    return json(res, { calls, actions: [...actions.values()] });
  }
  if (req.url === '/__stats') return json(res, { calls, actions: [...actions.values()] });
  if (req.url?.startsWith('/api/mcp-apps/')) {
    if (revoked || loadError) return json(res, { error: revoked ? 'Widget permissions revoked.' : 'Synthetic resource is unavailable.' }, 403);
    if (req.method === 'GET') return json(res, { view: { html: `<!doctype html><style>body{font:16px system-ui;padding:16px}td,th{text-align:left;padding:6px}button,input,select{margin:8px;padding:6px}</style>${ticket ? ticketDraftMarkup : markup}<script>${(ticket ? ticketJS : compatibility ? legacyJS : appJS).replaceAll('</script', '<\\/script')}</script>`,
      resourceHash: 'synthetic-pinned-html', input: {}, result: ticket ? ticketDraftResult : result, compatibility, sandboxUrl, title: ticket ? 'Synthetic ticket draft' : 'Synthetic table widget' }, actions: [...actions.values()] });
    const input = JSON.parse(await new Response(req).text());
    if (input.operation === 'call') {
      const action = { id: input.id, status: input.name === 'save' ? 'pending' : 'done', tool: input.name, input: input.arguments };
      if (action.status === 'done') {
        calls.push(action.tool); action.result = input.name === 'fail' ? { isError: true, content: [{ type: 'text', text: 'Synthetic error' }] } : { ...result, structuredContent: { rows: result.structuredContent.rows.filter(r => !input.arguments.filter || r.label.includes(input.arguments.filter)) } };
      }
      actions.set(action.id, action); return json(res, { action });
    }
    const action = actions.get(input.id);
    if (action.status === 'pending') { action.status = input.approve ? 'done' : 'denied'; if (input.approve) { calls.push(action.tool); action.result = result; } }
    return json(res, { action });
  }
  if (req.url === '/host.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(hostJS); return; }
  if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><style>body{font:16px system-ui;margin:24px}main{max-width:760px}iframe{width:100%;border:0}section{border:1px solid #ddd;border-radius:12px;overflow:hidden}section>div,section>p{padding:12px}button{padding:6px}pre{white-space:pre-wrap}</style><div id="fixture"></div><script src="/host.js"></script>'); return; }
  res.writeHead(404); res.end();
});
const sandbox = createMcpAppSandbox(host);
await Promise.all([new Promise(resolve => app.listen(3197, '127.0.0.1', resolve)), new Promise(resolve => sandbox.listen(3198, '127.0.0.1', resolve))]);
console.log('Synthetic MCP Apps browser fixture ready');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { app.close(); sandbox.close(); process.exit(0); });
