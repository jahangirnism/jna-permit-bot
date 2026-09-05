import { createPixxiListing } from './pixxi.js';

function clean(value){return String(value??'').trim();}
function number(value){const n=Number(String(value??'').replace(/,/g,''));return Number.isFinite(n)?n:0;}

export function normalizeHouseType(value){
  const v=clean(value).toUpperCase().replace(/[\s-]+/g,'_');
  const allowed=new Set(['APARTMENT','VILLA','TOWNHOUSE','OFFICE','LAND']);
  if(!allowed.has(v))throw new Error('Property type must be APARTMENT, VILLA, TOWNHOUSE, OFFICE, or LAND');
  return v;
}

export function normalizeCompletion(value){
  const v=clean(value).toUpperCase().replace(/[\s-]+/g,'_');
  if(['READY','COMPLETED','COMPLETE'].includes(v))return 'COMPLETED';
  if(['OFF_PLAN','OFFPLAN'].includes(v))return 'OFF_PLAN';
  if(['OFF_PLAN_PRIMARY','OFFPLAN_PRIMARY'].includes(v))return 'OFF_PLAN_PRIMARY';
  throw new Error('Completion status must be READY/COMPLETED, OFF_PLAN, or OFF_PLAN_PRIMARY');
}

function normalizeFurnishing(value){
  const v=clean(value).toUpperCase().replace(/[\s-]+/g,'_');
  if(['HAS','FULLY_FURNISHED','FURNISHED','FULL'].includes(v))return 'HAS';
  if(['SEMI','SEMI_FURNISHED','PARTLY_FURNISHED','PART_FURNISHED'].includes(v))return 'SEMI';
  if(['NONE','UNFURNISHED','NOT_FURNISHED'].includes(v))return 'NONE';
  return clean(value);
}

export function bedroomNumber(value){
  const v=clean(value);
  if(/studio/i.test(v))return 0;
  const m=v.match(/\d+/);return m?Number(m[0]):0;
}

export function formatJnAListingReference(rawReference,listingType){
  const raw=clean(rawReference);
  const suffix=raw.match(/(\d{3,})\s*$/)?.[1]||'';
  if(!suffix)return raw;
  const code=/sale|sell/i.test(clean(listingType))?'S':'R';
  return `JnA_${code}_${suffix}`;
}

export function pixxiListingPayload(state={}){
  if(!state.generated?.title||!state.generated?.description)throw new Error('AI listing draft is missing');
  const propertyType=/sale|sell/i.test(clean(state.listingType))?'SELL':'RENT';
  const houseType=normalizeHouseType(state.crmHouseType);
  // RENT listings are necessarily ready/completed in this workflow. Completion
  // choices are only collected for SALE listings.
  const completionStatus=propertyType==='RENT'?'COMPLETED':normalizeCompletion(state.completionStatus);
  const payload={
    name:state.generated.title,
    description:state.generated.description,
    propertyType,
    houseType:[houseType],
    bedRoomNum:bedroomNumber(state.bedrooms),
    size:number(state.size),
    price:Math.round(number(state.price)),
    isFurniture:normalizeFurnishing(state.furnishing),
    views:clean(state.view)?[clean(state.view)]:[],
    status:'ACTIVE',cityId:41,cityName:'Dubai'
  };
  if(propertyType==='SELL')payload.sellParameter={completionStatus};
  else payload.rentParameter={completionStatus:'COMPLETED'};
  return payload;
}

export async function createListingFromDraft(state={}){
  const payload=pixxiListingPayload(state);
  const result=await createPixxiListing(payload);
  const pixxiListingRef=result.listingRef;
  const listingRef=formatJnAListingReference(pixxiListingRef,state.listingType);
  return{...result,pixxiListingRef,listingRef,payload};
}

function dubaiTodayParts(){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Dubai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const obj={};for(const p of parts)if(p.type!=='literal')obj[p.type]=p.value;
  return{year:Number(obj.year),month:Number(obj.month),day:Number(obj.day)};
}
function fmtDate(date){return `${String(date.getUTCDate()).padStart(2,'0')}/${String(date.getUTCMonth()+1).padStart(2,'0')}/${date.getUTCFullYear()}`;}
export function contractDates(){
  const p=dubaiTodayParts();
  const start=new Date(Date.UTC(p.year,p.month-1,p.day));
  const end=new Date(start);end.setUTCMonth(end.getUTCMonth()+4);
  return{startDate:fmtDate(start),endDate:fmtDate(end)};
}

export function nocPayload(state={}){
  const {startDate,endDate}=contractDates();
  const agent=state.nocAgent||{};
  const house=normalizeHouseType(state.crmHouseType);
  const labels={APARTMENT:'Apartment',VILLA:'Villa',TOWNHOUSE:'Townhouse',OFFICE:'Office',LAND:'Land'};
  const listingType=/sale|sell/i.test(clean(state.listingType))?'SALE':'RENT';
  const completionStatus=listingType==='RENT'?'COMPLETED':normalizeCompletion(state.completionStatus);
  return{
    agentName:agent.name||'',agentBRN:agent.brn||'',agentMobile:agent.phone||'',agentEmail:agent.email||'',
    owner1Name:clean(state.ownerName),owner1ID:clean(state.ownerId),owner1Mobile:clean(state.ownerMobile),owner1Email:clean(state.ownerEmail),
    owner2Name:'',owner2ID:'',owner2Mobile:'',owner2Email:'',
    propLocation:[clean(state.building),clean(state.area)].filter(Boolean).join(', '),propArea:clean(state.area),
    titleDeed:clean(state.titleDeedNo),plotNo:clean(state.plotNo),unitNo:clean(state.unitNo),
    propSize:clean(state.size),propParking:clean(state.parking)||'1',listingPrice:clean(state.price),
    bedsLabel:clean(state.bedrooms),propTypeLabel:labels[house],propTypeValue:house,
    completionStatus,startDate,endDate,
    commission:clean(state.commission),contractType:state.contractType==='EXCLUSIVE'?'Exclusive':'Non-Exclusive'
  };
}

export async function generateNocPdf(state={}){
  const base=clean(process.env.LISTING_SERVICE_URL).replace(/\/$/,'');
  if(!base)throw new Error('Missing LISTING_SERVICE_URL in Railway Variables');
  const payload=nocPayload(state);
  const response=await fetch(`${base}/generate-pdf`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  if(!response.ok){
    let msg=`HTTP ${response.status}`;try{const data=await response.json();msg=data?.error||data?.message||msg;}catch{}
    throw new Error(`NOC PDF generation failed: ${msg}`);
  }
  const buffer=Buffer.from(await response.arrayBuffer());
  if(!buffer.length)throw new Error('NOC PDF generator returned an empty file');
  const safe=(clean(state.ownerName)||'Contract').replace(/[^A-Za-z0-9_-]+/g,'_');
  return{buffer,fileName:`JnAHouse_A2_${safe}.pdf`,payload};
}
