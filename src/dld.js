import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const DLD_URL='https://dubailand.gov.ae/en/MyDLD/#/login/sso';
const SESSION_PATH=process.env.DLD_SESSION_PATH||'/data/dld-storage.json';
const PROFILE_DIR=process.env.DLD_PROFILE_DIR||'/data/chromium-profile';
let context,page;

async function firstVisible(p,selectors){for(const s of selectors){const l=p.locator(s).first();try{if(await l.isVisible({timeout:1200}))return l;}catch{}}return null;}
function browserUrl(){const e=process.env.BROWSER_PUBLIC_URL;if(e)return e.replace(/\/$/,'')+'/vnc.html?autoconnect=true&resize=scale';const d=process.env.RAILWAY_PUBLIC_DOMAIN;return d?`https://${d}/vnc.html?autoconnect=true&resize=scale`:null;}
async function saveSession(){try{fs.mkdirSync(path.dirname(SESSION_PATH),{recursive:true});await context.storageState({path:SESSION_PATH});}catch(e){console.error('Could not save DLD session:',e.message);}}
function clearLocks(){for(const n of['SingletonLock','SingletonSocket','SingletonCookie']){try{fs.rmSync(path.join(PROFILE_DIR,n),{force:true});}catch{}}}
async function ensureSession(){if(context&&page&&!page.isClosed())return;fs.mkdirSync(PROFILE_DIR,{recursive:true});clearLocks();context=await chromium.launchPersistentContext(PROFILE_DIR,{headless:false,viewport:{width:1365,height:768},args:['--no-sandbox','--disable-dev-shm-usage','--window-size=1440,900']});page=context.pages()[0]||await context.newPage();page.setDefaultTimeout(10000);}

async function switchToUaePassPage(){
  if(!context)return false;
  const pages=context.pages().filter(p=>!p.isClosed());
  for(const p of [...pages].reverse()){
    const url=(p.url()||'').toLowerCase();
    if(url.includes('uaepass')||url.includes('uae-pass')){page=p;page.setDefaultTimeout(10000);return true;}
  }
  for(const p of [...pages].reverse()){
    const text=(await p.locator('body').innerText({timeout:1500}).catch(()=>'' )).toLowerCase();
    if(text.includes('login to uae pass')||text.includes('emirates id, email, or phone')){page=p;page.setDefaultTimeout(10000);return true;}
  }
  return false;
}

function challenge(text){for(const p of[/(?:number|code|match|matching|shown|displayed)[^0-9]{0,80}([0-9]{2,3})/i,/([0-9]{2,3})[^0-9]{0,80}(?:number|code|match|matching)/i]){const m=text.match(p);if(m)return m[1];}return null;}
async function isDashboard(){const b=(await page.locator('body').innerText({timeout:5000}).catch(()=>'' )).toLowerCase();return b.includes('dld application dashboard')||b.includes('multiple profiles found');}

async function handleUaePassModal(){
  const modal=page.locator('#application-infoUAE').first();
  if(!(await modal.isVisible({timeout:1200}).catch(()=>false)))return null;
  let clicked=false;
  const candidates=modal.locator('button,a,[role="button"],input[type="button"],input[type="submit"],.btn,[onclick]');
  const count=await candidates.count().catch(()=>0);
  for(let i=0;i<count;i++){
    const el=candidates.nth(i);
    if(!(await el.isVisible({timeout:300}).catch(()=>false)))continue;
    const label=((await el.innerText().catch(()=>''))+' '+(await el.getAttribute('aria-label').catch(()=>''))+' '+(await el.getAttribute('value').catch(()=>''))).replace(/\s+/g,' ').trim();
    if(/uae\s*pass/i.test(label)&&!/stay\s+on\s+dashboard/i.test(label)){
      const popupPromise=context.waitForEvent('page',{timeout:5000}).catch(()=>null);
      await el.click({timeout:4000,noWaitAfter:true,force:true}).catch(()=>{});
      const popup=await popupPromise;
      if(popup){page=popup;page.setDefaultTimeout(10000);}
      clicked=true;break;
    }
  }
  if(!clicked){
    const popupPromise=context.waitForEvent('page',{timeout:5000}).catch(()=>null);
    clicked=await page.evaluate(()=>{
      const modal=document.querySelector('#application-infoUAE');if(!modal)return false;
      const els=[...modal.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"],.btn,[onclick]')].filter(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>20&&r.height>20&&s.display!=='none'&&s.visibility!=='hidden';});
      if(!els.length)return false;const norm=s=>(s||'').replace(/\s+/g,' ').trim().toLowerCase();
      let target=els.find(el=>/uae\s*pass/i.test(norm(el.innerText||el.textContent||el.value||el.getAttribute('aria-label')))&&!/stay\s+on\s+dashboard/i.test(norm(el.innerText||el.textContent||el.value||el.getAttribute('aria-label'))));
      if(!target&&els.length>=2)target=[...els].sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top).at(-1);
      if(!target)return false;target.click();target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));return true;
    }).catch(()=>false);
    const popup=await popupPromise;if(popup){page=popup;page.setDefaultTimeout(10000);}
  }
  if(!clicked)return{status:'uae_pass_modal_button_not_found',url:page.url(),browserUrl:browserUrl()};
  await page.waitForTimeout(3000);
  await switchToUaePassPage();
  return submitUaePassId();
}

async function selectAdmin(){const raw=await page.locator('body').innerText({timeout:5000}).catch(()=>'' );if(!/multiple profiles found/i.test(raw))return null;const admin=page.getByText(/REAL ESTATE OFFICE ADMIN/i).first();if(!(await admin.isVisible({timeout:4000}).catch(()=>false)))return{status:'real_estate_admin_profile_not_found',url:page.url(),browserUrl:browserUrl()};const card=admin.locator('xpath=ancestor::*[.//input[@type="radio"]][1]');let radio=card.locator('input[type="radio"]').first();if(!(await radio.count()))radio=admin.locator('xpath=following::input[@type="radio"][1]');if(!(await radio.count()))return{status:'admin_profile_radio_not_found',url:page.url(),browserUrl:browserUrl()};await radio.check({force:true,timeout:5000});await page.waitForTimeout(800);const proceed=await firstVisible(page,['button:has-text("Proceed")','button:has-text("Continue")','button:has-text("Submit")','button:has-text("Next")','button[type="submit"]']);if(proceed){await proceed.click({timeout:5000,noWaitAfter:true}).catch(()=>{});await page.waitForTimeout(4000);}await saveSession();return{status:'real_estate_admin_profile_selected',url:page.url()};}

async function detectState(){await switchToUaePassPage().catch(()=>false);const modal=await handleUaePassModal().catch(()=>null);if(modal)return modal;const url=page.url(),raw=await page.locator('body').innerText({timeout:5000}).catch(()=>''),text=raw.toLowerCase();if(/multiple profiles found/i.test(raw))return selectAdmin();const c=challenge(raw);if(c)return{status:'uae_pass_approval_required',challenge:c,url,browserUrl:browserUrl()};const captcha=text.includes("i'm not a robot")||text.includes('recaptcha')||(await page.locator('iframe[src*="recaptcha"],iframe[title*="recaptcha" i]').count().catch(()=>0))>0;if(captcha)return{status:'captcha_required',url,browserUrl:browserUrl()};if(text.includes('authentication code'))return{status:'authentication_code',url};if(text.includes('login to uae pass')||text.includes('emirates id, email, or phone')||text.includes('uaepass'))return{status:'uae_pass',url,browserUrl:browserUrl()};if(await isDashboard()){await saveSession();return{status:'session_active',url};}const pass=await firstVisible(page,['input[type="password"]']);if(pass)return{status:'login_form',url};return{status:'post_login_unknown',url,title:await page.title().catch(()=>'' )};}

async function submitUaePassId(){
  await switchToUaePassPage().catch(()=>false);
  const eid=process.env.UAE_PASS_EMIRATES_ID;if(!eid)return{status:'uae_pass_id_required',url:page.url(),browserUrl:browserUrl()};
  const input=await firstVisible(page,['input[placeholder*="Emirates ID, email, or phone" i]','input[placeholder*="Emirates ID" i]','input[aria-label*="Emirates ID" i]','input[name*="emirates" i]','input[id*="emirates" i]','input[type="text"]','input[type="tel"]']);
  if(!input)return{status:'uae_pass_id_field_not_found',url:page.url(),browserUrl:browserUrl()};
  await input.fill(eid,{timeout:5000});
  const btn=await firstVisible(page,['button:has-text("Login")','button:has-text("Sign in")','button[type="submit"]','input[type="submit"]']);
  if(!btn)return{status:'uae_pass_login_button_not_found',url:page.url(),browserUrl:browserUrl()};
  await btn.click({timeout:5000,noWaitAfter:true});await page.waitForTimeout(4000);return detectState();
}

async function clickTrakheesi(){const t=page.getByText('Trakheesi',{exact:true}).first();try{if(!(await t.isVisible({timeout:5000})))return{status:'trakheesi_not_found',url:page.url()};}catch{return{status:'trakheesi_not_found',url:page.url()};}const card=t.locator('xpath=ancestor::*[.//button or .//a][1]');let btn=card.getByRole('button',{name:/login with uae pass/i}).first();if(!(await btn.isVisible().catch(()=>false)))btn=card.getByRole('link',{name:/login with uae pass/i}).first();if(!(await btn.isVisible().catch(()=>false)))btn=card.getByText('Login with UAE Pass',{exact:true}).first();if(!(await btn.isVisible().catch(()=>false)))return{status:'trakheesi_uae_pass_button_not_found',url:page.url()};await btn.click({timeout:5000,noWaitAfter:true});await page.waitForTimeout(1200);const m=await handleUaePassModal();if(m)return m;await switchToUaePassPage();return submitUaePassId();}

export async function startInteractiveDldLogin(){const u=process.env.DLD_USERNAME,p=process.env.DLD_PASSWORD;if(!u||!p)return{status:'missing_credentials'};if(!process.env.VNC_PASSWORD)return{status:'missing_vnc_password'};await ensureSession();if(page.url()!=='about:blank'){const s=await detectState();if(['session_active','real_estate_admin_profile_selected','uae_pass','uae_pass_approval_required'].includes(s.status))return s;}await page.goto(DLD_URL,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(4000);if(await isDashboard()){const body=(await page.locator('body').innerText({timeout:5000}).catch(()=>'' )).toLowerCase();if(body.includes('trakheesi')&&body.includes('login with uae pass'))return clickTrakheesi();await saveSession();return{status:'session_active',url:page.url()};}const user=await firstVisible(page,['input[name="username"]:not([type="radio"]):not([type="checkbox"])','input[name="Username"]:not([type="radio"]):not([type="checkbox"])','input[type="text"][id*="user" i]','input[type="text"][placeholder*="user" i]','input[type="email"]','input[type="text"]']);const pass=await firstVisible(page,['input[type="password"][name="password"]','input[type="password"][name="Password"]','input[type="password"][id*="pass" i]','input[type="password"]']);if(!user||!pass)return{status:'login_form_not_found',url:page.url(),title:await page.title()};await user.fill(u);await pass.fill(p);return detectState();}

export async function continueAfterCaptcha(){if(!page||page.isClosed())return{status:'no_active_session'};try{const m=await handleUaePassModal();if(m)return m;const raw=await page.locator('body').innerText({timeout:5000}).catch(()=>''),body=raw.toLowerCase();if(body.includes('dld application dashboard')&&body.includes('trakheesi')){if(body.includes('login with uae pass'))return await clickTrakheesi();await saveSession();return{status:'session_active',url:page.url()};}if(/multiple profiles found/i.test(raw))return await selectAdmin();if(body.includes('login to uae pass')||body.includes('emirates id, email, or phone')||body.includes('uaepass'))return await detectState();const btn=await firstVisible(page,['button:has-text("Sign In")','input[type="submit"]','button[type="submit"]']);if(!btn){await page.waitForTimeout(1000);return await detectState();}await btn.click({timeout:5000,noWaitAfter:true});await page.waitForTimeout(5000);const post=await handleUaePassModal();if(post)return post;const after=await page.locator('body').innerText({timeout:5000}).catch(()=>''),a=after.toLowerCase();if(a.includes('dld application dashboard')&&a.includes('trakheesi')&&a.includes('login with uae pass'))return await clickTrakheesi();return await detectState();}catch(error){return{status:'continue_error',message:error.message,url:page?.url?.()||''};}}
export async function continueUaePassLogin(){if(!page||page.isClosed())return{status:'no_active_session'};try{return await submitUaePassId();}catch(error){return{status:'uae_pass_error',message:error.message,url:page.url()};}}
export async function checkUaePassStatus(){if(!page||page.isClosed())return{status:'no_active_session'};try{await page.waitForTimeout(1000);const s=await detectState();if(['session_active','real_estate_admin_profile_selected'].includes(s.status))await saveSession();return s;}catch(error){return{status:'uae_pass_check_error',message:error.message,url:page.url()};}}
export async function testDldLogin(){try{return await startInteractiveDldLogin();}catch(error){return{status:'error',message:error.message};}}
