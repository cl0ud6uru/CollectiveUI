#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {WebSocketServer} from 'ws';
import {ResponsesSocket} from './ws.mjs';
let server,client;
try{
 const {values}=parseArgs({options:{help:{type:'boolean'},fixture:{type:'boolean'},live:{type:'boolean'},'credential-file':{type:'string'},model:{type:'string'}}});
 if(values.help)console.log('Usage: node probe-responses-ws.mjs --fixture\nLive opt-in: --live --credential-file /absolute/new-siwc.json --model MODEL\nRead-only JSON {access_token}; no defaults, sign-in, refresh or credential discovery. Live mode uses inference.');
 else{
  if(Boolean(values.fixture)===Boolean(values.live))throw Error('choose fixture or live');
  let url,token;
  if(values.fixture){
   if(values['credential-file'])throw Error('fixture cannot read credentials');
   server=new WebSocketServer({port:0});await new Promise(r=>server.once('listening',r));url=`ws://127.0.0.1:${server.address().port}`;
   server.on('connection',s=>s.on('message',data=>{const m=JSON.parse(data);for(const e of [{type:'response.output_text.delta',delta:'EX'},{type:'response.output_text.delta',delta:'ACT'},{type:'response.completed',response:{id:'fixture-response',status:'completed'}}])s.send(JSON.stringify({...e,stream_id:m.stream_id}));}));
  }else{
   if(!values.model||!values['credential-file']||!isAbsolute(values['credential-file']))throw Error('explicit credential and model required');
   const credential=JSON.parse(await readFile(values['credential-file'],'utf8'));token=credential.access_token;if(typeof token!=='string'||!token)throw Error('invalid credential');
  }
  client=new ResponsesSocket({url,token,timeoutMs:10000});
  console.log(JSON.stringify({mode:values.fixture?'fixture':'live',...await client.turn({streamId:'collectiveui-probe',model:values.model||'fixture',input:[{role:'user',content:'Reply with exactly EXACT and nothing else.'}],marker:'EXACT'})}));
 }
}catch{console.error('Responses WS probe failed; submitted live turn may be uncertain and was NOT replayed. Use --help.');process.exitCode=1;}
finally{client?.close();if(server){for(const s of server.clients)s.terminate();server.close();}}
