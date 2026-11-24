import { DefaultChatTransport } from 'ai';
import type { PortalUIMessage } from './store';

/** Resume starts a fresh streamed assistant response without inventing an optimistic user message. */
export class AppActionChatTransport extends DefaultChatTransport<PortalUIMessage> {
  override reconnectToStream(options: Parameters<DefaultChatTransport<PortalUIMessage>['reconnectToStream']>[0]) {
    if (options.body && 'appAction' in options.body) return this.sendMessages({ ...options, trigger: 'submit-message', messages: [], messageId: undefined, abortSignal: options.abortSignal });
    return super.reconnectToStream(options);
  }
}
