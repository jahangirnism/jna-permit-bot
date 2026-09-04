import http from 'node:http';
import crypto from 'node:crypto';

const queue=[];
const pending=new Map();
const secret=process.env.AGENT_SHARED_SECRET||'';

function json(res,status,body){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));}
function authorized(req){const auth=req.headers.authorization||'';return secret&&auth===`Bearer ${secret}`;}

export function startAgentRelay(){
  const port=Number(process.env.PORT||8080);
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/health')return json(res,200,{ok:true,mode:'local-agent'});
    if(!authorized(req))return json(res,401,{ok:false,error:'unauthorized'});

    if(req.method==='GET'&&req.url==='/agent/poll'){
      const task=queue.shift()||null;
      return json(res,200,{ok:true,task});
    }

    if(req.method==='POST'&&req.url==='/agent/result'){
      let raw='';for await(const chunk of req)raw+=chunk;
      let body;try{body=JSON.parse(raw||'{}');}catch{return json(res,400,{ok:false,error:'invalid_json'});}
      const waiter=pending.get(body.id);
      if(!waiter)return json(res,404,{ok:false,error:'unknown_task'});
      pending.delete(body.id);
      waiter.resolve(body.result||{status:'agent_error',message:'Local agent returned no result'});
      return json(res,200,{ok:true});
    }

    return json(res,404,{ok:false,error:'not_found'});
  });
  server.listen(port,()=>console.log(`Agent relay listening on ${port}`));
}

export function runBrowserTask(type,payload={},timeoutMs=60000){
  if(!secret)return Promise.resolve({status:'agent_not_configured',message:'AGENT_SHARED_SECRET is missing on Railway.'});
  const id=crypto.randomUUID();
  const task={id,type,payload,createdAt:Date.now()};
  queue.push(task);
  return new Promise(resolve=>{
    const timer=setTimeout(()=>{pending.delete(id);resolve({status:'agent_offline',message:'Local browser agent did not respond in time.'});},timeoutMs);
    pending.set(id,{resolve:(result)=>{clearTimeout(timer);resolve(result);}});
  });
}
