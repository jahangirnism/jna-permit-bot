const PIXXI_BASE='https://pixxicrm.ae/api';
let cachedToken=null;
let tokenExpiresAt=0;

function adminCredentials(){
  const email=process.env.PIXXI_ADMIN_EMAIL||'';
  const password=process.env.PIXXI_ADMIN_PASSWORD||'';
  if(!email||!password)throw new Error('Missing PIXXI_ADMIN_EMAIL or PIXXI_ADMIN_PASSWORD');
  return{email,password};
}

function extractToken(data){return data?.data?.accessToken||data?.data?.token||data?.data?.access_token||data?.accessToken||data?.token||data?.access_token||null;}
function normalizePhone(value=''){const digits=String(value).replace(/\D/g,'');if(!digits)return'';if(digits.startsWith('971'))return digits;if(digits.startsWith('0'))return`971${digits.slice(1)}`;if(digits.length===9)return`971${digits}`;return digits;}
function looksLikeStaffRow(row){return row&&typeof row==='object'&&!Array.isArray(row)&&(row.id||row.userId||row.staffId||row.nickName||row.realName||row.name||row.phone||row.mobile||row.tel||row.email||row.brn||row.BRN||row.agentBRN);}
function staffRows(data){
  const direct=[data?.data?.list,data?.data?.records,data?.data?.rows,data?.data?.content,data?.data?.items,data?.list,data?.records,data?.rows,data?.content,data?.items,Array.isArray(data?.data)?data.data:null];
  for(const value of direct){if(Array.isArray(value)&&value.some(looksLikeStaffRow))return value;}
  const queue=[data?.data,data].filter(Boolean),seen=new Set();
  while(queue.length){const node=queue.shift();if(!node||typeof node!=='object'||seen.has(node))continue;seen.add(node);if(Array.isArray(node)){if(node.some(looksLikeStaffRow))return node;for(const item of node)queue.push(item);}else{for(const value of Object.values(node))if(value&&typeof value==='object')queue.push(value);}}
  return[];
}

export async function pixxiLogin(force=false){
  if(!force&&cachedToken&&Date.now()<tokenExpiresAt)return cachedToken;
  const {email,password}=adminCredentials();
  const response=await fetch(`${PIXXI_BASE}/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:email,password})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(`Pixxi admin login failed (${response.status}): ${data?.message||data?.msg||'unknown error'}`);
  const token=extractToken(data);if(!token)throw new Error(`Pixxi admin login succeeded but no bearer token was returned${data?.message?`: ${data.message}`:''}`);
  cachedToken=token;tokenExpiresAt=Date.now()+45*60*1000;return token;
}

async function pixxiRequest(pathname,{method='GET',body}={}){
  for(let attempt=1;attempt<=2;attempt++){
    const token=await pixxiLogin(attempt===2);
    const response=await fetch(`${PIXXI_BASE}${pathname}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    if((response.status===401||response.status===403)&&attempt===1){cachedToken=null;tokenExpiresAt=0;continue;}
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(`Pixxi ${method} ${pathname} failed (${response.status}): ${data?.message||data?.msg||data?.error||'unknown error'}`);
    return data;
  }
  throw new Error('Pixxi request failed after re-authentication');
}

async function getPixxiStaffDetail(staffId){if(!staffId)return null;const data=await pixxiRequest(`/system/user/${encodeURIComponent(String(staffId))}`);return data?.data||data||null;}
export async function findPixxiAgentByMobile(mobile){
  const wanted=normalizePhone(mobile);if(!wanted)throw new Error('Agent mobile is required');
  for(let pageNum=1;pageNum<=10;pageNum++){
    const data=await pixxiRequest(`/system/user/list?pageNum=${pageNum}&deptId=1406&pageSize=100`),rows=staffRows(data);
    const exact=rows.find(row=>normalizePhone(row?.phone||row?.mobile||row?.tel)===wanted);
    const suffix=exact||rows.find(row=>{const phone=normalizePhone(row?.phone||row?.mobile||row?.tel);return phone&&phone.endsWith(wanted.slice(-9));});
    if(suffix){const staffId=suffix?.id||suffix?.userId||suffix?.staffId;if(!staffId)return suffix;try{const detail=await getPixxiStaffDetail(staffId);return detail&&typeof detail==='object'?{...suffix,...detail}:suffix;}catch(error){console.warn(`Pixxi staff detail lookup failed for ${staffId}:`,error.message);return suffix;}}
    if(rows.length>0&&rows.length<100)break;if(rows.length===0)break;
  }
  return null;
}
export async function getPixxiStaffDebug(){const data=await pixxiRequest('/system/user/list?pageNum=1&deptId=1406&pageSize=100');const rows=staffRows(data);return{rowCount:rows.length,topLevelKeys:Object.keys(data||{}).slice(0,20),dataKeys:data?.data&&typeof data.data==='object'&&!Array.isArray(data.data)?Object.keys(data.data).slice(0,20):[],samples:rows.slice(0,5).map(row=>({id:row?.id||row?.userId||row?.staffId||'',name:row?.nickName||row?.realName||row?.name||row?.userName||'',phone:row?.phone||row?.mobile||row?.tel||''}))};}
export function pixxiAgentSummary(row={}){return{id:row?.id||row?.userId||row?.staffId||'',name:row?.nickName||row?.realName||row?.name||row?.userName||row?.username||'',phone:row?.phone||row?.mobile||row?.tel||'',email:row?.email||row?.mail||'',brn:row?.agentBRN||row?.brn||row?.BRN||row?.brokerRegistrationNumber||row?.brokerNo||'',role:row?.roleName||row?.role||row?.position||''};}

function findReferenceDeep(value,seen=new Set()){
  if(value==null)return'';
  if(typeof value==='string'){const m=value.match(/\bJandA-[RS]-\d+\b/i);return m?.[0]||'';}
  if(typeof value!=='object'||seen.has(value))return'';seen.add(value);
  if(Array.isArray(value)){for(const item of value){const hit=findReferenceDeep(item,seen);if(hit)return hit;}return'';}
  const preferred=['listingRef','listingReference','referenceNo','refNo','propertyRef','propertyCode','reference','ref'];
  for(const key of preferred){if(value[key]!=null){const raw=String(value[key]).trim();const m=raw.match(/\bJandA-[RS]-\d+\b/i);if(m)return m[0];if(raw)return raw;}}
  for(const child of Object.values(value)){const hit=findReferenceDeep(child,seen);if(hit)return hit;}
  return'';
}
export function extractListingReference(data){
  const explicit=findReferenceDeep(data);if(explicit)return explicit;
  const root=data?.data||data||{};
  return String(root?.id||root?.propertyId||data?.id||data?.propertyId||'').trim();
}
function pixxiBodyFailure(data){
  const code=Number(data?.statusCode??data?.code);
  if(Number.isFinite(code)&&code>=400)return data?.message||data?.msg||data?.error||`Pixxi returned status ${code}`;
  if(data?.success===false)return data?.message||data?.msg||data?.error||'Pixxi reported the create request failed';
  return'';
}
export async function createPixxiListing(payload){
  if(!payload||typeof payload!=='object')throw new Error('Pixxi listing payload is required');
  const data=await pixxiRequest('/v1/property',{method:'POST',body:payload});
  const failure=pixxiBodyFailure(data);if(failure)throw new Error(`Pixxi listing creation failed: ${failure}`);
  const listingRef=extractListingReference(data);
  if(!listingRef)throw new Error(`Pixxi did not confirm listing creation or return a CRM reference. Response keys: ${Object.keys(data||{}).slice(0,12).join(', ')||'none'}`);
  return{listingRef,data};
}

export async function getPixxiCurrentUser(){await pixxiLogin();try{return await pixxiRequest('/v1/user/getInfo');}catch(error){if(/\/v1\/user\/getInfo failed \(404\)/.test(error.message))return{data:{name:'Admin account',email:process.env.PIXXI_ADMIN_EMAIL||'',authenticated:true,profileEndpointUnavailable:true}};throw error;}}
