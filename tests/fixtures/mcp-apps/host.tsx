import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { McpAppHost } from '../../../src/components/chat/mcp-app-host';
import { appInstanceIds } from '../../../src/lib/mcp/apps-contract';
import { standsAlone, StepsGroup } from '../../../src/components/chat/steps';

function TranscriptFixture() {
  const [live, setLive] = useState(true);
  const widget = { type: 'dynamic-tool' as const, toolName: 'ticket_tracker__draft_ticket',
    toolCallId: 'draft', state: 'output-available' as const, input: {}, output: { _mcpApp: 'syntheticInstance1' } };
  const delegated = { ...widget, toolName: 'ask_ticket_bot', output: { taskId: 'syntheticTask', apps: ['syntheticInstance1'] } };
  const shown = location.hash === '#delegated' ? delegated : widget;
  const lookup = { ...widget, toolCallId: 'lookup', toolName: 'ticket_tracker__lookup_users', output: {} };
  return <>
    <button onClick={() => setLive(false)}>Finish bot reply</button>
    <StepsGroup parts={[lookup]} live={live} timed={false} renderStep={() => <p>Looked up reporter</p>} />
    {standsAlone(shown) ? appInstanceIds(shown.output).map(id => <McpAppHost key={id} id={id} />) :
      <StepsGroup parts={[widget]} live={live} timed={false} renderStep={() => <McpAppHost id="syntheticInstance1" />} />}
    {!live && <p>Please review the ticket draft.</p>}
  </>;
}
document.body.innerHTML = '<h1>Synthetic MCP Apps harness</h1><main id="root"></main>';
createRoot(document.getElementById('root')!).render(['#transcript', '#delegated'].includes(location.hash) ?
  <TranscriptFixture /> : <McpAppHost id="syntheticInstance1" />);
