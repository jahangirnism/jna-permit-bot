import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

const {Client}=pg;
const ownerId=process.env.RAILWAY_DEPLOYMENT_ID||process.env.RAILWAY_REPLICA_ID||randomUUID();
const fallbackPath=process.env.BOT_STATE_PATH||path.join(os.tmpdir(),'jna-permit-bot-state.json');
let db=null;
let fallback={listingAi:{}};
let leaseTimer=null;

async function loadFallback(){
  try{fallback=JSON.parse(await fs.readFile(fallbackPath,'utf8'));}
  catch{fallback={listingAi:{}};}
  if(!fallback.listingAi)fallback.listingAi={};
}
async function saveFallback(){
  await fs.writeFile(fallbackPath,JSON.stringify(fallback,null,2),'utf8').catch(()=>{});
}

export async function initRuntimeState(){
  if(process.env.DATABASE_URL){
    try{
      db=new Client({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSLMODE==='disable'?false:{rejectUnauthorized:false}});
      await db.connect();
      await db.query(`CREATE TABLE IF NOT EXISTS jna_bot_runtime_state (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.query(`CREATE TABLE IF NOT EXISTS jna_bot_lease (
        name TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      )`);
      console.log('Persistent runtime state: PostgreSQL connected');
      return{persistent:true,backend:'postgres'};
    }catch(error){
      console.error('PostgreSQL runtime state unavailable; falling back to local JSON:',error.message);
      if(db){await db.end().catch(()=>{});db=null;}
    }
  }
  await loadFallback();
  console.warn(`Persistent runtime state fallback: ${fallbackPath}. Add DATABASE_URL for cross-deployment persistence and single-poller protection.`);
  return{persistent:false,backend:'file'};
}

export async function loadListingAiStates(){
  if(db){
    const {rows}=await db.query("SELECT key,value FROM jna_bot_runtime_state WHERE key LIKE 'listing-ai:%'");
    const out=new Map();
    for(const row of rows){const chatId=row.key.slice('listing-ai:'.length);out.set(Number(chatId)||chatId,row.value);}
    return out;
  }
  return new Map(Object.entries(fallback.listingAi||{}).map(([k,v])=>[Number(k)||k,v]));
}

export async function saveListingAiState(chatId,state){
  const key=`listing-ai:${chatId}`;
  const clean=JSON.parse(JSON.stringify(state||{}));
  if(db){
    await db.query(`INSERT INTO jna_bot_runtime_state(key,value,updated_at) VALUES($1,$2::jsonb,NOW())
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,[key,JSON.stringify(clean)]);
    return;
  }
  fallback.listingAi[String(chatId)]=clean;await saveFallback();
}

export async function deleteListingAiState(chatId){
  const key=`listing-ai:${chatId}`;
  if(db){await db.query('DELETE FROM jna_bot_runtime_state WHERE key=$1',[key]);return;}
  delete fallback.listingAi[String(chatId)];await saveFallback();
}

async function renewLease(){
  if(!db)return true;
  const {rows}=await db.query(`INSERT INTO jna_bot_lease(name,owner,expires_at)
    VALUES('telegram-poller',$1,NOW()+INTERVAL '35 seconds')
    ON CONFLICT(name) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at
    WHERE jna_bot_lease.expires_at < NOW() OR jna_bot_lease.owner=$1
    RETURNING owner`,[ownerId]);
  return rows[0]?.owner===ownerId;
}

export async function waitForTelegramLease(){
  if(!db){console.warn('Telegram single-poller lease disabled because DATABASE_URL is unavailable.');return true;}
  // Give Railway rolling deployments time to drain the previous revision before polling Telegram.
  await new Promise(r=>setTimeout(r,20000));
  while(true){
    if(await renewLease())break;
    console.log('Another JnA bot deployment owns Telegram polling. Waiting for its lease to expire...');
    await new Promise(r=>setTimeout(r,5000));
  }
  console.log(`Telegram polling lease acquired by ${ownerId}`);
  leaseTimer=setInterval(()=>{renewLease().catch(e=>console.error('Telegram lease heartbeat failed:',e.message));},10000);
  leaseTimer.unref?.();
  return true;
}

export async function releaseTelegramLease(){
  if(leaseTimer){clearInterval(leaseTimer);leaseTimer=null;}
  if(db)await db.query("DELETE FROM jna_bot_lease WHERE name='telegram-poller' AND owner=$1",[ownerId]).catch(()=>{});
}

export async function closeRuntimeState(){
  await releaseTelegramLease();
  if(db){await db.end().catch(()=>{});db=null;}
}
