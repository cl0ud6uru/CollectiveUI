import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { McpAppHost } from '../../../src/components/chat/mcp-app-host';
import { standsAlone, StepsGroup } from '../../../src/components/chat/steps';

function TranscriptFixture() {
  const [live, setLive] = useState(true);
  const widget = { type: 'dynamic-tool' as const, toolName: 'ticket_tracker__draft_ticket',
    toolCallId: 'draft', state: 'output-available' as const, input: {}, output: { _mcpApp: 'syntheticInstance1' } };
  const lookup = { ...widget, toolCallId: 'lookup', toolName: 'ticket_tracker__lookup_users', output: {} };
  return <>
    <button onClick={() => setLive(false)}>Finish bot reply</button>
    <StepsGroup parts={[lookup]} live={live} timed={false} renderStep={() => <p>Looked up reporter</p>} />
    {standsAlone(widget) ? <McpAppHost id="syntheticInstance1" /> :
      <StepsGroup parts={[widget]} live={live} timed={false} renderStep={() => <McpAppHost id="syntheticInstance1" />} />}
    {!live && <p>Please review the ticket draft.</p>}
  </>;
}
document.body.innerHTML = '<h1>Synthetic MCP Apps harness</h1><main id="root"></main>';
createRoot(document.getElementById('root')!).render(location.hash === '#transcript' ?
  <TranscriptFixture /> : <McpAppHost id="syntheticInstance1" />);
