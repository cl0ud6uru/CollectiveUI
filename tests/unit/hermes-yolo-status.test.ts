import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionYoloStatus } from '@/components/chat/session-yolo-status';

it('shows verified ON and OFF as persistent non-dismissible session state', () => {
  for (const enabled of [true, false]) {
    const html = renderToStaticMarkup(createElement(SessionYoloStatus, { state: { available: true, enabled } }));
    expect(html).toContain(`YOLO ${enabled ? 'ON' : 'OFF'}`);
    expect(html).toContain('session only'); expect(html).toContain('last verified by Hermes');
    expect(html).not.toContain('button');
  }
});
it('never presents unavailable or unchecked status as OFF', () => {
  for (const state of [undefined, { available: false as const, reason: 'Bad identity' }]) {
    const html = renderToStaticMarkup(createElement(SessionYoloStatus, { state }));
    expect(html).toContain('YOLO unverified');
    expect(html).not.toContain('YOLO OFF'); expect(html).not.toContain('YOLO ON');
  }
});
