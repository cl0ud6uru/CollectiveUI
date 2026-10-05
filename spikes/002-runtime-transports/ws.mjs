import WebSocket from 'ws';
export class ResponsesSocket {
 constructor({url='wss://api.openai.com/v1/responses',token,timeoutMs=5000}={}) { this.url=url; this.token=token; this.timeoutMs=timeoutMs; this.previous=new Map(); this.uncertain=new Set(); }
 async turn({streamId,model,input,marker}) {
  if(this.busy)throw new Error('busy: this spike supports sequential turns only');
  if(this.uncertain.has(streamId))throw new Error('uncertain stream; reconcile externally or use an explicit fresh stream; not replayed');
  this.busy=true;
  const socket=this.socket?.readyState===WebSocket.OPEN?this.socket:new WebSocket(this.url,{headers:this.token?{Authorization:`Bearer ${this.token}`}:{}}); this.socket=socket;
  return new Promise((resolve,reject)=>{
   let text='',settled=false;
   const finish=(error,result)=>{if(settled)return; settled=true; this.busy=false; clearTimeout(timer); socket.off('message',message); socket.off('error',errorHandler);socket.off('close',closeHandler);socket.off('open',send); if(error){this.uncertain.add(streamId);socket.close();} error?reject(error):resolve(result);};
   const timer=setTimeout(()=>finish(new Error('timeout; submitted turn uncertain; not replayed')),this.timeoutMs);
   const errorHandler=()=>finish(new Error('socket error; not replayed'));
   const closeHandler=()=>finish(new Error('disconnect; submitted turn uncertain; not replayed'));
   const send=()=>socket.send(JSON.stringify({type:'response.create',stream_id:streamId,model,input,...(this.previous.has(streamId)?{previous_response_id:this.previous.get(streamId)}:{})}));
   const message=data=>{
    let e;try{e=JSON.parse(data);}catch{return finish(new Error('malformed event'));}
    if(e.stream_id!==streamId)return;
    if(['response.failed','response.incomplete','error'].includes(e.type))return finish(new Error(e.type));
    if(e.type==='response.output_text.delta')text+=e.delta;
    if(e.type==='response.completed'){
     if(e.response?.status!=='completed'||text!==marker)return finish(new Error('terminal marker mismatch'));
     this.previous.set(streamId,e.response.id);finish(null,{text,responseId:e.response.id,status:'completed'});
    }
   };
   socket.on('error',errorHandler);socket.on('close',closeHandler);socket.on('message',message);
   if(socket.readyState===WebSocket.OPEN)send();else socket.once('open',send);
  });
 }
 close(){this.socket?.close();}
}
