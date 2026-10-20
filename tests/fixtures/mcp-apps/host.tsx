import React from 'react';
import { createRoot } from 'react-dom/client';
import { McpAppHost } from '../../../src/components/chat/mcp-app-host';

document.body.innerHTML = '<h1>Synthetic MCP Apps harness</h1><main id="root"></main>';
createRoot(document.getElementById('root')!).render(<McpAppHost id="syntheticInstance1" />);
