import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
function child(mode='success'){return spawn(process.execPath,[fileURLToPath(new URL('../fixtures/app-server.mjs',import.meta.url)),mode],{env:{PATH:process.env.PATH},stdio:['pipe','pipe','pipe']});}
test('private stdio initializes before initialized; no jsonrpc field',async()=>{
 const {AppServer}=await import('../app-server.mjs');const c=new AppServer(child());
 try{assert.equal((await c.initialize()).userAgent,'fixture');}finally{await c.close();}
});

test('app thread/start and turn/start map chunked output, isolate foreign turns',async()=>{
 const {AppServer}=await import('../app-server.mjs');const c=new AppServer(child());
 try{await c.initialize();const thread=await c.request('thread/start',{});assert.deepEqual(await c.turn({threadId:thread.thread.id,text:'probe',marker:'EXACT'}),{text:'EXACT',status:'completed',turnId:'turn1'});}finally{await c.close();}
});

for(const mode of ['failed','interrupted','disconnect','timeout','unknown'])test(`app rejects ${mode} without replay`,{timeout:2000},async()=>{
 const {AppServer}=await import('../app-server.mjs');const c=new AppServer(child(mode),{timeoutMs:500});
 try{await c.initialize();await c.request('thread/resume',{threadId:'thread1'});await assert.rejects(c.turn({threadId:'thread1',text:'probe',marker:'EXACT'}));}finally{await c.close();}
});
for(const decision of ['accept','decline',undefined])test(`approval ID echoed and decision ${decision??'default-decline'}`,async()=>{
 const {AppServer}=await import('../app-server.mjs');const seen=[];const c=new AppServer(child('approval'),{approval:decision?async request=>{seen.push(request.id);return decision;}:undefined});
 try{await c.initialize();assert.equal((await c.turn({threadId:'thread1',text:'probe',marker:'EXACT'})).status,'completed');assert.deepEqual(seen,decision?['approval-7']:[]);}finally{await c.close();}
});

test('app interrupt uses active thread and turn IDs; interrupted is not success',async()=>{
 const {AppServer}=await import('../app-server.mjs');const c=new AppServer(child('hold'),{timeoutMs:500});
 try{await c.initialize();const outcome=c.turn({threadId:'thread1',text:'probe',marker:'EXACT'});const rejected=assert.rejects(outcome,/terminal/);await new Promise(r=>setTimeout(r,40));await c.interrupt({threadId:'thread1',turnId:'turn1'});await rejected;}finally{await c.close();}
});

test('app rejects overlapping turns without replacing event pump',async()=>{
 const {AppServer}=await import('../app-server.mjs');const c=new AppServer(child('hold'),{timeoutMs:500});
 try{await c.initialize();const first=c.turn({threadId:'thread1',text:'probe',marker:'EXACT'});const rejected=assert.rejects(first,/terminal/);await assert.rejects(c.turn({threadId:'thread1',text:'duplicate',marker:'EXACT'}),/busy/);await new Promise(r=>setTimeout(r,40));await c.interrupt({threadId:'thread1',turnId:'turn1'});await rejected;}finally{await c.close();}
});

test('approval completing after turn timeout is declined, never stale accept',async()=>{
 const {AppServer}=await import('../app-server.mjs');const c=new AppServer(child('approval'),{timeoutMs:500,approval:async()=>{await new Promise(r=>setTimeout(r,550));return 'accept';}});
 try{await c.initialize();await assert.rejects(c.turn({threadId:'thread1',text:'probe',marker:'EXACT'}),/timeout/);await new Promise(r=>setTimeout(r,150));assert.equal((await c.request('fixture/approvalResult')).decision,'decline');}finally{await c.close();}
});

test('idle approvals with missing/null/empty IDs never invoke callback',async()=>{
 const {AppServer}=await import('../app-server.mjs');let calls=0;const c=new AppServer(child('controlled'),{approval:()=>{calls++;return 'accept';}});
 try{await c.initialize();for(const params of [{},{threadId:null,turnId:null},{threadId:'',turnId:''},{threadId:'thread1',turnId:'turn1'}])assert.equal((await c.request('fixture/requestApproval',params)).decision,'decline');assert.equal(calls,0);}finally{await c.close();}
});

test('approval before turn/start resolves requires nonempty string IDs',async()=>{
 const {AppServer}=await import('../app-server.mjs');let calls=0;const c=new AppServer(child('controlled-before-start'),{approval:()=>{calls++;return 'accept';}});
 try{await c.initialize();const turn=c.turn({threadId:'thread1',text:'probe',marker:''});turn.catch(()=>{});
 for(const params of [{threadId:'thread1'},{threadId:'thread1',turnId:null},{threadId:null,turnId:'turn1'},{threadId:'thread1',turnId:''},{threadId:'thread1',turnId:'turn1'}])assert.equal((await c.request('fixture/requestApproval',params)).decision,'decline');
 assert.equal(calls,0);await c.request('fixture/releaseStart');
 for(const params of [{},{threadId:'thread1'},{threadId:'thread1',turnId:null},{threadId:null,turnId:'turn1'},{threadId:'',turnId:'turn1'},{threadId:'thread1',turnId:1}])assert.equal((await c.request('fixture/requestApproval',params)).decision,'decline');
 assert.equal(calls,0);assert.equal((await c.request('fixture/requestApproval',{threadId:'thread1',turnId:'turn1'})).decision,'accept');assert.equal(calls,1);await c.request('fixture/complete');await turn;
 }finally{await c.close();}
});

test('stale approval result is declined after a later turn reuses IDs',async()=>{
 const {AppServer}=await import('../app-server.mjs');let release,entered;const ready=new Promise(r=>entered=r);const c=new AppServer(child('controlled'),{approval:()=>{entered();return new Promise(r=>release=r);}});
 try{await c.initialize();const first=c.turn({threadId:'thread1',text:'first',marker:''});first.catch(()=>{});await c.request('fixture/barrier');
 const decision=c.request('fixture/requestApproval',{threadId:'thread1',turnId:'turn1'});decision.catch(()=>{});await ready;await c.request('fixture/complete');await first;
 const second=c.turn({threadId:'thread1',text:'second',marker:''});second.catch(()=>{});await c.request('fixture/barrier');release('accept');assert.equal((await decision).decision,'decline');await c.request('fixture/complete');await second;
 }finally{release?.('decline');await c.close();}
});

test('close escalates EOF then SIGTERM then SIGKILL for resistant real child',async()=>{
 const {AppServer}=await import('../app-server.mjs');const processChild=child('resistant');let evidence='';processChild.stderr.on('data',b=>evidence+=b);const c=new AppServer(processChild,{eofMs:50,termMs:50,killMs:500});let watchdog,closing;
 try{await c.initialize();closing=c.close();await Promise.race([closing,new Promise((_,reject)=>watchdog=setTimeout(()=>reject(Error('close deadline exceeded')),1500))]);
 assert.equal(processChild.signalCode,'SIGKILL');assert.match(evidence,/ignored EOF/);assert.match(evidence,/ignored SIGTERM/);assert.equal(c.lines.closed,true);
 }finally{clearTimeout(watchdog);processChild.kill('SIGKILL');await closing;}
});

test('close is idempotent during shutdown and after exit',async()=>{
 const {AppServer}=await import('../app-server.mjs');const c=new AppServer(child('resistant'),{eofMs:30,termMs:30,killMs:500});c.child.stderr.resume();let closing;
 try{await c.initialize();const exits=c.child.listenerCount('exit');closing=c.close();const again=c.close();assert.equal(again,closing);await closing;assert.equal(c.close(),closing);assert.equal(c.child.listenerCount('exit'),exits);assert.equal(c.pending.size,0);assert.equal(c.lines.closed,true);
 }finally{c.child.kill('SIGKILL');await closing;}
});
