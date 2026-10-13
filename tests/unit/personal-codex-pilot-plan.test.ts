import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { renderPilotPlan } from '../../scripts/render-personal-codex-pilot-plan.mjs';
import { BrokerConfig } from '@/personal-codex/docker';

const input = { owner: 'synthetic-member', namespace: 'cui-codex-pilot', image: `sha256:${'a'.repeat(64)}`,
  egressSubnet: '172.30.240.0/29', uplinkSubnet: '172.30.240.8/29', hostIPv4: ['192.0.2.10'], dnsIPv4: ['9.9.9.9'] };
describe('operator pilot plan renderer', () => {
  it('produces a broker-compatible local image configuration and a mount-free exact proxy artifact', () => {
    const plan = renderPilotPlan(input);
    expect(BrokerConfig.parse(plan.brokerConfig).image).toBe(input.image);
    expect(plan.brokerConfig.owners).toEqual([input.owner]);
    const source = readFileSync('scripts/personal-codex-egress-proxy.mjs', 'utf8');
    expect(plan.proxy.sha256).toBe(createHash('sha256').update(source).digest('hex'));
    expect(plan.proxyCreate.at(-1)).toBe(`${source}\nstartProxy();`);
    expect(plan.proxyCreate).toContain(input.image);
    expect(plan.proxyCreate.some((v: string) => /^--(?:mount|volume|publish|privileged)/.test(v))).toBe(false);
    expect(plan.appliesChanges).toBe(false);
  });
  it('reserves all other IPAM addresses and emits only the own-proxy forwarding exception', () => {
    const plan = renderPilotPlan(input);
    expect(plan.proxy).toMatchObject({ runtimeIP: '172.30.240.2', proxyIP: '172.30.240.3', uplinkIP: '172.30.240.10' });
    expect(plan.networkCreate[0]).toContain('--internal');
    expect(plan.networkCreate[0]).toContain('com.docker.network.bridge.enable_icc=false');
    expect(plan.networkCreate[0]).toContain('reserved6=172.30.240.6');
    const rules = plan.firewallInstall;
    expect(rules.some((r: string[]) => r.includes('172.30.240.2') && r.includes('--dport') && r.includes('3128') && r.includes('NEW,ESTABLISHED'))).toBe(true);
    expect(rules.some((r: string[]) => r.includes('192.0.2.10/32') && r.includes('DROP'))).toBe(true);
    expect(rules.some((r: string[]) => r.includes('9.9.9.9') && r.includes('53'))).toBe(true);
    expect(rules.filter((r: string[]) => r.includes('ACCEPT')).every((r: string[]) => r.includes('-s') && r.includes('-d') || r.includes('443'))).toBe(true);
    expect(plan.firewallRemove.some((r: string[]) => r.includes('DOCKER-USER') && r.includes('-D'))).toBe(true);
  });
  it.each([
    { image: 'collectiveui/personal-codex:latest' }, { owner: 'member; exec bad' }, { namespace: '--privileged' },
    { egressSubnet: '172.30.240.1/29' }, { egressSubnet: '8.8.8.0/29' }, { uplinkSubnet: input.egressSubnet },
    { hostIPv4: [] }, { hostIPv4: ['172.30.240.2'] }, { dnsIPv4: [] }, { dnsIPv4: ['127.0.0.53'] }, { extra: true },
  ])('rejects invalid or conflicting input %j', change => { expect(() => renderPilotPlan({ ...input, ...change })).toThrow(); });
});
