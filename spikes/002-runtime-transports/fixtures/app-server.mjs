import {createInterface} from 'node:readline';
let lastDecision;let initialized=false;const mode=process.argv[2]||'success';
if(mode==='resistant'){
 process.on('SIGTERM',()=>process.stderr.write('ignored SIGTERM\n'));
 process.stdin.on('end',()=>process.stderr.write('ignored EOF\n'));
 setInterval(()=>{},1000);
}
const approvals=new Map();let heldStart;
let approvalId=0;
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
const events=()=>{
 send({method:'item/agentMessage/delta',params:{threadId:'foreign',turnId:'other',delta:'BAD'}});
 for(const delta of ['EX','ACT'])send({method:'item/agentMessage/delta',params:{threadId:'thread1',turnId:'turn1',delta}});
 if(mode==='disconnect')return process.exit(0);
 if(mode==='timeout'||mode==='hold')return;
 if(mode==='unknown'){send({id:'unknown-9',method:'item/newApproval/request',params:{}});return;}
 if(mode==='approval'){send({id:'foreign-approval',method:'item/fileChange/requestApproval',params:{threadId:'other',turnId:'other'}});send({id:'approval-7',method:'item/commandExecution/requestApproval',params:{threadId:'thread1',turnId:'turn1',command:'fixture only'}});return;}
 send({method:'turn/completed',params:{threadId:'thread1',turn:{id:'turn1',status:mode==='success'?'completed':mode}}});
};
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(approvals.has(m.id)){send({id:approvals.get(m.id),result:m.result});approvals.delete(m.id);return;}
 if(m.method==='fixture/requestApproval'){const id=`controlled-${++approvalId}`;approvals.set(id,m.id);send({id,method:'item/commandExecution/requestApproval',params:m.params});return;}
 if(m.method==='fixture/releaseStart'){send({id:heldStart,result:{turn:{id:'turn1',status:'inProgress'}}});send({id:m.id,result:{}});return;}
 if(m.method==='fixture/complete'){send({method:'turn/completed',params:{threadId:'thread1',turn:{id:'turn1',status:'completed'}}});send({id:m.id,result:{}});return;}
 if(m.method==='turn/start'&&mode.startsWith('controlled')){if(mode==='controlled-before-start')heldStart=m.id;else send({id:m.id,result:{turn:{id:'turn1',status:'inProgress'}}});return;}
 if(m.id==='foreign-approval'){if(m.result?.decision!=='decline')throw Error('foreign approval accepted');return;}
 if(m.id==='unknown-9'){if(m.error?.code!==-32601)throw Error('unknown request not failed closed');return;}
 if(m.method==='fixture/approvalResult'){send({id:m.id,result:{decision:lastDecision}});return;}
 if(m.id==='approval-7'){lastDecision=m.result?.decision;if(!['accept','decline'].includes(m.result?.decision))throw Error('unsafe approval');send({method:'turn/completed',params:{threadId:'thread1',turn:{id:'turn1',status:'completed'}}});return;}
 if('jsonrpc' in m)throw Error('private protocol omits jsonrpc');
 if(m.method==='initialize'){if(m.params.clientInfo.name!=='collectiveui')throw Error('bad client');send({id:m.id,result:{userAgent:'fixture'}});}
 else if(m.method==='initialized')initialized=true;
 else if(m.method==='thread/start'||m.method==='thread/resume'){if(!initialized)throw Error('not initialized');send({id:m.id,result:{thread:{id:'thread1'}}});}
 else if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'turn1',status:'inProgress'}}});setTimeout(events,5);}
 else if(m.method==='turn/interrupt'){if(m.params.threadId!=='thread1'||m.params.turnId!=='turn1')throw Error('wrong interrupt IDs');send({id:m.id,result:{}});send({method:'turn/completed',params:{threadId:'thread1',turn:{id:'turn1',status:'interrupted'}}});}
 else if(m.id)send({id:m.id,result:{}});
});
