import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MacProtectedStore } from '../src/chatgpt-companion/storage';
import { runCompanion, exactOrigin } from '../src/chatgpt-companion/client';
import { z } from 'zod';

async function main() {
  if (process.platform !== 'darwin') throw new Error();
  const helper = process.env.CUI_COMPANION_HELPER!, config = process.env.CUI_COMPANION_CONFIG!;
  if (!helper || !config) throw new Error();
  const approvedOrigins = z.array(z.string().transform(exactOrigin)).min(1).max(8).parse(JSON.parse(await readFile(config, 'utf8')));
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 8192) throw new Error(); chunks.push(Buffer.from(chunk)); }
  const { launch } = z.object({ launch: z.string().max(8192) }).strict().parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const root = join(homedir(), 'Library', 'Application Support', 'CollectiveUI ChatGPT');
  const globalStore = new MacProtectedStore(helper, root); const stores = [globalStore];
  try {
    await runCompanion(launch, { approvedOrigins, globalStore, attemptStore: id => {
      // Descriptor-relative helper creates only this direct child of the protected global root.
      const store = new MacProtectedStore(helper, join(root, id)); stores.push(store); return store;
    }, confirm: async (origin, email) => await globalStore.request('confirm', { origin, email }) === true,
    openBrowser: async url => {
      const parsed = new URL(url); if (parsed.origin !== 'https://auth.openai.com' || parsed.pathname !== '/api/accounts/authorize' || parsed.username || parsed.password || parsed.hash) throw new Error();
      await globalStore.request('open', { url });
    }, returnToApp: async url => {
      const parsed = new URL(url); if (!approvedOrigins.includes(parsed.origin) || parsed.pathname !== '/settings' || parsed.search !== '?tab=connected-accounts' || parsed.hash) throw new Error();
      await globalStore.request('open', { url });
    } });
  } finally { for (const store of stores) store.close(); }
}
main().catch(() => { process.exitCode = 1; });
