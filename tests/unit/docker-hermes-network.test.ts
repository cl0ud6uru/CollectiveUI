import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { DockerBroker } from '@/docker-hermes/broker';
import { BrokerConfig, runtimeKey, type RuntimeDriver, type Profile } from '@/docker-hermes/docker';
import { loadBrokerConfig, cleanupRetainedBroker } from '@/docker-hermes/main';
import type { NetworkMode, NetworkMigration } from '@/docker-hermes/network';
const id = (v: string) => createHash('sha256').update(v).digest('hex');
const until = async (fn: () => Promise<boolean>) => { for (let i=0;i<200;i++) { if (await fn()) return; await new Promise(r=>setTimeout(r,5)); } throw new Error('Timed out'); };
/** Explicitly synthetic lifecycle. Durable journals, admission and crash recovery are real. */
class Driver implements RuntimeDriver {
  modes = new Map<string, NetworkMode>(); active = new Set<string>(); ids = new Map<string,string>();
  roster = new Map<string, Profile[]>(); backup = new Map<string,string>();
  gate?: Promise<void>; failure = false; changes = 0; finishes = 0; probes = 0;
  setNetwork(owner: string, mode: NetworkMode) { this.modes.set(owner,mode); }
  async networkStatus(owner: string) { return {actual:this.ids.has(owner)?this.modes.get(owner)!:'absent' as const,running:this.active.has(owner)}; }
  async ensure(owner: string) { this.ids.set(owner,this.ids.get(owner)??id(owner));this.roster.set(owner,this.roster.get(owner)??[{name:'default',identity:id(owner+'profile')},{name:'unlinked',identity:id(owner+'unlinked')}]);this.active.add(owner); }
  async running(owner: string) { return this.active.has(owner); }
  async stop(owner: string) { this.active.delete(owner); }
  async profiles(owner: string) { return this.roster.get(owner)??[]; }
  async snapshotNetwork(owner: string) { return {originalId:this.ids.get(owner)??null,profiles:structuredClone(await this.profiles(owner))}; }
  async changeNetwork(owner: string,m:NetworkMigration,current:()=>void) {
    this.changes++; expect(this.active.has(owner)).toBe(false); this.backup.set(owner,this.ids.get(owner)!);
    this.setNetwork(owner,m.requested);this.ids.set(owner,id(m.requestId));this.active.add(owner);
    await this.gate;current();if(this.failure)throw new Error('Injected verification failure');return this.ids.get(owner)!;
  }
  async stopNetwork(owner:string) {this.active.delete(owner);}
  async finishNetwork(owner:string,m:NetworkMigration) { this.finishes++;expect(m.state).toBe('committed');this.backup.delete(owner); }
  async rollbackNetwork(owner:string,m:NetworkMigration) {this.active.delete(owner);this.setNetwork(owner,m.previous);if(this.backup.has(owner)){this.ids.set(owner,this.backup.get(owner)!);this.backup.delete(owner);}}
  async create(): Promise<Profile> { throw new Error('Not used'); }
  async resources() { return {skills:[],memories:[]}; }
  transport(): ReturnType<RuntimeDriver['transport']> { throw new Error('No native process in this fixture'); }
  async settings() {return {revision:id('settings'),provider:'openai-api' as const,model:'fixture-model',reasoningEffort:'' as const,maxTurns:null,advancedSupported:true,editableProviders:{'openai-api':true},credentials:{'openai-api':false,anthropic:false,openrouter:false,'openai-codex':false}};}
  async connectivity() {this.probes++;return 'reachable' as const;}
}
let root:string, config:BrokerConfig, driver:Driver, broker:DockerBroker;
beforeEach(async()=>{root=await mkdtemp(path.join(tmpdir(),'dh-network-'));await mkdir(path.join(root,'state'),{mode:0o700});await mkdir(path.join(root,'ipc'),{mode:0o700});
 config=BrokerConfig.parse({stateDir:path.join(root,'state'),socketPath:path.join(root,'ipc/b.sock'),bridgePath:path.resolve('src/docker-hermes/bridge.py'),namespace:'cui-network',image:`nousresearch/hermes-agent@sha256:${'a'.repeat(64)}`,network:'none'});
 driver=new Driver();broker=new DockerBroker(config,driver);broker.controller=vi.fn(async()=>({} as Awaited<ReturnType<DockerBroker['controller']>>));});
afterEach(async()=>{await broker.close();await rm(root,{recursive:true,force:true});});
const enable=async(owner='alice')=>{broker.authorize(owner,true);broker.enable(owner);await until(async()=>(await broker.status(owner)).phase==='ready');};
const request=(mode:NetworkMode,revision=0)=>({mode,revision,requestId:randomUUID(),confirmRestart:true as const});
const settled=()=>until(async()=>!(await broker.networkStatus('alice')).changing);
describe('per-owner network transitions',()=>{
 it('defaults fresh installs to Internet while omitted legacy config inherits its pinned offline deployment',async()=>{
   expect(BrokerConfig.parse({...config,network:undefined}).network).toBe('internet');
   const file=path.join(root,'broker.json');const raw={...config};delete (raw as Partial<BrokerConfig>).network;await writeFile(file,JSON.stringify(raw));
   expect((await loadBrokerConfig(file)).network).toBe('none');
   expect(()=>new DockerBroker({...config,network:'internet'},driver)).toThrow('configuration changed');
 });
 it('saves policy without provisioning a disabled owner and retries one durable request once',async()=>{
   broker.authorize('alice',false);const input=request('internet');broker.requestNetwork('alice',input,'admin');await settled();broker.requestNetwork('alice',input,'admin');
   expect(await broker.networkStatus('alice')).toMatchObject({mode:'internet',actual:'absent',revision:1,receipt:{state:'committed'}});expect(driver.changes).toBe(0);
   expect(()=>broker.requestNetwork('alice',{...input,mode:'none'},'admin')).toThrow('different details');
   expect(()=>broker.requestNetwork('alice',request('none',0),'admin')).toThrow('changed');
 });
 it('isolates owners and retains all bindings, full native roster and the original stored online policy',async()=>{
   await enable();await enable('bob');const before=await broker.status('alice'),roster=structuredClone(await driver.profiles('alice'));
   broker.requestNetwork('alice',request('proxy'),'admin');await settled();expect(driver.finishes).toBe(1);
   expect(await broker.status('alice')).toMatchObject({network:'proxy',phase:'ready',bindings:before.bindings});expect(await driver.profiles('alice')).toEqual(roster);
   expect(await broker.status('bob')).toMatchObject({network:'none',phase:'ready'});
   broker.requestNetwork('alice',request('none',1),'admin');await settled();expect(await broker.networkStatus('alice')).toMatchObject({mode:'none',onlineMode:'proxy',revision:2});
   const projected=JSON.stringify(await broker.networkStatus('alice'));expect(projected).not.toContain('unlinked');expect(projected).not.toContain('originalId');
 });
 it('keeps a stopped runtime stopped and never changes profile identity',async()=>{
   await enable();await broker.stop('alice');const original=await driver.profiles('alice');broker.requestNetwork('alice',request('internet'),'admin');await settled();
   expect(await broker.status('alice')).toMatchObject({phase:'stopped',network:'internet'});expect(driver.active.has('alice')).toBe(false);expect(await driver.profiles('alice')).toEqual(original);
 });
 it('rolls back verification failure with the old policy and no automatic restart',async()=>{
   await enable();const original=driver.ids.get('alice');driver.failure=true;broker.requestNetwork('alice',request('internet'),'admin');await settled();
   expect(await broker.networkStatus('alice')).toMatchObject({mode:'none',revision:0,receipt:{state:'rolled_back'}});expect(driver.ids.get('alice')).toBe(original);expect(driver.active.has('alice')).toBe(false);expect(driver.finishes).toBe(0);
 });
 it('fences new admissions immediately and cancellation stops replacement before commit',async()=>{
   await enable();const binding=(await broker.status('alice')).bindings[0];let release!:()=>void;driver.gate=new Promise(r=>{release=r;});
   broker.requestNetwork('alice',request('internet'),'admin');await until(async()=>driver.changes===1);
   await expect(broker.resources('alice',binding.bindingId)).rejects.toThrow('maintenance');expect(()=>broker.enable('alice')).toThrow('network change');
   expect(broker.requestRevoke('alice')).toMatchObject({stopped:false});release();await settled();await until(async()=>(await broker.status('alice')).phase==='stopped');
   expect(await broker.networkStatus('alice')).toMatchObject({mode:'none',revision:0,receipt:{state:'rolled_back'}});expect(driver.active.has('alice')).toBe(false);
 });
 it('recovers pending/applied crash residue before admission, stopping both retained identities',async()=>{
   await enable();const snapshot=await driver.snapshotNetwork('alice'),input=request('internet');await driver.stop('alice');
   const file=path.join(config.stateDir,runtimeKey('alice'),'runtime.json'),state=JSON.parse(await readFile(file,'utf8'));
   const m={requestId:input.requestId,revision:0,previous:'none',requested:'internet',actor:'admin',checkedAt:new Date().toISOString(),wasRunning:true,state:'applied',...snapshot,replacementId:id(input.requestId),snapshotReady:true};
   state.networks={[input.requestId]:m};state.network='internet';await writeFile(file,JSON.stringify(state));
   driver.backup.set('alice',snapshot.originalId!);driver.ids.set('alice',id(input.requestId));driver.active.add('alice');
   broker=new DockerBroker(config,driver);await broker.recoverNetworks();expect(driver.ids.get('alice')).toBe(snapshot.originalId);expect(driver.active.has('alice')).toBe(false);
   expect(await broker.networkStatus('alice')).toMatchObject({mode:'none',receipt:{state:'rolled_back'}});
 });
 it('supervisor cleanup recovers a pending target before ordinary current-policy stop',async()=>{
   await enable();const snapshot=await driver.snapshotNetwork('alice'),input=request('internet');await driver.stop('alice');
   const file=path.join(config.stateDir,runtimeKey('alice'),'runtime.json'),state=JSON.parse(await readFile(file,'utf8'));
   const m={requestId:input.requestId,revision:0,previous:'none',requested:'internet',actor:'admin',checkedAt:new Date().toISOString(),wasRunning:true,state:'pending',...snapshot,replacementId:null,snapshotReady:true};
   state.networks={[input.requestId]:m};await writeFile(file,JSON.stringify(state));driver.backup.set('alice',snapshot.originalId!);driver.ids.set('alice',id(input.requestId));driver.active.add('alice');
   const stop=driver.stop.bind(driver);driver.stop=async owner=>{if(driver.ids.get(owner)===id(input.requestId))throw new Error('Current policy mismatch');return stop(owner);};
   await cleanupRetainedBroker(config,driver);expect(driver.ids.get('alice')).toBe(snapshot.originalId);expect(driver.active.has('alice')).toBe(false);
 });
 it('stops the exact committed replacement even if retained-backup cleanup fails',async()=>{
   await enable();broker.requestNetwork('alice',request('internet'),'admin');await settled();driver.active.add('alice');
   driver.finishNetwork=async()=>{throw new Error('Backup removal failed');};
   const stopped=vi.spyOn(driver,'stopNetwork');broker=new DockerBroker(config,driver);
   await expect(broker.recoverNetworks()).rejects.toThrow('cleanup');expect(stopped).toHaveBeenCalled();expect(driver.active.has('alice')).toBe(false);
   expect(await broker.networkStatus('alice')).toMatchObject({mode:'internet',receipt:{state:'committed'}});
   driver.finishNetwork=async()=>{};
 });
 it('stops every retained owner before surfacing the first committed cleanup failure',async()=>{
   await enable();await enable('bob');broker.requestNetwork('alice',request('internet'),'admin');await settled();
   driver.finishNetwork=async()=>{throw new Error('First owner cleanup failed');};driver.active.add('alice');driver.active.add('bob');
   broker=new DockerBroker(config,driver);await expect(broker.recoverNetworks()).rejects.toThrow('cleanup');
   expect(driver.active.size).toBe(0);expect(await broker.networkStatus('alice')).toMatchObject({receipt:{state:'committed'}});
   driver.finishNetwork=async()=>{};
 });
 it('checks saved provider TLS without inference and caches only its current settings revision',async()=>{
   await enable();const b=(await broker.status('alice')).bindings[0],input={revision:id('settings')};
   expect(await broker.checkConnectivity('alice',b.bindingId,input)).toMatchObject({code:'offline'});expect(driver.probes).toBe(0);
   broker.requestNetwork('alice',request('internet'),'admin');await settled();
   expect(await broker.checkConnectivity('alice',b.bindingId,input)).toMatchObject({code:'reachable'});await broker.checkConnectivity('alice',b.bindingId,input);expect(driver.probes).toBe(1);
   await expect(broker.checkConnectivity('bob',b.bindingId,input)).rejects.toThrow();await expect(broker.checkConnectivity('alice',b.bindingId,{revision:id('stale')})).rejects.toThrow('changed');
 });
});
