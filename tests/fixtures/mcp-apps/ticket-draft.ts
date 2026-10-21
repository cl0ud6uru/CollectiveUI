import { App } from '@modelcontextprotocol/ext-apps';
const app = new App({ name: 'Synthetic Ticket Tracker draft', version: '1.0.0' }, {}, { autoResize: true });
const field = (name: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${name}"]`)!;
const attachment = document.querySelector<HTMLInputElement>('[name="attachment"]')!;
const preview = () => { document.getElementById('preview')!.textContent = `${field('summary').value} · ${field('location').value} · ${field('scope').value} · attachment ${attachment.checked ? 'included' : 'excluded'}`; };
app.ontoolresult = result => {
  const draft = (result.structuredContent as { draft: Record<string, string | boolean> }).draft;
  for (const name of ['summary', 'description', 'reporter', 'location', 'scope']) field(name).value = String(draft[name]);
  attachment.checked = draft.attachment === true; preview();
  document.getElementById('private')!.textContent = String(result._meta?.privateMarker);
  document.getElementById('status')!.textContent = 'Draft ready';
};
document.querySelector('form')!.onsubmit = event => {
  event.preventDefault(); preview(); document.getElementById('status')!.textContent = 'Preview updated; no ticket submitted';
};
void app.connect();
