import {createInterface} from 'node:readline';

export class AppServer {
 constructor(child,{timeoutMs=5000,approval,eofMs=1000,termMs=1000,killMs=1000}={}) {
  this.closeDeadlines={eofMs,termMs,killMs};
  this.child=child;this.timeoutMs=timeoutMs;this.approval=approval;this.pending=new Map();this.id=0;
  this.lines=createInterface({input:child.stdout});
  this.lines.on('line',line=>{let m;try{m=JSON.parse(line);}catch{return this.fail(new Error('malformed JSONL'));}
   if(m.method&&Object.hasOwn(m,'id')){void this.serverRequest(m);return;}
   if(m.method)this.onNotification?.(m);
   const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error('RPC error')):p.resolve(m.result);}
  });
  child.on('error',()=>this.fail(new Error('process error')));child.on('exit',()=>this.fail(new Error('disconnect; submitted turn uncertain; not replayed')));
  child.stdin.on('error',()=>this.fail(new Error('stdin disconnected')));
 }
 fail(error){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.rejectTurn?.(error);}
 async serverRequest(m){
  if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(m.method)){
   const generation=this.rejectTurn;
   const {threadId,turnId}=m.params??{};
   const inScope=()=>generation&&generation===this.rejectTurn&&typeof threadId==='string'&&threadId.length>0&&typeof turnId==='string'&&turnId.length>0&&threadId===this.activeThreadId&&turnId===this.activeTurnId;
   let decision='decline';try{const requested=inScope()?await this.approval?.(m):'decline';if((requested==='accept'||requested==='decline')&&inScope())decision=requested;}catch{}
   this.send({id:m.id,result:{decision}});
  }else{this.send({id:m.id,error:{code:-32601,message:'Unsupported server request; denied'}});this.fail(new Error('unsupported server request'));}
 }
 send(m){this.child.stdin.write(JSON.stringify(m)+'\n');}
 request(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('RPC timeout; not replayed'));},this.timeoutMs);this.pending.set(id,{resolve,reject,timer});this.send({id,method,params});});}
 async initialize(){const result=await this.request('initialize',{clientInfo:{name:'collectiveui',title:'CollectiveUI',version:'spike'}});this.send({method:'initialized',params:{}});return result;}
 async turn({threadId,text,marker}){
  if(this.rejectTurn)throw new Error('busy: this spike supports sequential turns only');
  this.activeThreadId=threadId;let output='',turnId;const buffered=[];
  return new Promise((resolve,reject)=>{
   const finish=(error,result)=>{clearTimeout(timer);this.onNotification=null;this.rejectTurn=null;this.activeThreadId=null;this.activeTurnId=null;error?reject(error):resolve(result);};
   const timer=setTimeout(()=>finish(new Error('turn timeout; submitted turn uncertain; not replayed')),this.timeoutMs);this.rejectTurn=error=>finish(error);
   this.onNotification=m=>{if(!turnId){buffered.push(m);return;}if(m.params?.threadId!==threadId)return;
    if(m.method==='item/agentMessage/delta'&&m.params.turnId===turnId)output+=m.params.delta;
    if(m.method==='turn/completed'&&m.params.turn.id===turnId)output===marker&&m.params.turn.status==='completed'?finish(null,{text:output,status:'completed',turnId}):finish(new Error('terminal failure'));
   };
   this.request('turn/start',{threadId,input:[{type:'text',text}]}).then(started=>{turnId=started.turn.id;this.activeTurnId=turnId;for(const m of buffered)this.onNotification?.(m);},error=>finish(error));
  });
 }
 interrupt({threadId,turnId}){return this.request('turn/interrupt',{threadId,turnId});}
 close(){return this.closePromise??=this.shutdown();}
 async shutdown(){
  const exited=()=>this.child.exitCode!==null||this.child.signalCode!==null||!this.child.pid;
  const wait=ms=>new Promise(resolve=>{
   if(exited())return resolve(true);
   const finish=value=>{clearTimeout(timer);this.child.removeListener('exit',onExit);resolve(value);};
   const onExit=()=>finish(true);const timer=setTimeout(()=>finish(false),ms);this.child.once('exit',onExit);
  });
  try{
   if(exited())return;
   this.child.stdin.end();
   if(await wait(this.closeDeadlines.eofMs))return;
   this.child.kill('SIGTERM');
   if(await wait(this.closeDeadlines.termMs))return;
   this.child.kill('SIGKILL');
   if(!await wait(this.closeDeadlines.killMs))throw new Error('process shutdown deadline exceeded after SIGKILL');
  }finally{
   this.lines.close();this.fail(new Error('app server closed; not replayed'));
   this.child.stdin.destroy();this.child.stdout.destroy();this.child.stderr?.destroy();
  }
 }
}
