import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const DLD_URL = 'https://dubailand.gov.ae/en/MyDLD/#/login/sso';
const SESSION_PATH = process.env.DLD_SESSION_PATH || '/data/dld-storage.json';
let browser, context, page;

async function firstVisible(pageObj, selectors) { for (const selector of selectors) { const locator = pageObj.locator(selector).first(); try { if (await locator.isVisible({ timeout: 1200 })) return locator; } catch {} } return null; }
function browserUrl() { const explicit=process.env.BROWSER_PUBLIC_URL; if(explicit)return explicit.replace(/\/$/,'')+'/vnc.html?autoconnect=true&resize=scale'; const d=process.env.RAILWAY_PUBLIC_DOMAIN; return d?`https://${d}/vnc.html?autoconnect=true&resize=scale`:null; }
async function saveSession(){try{fs.mkdirSync(path.dirname(SESSION_PATH),{recursive:true});await context.storageState({path:SESSION_PATH});}catch(e){console.error('Could not save DLD session:',e.message);}}
async function ensureSession(){if(browser&&context&&page&&!page.isClosed())return;browser=await chromium.launch({headless:false,args:['--no-sandbox','--disable-dev-shm-usage','--window-size=1440,900']});const o={viewport:{width:1365,height:768}};if(fs.existsSync(SESSION_PATH))o.storageState=SESSION_PATH;context=await browser.newContext(o);page=await context.newPage();page.setDefaultTimeout(15000);}
function extractUaePassChallenge(text){for(const p of[/(?:number|code|match|matching|shown|displayed)[^0-9]{0,80}([0-9]{2,3})/i,/([0-9]{2,3})[^0-9]{0,80}(?:number|code|match|matching)/i]){const m=text.match(p);if(m)return m[1];}return null;}
async function isDldDashboard(){const b=(await page.locator('body').innerText().catch(()=>'' )).toLowerCase();return b.includes('dld application dashboard')||b.includes('multiple profiles found');}
async function selectRealEstateAdminProfile(){const raw=await page.locator('body').innerText().catch(()=>'' );if(!/multiple profiles found/i.test(raw))return null;const admin=page.getByText(/REAL ESTATE OFFICE ADMIN/i).first();if(!(await admin.isVisible().catch(()=>false)))return{status:'real_estate_admin_profile_not_found',url:page.url(),browserUrl:browserUrl()};const card=admin.locator('xpath=ancestor::*[.//input[@type="radio"]][1]');let radio=card.locator('input[type="radio"]').first();if(!(await radio.count()))radio=admin.locator('xpath=following::input[@type="radio"][1]');if(!(await radio.count()))return{status:'admin_profile_radio_not_found',url:page.url(),browserUrl:browserUrl()};await radio.check({force:true});await page.waitForTimeout(800);const proceed=await firstVisible(page,['button:has-text("Proceed")','button:has-text("Continue")','button:has-text("Submit")','button:has-text("Next")','button[type="submit"]']);if(proceed){await proceed.click();await page.waitForTimeout(5000);}await saveSession();return{status:'real_estate_admin_profile_selected',url:page.url()};}
async function detectState(){const url=page.url(),raw=await page.locator('body').innerText().catch(()=>''),text=raw.toLowerCase();if(/multiple profiles found/i.test(raw))return selectRealEstateAdminProfile();const challenge=extractUaePassChallenge(raw);if(challenge)return{status:'uae_pass_approval_required',challenge,url,browserUrl:browserUrl()};const captcha=text.includes("i'm not a robot")||text.includes('recaptcha')||(await page.locator('iframe[src*="recaptcha"], iframe[title*="recaptcha" i]').count().catch(()=>0))>0;if(captcha)return{status:'captcha_required',url,browserUrl:browserUrl()};if(text.includes('authentication code'))return{status:'authentication_code',url};if(text.includes('login to uae pass')||text.includes('continue with uae pass')||text.includes('uaepass'))return{status:'uae_pass',url,browserUrl:browserUrl()};if(await isDldDashboard()){await saveSession();return{status:'session_active',url};}const pass=await firstVisible(page,['input[type="password"]']);if(pass)return{status:'login_form',url};return{status:'post_login_unknown',url,title:await page.title().catch(()=>'' )};}
async function submitUaePassId(){const eid=process.env.UAE_PASS_EMIRATES_ID;if(!eid)return{status:'uae_pass_id_required',url:page.url(),browserUrl:browserUrl()};const input=await firstVisible(page,['input[placeholder*="Emirates ID" i]','input[aria-label*="Emirates ID" i]','input[name*="emirates" i]','input[id*="emirates" i]','input[type="text"]','input[type="tel"]']);if(!input)return{status:'uae_pass_id_field_not_found',url:page.url(),browserUrl:browserUrl()};await input.fill(eid);const btn=await firstVisible(page,['button:has-text("Login")','button:has-text("Sign in")','button[type="submit"]','input[type="submit"]']);if(!btn)return{status:'uae_pass_login_button_not_found',url:page.url(),browserUrl:browserUrl()};await btn.click();await page.waitForTimeout(5000);return detectState();}
async function clickTrakheesiUaePass(){const t=page.getByText('Trakheesi',{exact:true}).first();try{if(!(await t.isVisible({timeout:8000})))return{status:'trakheesi_not_found',url:page.url()};}catch{return{status:'trakheesi_not_found',url:page.url()};}const card=t.locator('xpath=ancestor::*[.//button or .//a][1]');let btn=card.getByRole('button',{name:/login with uae pass/i}).first();if(!(await btn.isVisible().catch(()=>false)))btn=card.getByRole('link',{name:/login with uae pass/i}).first();if(!(await btn.isVisible().catch(()=>false)))btn=card.getByText('Login with UAE Pass',{exact:true}).first();if(!(await btn.isVisible().catch(()=>false)))return{status:'trakheesi_uae_pass_button_not_found',url:page.url()};await btn.click();await page.waitForTimeout(1500);const c=await firstVisible(page,['button:has-text("Continue with UAE PASS")','text="Continue with UAE PASS"']);if(c){await c.click();await page.waitForTimeout(5000);}return submitUaePassId();}
export async function startInteractiveDldLogin(){const u=process.env.DLD_USERNAME,p=process.env.DLD_PASSWORD;if(!u||!p)return{status:'missing_credentials'};if(!process.env.VNC_PASSWORD)return{status:'missing_vnc_password'};await ensureSession();if(page.url()!=='about:blank'){const s=await detectState();if(['session_active','real_estate_admin_profile_selected','uae_pass','uae_pass_approval_required'].includes(s.status))return s;}await page.goto(DLD_URL,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(4000);if(await isDldDashboard()){const body=(await page.locator('body').innerText().catch(()=>'' )).toLowerCase();if(body.includes('trakheesi')&&body.includes('login with uae pass'))return clickTrakheesiUaePass();await saveSession();return{status:'session_active',url:page.url()};}const user=await firstVisible(page,['input[name="username"]:not([type="radio"]):not([type="checkbox"])','input[name="Username"]:not([type="radio"]):not([type="checkbox"])','input[type="text"][id*="user" i]','input[type="text"][placeholder*="user" i]','input[type="email"]','input[type="text"]']);const pass=await firstVisible(page,['input[type="password"][name="password"]','input[type="password"][name="Password"]','input[type="password"][id*="pass" i]','input[type="password"]']);if(!user||!pass)return{status:'login_form_not_found',url:page.url(),title:await page.title()};await user.fill(u);await pass.fill(p);return detectState();}
export async function continueAfterCaptcha(){
  if(!page||page.isClosed())return{status:'no_active_session'};

  // If the user already clicked Sign In manually, continue from the page we are on.
  let state=await detectState();
  if(state.status!=='captcha_required' && state.status!=='login_form'){
    if(state.status==='session_active'){
      const body=(await page.locator('body').innerText().catch(()=>'' )).toLowerCase();
      if(body.includes('trakheesi')&&body.includes('login with uae pass')) return clickTrakheesiUaePass();
    }
    return state;
  }

  const btn=await firstVisible(page,['button:has-text("Sign In")','button:has-text("Login")','input[type="submit"]','button[type="submit"]']);
  if(!btn){
    await page.waitForTimeout(1500);
    return detectState();
  }

  await btn.click();
  await page.waitForTimeout(6000);
  const body=(await page.locator('body').innerText().catch(()=>'' )).toLowerCase();
  if(body.includes('trakheesi')&&body.includes('login with uae pass'))return clickTrakheesiUaePass();
  return detectState();
}
export async function continueUaePassLogin(){if(!page||page.isClosed())return{status:'no_active_session'};return submitUaePassId();}
export async function checkUaePassStatus(){if(!page||page.isClosed())return{status:'no_active_session'};await page.waitForTimeout(1500);const s=await detectState();if(['session_active','real_estate_admin_profile_selected'].includes(s.status))await saveSession();return s;}
export async function testDldLogin(){try{return await startInteractiveDldLogin();}catch(error){return{status:'error',message:error.message};}}
