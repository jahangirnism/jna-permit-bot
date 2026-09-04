import { testDldLogin, continueAfterCaptcha, continueUaePassLogin, checkUaePassStatus } from './dld.js';

const base=(process.env.COORDINATOR_URL||'').replace(/\/$/,'');
const secret=process.env.AGENT_SHARED_SECRET||'';
if(!base||!secret){console.error('Missing COORDINATOR_URL or AGENT_SHARED_SECRET');process.exit(1);}

async function api(path,options={}){
  const res=await fetch(`${base}${path}`,{...options,headers:{authorization:`Bearer ${secret}`,'content-type':'application/json',...(options.headers||{})}});
  if(!res.ok)throw new Error(`${path} failed (${res.status})`);
  return res.json();
}

async function execute(task){
  switch(task.type){
    case 'test_login': return testDldLogin();
    case 'continue': return continueAfterCaptcha();
    case 'uae_pass': return continueUaePassLogin();
    case 'check_uae_pass': return checkUaePassStatus();
    default:return{status:'agent_error',message:`Unknown task: ${task.type}`};
  }
}

console.log('JnA local browser agent started. Keep this terminal open.');
while(true){
  try{
    const {task}=await api('/agent/poll');
    if(!task){await new Promise(r=>setTimeout(r,1500));continue;}
    console.log(`Running browser task ${task.type}`);
    let result;
    try{result=await execute(task);}catch(error){result={status:'agent_error',message:error.message};}
    await api('/agent/result',{method:'POST',body:JSON.stringify({id:task.id,result})});
  }catch(error){console.error('Agent connection error:',error.message);await new Promise(r=>setTimeout(r,3000));}
}
