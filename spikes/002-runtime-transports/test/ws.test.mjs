import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
async function fixture(t, handler) {
 const server = new WebSocketServer({ port: 0 });
 await new Promise(r => server.once('listening',r));
 server.on('connection', socket => socket.on('message', data => handler(socket, JSON.parse(data))));
 t.after(() => { for(const s of server.clients) s.terminate(); server.close(); });
 return `ws://127.0.0.1:${server.address().port}`;
}
test('WS maps chunk deltas and requires exact successful terminal marker', async t => {
 const { ResponsesSocket } = await import('../ws.mjs');
 const url = await fixture(t,(s,m) => {
  assert.equal(m.type,'response.create'); assert.equal(m.stream_id,'main');
  assert.equal(m.stream,undefined); assert.equal(m.background,undefined);
  for(const e of [{type:'response.output_text.delta',delta:'EX'},{type:'response.output_text.delta',delta:'ACT'},{type:'response.completed',response:{id:'r1',status:'completed'}}]) s.send(JSON.stringify({...e,stream_id:m.stream_id}));
 });
 const client = new ResponsesSocket({url}); t.after(()=>client.close());
 assert.deepEqual(await client.turn({streamId:'main',model:'fixture',input:[],marker:'EXACT'}),{text:'EXACT',responseId:'r1',status:'completed'});
});

for(const mode of ['response.failed','response.incomplete','disconnect','timeout','bad-status','bad-marker','malformed','error']) test(`WS rejects ${mode} after partial output without replay`,{timeout:2000},async t=>{
 const {ResponsesSocket}=await import('../ws.mjs'); let count=0;
 const url=await fixture(t,(s,m)=>{count++; s.send(JSON.stringify({type:'response.output_text.delta',stream_id:m.stream_id,delta:'PARTIAL'}));
  if(mode==='disconnect') s.close();
  else if(mode==='malformed') s.send('{');
  else if(mode==='bad-status'||mode==='bad-marker') s.send(JSON.stringify({type:'response.completed',stream_id:m.stream_id,response:{id:'r',status:mode==='bad-status'?'incomplete':'completed'}}));
  else if(mode!=='timeout') s.send(JSON.stringify({type:mode,stream_id:m.stream_id}));
 });
 const client=new ResponsesSocket({url,timeoutMs:40}); t.after(()=>client.close());
 await assert.rejects(client.turn({streamId:'main',model:'fixture',input:[],marker:'EXACT'})); assert.equal(count,1);
});

test('WS reuses one connection, isolates streams and chains only successful input',async t=>{
 const {ResponsesSocket}=await import('../ws.mjs'); const received=[]; let sockets=new Set();
 const url=await fixture(t,(s,m)=>{sockets.add(s);received.push(m);
  s.send(JSON.stringify({type:'response.output_text.delta',stream_id:'foreign',delta:'WRONG'}));
  s.send(JSON.stringify({type:'response.output_text.delta',stream_id:m.stream_id,delta:'OK'}));
  s.send(JSON.stringify({type:'response.completed',stream_id:m.stream_id,response:{id:`r${received.length}`,status:'completed'}}));
 });
 const client=new ResponsesSocket({url}); t.after(()=>client.close());
 await client.turn({streamId:'a',model:'f',input:['first'],marker:'OK'});
 await client.turn({streamId:'b',model:'f',input:['other'],marker:'OK'});
 await client.turn({streamId:'a',model:'f',input:['new-only'],marker:'OK'});
 assert.equal(sockets.size,1); assert.equal(received[1].previous_response_id,undefined);
 assert.equal(received[2].previous_response_id,'r1'); assert.deepEqual(received[2].input,['new-only']);
});

test('WS uncertain disconnect blocks same stream replay; explicit new stream recovers',async t=>{
 const {ResponsesSocket}=await import('../ws.mjs');const requests=[];
 const url=await fixture(t,(socket,m)=>{requests.push(m);if(requests.length===1){socket.close();return;}
 socket.send(JSON.stringify({type:'response.output_text.delta',stream_id:m.stream_id,delta:'OK'}));socket.send(JSON.stringify({type:'response.completed',stream_id:m.stream_id,response:{id:'new',status:'completed'}}));});
 const c=new ResponsesSocket({url,timeoutMs:100});t.after(()=>c.close());
 await assert.rejects(c.turn({streamId:'old',model:'f',input:['old'],marker:'OK'}),/disconnect/);
 await assert.rejects(c.turn({streamId:'old',model:'f',input:['old'],marker:'OK'}),/uncertain/);
 await c.turn({streamId:'fresh',model:'f',input:['explicit-new'],marker:'OK'});
 assert.equal(requests.length,2);assert.equal(requests[1].previous_response_id,undefined);assert.deepEqual(requests[1].input,['explicit-new']);
});

test('WS rejects overlapping submissions instead of duplicating a conversation',async t=>{
 const {ResponsesSocket}=await import('../ws.mjs');let count=0;
 const url=await fixture(t,(socket,m)=>{count++;setTimeout(()=>{socket.send(JSON.stringify({type:'response.output_text.delta',stream_id:m.stream_id,delta:'OK'}));socket.send(JSON.stringify({type:'response.completed',stream_id:m.stream_id,response:{id:'r',status:'completed'}}));},40);});
 const c=new ResponsesSocket({url});t.after(()=>c.close());
 const first=c.turn({streamId:'a',model:'f',input:[],marker:'OK'});
 await assert.rejects(c.turn({streamId:'a',model:'f',input:[],marker:'OK'}),/busy/);
 await first;assert.equal(count,1);
});
