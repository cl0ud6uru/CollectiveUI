#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {AppServer} from './app-server.mjs';
let home,c;
try{
 const {values}=parseArgs({options:{help:{type:'boolean'},fixture:{type:'boolean'},binary:{type:'string'}}});
 if(values.help){console.log('Usage: node probe-app-server.mjs --fixture | --binary /absolute/pinned/codex\nBinary mode: initialize/initialized then EOF shutdown only; no inference or credentials.');}
 else{
  if(Boolean(values.fixture)===Boolean(values.binary))throw Error('choose fixture or explicit binary');
  if(values.binary&&!isAbsolute(values.binary))throw Error('absolute binary required');
  home=await mkdtemp(join(tmpdir(),'runtime-codex-'));await mkdir(join(home,'codex'));
  const binary=values.fixture?process.execPath:values.binary;
  const args=values.fixture?[fileURLToPath(new URL('./fixtures/app-server.mjs',import.meta.url))]:['app-server','--listen','stdio://'];
  const child=spawn(binary,args,{cwd:home,env:{PATH:'/usr/bin:/bin',HOME:home,CODEX_HOME:join(home,'codex'),TMPDIR:home},stdio:['pipe','pipe','pipe']});
  child.stderr.resume();c=new AppServer(child);
  const handshake=await c.initialize();
  if(values.fixture){const thread=await c.request('thread/start',{});console.log(JSON.stringify({mode:'fixture',...await c.turn({threadId:thread.thread.id,text:'probe',marker:'EXACT'})}));}
  else console.log(JSON.stringify({mode:'binary-handshake-only',initialized:true,userAgent:handshake.userAgent,inference:false}));
 }
}catch{console.error('App-server probe failed (no credentials read). Use --help.');process.exitCode=1;}
finally{await c?.close();if(home)await rm(home,{recursive:true,force:true});}
