import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DockerBroker } from '@/docker-hermes/broker';
import { DockerDriver, BrokerConfig } from '@/docker-hermes/docker';
import type { NetworkMigration, NetworkMode } from '@/docker-hermes/network';
const exec=promisify(execFile),PIN='nousresearch/hermes-agent@sha256:2fd023efbb8d3d2b0ce1a73d028b07370cff34f567cfe0e999553e8c327ea283';
const suite=process.env.DOCKER_HERMES_NETWORK_TEST==='1'?describe:describe.skip;
class Driver extends DockerDriver {
  fail=false; missingBackup=false;
  protected async command(args:string[],timeout?:number){
    const result=await super.command(args,timeout);
    // Docker Desktop reports the same host bind with its VM /host_mnt prefix. Production validation stays strict.
    if(process.platform==='darwin' && args[0]==='inspect'){const rows=JSON.parse(result);for(const row of rows)for(const mount of row.Mounts??[])if(mount.Source===`/host_mnt${this.config.bridgePath}`)mount.Source=this.config.bridgePath;return JSON.stringify(rows);}
    return result;
  }
  async changeNetwork(owner:string,m:NetworkMigration,current:()=>void){const id=await super.changeNetwork(owner,m,current);if(this.missingBackup){await super.command(['container','rm',m.originalId!]);throw new Error('Injected missing retained backup');}if(this.fail)throw new Error('Injected post-start verification failure');return id;}
}
suite('actual pinned Docker network migration, no account or inference',()=>{
 let root:string,broker:DockerBroker,driver:Driver,lease:NodeJS.Timeout;const owners=['network-alice','network-bob'];
 beforeAll(async()=>{root=await mkdtemp(path.join(tmpdir(),'dh-network-real-'));for(const d of ['state','ipc'])await mkdir(path.join(root,d),{mode:0o700});
  driver=new Driver(BrokerConfig.parse({stateDir:path.join(root,'state'),socketPath:path.join(root,'ipc/b.sock'),bridgePath:path.resolve('src/docker-hermes/bridge.py'),namespace:`cui-net-${Date.now()}`,image:PIN,network:'none'}));
  broker=new DockerBroker(driver.config,driver);
  // App controller handshake is synthetic; native container/profile filesystem and replacement are actual.
  broker.controller=async()=>({} as Awaited<ReturnType<DockerBroker['controller']>>);
  lease=setInterval(()=>owners.forEach(o=>broker.authorize(o,true)),15000);
 });
 afterAll(async()=>{clearInterval(lease);await broker?.close().catch(()=>{});if(driver)for(const owner of owners){await exec('docker',['rm','-f',driver.name(owner)]).catch(()=>{});await exec('docker',['volume','rm',`${driver.name(owner)}-data`]).catch(()=>{});await exec('docker',['network','rm',`${driver.name(owner)}-internet`]).catch(()=>{});}if(root)await rm(root,{recursive:true,force:true});});
 const enable=async(owner:string)=>{broker.authorize(owner,true);broker.enable(owner);const end=Date.now()+120000;for(;;){const s=await broker.status(owner);if(s.phase==='ready')return;if(s.phase==='error')throw new Error(s.error!);if(Date.now()>end)throw new Error('Native setup timeout');await new Promise(r=>setTimeout(r,250));}};
 const change=async(mode:NetworkMode)=>{const status=await broker.networkStatus(owners[0]);broker.requestNetwork(owners[0],{mode,revision:status.revision,requestId:randomUUID(),confirmRestart:true},'test-admin');return broker.settleNetwork(owners[0]);};
 const native=async(code:string)=>JSON.parse((await exec('docker',['exec','--user','10000:10000',driver.name(owners[0]),'/opt/hermes/.venv/bin/python','-c',code])).stdout);
 it('replaces offline with a dedicated Internet bridge and retains all profile identities, app bindings and native data',async()=>{
  await enable(owners[0]);await enable(owners[1]);const before=await broker.status(owners[0]);
  await native("from pathlib import Path\nimport json,contextlib,sys\nfrom hermes_cli.profiles import create_profile\nwith contextlib.redirect_stdout(sys.stderr): create_profile('external',no_alias=True)\nPath('/opt/data/network-test-retained.txt').write_text('retained-native-data')\nprint(json.dumps(True))");
  const profiles=await driver.profiles(owners[0]);const result=await change('internet');expect(result).toMatchObject({mode:'internet',actual:'internet',running:true,receipt:{state:'committed'}});
  expect(await driver.profiles(owners[0])).toEqual(profiles);expect((await broker.status(owners[0])).bindings).toEqual(before.bindings);
  expect(await native("from pathlib import Path\nimport json\nprint(json.dumps(Path('/opt/data/network-test-retained.txt').read_text()))")).toBe('retained-native-data');
  const [a]=JSON.parse((await exec('docker',['inspect',driver.name(owners[0])])).stdout),[b]=JSON.parse((await exec('docker',['inspect',driver.name(owners[1])])).stdout);
  expect(a.HostConfig.NetworkMode).toBe(`${driver.name(owners[0])}-internet`);expect(Object.keys(a.NetworkSettings.Networks)).toEqual([a.HostConfig.NetworkMode]);expect(a.HostConfig.PortBindings).toEqual({});expect(b.HostConfig.NetworkMode).toBe('none');
  const [network]=JSON.parse((await exec('docker',['network','inspect',a.HostConfig.NetworkMode])).stdout);expect(network.Internal).toBe(false);expect(network.EnableIPv6).toBe(false);expect(Object.keys(network.Containers)).toEqual([a.Id]);
  const code=await driver.connectivity(owners[0],'openai-api');expect(code).toBe('reachable');
 },240000);
 it('rolls back a failed replacement to the exact original container with its native data, stopped',async()=>{
  const before=JSON.parse((await exec('docker',['inspect',driver.name(owners[0])])).stdout)[0],profiles=await driver.profiles(owners[0]);driver.fail=true;
  expect(await change('none')).toMatchObject({mode:'internet',actual:'internet',running:false,receipt:{state:'rolled_back'}});driver.fail=false;
  const after=JSON.parse((await exec('docker',['inspect',driver.name(owners[0])])).stdout)[0];expect(after.Id).toBe(before.Id);expect(after.Mounts.find((m:{Destination:string})=>m.Destination==='/opt/data').Name).toBe(before.Mounts.find((m:{Destination:string})=>m.Destination==='/opt/data').Name);
  await enable(owners[0]);expect(await driver.profiles(owners[0])).toEqual(profiles);
 },120000);
 it('reads stopped native storage without starting it, then applies offline while preserving its complete roster',async()=>{
  const profiles=await driver.profiles(owners[0]);await broker.stop(owners[0]);const result=await change('none');expect(result).toMatchObject({mode:'none',actual:'none',running:false,receipt:{state:'committed'}});
  await enable(owners[0]);expect(await driver.profiles(owners[0])).toEqual(profiles);expect(await driver.connectivity(owners[0],'openai-api')).toBe('offline');
 },120000);
 it('stops the identifiable replacement even when its original backup was removed unexpectedly',async()=>{
  driver.missingBackup=true;const result=await change('internet');expect(result.receipt?.state).toBe('failed');
  const [current]=JSON.parse((await exec('docker',['inspect',driver.name(owners[0])])).stdout);expect(current.State.Running).toBe(false);
  expect(current.Mounts.some((m:{Name:string})=>m.Name===`${driver.name(owners[0])}-data`)).toBe(true);
 },120000);

});
