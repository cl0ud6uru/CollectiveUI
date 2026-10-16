import { App } from '@modelcontextprotocol/ext-apps';
const app = new App({ name: 'Synthetic forms and table', version: '1.0.0' }, {}, { autoResize: true });
const status = () => document.getElementById('status')!;
app.ontoolresult = result => {
  const rows = (result.structuredContent as { rows: { label: string }[] }).rows;
  document.querySelector('tbody')!.innerHTML = '';
  for (const row of rows) {
    const tr = document.createElement('tr'), td = document.createElement('td'); td.textContent = row.label; tr.append(td); document.querySelector('tbody')!.append(tr);
  }
  document.getElementById('private')!.textContent = String(result._meta?.privateMarker);
  status().textContent = 'Ready';
};
document.querySelector('form')!.addEventListener('submit', async e => {
  e.preventDefault(); status().textContent = 'Reading';
  const result = await app.callServerTool({ name: 'refresh', arguments: { filter: (document.querySelector('input') as HTMLInputElement).value } });
  app.ontoolresult?.(result); status().textContent = 'Filtered';
});
document.getElementById('save')!.onclick = async () => {
  status().textContent = 'Waiting';
  try { await app.callServerTool({ name: 'save', arguments: { label: 'Synthetic row' } }); status().textContent = 'Saved'; }
  catch { status().textContent = 'Denied'; }
};
document.getElementById('fail')!.onclick = async () => {
  const result = await app.callServerTool({ name: 'fail', arguments: {} }); status().textContent = result.isError ? 'Tool failed' : 'Unexpected';
};
document.getElementById('network')!.onclick = async () => {
  try { await fetch('https://example.invalid/private-leak'); status().textContent = 'Network allowed'; }
  catch { status().textContent = 'Network blocked'; }
};
try { window.parent.document.body.dataset.escape = 'bad'; document.getElementById('isolation')!.textContent = 'Isolation failed'; }
catch { document.getElementById('isolation')!.textContent = 'Isolated'; }
void app.connect();
