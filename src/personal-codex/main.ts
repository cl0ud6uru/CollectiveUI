import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { PersonalCodexBrokerConfig, PersonalCodexDriver } from './docker';
import { SbxPersonalCodexDriver } from './sbx';
import { startPersonalBroker } from './server';

async function main() {
  const path = process.env.PERSONAL_CODEX_BROKER_CONFIG;
  if (!path || !isAbsolute(path)) throw new Error('An absolute operator-installed PERSONAL_CODEX_BROKER_CONFIG is required.');
  const config = PersonalCodexBrokerConfig.parse(JSON.parse(await readFile(path, 'utf8')));
  const driver = config.backend === 'sbx' ? new SbxPersonalCodexDriver(config) : new PersonalCodexDriver(config);
  const broker = await startPersonalBroker(driver);
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    setTimeout(() => process.exit(0), 5000).unref();
    void broker.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
// Never print config, rejected inputs, native output or exception objects.
main().catch(() => { console.error('Personal Codex broker could not start. Check the protected configuration and socket.'); process.exitCode = 1; });
