/** Native dashboard RPC, verified against Hermes f97608f and 6fa88c1. No Runs API slash forwarding. */
export type NativeCommand = { value: string; description: string; kind: 'native' | 'skill' | 'local'; available: boolean; reason?: string };
export type NativeCommandCatalog = { commands: NativeCommand[]; aliases: Record<string, string>; warning: string };
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown, max = 2000) => typeof v === 'string' ? v.slice(0, max) : '';
const token = /^\/[a-z][a-z0-9_-]*$/i;
// Bounded session controls. Profile administration, arbitrary exec/plugin commands and terminal UI stay outside this surface.
const supported = new Set(['/help', '/status', '/usage', '/version', '/tools', '/toolsets', '/skills', '/compress', '/title']);
const local: NativeCommand[] = [
  { value: '/commands', description: 'Browse commands supported in this remote chat', kind: 'local', available: true },
  { value: '/context', description: 'Inspect native context usage', kind: 'local', available: true },
  { value: '/stop', description: 'Interrupt this native turn', kind: 'local', available: true },
  { value: '/yolo', description: 'Inspect YOLO status or confirm session on/off when allowed', kind: 'local', available: true },
  { value: '/approvals', description: 'Inspect approval mode; answer pending prompts with Allow once or Deny', kind: 'local', available: true },
];
export function nativeCommandCatalog(raw: unknown): NativeCommandCatalog {
  const data = obj(raw), skills = obj(data.skills), canon = obj(data.canon);
  const commands = new Map(local.map(c => [c.value, c]));
  const unsafe = new Set<string>();
  for (const category of Array.isArray(data.categories) ? data.categories.slice(0, 200) : []) {
    const c = obj(category);
    if (['User commands', 'Plugin commands'].includes(str(c.name)))
      for (const p of Array.isArray(c.pairs) ? c.pairs : []) if (Array.isArray(p)) unsafe.add(str(p[0], 100).toLowerCase());
  }
  for (const pair of Array.isArray(data.pairs) ? data.pairs.slice(0, 1000) : []) {
    if (!Array.isArray(pair) || !token.test(str(pair[0], 100))) continue;
    const value = str(pair[0], 100).toLowerCase();
    if (commands.has(value)) continue;
    const skill = Object.hasOwn(skills, value);
    const available = !data.warning && !unsafe.has(value) && (supported.has(value) || skill);
    commands.set(value, { value, description: unsafe.has(value) ? 'Native user or plugin command' : str(pair[1], 500), kind: skill ? 'skill' : 'native', available,
      ...(!available ? { reason: data.warning ? 'Hermes command discovery is incomplete. Native execution is unavailable until discovery succeeds; check Hermes and refresh.'
        : 'Use native Hermes for this command. Remote chat exposes session controls and skill prefills; profile, shell and terminal controls are unavailable.' } : {}) });
  }
  const aliases: Record<string, string> = {};
  for (const [key, value] of Object.entries(canon).slice(0, 2000)) {
    if (token.test(key) && typeof value === 'string' && token.test(value) && !unsafe.has(key.toLowerCase()))
      aliases[key.toLowerCase()] = value.toLowerCase();
  }
  return { commands: [...commands.values()], aliases,
    warning: Array.isArray(data.pairs) ? (data.warning ? 'Hermes reported incomplete command discovery. Some skills may be missing; refresh after checking Hermes.' : '')
      : 'This Hermes version does not provide a compatible command catalog. Update Hermes to discover native commands. Local controls remain available.' };
}
export function parseNativeInput(text: string): { kind: 'text' | 'command' | 'shell'; text: string; name?: string; args?: string } {
  const trimmed = text.trim();
  if (trimmed.startsWith('//')) return { kind: 'text', text: trimmed.slice(1) };
  if (trimmed.startsWith('!')) return { kind: 'shell', text };
  const match = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  return match ? { kind: 'command', text: trimmed, name: `/${match[1].toLowerCase()}`, args: (match[2] ?? '').trim() } : { kind: 'text', text };
}
export function resolveNativeCommand(text: string, catalog: NativeCommandCatalog) {
  const parsed = parseNativeInput(text);
  if (parsed.kind !== 'command') throw new Error(parsed.kind === 'shell' ? '! is CLI shell syntax, not a remote Hermes command. Use /yolo to inspect approval status.' : 'Enter a whole leading /command. Use // to send literal slash text.');
  const name = catalog.aliases[parsed.name!] ?? parsed.name!;
  const entry = catalog.commands.find(c => c.value === name);
  if (!entry?.available) throw new Error(entry?.reason ?? 'This command is not advertised by a supported Hermes runtime. Refresh Commands & skills or update Hermes.');
  const args = parsed.args!;
  if (name === '/yolo' && args && !['status', 'on', 'off'].includes(args)) throw new Error('Use /yolo [status|on|off]. Session changes require a separate confirmation.');
  if (name === '/approvals' && args && args !== 'status')
    throw new Error('CollectiveUI does not change approval bypass or persistent approval policy. Use Allow once or Deny on the exact pending prompt.');
  if (entry.kind !== 'skill' && name !== '/title' && !['/yolo', '/approvals'].includes(name) && args)
    throw new Error(`${name} does not accept arguments in this remote chat.`);
  return { ...entry, args, command: `${name.slice(1)}${args ? ` ${args}` : ''}` };
}
/** Only display text is rendered. Inference directives become drafts for an explicit human send. */
export function nativeCommandResult(raw: unknown) {
  const r = obj(raw), type = str(r.type, 30);
  const output = [str(r.output, 64000), str(r.display, 64000), str(r.notice, 4000), str(r.warning, 4000)].filter(Boolean).join('\n');
  const prefill = type === 'alias' ? str(r.target, 64000) : ['send', 'skill', 'prefill'].includes(type) ? str(r.message, 64000) : '';
  return { type, output: output || (prefill ? 'Hermes prepared a draft. Review it and press Send to continue.' : 'Hermes command completed.'), ...(prefill ? { prefill } : {}) };
}
