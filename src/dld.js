import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DLD_URL='https://dubailand.gov.ae/en/MyDLD/#/login/sso';
const LOCAL_ROOT=process.env.JNA_LOCAL_DATA_DIR||path.join(os.homedir(),'.jna-permit-bot');
const PROFILE_DIR=process.env.DLD_PROFILE_DIR||path.join(LOCAL_ROOT,'chrome-profile');
const SESSION_PATH=process.env.DLD_SESSION_PATH||path.join(LOCAL_ROOT,'dld-storage.json');
let context,page;

async function firstVisible(p,selectors){for(const s of selectors){const l=p.locator(s).first();try{if(await l.isVisible({timeout:1200}))return l;}catch{}}return null;}
async function pageText(p){return(await p.locator('body').innerText({timeout:2500}).catch(()=>'' )).toLowerCase();}
async function saveSession(){try{fs.mkdirSync(path.dirname(SESSION_PATH),{recursive:true});await context.storageState({path:SESSION_PATH});}catch(e){console.error('Could not save session:',e.message);}}
function clearLocks(){for(const n of['SingletonLock','SingletonSocket','SingletonCookie']){try{fs.rmSync(path.join(PROFILE_DIR,n),{force:true});}catch{}}}

async function ensureSession(){
  if(context&&page&&!page.isClosed())return;
  fs.mkdirSync(PROFILE_DIR,{recursive:true});clearLocks();
  context=await chromium.launchPersistentContext(PROFILE_DIR,{channel:'chrome',headless:false,viewport:{width:1440,height:900},args:['--start-maximized']});
  page=context.pages()[0]||await context.newPage();page.setDefaultTimeout(10000);
}

async function selectBestPage(){
  if(!context)return false;const pages=context.pages().filter(p=>!p.isClosed());if(!pages.length)return false;
  const scored=[];
  for(const p of pages){const url=(p.url()||'').toLowerCase(),text=await pageText(p);let score=0;
    if(text.includes('multiple profiles found')||text.includes('real estate office admin'))score=100;
    else if(text.includes('dld application dashboard')||text.includes('trakheesi'))score=90;
    else if(text.includes('login to uae pass')||text.includes('emirates id, email, or phone')||url.includes('uaepass'))score=80;
    else if(text.includes("i'm not a robot")||text.includes('recaptcha'))score=70;
    else if(await p.locator('input[type="password"]').count().catch(()=>0))score=60;
    else if(url.includes('dubailand.gov.ae'))score=50;
    else if(url!=='about:blank')score=10;
    scored.push({p,score});}
  scored.sort((a,b)=>b.score-a.score);if(scored[0]?.score>0){page=scored[0].p;page.setDefaultTimeout(10000);return true;}return false;
}

async function switchToUaePass(){
  if(!context)return false;
  for(const p of [...context.pages()].reverse()){if(p.isClosed())continue;const url=(p.url()||'').toLowerCase(),text=await pageText(p);if(url.includes('uaepass')||text.includes('login to uae pass')||text.includes('emirates id, email, or phone')){page=p;page.setDefaultTimeout(10000);return true;}}
  return false;
}

function challenge(text){for(const r of[/(?:number|code|match|matching|shown|displayed)[^0-9]{0,100}([0-9]{2,3})/i,/([0-9]{2,3})[^0-9]{0,100}(?:number|code|match|matching|shown)/i]){const m=text.match(r);if(m)return m[1];}return null;}

async function selectAdmin(){
  const raw=await page.locator('body').innerText({timeout:5000}).catch(()=>'' );if(!/multiple profiles found/i.test(raw))return null;
  const admin=page.getByText(/REAL ESTATE OFFICE ADMIN/i).first();if(!(await admin.isVisible({timeout:4000}).catch(()=>false)))return{status:'real_estate_admin_profile_not_found',url:page.url()};
  const card=admin.locator('xpath=ancestor::*[.//input[@type="radio"]][1]');let radio=card.locator('input[type="radio"]').first();if(!(await radio.count()))radio=admin.locator('xpath=following::input[@type="radio"][1]');
  if(!(await radio.count()))return{status:'admin_profile_radio_not_found',url:page.url()};
  await radio.check({force:true});
  const proceed=await firstVisible(page,['button:has-text("Proceed")','button:has-text("Continue")','button:has-text("Submit")','button:has-text("Next")','button[type="submit"]']);
  if(proceed){await proceed.click({noWaitAfter:true}).catch(()=>{});await page.waitForTimeout(3500);}await saveSession();return{status:'real_estate_admin_profile_selected',url:page.url()};
}

async function handleUaePassModal(){
  const modal=page.locator('#application-infoUAE').first();if(!(await modal.isVisible({timeout:1200}).catch(()=>false)))return null;
  const candidates=modal.locator('button,a,[role="button"],input[type="button"],input[type="submit"],.btn,[onclick]');let target=null;
  for(let i=0;i<await candidates.count();i++){const el=candidates.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;const label=((await el.innerText().catch(()=>''))+' '+(await el.getAttribute('value').catch(()=>''))).trim();if(/uae\s*pass/i.test(label)&&!/stay\s+on\s+dashboard/i.test(label)){target=el;break;}}
  if(!target)return{status:'uae_pass_modal_button_not_found',url:page.url()};
  const popup=context.waitForEvent('page',{timeout:5000}).catch(()=>null);await target.click({force:true,noWaitAfter:true});const p=await popup;if(p){page=p;page.setDefaultTimeout(10000);}await page.waitForTimeout(2500);await switchToUaePass();return submitUaePassId();
}

async function detectState(){
  await selectBestPage();const raw=await page.locator('body').innerText({timeout:5000}).catch(()=>''),text=raw.toLowerCase(),url=page.url();
  if(/multiple profiles found/i.test(raw))return selectAdmin();
  const c=challenge(raw);if(c)return{status:'uae_pass_approval_required',challenge:c,url};
  const captcha=text.includes("i'm not a robot")||text.includes('recaptcha')||(await page.locator('iframe[src*="recaptcha"],iframe[title*="recaptcha" i]').count().catch(()=>0))>0;if(captcha)return{status:'captcha_required',url};
  if(text.includes('login to uae pass')||text.includes('emirates id, email, or phone')||url.toLowerCase().includes('uaepass'))return{status:'uae_pass',url};
  const modal=await handleUaePassModal().catch(()=>null);if(modal)return modal;
  if(text.includes('dld application dashboard')||text.includes('trakheesi')){await saveSession();return{status:'session_active',url};}
  if(text.includes('authentication code'))return{status:'authentication_code',url};
  if(await page.locator('input[type="password"]').count().catch(()=>0))return{status:'login_form',url};
  return{status:'post_login_unknown',url,title:await page.title().catch(()=>'' )};
}

async function submitUaePassId(){
  await switchToUaePass();const eid=process.env.UAE_PASS_EMIRATES_ID;if(!eid)return{status:'uae_pass_id_required',url:page.url()};
  const input=await firstVisible(page,['input[placeholder*="Emirates ID, email, or phone" i]','input[placeholder*="Emirates ID" i]','input[aria-label*="Emirates ID" i]','input[type="text"]','input[type="tel"]']);
  if(!input)return{status:'uae_pass_id_field_not_found',url:page.url()};await input.fill(eid);
  const btn=await firstVisible(page,['button:has-text("Login")','button:has-text("Sign in")','button[type="submit"]','input[type="submit"]']);if(!btn)return{status:'uae_pass_login_button_not_found',url:page.url()};
  await btn.click({noWaitAfter:true});await page.waitForTimeout(3500);return detectState();
}

async function clickTrakheesi(){
  const t=page.getByText('Trakheesi',{exact:true}).first();if(!(await t.isVisible({timeout:5000}).catch(()=>false)))return{status:'trakheesi_not_found',url:page.url()};
  const card=t.locator('xpath=ancestor::*[.//button or .//a][1]');let btn=card.getByRole('button',{name:/login with uae pass/i}).first();if(!(await btn.isVisible().catch(()=>false)))btn=card.getByText(/login with uae pass/i).first();if(!(await btn.isVisible().catch(()=>false)))return{status:'trakheesi_uae_pass_button_not_found',url:page.url()};
  await btn.click({noWaitAfter:true});await page.waitForTimeout(1000);const m=await handleUaePassModal();return m||detectState();
}

export async function startInteractiveDldLogin(){
  const u=process.env.DLD_USERNAME,p=process.env.DLD_PASSWORD;if(!u||!p)return{status:'missing_credentials'};await ensureSession();await selectBestPage();
  if(page&&page.url()!=='about:blank'){const existing=await detectState();if(['session_active','real_estate_admin_profile_selected','uae_pass','uae_pass_approval_required','captcha_required','login_form'].includes(existing.status))return existing;}
  await page.goto(DLD_URL,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(3000);
  const body=await pageText(page);if(body.includes('dld application dashboard')){if(body.includes('trakheesi')&&body.includes('login with uae pass'))return clickTrakheesi();await saveSession();return{status:'session_active',url:page.url()};}
  const user=await firstVisible(page,['input[name="username"]','input[name="Username"]','input[type="text"][placeholder*="user" i]','input[type="email"]','input[type="text"]']);
  const pass=await firstVisible(page,['input[type="password"]']);if(!user||!pass)return{status:'login_form_not_found',url:page.url()};await user.fill(u);await pass.fill(p);return detectState();
}

export async function continueAfterCaptcha(){if(!page||page.isClosed())return{status:'no_active_session'};try{await selectBestPage();const m=await handleUaePassModal();if(m)return m;const raw=await page.locator('body').innerText({timeout:5000}).catch(()=>''),body=raw.toLowerCase();if(body.includes('dld application dashboard')&&body.includes('trakheesi')){if(body.includes('login with uae pass'))return clickTrakheesi();return{status:'session_active',url:page.url()};}if(/multiple profiles found/i.test(raw))return selectAdmin();if(body.includes('login to uae pass')||body.includes('emirates id, email, or phone'))return detectState();const btn=await firstVisible(page,['button:has-text("Sign In")','input[type="submit"]','button[type="submit"]']);if(btn){await btn.click({noWaitAfter:true});await page.waitForTimeout(4000);}return detectState();}catch(error){return{status:'continue_error',message:error.message,url:page?.url?.()||''};}}
export async function continueUaePassLogin(){if(!page||page.isClosed())return{status:'no_active_session'};try{return await submitUaePassId();}catch(error){return{status:'uae_pass_error',message:error.message,url:page?.url?.()||''};}}
export async function checkUaePassStatus(){if(!page||page.isClosed())return{status:'no_active_session'};try{await page.waitForTimeout(1000);const s=await detectState();if(['session_active','real_estate_admin_profile_selected'].includes(s.status))await saveSession();return s;}catch(error){return{status:'uae_pass_check_error',message:error.message,url:page?.url?.()||''};}}
export async function testDldLogin(){try{return await startInteractiveDldLogin();}catch(error){return{status:'agent_error',message:error.message};}}
