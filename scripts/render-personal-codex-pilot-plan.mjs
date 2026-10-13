// Pure renderer: prints reviewable argv/config; never calls Docker or a firewall.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const digest = value => createHash('sha256').update(value).digest('hex');
const proxySource = readFileSync(new URL('./personal-codex-egress-proxy.mjs', import.meta.url), 'utf8');
const denied = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3'];
function ipv4(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(value)) throw new Error('Invalid IPv4');
  const parts = value.split('.').map(Number); if (parts.some(v => v > 255)) throw new Error('Invalid IPv4');
  return parts.reduce((n, v) => n * 256 + v, 0);
}
const address = n => [24, 16, 8, 0].map(shift => (n >>> shift) & 255).join('.');
function subnet(value) {
  if (typeof value !== 'string' || !value.endsWith('/29')) throw new Error('Two operator-verified private /29 subnets required');
  const n = ipv4(value.slice(0, -3)); const a = n >>> 24; const b = (n >>> 16) & 255;
  if (n % 8 || !(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) throw new Error('Aligned RFC1918 /29 required');
  return n;
}
export function renderPilotPlan(input) {
  if (!input || Object.keys(input).sort().join(',') !== 'dnsIPv4,egressSubnet,hostIPv4,image,namespace,owner,uplinkSubnet') throw new Error('Exact input fields required');
  const { owner, namespace, image, hostIPv4, dnsIPv4 } = input;
  if (typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(owner) || !/^cui-codex-[a-z0-9-]{1,20}$/.test(namespace) ||
    !/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Verified owner, namespace and complete local image ID required');
  if (!Array.isArray(hostIPv4) || !hostIPv4.length) throw new Error('Read-only inventory of every VM IPv4 required');
  for (const ip of hostIPv4) ipv4(ip);
  if (!Array.isArray(dnsIPv4) || !dnsIPv4.length) throw new Error('Effective Docker upstream DNS IPv4 inventory required');
  for (const ip of dnsIPv4) { const n = ipv4(ip); if ((n >>> 24) === 127 || n === 0) throw new Error('Container-reachable DNS required'); }
  const egress = subnet(input.egressSubnet), uplink = subnet(input.uplinkSubnet);
  if (egress === uplink || hostIPv4.some(ip => [egress, uplink].some(n => ipv4(ip) >= n && ipv4(ip) < n + 8))) throw new Error('Subnets conflict');
  if (dnsIPv4.some(ip => hostIPv4.includes(ip) || [egress, uplink].some(n => ipv4(ip) >= n && ipv4(ip) < n + 8))) throw new Error('DNS requires separately reviewed host/internal-network access');
  const key = digest(owner), name = `${namespace}-${key}`, bridge = `cdx${key.slice(0, 9)}`, outside = `cdu${key.slice(0, 9)}`;
  const runtimeIP = address(egress + 2), proxyIP = address(egress + 3), uplinkIP = address(uplink + 2);
  const chain = `CDX_${key.slice(0, 12)}`;
  const labels = ['--label', `collective.codex.owner=${key}`, '--label', `collective.codex.namespace=${namespace}`];
  const docker = args => ['/usr/bin/docker', ...args];
  const iptables = args => ['/usr/sbin/iptables', '-w', ...args];
  const forward = [
    ['-i', bridge, '-o', bridge, '-s', runtimeIP, '-d', proxyIP, '-p', 'tcp', '--dport', '3128', '-m', 'conntrack', '--ctstate', 'NEW,ESTABLISHED', '-j', 'ACCEPT'],
    ['-i', bridge, '-o', bridge, '-s', proxyIP, '-d', runtimeIP, '-p', 'tcp', '--sport', '3128', '-m', 'conntrack', '--ctstate', 'ESTABLISHED', '-j', 'ACCEPT'],
    ['-i', bridge, '-j', 'DROP'], ['-o', bridge, '-j', 'DROP'],
    ...dnsIPv4.flatMap(ip => ['udp', 'tcp'].flatMap(protocol => [
      ['-i', outside, '-s', uplinkIP, '-d', ip, '-p', protocol, '--dport', '53', '-m', 'conntrack', '--ctstate', 'NEW,ESTABLISHED', '-j', 'ACCEPT'],
      ['-o', outside, '-s', ip, '-d', uplinkIP, '-p', protocol, '--sport', '53', '-m', 'conntrack', '--ctstate', 'ESTABLISHED', '-j', 'ACCEPT'],
    ])),
    ...[...denied, ...hostIPv4.map(ip => `${ip}/32`)].map(cidr => ['-i', outside, '-s', uplinkIP, '-d', cidr, '-j', 'DROP']),
    ['-i', outside, '-s', uplinkIP, '-p', 'tcp', '--dport', '443', '-m', 'conntrack', '--ctstate', 'NEW,ESTABLISHED', '-j', 'ACCEPT'],
    ['-o', outside, '-d', uplinkIP, '-p', 'tcp', '--sport', '443', '-m', 'conntrack', '--ctstate', 'ESTABLISHED', '-j', 'ACCEPT'],
    ['-i', outside, '-j', 'DROP'], ['-o', outside, '-j', 'DROP'], ['-j', 'RETURN'],
  ];
  return {
    appliesChanges: false, requiresActionTimeApproval: true,
    imageIdentity: { kind: 'docker-local-config-id', id: image, registryManifestVerified: false },
    proxy: { sha256: digest(proxySource), allowedConnect: ['auth.openai.com:443', 'chatgpt.com:443'], sniMustMatch: true, runtimeIP, proxyIP, uplinkIP },
    brokerConfig: { socketPath: '/run/collective-codex/broker.sock', image, namespace, owners: [owner], sandboxProfile: 'collectiveui-sandbox-v1', dockerExecutable: '/usr/bin/docker', memoryMb: 2048, cpus: 2 },
    prerequisites: ['Operator verified both /29s unused against all Docker pools, host/VPN/LAN routes; supplied every VM IPv4 and current effective Docker upstream DNS.',
      'Docker uses iptables backend, DOCKER-USER is reached, bridge netfilter is active; review existing rule order before insertion.',
      'Exact owner and email reconciliation separately approved; exact trusted broker artifact, UID/GID and IPC mounts reviewed.',
      'Create/install firewall while both containers are stopped; inspect exact image ID, mounts, endpoints/IPs and rules before starting.',
      'No other endpoint may join either network. Persist only these reviewed owner-scoped rules; never change global policy.'],
    networkCreate: [
      docker(['network', 'create', '--driver', 'bridge', '--internal', '--subnet', input.egressSubnet, '--gateway', address(egress + 1),
        '--aux-address', `reserved4=${address(egress + 4)}`, '--aux-address', `reserved5=${address(egress + 5)}`, '--aux-address', `reserved6=${address(egress + 6)}`,
        '--opt', `com.docker.network.bridge.name=${bridge}`, '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', '--opt', 'com.docker.network.bridge.enable_icc=false', ...labels, `${name}-egress`]),
      docker(['network', 'create', '--driver', 'bridge', '--subnet', input.uplinkSubnet, '--gateway', address(uplink + 1),
        '--opt', `com.docker.network.bridge.name=${outside}`, '--opt', 'com.docker.network.bridge.enable_icc=false', ...labels, `${name}-uplink`]),
    ],
    proxyCreate: docker(['create', '--pull=never', '--name', `${name}-proxy`, '--user', '10001:10001', '--read-only', '--cap-drop=ALL',
      '--security-opt', 'no-new-privileges=true', '--network', `${name}-uplink`, '--ip', uplinkIP, '--memory', '128m', '--memory-swap', '128m',
      '--cpus', '.5', '--pids-limit', '64', '--log-driver', 'none', '--restart', 'no', ...labels, '--label', 'collective.codex.egress-proxy=true',
      '--label', `collective.codex.proxy-source-sha256=${digest(proxySource)}`, ...dnsIPv4.flatMap(ip => ['--dns', ip]), '--env', `CODEX_PROXY_LISTEN_IP=${proxyIP}`,
      '--env', `CODEX_PROXY_CLIENT_IP=${runtimeIP}`, image, 'node', '--input-type=module', '-e', `${proxySource}\nstartProxy();`]),
    proxyConnect: docker(['network', 'connect', '--ip', proxyIP, '--alias', 'codex-egress', `${name}-egress`, `${name}-proxy`]),
    firewallInstall: [iptables(['-N', chain]), ...forward.map(rule => iptables(['-A', chain, ...rule])),
      iptables(['-I', 'DOCKER-USER', '1', '-j', chain]), iptables(['-I', 'INPUT', '1', '-i', bridge, '-j', 'DROP']), iptables(['-I', 'INPUT', '1', '-i', outside, '-j', 'DROP'])],
    firewallRemove: [iptables(['-D', 'DOCKER-USER', '-j', chain]), iptables(['-D', 'INPUT', '-i', bridge, '-j', 'DROP']),
      iptables(['-D', 'INPUT', '-i', outside, '-j', 'DROP']), iptables(['-F', chain]), iptables(['-X', chain])],
    startAfterInspection: docker(['start', `${name}-proxy`]),
    rollback: ['Stop work and revoke/disconnect native grant; disable caller admission and web/worker IPC; stop broker/runtime/proxy.',
      'Remove only generated owner rules and networks with no users; retain owner home/workspace and backups. Never prune shared resources.'],
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${JSON.stringify(renderPilotPlan(JSON.parse(readFileSync(0, 'utf8'))), null, 2)}\n`); }
  catch { console.error('Plan input rejected. No changes applied.'); process.exitCode = 1; }
}
