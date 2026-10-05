import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const run=(name,args)=>spawnSync(process.execPath,[fileURLToPath(new URL(`../${name}`,import.meta.url)),...args],{encoding:'utf8',env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR||'/home/hermes/.hermes/cache/scratch'},timeout:10000});
for(const name of ['probe-app-server.mjs','probe-responses-ws.mjs']){
 test(`${name} help is executable`,()=>{const r=run(name,['--help']);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/--fixture/);});
 test(`${name} refuses implicit live execution`,()=>{const r=run(name,[]);assert.notEqual(r.status,0);});
 test(`${name} fixture is runnable and labeled`,()=>{const r=run(name,['--fixture']);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/fixture/);assert.match(r.stdout,/completed/);});
}
