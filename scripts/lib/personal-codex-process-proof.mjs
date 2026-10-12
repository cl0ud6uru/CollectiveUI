const workspace = '/home/agent/workspace';
const fixtureToken = token => {
  if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error('Invalid synthetic process nonce.');
  return token;
};

// Hold the exact native command until the outer fixture observes its live PID
// namespace. This grants the tool no new filesystem or process permissions.
export function heldProcessCommand(script, token) {
  fixtureToken(token);
  return `
const processProofFs = require('node:fs');
const fixtureProcessNonce = ${JSON.stringify(token)};
processProofFs.writeFileSync(${JSON.stringify(workspace + '/fixture-tool-ready-' + token + '.json')},JSON.stringify({nonce:fixtureProcessNonce,pid:process.pid}));
const processProofDeadline = setTimeout(()=>{throw new Error('Outer PID namespace observation timed out.');},3500);
const processProofWait = setInterval(()=>{
  if(!processProofFs.existsSync(${JSON.stringify(workspace + '/fixture-tool-release-' + token)}))return;
  clearInterval(processProofWait);clearTimeout(processProofDeadline);
  ${script}
},25);`;
}

// Executes outside the native tool in its disposable container, as the same
// unprivileged fixture UID. Never inspect accounts or real credential volumes.
export function observeProcessCommand(token) {
  fixtureToken(token);
  return `
const fs=require('node:fs');
const nonce=${JSON.stringify(token)},workspace=${JSON.stringify(workspace)};
(async()=>{
  let observation={ready:false,nonce};
  try {
    const readyPath=workspace+'/fixture-tool-ready-'+nonce+'.json';
    for(let i=0;i<45&&!fs.existsSync(readyPath);i++)await new Promise(resolve=>setTimeout(resolve,50));
    if(!fs.existsSync(readyPath))throw new Error('Native held process did not become ready.');
    const ready=JSON.parse(fs.readFileSync(readyPath,'utf8'));
    const parent=JSON.parse(fs.readFileSync(workspace+'/fixture-parent.json','utf8'));
    if(ready.nonce!==nonce||!Number.isSafeInteger(ready.pid)||ready.pid<=0)throw new Error('Invalid held process identity.');
    const candidates=[];
    for(const pid of fs.readdirSync('/proc').filter(value=>/^[1-9][0-9]*$/.test(value)&&Number(value)!==process.pid)){
      let args;try{args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0');}catch{continue;}
      if((args[0]==='node'||args[0].endsWith('/node'))&&args[1]==='-e'&&args[2].includes('const fixtureProcessNonce = '+JSON.stringify(nonce)+';'))candidates.push(Number(pid));
    }
    if(candidates.length!==1)throw new Error('Held native Node process match count: '+candidates.length);
    const toolOuterPid=candidates[0];
    process.kill(parent.pid,0); // Read-only liveness positive control, no delivered signal.
    observation={ready:true,nonce,toolPid:ready.pid,toolOuterPid,parentOuterPid:parent.pid,parentAlive:true,node:process.versions.node,uv:process.versions.uv};
    observation.parentNamespace=fs.readlinkSync('/proc/'+parent.pid+'/ns/pid');
    observation.observerNamespace=fs.readlinkSync('/proc/self/ns/pid');
    observation.toolNamespace=fs.readlinkSync('/proc/'+toolOuterPid+'/ns/pid');
  }catch(error){observation={...observation,error:{code:error.code??null,message:String(error.message).slice(0,512)}};}
  try{fs.writeFileSync(workspace+'/fixture-tool-release-'+nonce,'fixture-release');}
  catch(error){observation.releaseError={code:error.code??null,message:String(error.message).slice(0,512)};}
  process.stdout.write(JSON.stringify(observation));
})();`;
}

export function passedProcessObservation(value, parent, token) {
  const namespace = name => typeof name === 'string' && /^pid:\[[1-9][0-9]*\]$/.test(name);
  return value?.ready === true && value.nonce === token && !value.error && !value.releaseError && value.parentAlive === true
    && Number.isSafeInteger(parent?.pid) && parent.pid > 0
    && Number.isSafeInteger(value.toolPid) && value.toolPid > 0
    && Number.isSafeInteger(value.toolOuterPid) && value.toolOuterPid > 0 && value.toolOuterPid !== parent?.pid
    && value.parentOuterPid === parent?.pid && namespace(parent?.pidNamespace)
    && value.parentNamespace === parent.pidNamespace && value.observerNamespace === parent.pidNamespace
    && namespace(value.toolNamespace) && value.toolNamespace !== parent.pidNamespace;
}
