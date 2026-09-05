const PIXXI_BASE='https://pixxicrm.ae/api';
let cachedToken=null;
let tokenExpiresAt=0;

function adminCredentials(){
  const email=process.env.PIXXI_ADMIN_EMAIL||'';
  const password=process.env.PIXXI_ADMIN_PASSWORD||'';
  if(!email||!password)throw new Error('Missing PIXXI_ADMIN_EMAIL or PIXXI_ADMIN_PASSWORD');
  return{email,password};
}

function extractToken(data){
  return data?.data?.accessToken||data?.data?.token||data?.data?.access_token||data?.accessToken||data?.token||data?.access_token||null;
}

function normalizePhone(value=''){
  const digits=String(value).replace(/\D/g,'');
  if(!digits)return'';
  if(digits.startsWith('971'))return digits;
  if(digits.startsWith('0'))return`971${digits.slice(1)}`;
  if(digits.length===9)return`971${digits}`;
  return digits;
}

export async function pixxiLogin(force=false){
  if(!force&&cachedToken&&Date.now()<tokenExpiresAt)return cachedToken;
  const {email,password}=adminCredentials();
  const response=await fetch(`${PIXXI_BASE}/login`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:email,password})
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(`Pixxi admin login failed (${response.status}): ${data?.message||data?.msg||'unknown error'}`);
  const token=extractToken(data);
  if(!token)throw new Error(`Pixxi admin login succeeded but no bearer token was returned${data?.message?`: ${data.message}`:''}`);
  cachedToken=token;
  tokenExpiresAt=Date.now()+45*60*1000;
  return token;
}

async function pixxiRequest(pathname,{method='GET',body}={}){
  for(let attempt=1;attempt<=2;attempt++){
    const token=await pixxiLogin(attempt===2);
    const response=await fetch(`${PIXXI_BASE}${pathname}`,{
      method,
      headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body)
    });
    if((response.status===401||response.status===403)&&attempt===1){cachedToken=null;tokenExpiresAt=0;continue;}
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(`Pixxi ${method} ${pathname} failed (${response.status})`);
    return data;
  }
  throw new Error('Pixxi request failed after re-authentication');
}

export async function findPixxiAgentByMobile(mobile){
  const wanted=normalizePhone(mobile);
  if(!wanted)throw new Error('Agent mobile is required');
  const query=encodeURIComponent(String(mobile).replace(/^\+/,''));
  const data=await pixxiRequest(`/system/user/list?nickName=${query}&pageNum=1&deptId=1406&pageSize=50`);
  const candidates=data?.data?.list||data?.data?.records||data?.data||[];
  const rows=Array.isArray(candidates)?candidates:[];
  const exact=rows.find(row=>normalizePhone(row?.phone||row?.mobile||row?.tel)===wanted);
  if(exact)return exact;
  return rows.find(row=>normalizePhone(row?.phone||row?.mobile||row?.tel).endsWith(wanted.slice(-9)))||null;
}

export function extractListingReference(data){
  const root=data?.data||data||{};
  return String(root?.listingRef||root?.referenceNo||root?.refNo||root?.propertyRef||root?.propertyCode||root?.id||root?.propertyId||'').trim();
}

export async function createPixxiListing(payload){
  if(!payload||typeof payload!=='object')throw new Error('Pixxi listing payload is required');
  const data=await pixxiRequest('/v1/property',{method:'POST',body:payload});
  const listingRef=extractListingReference(data);
  if(!listingRef)throw new Error('Pixxi listing was created but no listing reference/id was returned');
  return{listingRef,data};
}

export async function getPixxiCurrentUser(){
  return pixxiRequest('/v1/user/getInfo');
}
