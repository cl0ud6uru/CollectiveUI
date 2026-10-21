// Invented Ticket Tracker-style draft. No submit/create tool, credentials, remote API or external asset.
export const ticketDraftTool = {
  name: 'draft_ticket', title: 'Synthetic ticket draft',
  inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true },
  _meta: { ui: { resourceUri: 'ui://synthetic-ticket-tracker/draft' } },
};
export const ticketDraftResult = {
  content: [{ type: 'text', text: 'Synthetic draft widget ready. No ticket has been submitted.' }],
  structuredContent: { draft: { summary: 'Synthetic printer test', description: 'Invented test data only.', reporter: 'Fixture User (fixture@example.invalid)', location: 'Test office', scope: 'One test user', attachment: false } },
  _meta: { privateMarker: 'SYNTHETIC_TICKET_COMPONENT_ONLY' },
};
export const ticketDraftMarkup = '<h2>Synthetic Ticket Tracker draft</h2><p>Preview only. This fixture cannot submit tickets.</p><form><label>Summary <input name="summary"></label><label>Description <textarea name="description"></textarea></label><label>Reporter <input name="reporter" readonly></label><label>Work location <select name="location"><option>Test office</option><option>Test remote</option></select></label><label>Scope <select name="scope"><option>One test user</option><option>Test team</option></select></label><label><input name="attachment" type="checkbox"> Include synthetic attachment</label><button>Preview changes</button><button type="button" disabled>Create ticket (disabled in fixture)</button></form><p id="preview"></p><p id="status">Starting</p><p id="private"></p>';
