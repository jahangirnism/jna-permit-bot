import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DLD_URL='https://dubailand.gov.ae/en/MyDLD/#/login/sso';
const SECONDARY_PERMIT='150273';
const LOCAL_ROOT=process.env.JNA_LOCAL_DATA_DIR||path.join(os.homedir(),'.jna-permit-bot');
const PROFILE_DIR=process.env.DLD_PROFILE_DIR||path.join(LOCAL_ROOT,'chrome-profile');
const SESSION_PATH=process.env.DLD_SESSION_PATH||path.join(LOCAL_ROOT,'dld-storage.json');
const UNIT_AREA_INPUT='#ctl00_MainContent_UCPermitHeader_UCPropertyList1_UCPopUpPropertiesTypes_BodyTemplateContainer_UCPropertiesTypes1_PropertyTabContainer_UnitTab_UCUnitDetails_AreaListRadComboBox_Input';
const UNIT_AREA_DROPDOWN='#ctl00_MainContent_UCPermitHeader_UCPropertyList1_UCPopUpPropertiesTypes_BodyTemplateContainer_UCPropertiesTypes1_PropertyTabContainer_UnitTab_UCUnitDetails_AreaListRadComboBox_DropDown';
const LISTING_PROPERTY_RADIO='#MainContent_UCPermitHeader_UCPropertyList1_UCPopUpPropertyAction_BodyTemplateContainer_UCPropertyActionObj_listingTypeRbl_2';
const ADD_PROPERTY_BUTTON='#MainContent_UCPermitHeader_UCPropertyList1_AddPropertyButton';
let context,page;

async function firstVisible(p,selectors){for(const s of selectors){const l=p.locator(s).first();try{if(await l.isVisible({timeout:1200}))return l;}catch{}}return null;}
async function pageText(p){return(await p.locator('body').innerText({timeout:2500}).catch(()=>'' )).toLowerCase();}
async function saveSession(){try{fs.mkdirSync(path.dirname(SESSION_PATH),{recursive:true});await context.storageState({path:SESSION_PATH});}catch(e){console.error('Could not save session:',e.message);}}
function clearLocks(){for(const n of['SingletonLock','SingletonSocket','SingletonCookie']){try{fs.rmSync(path.join(PROFILE_DIR,n),{force:true});}catch{}}}
async function clickText(text,exact=true){const l=page.getByText(text,{exact}).first();if(await l.isVisible({timeout:5000}).catch(()=>false)){await l.click({force:true});return true;}return false;}
async function clickRadioLabel(label){const byLabel=page.getByLabel(new RegExp(`^${label}$`,'i')).first();if(await byLabel.count().catch(()=>0)){try{await byLabel.evaluate(el=>el.click());await page.waitForTimeout(900);return true;}catch{}}const text=page.getByText(new RegExp(`^${label}$`,'i')).first();if(await text.isVisible({timeout:4000}).catch(()=>false)){await text.click({force:true});await page.waitForTimeout(900);return true;}return false;}
async function inputNearLabel(label){const lab=page.getByText(new RegExp(`^${label}\\s*\\*?$`,'i')).first();if(await lab.count().catch(()=>0)){const container=lab.locator('xpath=ancestor::*[self::div or self::td or self::label][1]');let input=container.locator('input,textarea').first();if(await input.count())return input;input=lab.locator('xpath=following::input[1]');if(await input.count())return input;}return null;}
function normArea(s){return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();}
function areaScore(expected,candidate){const e=normArea(expected),c=normArea(candidate);if(!e||!c)return 0;if(e===c)return 1;if(e.startsWith(c+' '))return .99;if(e.includes(c))return .98;if(c.includes(e))return .94;const et=e.split(' '),ct=c.split(' ');let prefix=0;while(prefix<et.length&&prefix<ct.length&&et[prefix]===ct[prefix])prefix++;if(prefix>=2)return .97;if(prefix===1)return .84;const es=new Set(et),cs=new Set(ct);let shared=0;for(const t of cs)if(es.has(t))shared++;const precision=shared/Math.max(cs.size,1),recall=shared/Math.max(es.size,1);return precision&&recall?(2*precision*recall)/(precision+recall):0;}
async function selectArea(area){
  const input=page.locator(UNIT_AREA_INPUT).first();
  const dropdown=page.locator(UNIT_AREA_DROPDOWN).first();
  if(!(await input.count().catch(()=>0)))return false;
  await input.click({force:true}).catch(()=>{});await page.waitForTimeout(250);
  const combo=input.locator('xpath=ancestor::*[contains(@class,"RadComboBox")][1]');const arrow=combo.locator('.rcbActionButton,.rcbArrowCell,a').last();if(await arrow.count().catch(()=>0))await arrow.click({force:true}).catch(()=>{});await page.waitForTimeout(350);
  const items=dropdown.locator('li.rcbItem,li.rcbHovered');const candidates=[];
  for(let i=0;i<await items.count();i++){const el=items.nth(i);const txt=(await el.innerText().catch(()=>'' )).replace(/\s+/g,' ').trim();if(!txt||/^all$/i.test(txt))continue;candidates.push({el,txt,score:areaScore(area,txt)});}
  candidates.sort((a,b)=>b.score-a.score);const best=candidates[0],second=candidates[1];if(!best||best.score<0.72)return false;if(second&&best.score<0.95&&best.score-second.score<0.06)return false;
  await input.fill(best.txt).catch(()=>{});await page.waitForTimeout(250);let exact=dropdown.locator('li.rcbItem,li.rcbHovered').filter({hasText:new RegExp(`^${best.txt.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')}$`,'i')}).first();if(!(await exact.count().catch(()=>0)))exact=best.el;await exact.evaluate(el=>el.click()).catch(async()=>{await exact.click({force:true}).catch(()=>{});});await page.waitForTimeout(500);const selected=normArea(await input.inputValue().catch(()=>''));return selected===normArea(best.txt)||selected.includes(normArea(best.txt));
}
async function ensureSession(){if(context&&page&&!page.isClosed())return;fs.mkdirSync(PROFILE_DIR,{recursive:true});clearLocks();context=await chromium.launchPersistentContext(PROFILE_DIR,{channel:'chrome',headless:false,viewport:{width:1440,height:900},args:['--start-maximized']});page=context.pages()[0]||await context.newPage();page.setDefaultTimeout(10000);}
async function selectBestPage(){if(!context)return false;const pages=context.pages().filter(p=>!p.isClosed());if(!pages.length)return false;const scored=[];for(const p of pages){const url=(p.url()||'').toLowerCase(),text=await pageText(p);let score=0;if(url.includes('trakheesi.dubailand.gov.ae')){score=110;if(text.includes('transaction #')&&text.includes(SECONDARY_PERMIT))score+=80;if(await p.locator(UNIT_AREA_INPUT).isVisible({timeout:300}).catch(()=>false))score+=120;else if(await p.locator(LISTING_PROPERTY_RADIO).isVisible({timeout:300}).catch(()=>false))score+=90;else if(await p.locator(ADD_PROPERTY_BUTTON).isVisible({timeout:300}).catch(()=>false))score+=40;}else if(text.includes('multiple profiles found')||text.includes('real estate office admin'))score=100;else if(text.includes('dld application dashboard')||text.includes('trakheesi'))score=90;else if(text.includes('login to uae pass')||text.includes('emirates id, email, or phone')||url.includes('uaepass'))score=80;else if(text.includes("i'm not a robot")||text.includes('recaptcha')||(await p.locator('iframe[src*="recaptcha"],iframe[title*="recaptcha" i]').count().catch(()=>0))>0)score=70;else if(await p.locator('input[type="password"]').count().catch(()=>0))score=60;else if(url.includes('dubailand.gov.ae'))score=50;else if(url!=='about:blank')score=10;scored.push({p,score});}scored.sort((a,b)=>b.score-a.score);if(scored[0]?.score>0){page=scored[0].p;page.setDefaultTimeout(10000);return true;}return false;}
async function switchToUaePass(){if(!context)return false;for(const p of [...context.pages()].reverse()){if(p.isClosed())continue;const url=(p.url()||'').toLowerCase(),text=await pageText(p);if(url.includes('uaepass')||text.includes('login to uae pass')||text.includes('emirates id, email, or phone')){page=p;page.setDefaultTimeout(10000);return true;}}return false;}
function challenge(text){for(const r of[/(?:number|code|match|matching|shown|displayed)[^0-9]{0,100}([0-9]{2,3})/i,/([0-9]{2,3})[^0-9]{0,100}(?:number|code|match|matching|shown)/i]){const m=text.match(r);if(m)return m[1];}return null;}
async function selectAdmin(){const raw=await page.locator('body').innerText({timeout:5000}).catch(()=>'' );if(!/multiple profiles found/i.test(raw))return null;const admin=page.getByText(/REAL ESTATE OFFICE ADMIN/i).first();if(!(await admin.isVisible({timeout:4000}).catch(()=>false)))return{status:'real_estate_admin_profile_not_found',url:page.url()};const card=admin.locator('xpath=ancestor::*[.//input[@type="radio"]][1]');let radio=card.locator('input[type="radio"]').first();if(!(await radio.count()))radio=admin.locator('xpath=following::input[@type="radio"][1]');if(!(await radio.count()))return{status:'admin_profile_radio_not_found',url:page.url()};await radio.check({force:true});const proceed=await firstVisible(page,['button:has-text("Proceed")','button:has-text("Continue")','button:has-text("Submit")','button:has-text("Next")','button[type="submit"]']);if(proceed){await proceed.click({noWaitAfter:true}).catch(()=>{});await page.waitForTimeout(3500);}await saveSession();return{status:'real_estate_admin_profile_selected',url:page.url()};}
async function handleUaePassModal(){const modal=page.locator('#application-infoUAE').first();if(!(await modal.isVisible({timeout:1200}).catch(()=>false)))return null;const candidates=modal.locator('button,a,[role="button"],input[type="button"],input[type="submit"],.btn,[onclick]');let target=null;for(let i=0;i<await candidates.count();i++){const el=candidates.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;const label=((await el.innerText().catch(()=>''))+' '+(await el.getAttribute('value').catch(()=>''))).trim();if(/uae\s*pass/i.test(label)&&!/stay\s+on\s+dashboard/i.test(label)){target=el;break;}}if(!target)return{status:'uae_pass_modal_button_not_found',url:page.url()};const popup=context.waitForEvent('page',{timeout:5000}).catch(()=>null);await target.click({force:true,noWaitAfter:true});const p=await popup;if(p){page=p;page.setDefaultTimeout(10000);}await page.waitForTimeout(2500);await switchToUaePass();return submitUaePassId();}
async function detectState(){await selectBestPage();const raw=await page.locator('body').innerText({timeout:5000}).catch(()=>''),text=raw.toLowerCase(),url=page.url();if(/multiple profiles found/i.test(raw))return selectAdmin();const c=challenge(raw);if(c)return{status:'uae_pass_approval_required',challenge:c,url};const captcha=text.includes("i'm not a robot")||text.includes('recaptcha')||(await page.locator('iframe[src*="recaptcha"],iframe[title*="recaptcha" i]').count().catch(()=>0))>0;if(captcha)return{status:'captcha_required',url};if(text.includes('login to uae pass')||text.includes('emirates id, email, or phone')||url.toLowerCase().includes('uaepass'))return{status:'uae_pass',url};const modal=await handleUaePassModal().catch(()=>null);if(modal)return modal;if(text.includes('dld application dashboard')||text.includes('trakheesi')||url.includes('trakheesi.dubailand.gov.ae')){await saveSession();return{status:'session_active',url};}if(text.includes('authentication code'))return{status:'authentication_code',url};if(await page.locator('input[type="password"]').count().catch(()=>0))return{status:'login_form',url};return{status:'post_login_unknown',url,title:await page.title().catch(()=>'' )};}
async function waitForUaePassApproval(initial){if(initial?.status!=='uae_pass_approval_required')return initial;const number=initial.challenge;const deadline=Date.now()+90000;while(Date.now()<deadline){await page.waitForTimeout(2000);const s=await detectState();if(s.status!=='uae_pass_approval_required'||s.challenge!==number)return s;}return{...initial,status:'uae_pass_approval_timeout',challenge:number};}
async function submitUaePassId(){await switchToUaePass();const eid=process.env.UAE_PASS_EMIRATES_ID;if(!eid)return{status:'uae_pass_id_required',url:page.url()};const input=await firstVisible(page,['input[placeholder*="Emirates ID, email, or phone" i]','input[placeholder*="Emirates ID" i]','input[aria-label*="Emirates ID" i]','input[type="text"]','input[type="tel"]']);if(!input)return{status:'uae_pass_id_field_not_found',url:page.url()};await input.fill(eid);const btn=await firstVisible(page,['button:has-text("Login")','button:has-text("Sign in")','button[type="submit"]','input[type="submit"]']);if(!btn)return{status:'uae_pass_login_button_not_found',url:page.url()};await btn.click({noWaitAfter:true});await page.waitForTimeout(3500);const s=await detectState();return waitForUaePassApproval(s);}
async function clickTrakheesi(){const t=page.getByText('Trakheesi',{exact:true}).first();if(!(await t.isVisible({timeout:5000}).catch(()=>false)))return{status:'trakheesi_not_found',url:page.url()};const card=t.locator('xpath=ancestor::*[.//*[contains(normalize-space(.),"Go to Account")] or .//*[contains(normalize-space(.),"Login with UAE Pass")]][1]');let btn=card.getByText(/Go to Account/i,{exact:true}).first();if(await btn.isVisible({timeout:1500}).catch(()=>false)){const popup=context.waitForEvent('page',{timeout:4000}).catch(()=>null);await btn.click({force:true,noWaitAfter:true});const p=await popup;if(p){page=p;page.setDefaultTimeout(10000);}await page.waitForTimeout(3500);await selectBestPage();if(page.url().includes('trakheesi.dubailand.gov.ae')){await saveSession();return{status:'session_active',url:page.url()};}return detectState();}btn=card.getByRole('button',{name:/login with uae pass/i}).first();if(!(await btn.isVisible().catch(()=>false)))btn=card.getByText(/login with uae pass/i).first();if(!(await btn.isVisible().catch(()=>false)))return{status:'trakheesi_account_button_not_found',url:page.url()};await btn.click({noWaitAfter:true});await page.waitForTimeout(1000);const m=await handleUaePassModal();return m||detectState();}
async function ensureTrakheesiAccount(){await selectBestPage();if(page.url().includes('trakheesi.dubailand.gov.ae'))return{status:'session_active',url:page.url()};const text=await pageText(page);if(text.includes('dld application dashboard')&&text.includes('trakheesi')){const entered=await clickTrakheesi();await page.waitForTimeout(1500);await selectBestPage();if(page.url().includes('trakheesi.dubailand.gov.ae'))return{status:'session_active',url:page.url()};return entered;}return{status:'trakheesi_session_required',url:page.url()};}
async function openSecondaryPermitEdit(){
  await ensureSession();
  const entered=await ensureTrakheesiAccount();
  if(!page.url().includes('trakheesi.dubailand.gov.ae'))return entered?.status==='session_active'?{status:'trakheesi_session_required',url:page.url()}:entered;

  let raw=await page.locator('body').innerText({timeout:4000}).catch(()=>'' );
  let tx=raw.match(/Transaction\s*#\s*([0-9]+)/i)?.[1]||null;
  const unitModalOpen=await page.locator(UNIT_AREA_INPUT).isVisible({timeout:500}).catch(()=>false);
  const listingModalOpen=await page.locator(LISTING_PROPERTY_RADIO).isVisible({timeout:500}).catch(()=>false);
  const addButtonOpen=await page.locator(ADD_PROPERTY_BUTTON).isVisible({timeout:500}).catch(()=>false);
  if(tx===SECONDARY_PERMIT&&(unitModalOpen||listingModalOpen||addButtonOpen))return{status:'secondary_permit_edit_open',permit:SECONDARY_PERMIT,url:page.url()};

  const permitNav=page.getByText('Permit',{exact:true}).first();
  if(await permitNav.isVisible({timeout:5000}).catch(()=>false))await permitNav.click({force:true});
  await page.waitForFunction(permit=>document.body?.innerText?.includes(permit),SECONDARY_PERMIT,{timeout:12000}).catch(()=>{});

  const result=await page.evaluate(permit=>{
    const norm=s=>(s||'').replace(/\s+/g,' ').trim();
    const permitRe=new RegExp(`Permit\\s*Number\\s*${permit}(?:\\s|$)`,'i');
    const editLinks=[...document.querySelectorAll('a[title="Edit Permit"][id*="UserPermitDashBoardGrid_EditLinkButton"]')];
    const candidates=[];
    for(const link of editLinks){let node=link;for(let depth=0;depth<12&&node;depth++,node=node.parentElement){const text=norm(node.innerText||node.textContent);if(permitRe.test(text)&&/Electronic Advertisement/i.test(text)){candidates.push({link,node,depth,textLength:text.length});break;}}}
    candidates.sort((a,b)=>a.depth-b.depth||a.textLength-b.textLength);const chosen=candidates[0];if(!chosen)return{clicked:false,reason:'no_edit_link_bound_to_permit'};const text=norm(chosen.node.innerText||chosen.node.textContent);if(!permitRe.test(text))return{clicked:false,reason:'permit_verification_failed'};chosen.link.click();return{clicked:true};
  },SECONDARY_PERMIT).catch(error=>({clicked:false,reason:error.message}));

  if(!result?.clicked){await page.waitForTimeout(500);const edits=page.getByText(/^Edit$/i,{exact:true});const visible=[];for(let i=0;i<await edits.count().catch(()=>0);i++)if(await edits.nth(i).isVisible().catch(()=>false))visible.push(edits.nth(i));if(visible.length!==1)return{status:'permit_edit_not_found',permit:SECONDARY_PERMIT,url:page.url(),reason:result?.reason||'visible_edit_not_unique'};await visible[0].click({force:true});}

  await page.waitForTimeout(2500);raw=await page.locator('body').innerText().catch(()=>'' );tx=raw.match(/Transaction\s*#\s*([0-9]+)/i)?.[1]||null;if(tx!==SECONDARY_PERMIT)return{status:'wrong_permit_edit_page',permit:SECONDARY_PERMIT,actualTransaction:tx,url:page.url()};return{status:'secondary_permit_edit_open',permit:SECONDARY_PERMIT,url:page.url()};
}
export async function prepareSecondaryListing(payload={}){try{
  const {purpose,propertyType,deed={}}=payload;if(!['RENT','SALE'].includes(purpose))return{status:'invalid_listing_purpose'};if(!['LAND','BUILDING','VILLA','UNIT'].includes(propertyType))return{status:'invalid_property_type'};if(propertyType!=='UNIT')return{status:'property_type_not_mapped',propertyType};for(const key of['area','landNo','buildingName','unitNo'])if(!deed[key])return{status:'missing_deed_field',field:key};
  const opened=await openSecondaryPermitEdit();if(opened.status!=='secondary_permit_edit_open')return opened;

  let unitArea=page.locator(UNIT_AREA_INPUT).first();
  let inUnitModal=await unitArea.isVisible({timeout:800}).catch(()=>false);

  if(!inUnitModal){
    let propertyRadio=page.locator(LISTING_PROPERTY_RADIO).first();
    if(!(await propertyRadio.isVisible({timeout:800}).catch(()=>false))){
      const add=page.locator(ADD_PROPERTY_BUTTON).first();
      if(!(await add.isVisible({timeout:5000}).catch(()=>false)))return{status:'add_property_button_not_found',url:page.url()};
      await add.evaluate(el=>el.click());await page.waitForTimeout(900);
      propertyRadio=page.locator(LISTING_PROPERTY_RADIO).first();
    }
    if(!(await propertyRadio.count().catch(()=>0)))return{status:'listing_type_property_not_found',url:page.url()};
    await propertyRadio.evaluate(el=>el.click());await page.waitForLoadState('domcontentloaded',{timeout:8000}).catch(()=>{});await page.waitForTimeout(1400);

    const purposeId=purpose==='RENT'?'#MainContent_UCPermitHeader_UCPropertyList1_UCPopUpPropertyAction_BodyTemplateContainer_UCPropertyActionObj_ListingPurposeRbl_0':'#MainContent_UCPermitHeader_UCPropertyList1_UCPopUpPropertyAction_BodyTemplateContainer_UCPropertyActionObj_ListingPurposeRbl_1';
    let purposeRadio=page.locator(purposeId).first();
    if(!(await purposeRadio.count().catch(()=>0))){const addAgain=page.locator(ADD_PROPERTY_BUTTON).first();if(await addAgain.isVisible({timeout:2500}).catch(()=>false)){await addAgain.evaluate(el=>el.click());await page.waitForTimeout(900);purposeRadio=page.locator(purposeId).first();}}
    if(!(await purposeRadio.count().catch(()=>0)))return{status:'listing_purpose_not_found',url:page.url()};
    await purposeRadio.evaluate(el=>el.click());

    const proceedId='MainContent_UCPermitHeader_UCPropertyList1_UCPopUpPropertyAction_BodyTemplateContainer_UCPropertyActionObj_ActionButton';
    await page.waitForFunction(id=>{const el=document.getElementById(id);return !!el&&el.offsetParent!==null&&el.value==='Proceed';},proceedId,{timeout:10000}).catch(()=>{});await page.waitForTimeout(300);
    const proceed=page.locator(`#${proceedId}`).first();if(!(await proceed.isVisible({timeout:3000}).catch(()=>false)))return{status:'listing_proceed_not_found',url:page.url()};await proceed.evaluate(el=>el.click());await page.waitForTimeout(1200);

    unitArea=page.locator(UNIT_AREA_INPUT).first();
    if(!(await unitArea.isVisible({timeout:800}).catch(()=>false))){
      const unitLabel=page.locator('#MainContent_UCPermitHeader_UCPropertyList1_UCPopUpPropertiesTypes_BodyTemplateContainer_UCPropertiesTypes1_PropertyTabContainer_UnitTab_UnitLabel').first();
      if(!(await unitLabel.count().catch(()=>0)))return{status:'unit_tab_not_found',url:page.url()};
      await unitLabel.evaluate(el=>{const target=el.closest('a,[onclick],[role="tab"]')||el;target.click();});await page.waitForTimeout(500);
    }
  }

  if(!(await selectArea(deed.area)))return{status:'area_option_not_found',area:deed.area,url:page.url()};
  const land=page.locator('#MainContent_UCPermitHeader_UCPropertyList1_UCPopUpPropertiesTypes_BodyTemplateContainer_UCPropertiesTypes1_PropertyTabContainer_UnitTab_UCUnitDetails_SearchLandNumberTextBox').first();const building=page.locator('#MainContent_UCPermitHeader_UCPropertyList1_UCPopUpPropertiesTypes_BodyTemplateContainer_UCPropertiesTypes1_PropertyTabContainer_UnitTab_UCUnitDetails_SearchBuildingNameTextBox').first();const unit=page.locator('#MainContent_UCPermitHeader_UCPropertyList1_UCPopUpPropertiesTypes_BodyTemplateContainer_UCPropertiesTypes1_PropertyTabContainer_UnitTab_UCUnitDetails_SearchPropertyTextBox').first();if(!(await land.count().catch(()=>0))||!(await building.count().catch(()=>0))||!(await unit.count().catch(()=>0)))return{status:'property_search_fields_not_found',url:page.url()};await land.fill(String(deed.landNo));await building.fill(String(deed.buildingName));await unit.fill(String(deed.unitNo));
  const search=page.locator('#MainContent_UCPermitHeader_UCPropertyList1_UCPopUpPropertiesTypes_BodyTemplateContainer_UCPropertiesTypes1_PropertyTabContainer_UnitTab_UCUnitDetails_SearchButton').first();if(!(await search.isVisible({timeout:5000}).catch(()=>false)))return{status:'property_search_button_not_found',url:page.url()};await search.click({force:true});await page.waitForTimeout(1800);

  // DLD can return the correct unit while expanding the building name, e.g.
  // title deed "EMPIRE HEIGHTS" -> DLD "EMPIRE HEIGHTS PODIUM". Do not reject
  // the returned row only because building/area text is not an exact OCR match.
  const resultHeading=page.getByText('Search Result',{exact:true}).first();
  let resultTable=resultHeading.locator('xpath=following::table[1]');
  if(!(await resultTable.count().catch(()=>0)))resultTable=page.locator('table').filter({hasText:String(deed.unitNo)}).last();
  const resultRows=resultTable.locator('tr').filter({has:page.locator('td')});
  const visibleRows=[];
  for(let i=0;i<await resultRows.count().catch(()=>0);i++){
    const row=resultRows.nth(i);
    if(await row.isVisible().catch(()=>false))visibleRows.push(row);
  }
  if(!visibleRows.length)return{status:'property_search_no_results',url:page.url()};

  const wantedUnit=String(deed.unitNo).trim().toLowerCase();
  let match=null;
  for(const row of visibleRows){
    const firstCell=(await row.locator('td').first().innerText().catch(()=>'' )).replace(/\s+/g,' ').trim().toLowerCase();
    if(firstCell===wantedUnit){match=row;break;}
  }
  // User preference: if DLD returns rows, use the first returned result when
  // there is no exact first-column unit hit rather than failing on building text.
  if(!match)match=visibleRows[0];

  await match.click({force:true});await page.waitForTimeout(700);
  const selectedText=(await match.innerText().catch(()=>'' )).replace(/\s+/g,' ').trim();
  const value=await inputNearLabel('Value');if(!value)return{status:'property_selected_but_value_field_not_found',url:page.url()};
  return{status:'property_selected',permit:SECONDARY_PERMIT,unitNo:deed.unitNo,buildingName:deed.buildingName,area:deed.area,selectedResult:selectedText,url:page.url()};
}catch(error){return{status:'prepare_listing_error',message:error.message,url:page?.url?.()||''};}}
export async function finalizeSecondaryListing(payload={}){try{if(!page||page.isClosed())return{status:'no_active_session'};const {value,marketingContract,advertisementFormat}=payload;if(!value||!marketingContract?.path||!advertisementFormat?.path)return{status:'listing_inputs_missing'};const valueInput=await inputNearLabel('Value');if(!valueInput)return{status:'value_field_not_found',url:page.url()};await valueInput.fill(String(value));const rows=page.locator('table tr');let marketingInput=null,adInput=null;for(let i=0;i<await rows.count();i++){const row=rows.nth(i),txt=(await row.innerText().catch(()=>'' )).toLowerCase();if(txt.includes('marketing contract from the owner'))marketingInput=row.locator('input[type="file"]').first();if(txt.includes('copy of the advertisement format'))adInput=row.locator('input[type="file"]').first();}if(!marketingInput||!(await marketingInput.count())||!adInput||!(await adInput.count()))return{status:'document_upload_fields_not_found',url:page.url()};await marketingInput.setInputFiles(marketingContract.path);await adInput.setInputFiles(advertisementFormat.path);const announcement=await inputNearLabel('Announcement Text');if(announcement)await announcement.fill('');const save=page.getByText('Save',{exact:true}).last();if(!(await save.isVisible({timeout:4000}).catch(()=>false)))return{status:'listing_save_button_not_found',url:page.url()};await save.click({force:true});await page.waitForTimeout(2500);await saveSession();return{status:'listing_saved',permit:SECONDARY_PERMIT,url:page.url(),message:(await page.locator('body').innerText().catch(()=>'' )).slice(0,1200)};}catch(error){return{status:'finalize_listing_error',message:error.message,url:page?.url?.()||''};}}
export async function startInteractiveDldLogin(){const u=process.env.DLD_USERNAME,p=process.env.DLD_PASSWORD;if(!u||!p)return{status:'missing_credentials'};await ensureSession();await selectBestPage();if(page&&page.url()!=='about:blank'){const existing=await detectState();if(existing.status==='uae_pass_approval_required')return waitForUaePassApproval(existing);if(['session_active','real_estate_admin_profile_selected','uae_pass','captcha_required','login_form'].includes(existing.status))return existing;}await page.goto(DLD_URL,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(3000);const body=await pageText(page);if(body.includes('dld application dashboard')){if(body.includes('trakheesi'))return clickTrakheesi();await saveSession();return{status:'session_active',url:page.url()};}const user=await firstVisible(page,['input[name="username"]','input[name="Username"]','input[type="text"][placeholder*="user" i]','input[type="email"]','input[type="text"]']);const pass=await firstVisible(page,['input[type="password"]']);if(!user||!pass)return{status:'login_form_not_found',url:page.url()};await user.fill(u);await pass.fill(p);return detectState();}
export async function continueAfterCaptcha(){if(!page||page.isClosed())return{status:'no_active_session'};try{await selectBestPage();const m=await handleUaePassModal();if(m)return m;const raw=await page.locator('body').innerText({timeout:5000}).catch(()=>''),body=raw.toLowerCase();if(body.includes('dld application dashboard')&&body.includes('trakheesi'))return clickTrakheesi();if(/multiple profiles found/i.test(raw))return selectAdmin();if(body.includes('login to uae pass')||body.includes('emirates id, email, or phone'))return detectState();const btn=await firstVisible(page,['button:has-text("Sign In")','input[type="submit"]','button[type="submit"]']);if(btn){await btn.click({noWaitAfter:true});await page.waitForTimeout(4000);}const s=await detectState();return waitForUaePassApproval(s);}catch(error){return{status:'continue_error',message:error.message,url:page?.url?.()||''};}}
export async function continueUaePassLogin(){if(!page||page.isClosed())return{status:'no_active_session'};try{return await submitUaePassId();}catch(error){return{status:'uae_pass_error',message:error.message,url:page?.url?.()||''};}}
export async function checkUaePassStatus(){if(!page||page.isClosed())return{status:'no_active_session'};try{await page.waitForTimeout(1000);let s=await detectState();s=await waitForUaePassApproval(s);if(['session_active','real_estate_admin_profile_selected'].includes(s.status))await saveSession();return s;}catch(error){return{status:'uae_pass_check_error',message:error.message,url:page?.url?.()||''};}}
export async function testDldLogin(){try{return await startInteractiveDldLogin();}catch(error){return{status:'agent_error',message:error.message};}}
