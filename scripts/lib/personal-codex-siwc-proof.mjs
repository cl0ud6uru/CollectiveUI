const SOCKET = '/codex-home/.collective-codex-siwc.sock';
export const SIWC_NODE_EXECUTABLE = '/usr/local/bin/node';
const SPAWN_CODES = ['EACCES','EAGAIN','E2BIG','EINVAL','EIO','EMFILE','ENAMETOOLONG','ENFILE','ENOENT','ENOEXEC','ENOMEM','ENOSYS','ENOTDIR','ENOTSUP','EPERM','ETIMEDOUT','ENOBUFS'];
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...keys].sort().join();
const pid = value => Number.isSafeInteger(value) && value > 0;
const CHILD_FIELDS = ['writerMode','spawnPid','status','signal','spawnError','spawnErrorCode','spawnErrorSyscall','spawnErrorMessage',
  'spawnExecutable','stdoutType','stdoutBytes','stdoutEmpty','stderrType','stderrBytes','stderrEmpty','stdoutJsonParsed',
  'stdoutJsonExact','stdoutJsonSchemaExact','accessTokenObserved','proof'];
function spawnMessage(value, code) {
  if (value === null) return null;
  const known = SPAWN_CODES.includes(code) ? code : 'UNKNOWN';
  return value === 'spawnSync ' + SIWC_NODE_EXECUTABLE + ' ' + known || value === 'Child spawn error: ' + known ? value : 'other';
}
function nonce(value) {
  if (!/^[a-f0-9-]{36}$/.test(value)) throw new Error('Invalid synthetic SIWC nonce.');
  return value;
}

/** Observe the inherited child environment: never replace it with a filtered env. */
export function siwcChildCommand(token, writerMode = 'stream') {
  nonce(token);
  if (!['stream','sync'].includes(writerMode)) throw new Error('Invalid SIWC diagnostic writer mode.');
  const json = `JSON.stringify({probe:'siwcChildEnvironment',nonce:${JSON.stringify(token)},pid:process.pid,accessTokenPresent:Object.prototype.hasOwnProperty.call(process.env,'ACCESS_TOKEN')})`;
  return writerMode === 'stream' ? `process.stdout.write(${json});` : `require('node:fs').writeSync(1,${json});`;
}

/** Fixed image executable avoids Node's argv[0] fallback when the sandbox has no /proc/self/exe.
 * Ignored stdin avoids shutdown-related seccomp failure; the child inherits the parent environment unchanged.
 */
export function siwcToolCommand(token, appServerPid, socketPath = SOCKET) {
  nonce(token);
  if (!pid(appServerPid)) throw new Error('Invalid app-server PID.');
  if (socketPath !== SOCKET) throw new Error('Unreviewed SIWC socket path.');
  return `
const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net');
const childExecutable=${JSON.stringify(SIWC_NODE_EXECUTABLE)};
function streamStats(value){
 const type=typeof value==='string'?'string':Buffer.isBuffer(value)?'buffer':value===null?'null':value===undefined?'undefined':'other';
 const bytes=type==='string'?Buffer.byteLength(value):type==='buffer'?value.length:null;
 return {type,bytes,empty:bytes===null?null:bytes===0};
}
function observeChild(writerMode,script){
 const child=cp.spawnSync(childExecutable,['-e',script],{encoding:'utf8',timeout:3000,maxBuffer:4096,stdio:['ignore','pipe','pipe']});
 const spawnErrorCode=child.error?(${JSON.stringify(SPAWN_CODES)}.includes(child.error.code)?child.error.code:'UNKNOWN'):null;
 const spawnErrorSyscall=child.error?(child.error.syscall==='spawnSync '+childExecutable?child.error.syscall:'other'):null;
 const spawnErrorMessage=child.error?(child.error.message==='spawnSync '+childExecutable+' '+spawnErrorCode?child.error.message:'Child spawn error: '+spawnErrorCode):null;
 const out=streamStats(child.stdout),err=streamStats(child.stderr);
 let parsed=null,stdoutJsonParsed=false,stdoutJsonExact=false,stdoutJsonSchemaExact=false,childProof=null;
 if(out.type==='string'||out.type==='buffer')try{
  parsed=JSON.parse(child.stdout);stdoutJsonParsed=true;stdoutJsonExact=child.stdout===JSON.stringify(parsed);
  stdoutJsonSchemaExact=parsed!==null&&typeof parsed==='object'&&!Array.isArray(parsed)
   &&Object.keys(parsed).sort().join()==='accessTokenPresent,nonce,pid,probe'
   &&typeof parsed.probe==='string'&&typeof parsed.nonce==='string'&&Number.isSafeInteger(parsed.pid)&&parsed.pid>0&&typeof parsed.accessTokenPresent==='boolean';
  if(stdoutJsonSchemaExact)childProof={probe:parsed.probe==='siwcChildEnvironment'?parsed.probe:null,
   nonce:parsed.nonce===${JSON.stringify(token)}?parsed.nonce:null,pid:parsed.pid,accessTokenPresent:parsed.accessTokenPresent};
 }catch{}
 return {writerMode,spawnPid:Number.isSafeInteger(child.pid)&&child.pid>=0?child.pid:null,status:child.status,signal:child.signal,
  spawnError:!!child.error,spawnErrorCode,spawnErrorSyscall,spawnErrorMessage,spawnExecutable:childExecutable,
  stdoutType:out.type,stdoutBytes:out.bytes,stdoutEmpty:out.empty,stderrType:err.type,stderrBytes:err.bytes,stderrEmpty:err.empty,
  stdoutJsonParsed,stdoutJsonExact,stdoutJsonSchemaExact,
  accessTokenObserved:typeof parsed?.accessTokenPresent==='boolean'?parsed.accessTokenPresent:null,proof:childProof};
}
const child=observeChild('stream',${JSON.stringify(siwcChildCommand(token))});
// Diagnostic comparison only: its output never substitutes for the primary stream writer.
const comparison=observeChild('sync',${JSON.stringify(siwcChildCommand(token, 'sync'))});
let parentEnvironDenied=false,parentEnvironError=null;
try{fs.readFileSync('/proc/${appServerPid}/environ');}catch(error){parentEnvironError=error.code??null;parentEnvironDenied=['EACCES','EPERM','ENOENT'].includes(parentEnvironError);}
const result={probe:'siwcToolIsolation',nonce:${JSON.stringify(token)},pid:process.pid,accessTokenPresent:Object.prototype.hasOwnProperty.call(process.env,'ACCESS_TOKEN'),
 child,comparison,parentEnvironDenied,parentEnvironError,socketDenied:false,socketError:null};
const socket=net.connect(${JSON.stringify(socketPath)});let finished=false;
function finish(){if(finished)return;finished=true;socket.destroy();process.stdout.write(JSON.stringify(result));}
socket.setTimeout(1500,()=>{result.socketError='TIMEOUT';finish();});
socket.once('connect',finish);
socket.once('error',error=>{result.socketError=error.code??null;result.socketDenied=['EACCES','EPERM','ENOENT'].includes(result.socketError);finish();});
`;
}

export function passedSiwcChild(value, token, parentPid) {
  return exact(value, ['probe','nonce','pid','accessTokenPresent']) && value.probe === 'siwcChildEnvironment'
    && value.nonce === token && pid(value.pid) && value.pid !== parentPid && value.accessTokenPresent === false;
}

/** Strict proof acceptance: exit zero alone, absent output, or reported success cannot pass. */
export function siwcToolEvidence(reply, token) {
  let proof = null;
  try { proof = JSON.parse(reply?.result?.stdout); } catch { /* Missing/malformed observations fail below. */ }
  const checks = {
    rpcReply: !reply?.error && exact(reply?.result, ['exitCode','stdout','stderr']),
    commandExit: reply?.result?.exitCode === 0 && reply?.result?.stderr === '',
    toolObserved: exact(proof,['probe','nonce','pid','accessTokenPresent','child','comparison','parentEnvironDenied','parentEnvironError','socketDenied','socketError'])
      && proof.probe === 'siwcToolIsolation' && proof.nonce === token && pid(proof.pid),
    toolEnvironmentExcluded: proof?.accessTokenPresent === false,
    childExecuted: exact(proof?.child,CHILD_FIELDS) && proof.child.writerMode === 'stream' && pid(proof.child.spawnPid)
      && proof.child.status === 0 && proof.child.signal === null && proof.child.spawnError === false
      && proof.child.spawnErrorCode === null && proof.child.spawnErrorSyscall === null && proof.child.spawnErrorMessage === null && proof.child.spawnExecutable === SIWC_NODE_EXECUTABLE
      && proof.child.stdoutType === 'string' && Number.isSafeInteger(proof.child.stdoutBytes) && proof.child.stdoutBytes > 0 && proof.child.stdoutBytes <= 4096
      && proof.child.stdoutEmpty === false && proof.child.stderrType === 'string' && proof.child.stderrBytes === 0 && proof.child.stderrEmpty === true
      && proof.child.stdoutJsonParsed === true && proof.child.stdoutJsonExact === true && proof.child.stdoutJsonSchemaExact === true
      && proof.child.accessTokenObserved === false && proof.child.spawnPid === proof.child.proof?.pid && passedSiwcChild(proof.child.proof, token, proof.pid),
    comparisonTokenNotObserved: proof?.comparison?.accessTokenObserved !== true && proof?.comparison?.proof?.accessTokenPresent !== true,
    parentEnvironDenied: proof?.parentEnvironDenied === true && ['EACCES','EPERM','ENOENT'].includes(proof.parentEnvironError),
    siwcSocketDenied: proof?.socketDenied === true && ['EACCES','EPERM','ENOENT'].includes(proof.socketError),
  };
  // Expose only credential-free fields, never arbitrary child stdout or environment bytes.
  return { passed: Object.values(checks).every(Boolean), checks,
    observed: { rpcError: !!reply?.error, commandExitCode: typeof reply?.result?.exitCode === 'number' ? reply.result.exitCode : null,
      commandStderrEmpty: reply?.result?.stderr === '', commandStdoutJsonParsed: proof !== null,
      toolPid: pid(proof?.pid) ? proof.pid : null, childPid: pid(proof?.child?.proof?.pid) ? proof.child.proof.pid : null,
      childExitCode: typeof proof?.child?.status === 'number' ? proof.child.status : null,
      childSignal: proof?.child?.signal === null ? null : 'present', childSpawnError: proof?.child?.spawnError === true,
      childSpawnExecutable: proof?.child?.spawnExecutable === SIWC_NODE_EXECUTABLE ? SIWC_NODE_EXECUTABLE : null,
      childSpawnErrorCode: SPAWN_CODES.includes(proof?.child?.spawnErrorCode) ? proof.child.spawnErrorCode
        : proof?.child?.spawnErrorCode === null ? null : 'UNKNOWN',
      childSpawnErrorSyscall: proof?.child?.spawnErrorSyscall === 'spawnSync ' + SIWC_NODE_EXECUTABLE ? proof.child.spawnErrorSyscall
        : proof?.child?.spawnErrorSyscall === null ? null : 'other',
      childSpawnErrorMessage: spawnMessage(proof?.child?.spawnErrorMessage, proof?.child?.spawnErrorCode),
      childStderrEmpty: proof?.child?.stderrEmpty === true, childExactJson: proof?.child?.stdoutJsonExact === true,
      childDiagnostics: childDiagnostics(proof?.child, token, proof?.pid),
      comparisonDiagnostics: childDiagnostics(proof?.comparison, token, proof?.pid),
      parentEnvironError: ['EACCES','EPERM','ENOENT'].includes(proof?.parentEnvironError) ? proof.parentEnvironError : null,
      socketError: ['EACCES','EPERM','ENOENT'].includes(proof?.socketError) ? proof.socketError : null } };
}

function childDiagnostics(child, token, parentPid) {
  const type = value => ['string','buffer','null','undefined','other'].includes(value) ? value : null;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const boolean = value => typeof value === 'boolean' ? value : null;
  return { writerMode: ['stream','sync'].includes(child?.writerMode) ? child.writerMode : null,
    spawnPid: count(child?.spawnPid), exitCode: count(child?.status), signal: child?.signal === null ? null : 'present',
    spawnError: boolean(child?.spawnError), spawnExecutable: child?.spawnExecutable === SIWC_NODE_EXECUTABLE ? SIWC_NODE_EXECUTABLE : null,
    spawnErrorCode: SPAWN_CODES.includes(child?.spawnErrorCode) ? child.spawnErrorCode : child?.spawnErrorCode === null ? null : 'UNKNOWN',
    spawnErrorSyscall: child?.spawnErrorSyscall === 'spawnSync ' + SIWC_NODE_EXECUTABLE ? child.spawnErrorSyscall : child?.spawnErrorSyscall === null ? null : 'other',
    spawnErrorMessage: spawnMessage(child?.spawnErrorMessage, child?.spawnErrorCode),
    stdoutType: type(child?.stdoutType), stdoutBytes: count(child?.stdoutBytes), stdoutEmpty: boolean(child?.stdoutEmpty),
    stderrType: type(child?.stderrType), stderrBytes: count(child?.stderrBytes), stderrEmpty: boolean(child?.stderrEmpty),
    jsonParsed: boolean(child?.stdoutJsonParsed), jsonExact: boolean(child?.stdoutJsonExact), schemaExact: boolean(child?.stdoutJsonSchemaExact),
    accessTokenObserved: boolean(child?.accessTokenObserved), proofPid: pid(child?.proof?.pid) ? child.proof.pid : null,
    nonceMatched: child?.proof?.nonce === token, proofPassed: passedSiwcChild(child?.proof, token, parentPid) };
}

/** Outside-tool /proc positive control. Print only PIDs/counts/booleans, never environment content. */
export function siwcAppServerObservation(token) {
  nonce(token);
  return `
const fs=require('node:fs'),sentinel=${JSON.stringify('fixture-only-siwc-' + token)};
const matches=[];let sentinelCount=0,accessTokenCount=0,scanComplete=true;
for(const id of fs.readdirSync('/proc').filter(value=>/^[1-9][0-9]*$/.test(value))){
 try{
  const args=fs.readFileSync('/proc/'+id+'/cmdline','utf8').split('\\0');
  const environment=fs.readFileSync('/proc/'+id+'/environ','utf8').split('\\0');
  const hasToken=environment.some(value=>value.startsWith('ACCESS_TOKEN='));
  const hasSentinel=environment.includes('ACCESS_TOKEN='+sentinel);
  if(hasToken)accessTokenCount++;if(hasSentinel)sentinelCount++;
  if((args[0]==='codex'||args[0].endsWith('/codex'))&&args.includes('app-server')&&args.includes('ws://127.0.0.1:4500'))matches.push({pid:Number(id),sentinelPresent:hasSentinel,accessTokenPresent:hasToken});
 }catch(error){if(error.code!=='ENOENT'&&error.code!=='ESRCH')scanComplete=false;}
}
process.stdout.write(JSON.stringify({appServerCount:matches.length,appServerPid:matches.length===1?matches[0].pid:null,
sentinelPresent:matches.length===1&&matches[0].sentinelPresent,accessTokenPresent:matches.length===1&&matches[0].accessTokenPresent,sentinelCount,accessTokenCount,scanComplete}));`;
}

export function passedSiwcAppServerObservation(value, present, previousPid) {
  return exact(value,['appServerCount','appServerPid','sentinelPresent','accessTokenPresent','sentinelCount','accessTokenCount','scanComplete'])
    && value.scanComplete === true && value.appServerCount === 1 && pid(value.appServerPid)
    && value.sentinelPresent === present && value.accessTokenPresent === present
    && value.sentinelCount === (present ? 1 : 0) && value.accessTokenCount === (present ? 1 : 0)
    && (previousPid === undefined || (pid(previousPid) && value.appServerPid !== previousPid));
}

export function siwcSocketPositiveControl() {
  return `const socket=require('node:net').connect(${JSON.stringify(SOCKET)});let done=false;
function finish(connected){if(done)return;done=true;socket.destroy();process.stdout.write(JSON.stringify({connected}));}
socket.setTimeout(1500,()=>finish(false));socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));`;
}
