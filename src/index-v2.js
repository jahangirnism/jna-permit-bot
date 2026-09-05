import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractTitleDeedFromFile } from './titleDeed.js';
import { extractIdFromFile } from './id-document.js';
import { startAgentRelay, runBrowserTask } from './agentRelay.js';
import { findPixxiAgentByMobile, getPixxiCurrentUser, pixxiAgentSummary } from './pixxi.js';
import { generateListingCopy } from './listing-ai.js';
import { createListingFromDraft, generateNocPdf, normalizeHouseType } from './listing-crm.js';
import { initRuntimeState, loadListingAiStates, saveListingAiState, deleteListingAiState, loadListingCaseStates, saveListingCaseState, deleteListingCaseState, waitForTelegramLease, closeRuntimeState } from './runtime-state.js';

const token=process.env.TELEGRAM_BOT_TOKEN;
if(!token){console.error('Missing TELEGRAM_BOT_TOKEN environment variable');process.exit(1);}
const apiBase=`https://api.telegram.org/bot${token}`;
let offset=0,loginTestRunning=false;
const permitState=new Map(),listingAiState=new Map(),listingCaseState=new Map(),autoResumeWatchers=new Map();
const MANUAL_BROWSER_STATES=new Set(['login_form','captcha_required','authentication_code','uae_pass','uae_pass_approval_required','uae_pass_approval_timeout','post_login_unknown']);

async function telegram(method,body={}){const response=await fetch(`${apiBase}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!data.ok)throw new Error(`${method} failed (${data.error_code||response.status}): ${data.description||'Unknown Telegram error'}`);return data.result;}
function replyChoices(options){return{reply_markup:{keyboard:[options.map(text=>({text}))],resize_keyboard:true,one_time_keyboard:true}};}
async function sendMessage(chatId,text,extra={}){return telegram('sendMessage',{chat_id:chatId,text,disable_web_page_preview:true,...extra});}
async function sendDocument(chatId,buffer,fileName,caption=''){const form=new FormData();form.append('chat_id',String(chatId));if(caption)form.append('caption',caption);form.append('document',new Blob([buffer],{type:'application/pdf'}),fileName);const r=await fetch(`${apiBase}/sendDocument`,{method:'POST',body:form});const d=await r.json();if(!d.ok)throw new Error(`sendDocument failed: ${d.description||r.status}`);return d.result;}
function workflowPayload(state){return state?.deed&&state?.purpose&&state?.propertyType?{deed:state.deed,purpose:state.purpose,propertyType:state.propertyType,step:state.step}:null;}
function clean(v){return String(v??'').trim();}

function resultMessage(result){switch(result.status){
case'agent_not_configured':return'Local browser agent is not configured yet. Add AGENT_SHARED_SECRET on Railway and start the office agent with the same secret.';
case'agent_offline':return'The office browser agent is offline. Start it on the office computer, keep Chrome available, then try again.';
case'agent_error':return`Office browser agent error: ${result.message||'unknown error'}`;
case'missing_credentials':return'The office browser agent is missing DLD_USERNAME or DLD_PASSWORD in its local environment.';
case'login_form':return'DLD login/verification is open in the office Chrome window. Complete the required manual step there; I will keep checking and continue automatically.';
case'captcha_required':return'CAPTCHA is showing in the office Chrome window. Complete it manually there; I will keep checking and continue automatically.';
case'authentication_code':return'DLD reached an authentication-code screen. Enter the code manually in the office Chrome window; I will keep checking and continue automatically.';
case'uae_pass':return'UAE PASS is open in the office Chrome window. Complete the required manual step; I will keep checking and continue automatically.';
case'uae_pass_id_required':return'The office browser agent is missing UAE_PASS_EMIRATES_ID in its local environment.';
case'uae_pass_id_field_not_found':return'UAE PASS opened, but the Emirates ID field was not detected in the office Chrome window.';
case'uae_pass_login_button_not_found':return'The Emirates ID was filled, but the UAE PASS Login button was not detected.';
case'uae_pass_approval_required':return`UAE PASS APPROVAL REQUIRED\n\nSelect number ${result.challenge} in your UAE PASS app.\n\nI will keep checking automatically after approval.`;
case'real_estate_admin_profile_selected':return result.needsPermitContext?'REAL ESTATE OFFICE ADMIN is active. The browser session is recovered, but the local agent does not yet have this permit’s property context.':'REAL ESTATE OFFICE ADMIN profile selected successfully. Continuing from the current Trakheesi session.';
case'session_active':return result.needsPermitContext?'DLD/Trakheesi session is active, but the local agent does not yet have this permit’s property context.':'DLD/Trakheesi session is active on the office computer.';
case'real_estate_admin_profile_not_found':return'Multiple DLD profiles were found, but REAL ESTATE OFFICE ADMIN was not detected.';
case'admin_profile_radio_not_found':return'REAL ESTATE OFFICE ADMIN was detected, but its selection control was not found.';
case'trakheesi_not_found':return'DLD dashboard opened, but the Trakheesi card was not detected.';
case'trakheesi_uae_pass_button_not_found':return'Trakheesi was detected, but its “Login with UAE Pass” button was not found.';
case'no_active_session':return'There is no active local DLD browser session. Send /testlogin first.';
case'login_form_not_found':return`DLD opened, but the login form was not detected. Page: ${result.url||'unknown'}`;
case'post_login_unknown':return`DLD moved to a new screen that still needs mapping. I will keep checking for the next known state. Page: ${result.url||'unknown'}`;
case'secondary_permit_not_found':return'Secondary permit 150273 was not found. I stopped without changing anything.';
case'permit_menu_not_found':return'Permit 150273 was found, but its action menu was not detected. I stopped without changing anything.';
case'permit_edit_not_found':return'Permit 150273 menu opened, but Edit was not detected. I stopped.';
case'wrong_permit_edit_page':return'The page did not confirm transaction 150273. I stopped to avoid editing the wrong permit.';
case'add_property_button_not_found':return'Permit 150273 opened, but Add Property/Project was not detected.';
case'area_option_not_found':return`Area “${result.area}” was not found in the DLD dropdown. Please check the Title Deed/DLD area name.`;
case'property_type_not_mapped':return`${result.propertyType} is selected, but automatic field mapping is currently defined only for UNIT.`;
case'property_selected':return`Property selected:\n${result.unitNo} — ${result.selectedResult||`${result.buildingName}, ${result.area}`}`;
case'listing_value_ready':return`Current Trakheesi listing is ready for Value${result.selectedResult?`:\n${result.selectedResult}`:'.'}`;
case'listing_resume_not_ready':return`I could not safely resume from the current Trakheesi page (${result.reason||'required listing screen not found'}). I did not click anything.`;
case'listing_resume_error':return`Could not inspect the current Trakheesi listing: ${result.message||'unknown error'}`;
case'file_normalization_failed':return`Could not prepare the ${result.which==='marketing_contract'?'Marketing Contract':'Advertisement Format'} for DLD: ${result.message}`;
case'document_upload_fields_not_found':return'The required DLD document upload fields were not detected. I stopped before Save.';
case'value_field_not_found':return'The visible Value field was not detected. I stopped before changing anything.';
case'listing_save_button_not_found':return'The exact Unit Save button was not detected. I stopped without saving.';
case'listing_saved':return'Property listing was saved successfully under secondary permit 150273.';
default:return`DLD browser status: ${result.message||result.status||'unknown error'}`;}}

async function downloadTelegramFile(fileId,originalName='upload.pdf'){const info=await telegram('getFile',{file_id:fileId});const response=await fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`);if(!response.ok)throw new Error(`Telegram file download failed (${response.status})`);const extension=path.extname(originalName)||path.extname(info.file_path)||'.bin';const filePath=path.join(os.tmpdir(),`jna-${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`);await fs.writeFile(filePath,Buffer.from(await response.arrayBuffer()));return filePath;}
async function telegramFileData(message,defaultName){const doc=message.document,photo=message.photo?.at(-1);const fileId=doc?.file_id||photo?.file_id;if(!fileId)return null;const info=await telegram('getFile',{file_id:fileId});const response=await fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`);if(!response.ok)throw new Error(`Telegram file download failed (${response.status})`);const buf=Buffer.from(await response.arrayBuffer());return{name:doc?.file_name||(defaultName||`upload-${Date.now()}.jpg`),size:buf.length,base64:buf.toString('base64')};}

async function handleTitleDeed(chatId,message,state){const doc=message.document,photo=message.photo?.at(-1),fileId=doc?.file_id||photo?.file_id;if(!fileId)return false;const name=doc?.file_name||(photo?'title-deed.jpg':'title-deed.bin');let local;try{await sendMessage(chatId,'Reading the Title Deed…');local=await downloadTelegramFile(fileId,name);const{fields}=await extractTitleDeedFromFile(local);state.deed=fields;const missing=[];if(!fields.area)missing.push('Community / Area');if(!fields.landNo)missing.push('Plot No / Land No');if(!fields.buildingName)missing.push('Building Name');if(!fields.unitNo)missing.push('Property No / Unit No');const summary=`Title Deed extracted:\n\nArea: ${fields.area||'NOT FOUND'}\nLand No: ${fields.landNo||'NOT FOUND'}\nBuilding Name: ${fields.buildingName||'NOT FOUND'}\nUnit No: ${fields.unitNo||'NOT FOUND'}`;if(missing.length){state.step='deed_review';await sendMessage(chatId,`${summary}\n\nI could not confidently read: ${missing.join(', ')}. Please check the deed manually before we continue.`);return true;}state.step='purpose';await sendMessage(chatId,`${summary}\n\nSelect RENT or SALE.`,replyChoices(['RENT','SALE']));return true;}finally{if(local)await fs.rm(local,{force:true}).catch(()=>{});}}

function inferHouseType(v=''){const s=String(v).toUpperCase();for(const x of['APARTMENT','VILLA','TOWNHOUSE','OFFICE','LAND'])if(s.includes(x))return x;return'';}
async function askNextListingField(chatId,state){
  if(!state.agentMobile){state.step='agent_mobile';return sendMessage(chatId,'Agent mobile number?\nExample: +971544559898');}
  if(!state.ownerMobile){state.step='owner_mobile';return sendMessage(chatId,'Owner mobile number?');}
  if(!state.ownerEmail){state.step='owner_email';return sendMessage(chatId,'Owner email? Send - if unavailable.');}
  if(!state.building){state.step='building';return sendMessage(chatId,'Building / Project name?');}
  if(!state.area){state.step='area';return sendMessage(chatId,'Area / community?');}
  if(!state.crmHouseType){state.step='crm_house_type';return sendMessage(chatId,'Property type? APARTMENT, VILLA, TOWNHOUSE, OFFICE, or LAND');}
  if(!state.size){state.step='size';return sendMessage(chatId,'Property size in sq ft?');}
  if(!state.listingType){state.step='listing_type';return sendMessage(chatId,'Select listing type:',replyChoices(['RENT','SALE']));}
  if(state.listingType==='RENT'&&!state.completionStatus)state.completionStatus='COMPLETED';
  if(state.bedrooms===undefined||state.bedrooms===null||state.bedrooms===''){state.step='bedrooms';return sendMessage(chatId,'Bedrooms? Example: Studio, 1 BR, 2 BR');}
  if(!state.price){state.step='price';return sendMessage(chatId,'Listing price in AED?');}
  if(!state.furnishing){state.step='furnishing';return sendMessage(chatId,'Furnishing? Furnished, Unfurnished, or Semi Furnished');}
  if(state.view===undefined){state.step='view';return sendMessage(chatId,'View? Send - if none.');}
  if(!state.completionStatus){state.step='completion';return sendMessage(chatId,'Sale completion status:',replyChoices(['COMPLETED','OFF_PLAN']));}
  if(!state.parking){state.step='parking';return sendMessage(chatId,'Parking spaces? Send 0 if none.');}
  if(state.commission===undefined){state.step='commission';return sendMessage(chatId,'Commission amount / terms for NOC? Send - if none.');}
  if(!state.contractType){state.step='contract_type';return sendMessage(chatId,'Contract type? EXCLUSIVE or NON-EXCLUSIVE');}
  if(state.notes===undefined){state.step='notes';return sendMessage(chatId,'Agent notes / special features for the listing AI? Send - if none.');}
  state.step='generating';await saveListingCaseState(chatId,state);await sendMessage(chatId,'Generating the listing title and description…');
  const generated=await generateListingCopy(state);state.generated=generated;state.step='draft_ready';await saveListingCaseState(chatId,state);
  await sendMessage(chatId,`AI LISTING DRAFT\n\nTITLE (${generated.titleChars} chars)\n${generated.title}\n\nDESCRIPTION (${generated.descriptionChars} chars)\n${generated.description}\n\nReview it. If approved, send /createcrm to create the Pixxi listing and generate the A2/NOC.`);
}

async function handleNewListingUpload(chatId,message,state){
  if(state.step==='title_deed_upload'){
    const file=await telegramFileData(message,'Title Deed.pdf');if(!file)return false;let local;
    try{await sendMessage(chatId,'Reading the Title Deed and extracting reusable property data…');local=await downloadTelegramFile(message.document?.file_id||message.photo?.at(-1)?.file_id,file.name);const{fields}=await extractTitleDeedFromFile(local);state.titleDeedFile=file;state.deed=fields;state.area=fields.area||'';state.building=fields.buildingName||'';state.plotNo=fields.landNo||'';state.unitNo=fields.unitNo||'';state.titleDeedNo=fields.titleDeedNo||'';state.size=fields.sizeSqFt||'';state.parking=fields.parking||'';state.crmHouseType=inferHouseType(fields.propertyType);state.ownerNameFromDeed=fields.ownerName||'';state.step='id_upload';await saveListingCaseState(chatId,state);await sendMessage(chatId,`Title Deed read successfully.\n\nOwner: ${fields.ownerName||'NOT FOUND'}\nArea: ${fields.area||'NOT FOUND'}\nBuilding: ${fields.buildingName||'NOT FOUND'}\nUnit: ${fields.unitNo||'NOT FOUND'}\nPlot: ${fields.landNo||'NOT FOUND'}\nTitle Deed No: ${fields.titleDeedNo||'NOT FOUND'}\nSize: ${fields.sizeSqFt?`${fields.sizeSqFt} sq ft`:'NOT FOUND'}\n\nNow upload the owner's Passport / Emirates ID / ID copy.`);return true;}finally{if(local)await fs.rm(local,{force:true}).catch(()=>{});}
  }
  if(state.step==='id_upload'){
    const file=await telegramFileData(message,'ID.pdf');if(!file)return false;let local;
    try{await sendMessage(chatId,'Reading the ID document…');local=await downloadTelegramFile(message.document?.file_id||message.photo?.at(-1)?.file_id,file.name);const{fields}=await extractIdFromFile(local);state.idFile=file;state.idFields=fields;state.ownerName=fields.fullName||state.ownerNameFromDeed||'';state.ownerId=fields.idNo||'';state.step='collecting';await saveListingCaseState(chatId,state);await sendMessage(chatId,`ID extracted.\n\nName: ${state.ownerName||'NOT FOUND'}\nFirst Name: ${fields.firstName||'NOT FOUND'}\nLast Name: ${fields.lastName||'NOT FOUND'}\nID No: ${state.ownerId||'NOT FOUND'}\nDocument: ${fields.documentType||'ID'}\n\nI will now ask only for information not available from the documents.`);await askNextListingField(chatId,state);return true;}finally{if(local)await fs.rm(local,{force:true}).catch(()=>{});}
  }
  return false;
}

async function handleListingText(chatId,raw,state){const v=raw.trim();switch(state.step){
case'agent_mobile':{const row=await findPixxiAgentByMobile(v);if(!row){await sendMessage(chatId,'No Pixxi staff member matched that mobile. Please check the number.');return true;}state.agentMobile=v;state.nocAgent=pixxiAgentSummary(row);break;}
case'owner_mobile':state.ownerMobile=v;break;
case'owner_email':state.ownerEmail=v==='-'?'':v;break;
case'building':state.building=v;break;
case'area':state.area=v;break;
case'crm_house_type':try{state.crmHouseType=normalizeHouseType(v);}catch(e){await sendMessage(chatId,e.message);return true;}break;
case'size':state.size=v.replace(/,/g,'');break;
case'listing_type':if(!/^(rent|sale)$/i.test(v)){await sendMessage(chatId,'Please choose RENT or SALE.',replyChoices(['RENT','SALE']));return true;}state.listingType=v.toUpperCase();if(state.listingType==='RENT')state.completionStatus='COMPLETED';else if(state.completionStatus==='COMPLETED')state.completionStatus='';break;
case'bedrooms':state.bedrooms=v;break;
case'price':state.price=v.replace(/,/g,'');break;
case'furnishing':state.furnishing=v;break;
case'view':state.view=v==='-'?'':v;break;
case'completion':if(!/^(ready|completed|complete|off[_ -]?plan)$/i.test(v)){await sendMessage(chatId,'Please choose COMPLETED or OFF_PLAN.',replyChoices(['COMPLETED','OFF_PLAN']));return true;}state.completionStatus=/off[_ -]?plan/i.test(v)?'OFF_PLAN':'COMPLETED';break;
case'parking':state.parking=v;break;
case'commission':state.commission=v==='-'?'':v;break;
case'contract_type':if(!/^(exclusive|non[- ]?exclusive)$/i.test(v)){await sendMessage(chatId,'Please send EXCLUSIVE or NON-EXCLUSIVE.');return true;}state.contractType=/^exclusive$/i.test(v)?'EXCLUSIVE':'NON-EXCLUSIVE';break;
case'notes':state.notes=v==='-'?'':v;break;
default:return false;}
  await saveListingCaseState(chatId,state);await askNextListingField(chatId,state);return true;
}

async function createCrmAndNoc(chatId,state){
  if(state.step!=='draft_ready'||!state.generated)throw new Error('No approved listing draft is ready. Start with /newlisting.');
  state.step='crm_creating';await saveListingCaseState(chatId,state);await sendMessage(chatId,'Creating the Pixxi CRM listing…');
  const created=await createListingFromDraft(state);state.listingRef=created.listingRef;state.pixxiListingRef=created.pixxiListingRef||created.listingRef;state.crmCreateResponse=created.data;state.step='crm_created';
  await saveListingCaseState(chatId,state);
  const sync=await runBrowserTask('sync_listing_case',{listingRef:state.listingRef,titleDeed:state.titleDeedFile,idCopy:state.idFile},60000);
  if(sync.status!=='listing_case_synced')await sendMessage(chatId,`CRM listing created, but the office case folder could not be confirmed: ${sync.message||sync.status}`);
  else await sendMessage(chatId,`Pixxi listing created.\n\nJnA Case Reference: ${state.listingRef}${state.pixxiListingRef!==state.listingRef?`\nPixxi raw reference: ${state.pixxiListingRef}`:''}\nLocal case folder: Listing/${state.listingRef}/\nTitle Deed and ID have been saved there.`);
  await sendMessage(chatId,'Generating the A2/NOC PDF from the same extracted owner/property information…');
  const pdf=await generateNocPdf(state);state.step='waiting_signed_noc';await saveListingCaseState(chatId,state);
  await sendDocument(chatId,pdf.buffer,pdf.fileName,`A2/NOC for case ${state.listingRef}. Staff ID is internal and is not shown on this PDF.`);
  await sendMessage(chatId,`Case ${state.listingRef} is now linked end-to-end. The same Title Deed fields are retained for the Trakheesi permit stage; you will not need to re-enter Area, Plot/Land No, Building or Unit.`);
}

async function prepareListing(chatId,state){if(!state?.deed||!state.purpose||!state.propertyType)return;await sendMessage(chatId,'Opening secondary permit 150273 and searching DLD for the Title Deed property…');const result=await runBrowserTask('prepare_listing',{purpose:state.purpose,propertyType:state.propertyType,deed:state.deed},70000);await sendMessage(chatId,resultMessage(result));if(result.status==='property_selected'){state.step='value';await sendMessage(chatId,'Please enter the property VALUE in AED.\nExample: 50000');}}
async function maybePrepareListing(chatId,state,result){if(state?.step==='ready_for_dld'&&['session_active','real_estate_admin_profile_selected'].includes(result.status))await prepareListing(chatId,state);}
function cancelAutoResumeWatch(chatId){autoResumeWatchers.delete(chatId);}
async function applyRecoveredBrowserState(chatId,fallbackState,result){let state=permitState.get(chatId)||fallbackState;if(['listing_value_ready','property_selected'].includes(result.status)){if(!state)state={};state.step='value';state.resumed=true;permitState.set(chatId,state);await sendMessage(chatId,'I recovered the current listing and continued to the next safe step.\n\nPlease enter the property VALUE in AED.\nExample: 50000');return true;}if(['session_active','real_estate_admin_profile_selected'].includes(result.status)&&state?.step==='ready_for_dld'){await sendMessage(chatId,'DLD session recovered. Continuing the permit workflow automatically…');await prepareListing(chatId,state);return true;}return false;}
function startAutoResumeWatch(chatId,state){if(autoResumeWatchers.has(chatId))return;const marker=Symbol('auto-resume');autoResumeWatchers.set(chatId,marker);void(async()=>{const deadline=Date.now()+5*60*1000;try{while(Date.now()<deadline&&autoResumeWatchers.get(chatId)===marker){await new Promise(r=>setTimeout(r,5000));const current=permitState.get(chatId)||state;const result=await runBrowserTask('resume_listing',{workflow:workflowPayload(current)},70000).catch(error=>({status:'agent_error',message:error.message}));if(MANUAL_BROWSER_STATES.has(result.status))continue;if(await applyRecoveredBrowserState(chatId,current,result))return;if(['agent_offline','agent_not_configured','no_active_session'].includes(result.status))return;}}finally{if(autoResumeWatchers.get(chatId)===marker)autoResumeWatchers.delete(chatId);}})();}
async function runLoginTest(chatId,state){if(loginTestRunning){await sendMessage(chatId,'A DLD login check is already running.');return;}loginTestRunning=true;try{await sendMessage(chatId,'Checking the DLD session on the office computer…');const result=await runBrowserTask('test_login',{workflow:workflowPayload(state)},90000);await sendMessage(chatId,resultMessage(result));if(await applyRecoveredBrowserState(chatId,state,result))return;await maybePrepareListing(chatId,state,result);if(MANUAL_BROWSER_STATES.has(result.status))startAutoResumeWatch(chatId,state);}finally{loginTestRunning=false;}}
async function finalizeListing(chatId,state){state.step='saving';await sendMessage(chatId,'Preparing the files, uploading them to Trakheesi, and saving the property…');const result=await runBrowserTask('finalize_listing',{value:state.value,marketingContract:state.marketingContract,advertisementFormat:state.advertisementFormat},90000);await sendMessage(chatId,resultMessage(result));if(result.status==='listing_saved'){state.step='saved';await sendMessage(chatId,'Done. Announcement Text was left blank. Save was completed.');}else state.step='advertisement_format';}

async function handleListingAiInput(chatId,raw,state){const value=raw.trim();if(state.step==='building'){state.building=value;state.step='area';await sendMessage(chatId,'Area / community?');return true;}if(state.step==='area'){state.area=value;state.step='bedrooms';await sendMessage(chatId,'Bedrooms?');return true;}if(state.step==='bedrooms'){state.bedrooms=value;state.step='size';await sendMessage(chatId,'Size in sq ft?');return true;}if(state.step==='size'){state.size=value;state.step='listing_type';await sendMessage(chatId,'Select listing type:',replyChoices(['RENT','SALE']));return true;}if(state.step==='listing_type'){if(!/^(rent|sale)$/i.test(value)){await sendMessage(chatId,'Please choose RENT or SALE.',replyChoices(['RENT','SALE']));return true;}state.listingType=value.toUpperCase();state.step='price';await sendMessage(chatId,'Price in AED?');return true;}if(state.step==='price'){state.price=value.replace(/,/g,'');state.step='furnishing';await sendMessage(chatId,'Furnishing?');return true;}if(state.step==='furnishing'){state.furnishing=value;state.step='view';await sendMessage(chatId,'View? Send - if none.');return true;}if(state.step==='view'){state.view=value==='-'?'':value;state.step='notes';await sendMessage(chatId,'Agent notes / special features? Send - if none.');return true;}if(state.step==='notes'){state.notes=value==='-'?'':value;state.step='generating';await saveListingAiState(chatId,state);await sendMessage(chatId,'Researching the building and generating the listing title + description with the existing Claude workflow…');try{const result=await generateListingCopy(state);state.step='generated';state.generated=result;await saveListingAiState(chatId,state);await sendMessage(chatId,`AI LISTING DRAFT\n\nTITLE (${result.titleChars} chars)\n${result.title}\n\nDESCRIPTION (${result.descriptionChars} chars)\n${result.description}\n\nRead-only AI test complete. No Pixxi listing was created or changed.`);}catch(error){state.step='notes';await saveListingAiState(chatId,state);await sendMessage(chatId,`Listing AI failed: ${error.message}`);}return true;}return false;}

async function handleUpdate(update){const message=update.message;if(!message)return;const chatId=message.chat.id;let state=permitState.get(chatId),caseState=listingCaseState.get(chatId);
  if(caseState&&(message.document||message.photo)&&['title_deed_upload','id_upload'].includes(caseState.step)){try{if(await handleNewListingUpload(chatId,message,caseState))return;}catch(e){await sendMessage(chatId,`Could not process that document: ${e.message}`);return;}}
  if(state?.step==='title_deed'&&(message.document||message.photo)){try{await handleTitleDeed(chatId,message,state);}catch(e){await sendMessage(chatId,`I could not read that Title Deed automatically: ${e.message}`);}return;}
  if(state?.step==='marketing_contract'&&(message.document||message.photo)){state.marketingContract=await telegramFileData(message,'marketing-contract.jpg');state.step='advertisement_format';await sendMessage(chatId,'Marketing Contract received. Now upload the Copy of the Advertisement Format.');return;}
  if(state?.step==='advertisement_format'&&(message.document||message.photo)){state.advertisementFormat=await telegramFileData(message,'advertisement-format.jpg');await finalizeListing(chatId,state);return;}
  if(!message.text)return;const raw=message.text.trim(),command=raw.split(/\s+/)[0].split('@')[0].toLowerCase();console.log(`Received ${command} from chat ${chatId}`);

  if(command==='/newlisting'||command==='/createcrm'&&(!caseState||caseState.step!=='draft_ready')){
    if(command==='/createcrm'&&caseState){}else{caseState={step:'title_deed_upload',createdAt:new Date().toISOString()};listingCaseState.set(chatId,caseState);await saveListingCaseState(chatId,caseState);await sendMessage(chatId,'New Listing / CRM Case\n\nPlease upload the Title Deed as PDF or a clear image. I will extract the available property and owner details and reuse them for CRM, NOC and the permit.');return;}}
  if(command==='/createcrm'){try{await createCrmAndNoc(chatId,caseState);}catch(e){if(caseState){caseState.step='draft_ready';await saveListingCaseState(chatId,caseState);}await sendMessage(chatId,`CRM/NOC workflow failed: ${e.message}`);}return;}
  if(command==='/testpixxi'){await sendMessage(chatId,'Testing Pixxi admin login…');try{const data=await getPixxiCurrentUser();const u=data?.data||data||{};await sendMessage(chatId,`Pixxi admin login successful.\n\nAccount: ${u?.nickName||u?.name||'Admin account'}${u?.email?`\nEmail: ${u.email}`:''}`);}catch(e){await sendMessage(chatId,`Pixxi admin login failed: ${e.message}`);}return;}
  if(command==='/testagent'){const mobile=raw.split(/\s+/).slice(1).join(' ').trim();if(!mobile){await sendMessage(chatId,'Example: /testagent +971544559898');return;}const row=await findPixxiAgentByMobile(mobile);if(!row){await sendMessage(chatId,'No Pixxi staff member matched that mobile number.');return;}const a=pixxiAgentSummary(row);await sendMessage(chatId,`Pixxi staff match found.\n\nName: ${a.name}\nPhone: ${a.phone}\nEmail: ${a.email}\nBRN: ${a.brn}\nStaff ID: ${a.id}\n\nRead-only test.`);return;}
  if(command==='/testlistingai'){const s={step:'building'};listingAiState.set(chatId,s);await saveListingAiState(chatId,s);await sendMessage(chatId,'Claude Listing AI Test\n\nFirst, send the Building / Project name.');return;}
  if(command==='/resumelisting'){await sendMessage(chatId,'Checking the current DLD/Trakheesi browser state…');const result=await runBrowserTask('resume_listing',{workflow:workflowPayload(state)},90000);await sendMessage(chatId,resultMessage(result));if(await applyRecoveredBrowserState(chatId,state,result)){cancelAutoResumeWatch(chatId);return;}if(MANUAL_BROWSER_STATES.has(result.status))startAutoResumeWatch(chatId,state);return;}
  if(command==='/cancel'){cancelAutoResumeWatch(chatId);permitState.delete(chatId);listingAiState.delete(chatId);listingCaseState.delete(chatId);await deleteListingAiState(chatId);await deleteListingCaseState(chatId);await sendMessage(chatId,'Current workflow cancelled. No DLD browser changes were made by cancellation.');return;}
  if(command==='/start'){await sendMessage(chatId,'Welcome to JnA Permit Bot.\n\nUse /newlisting for the integrated Title Deed → ID → AI → Pixxi → NOC flow, or /newpermit for permit-only requests.');return;}
  if(command==='/newpermit'){cancelAutoResumeWatch(chatId);state={step:'title_deed'};permitState.set(chatId,state);await sendMessage(chatId,'New Permit Request\n\nPlease upload the Title Deed.');return;}
  if(command==='/testlogin'){await runLoginTest(chatId,state);return;}
  if(command==='/continue'){const result=await runBrowserTask('continue',{},50000);await sendMessage(chatId,resultMessage(result));await maybePrepareListing(chatId,state,result);if(MANUAL_BROWSER_STATES.has(result.status))startAutoResumeWatch(chatId,state);return;}
  if(command==='/uaepass'){const result=await runBrowserTask('uae_pass',{},50000);await sendMessage(chatId,resultMessage(result));if(MANUAL_BROWSER_STATES.has(result.status))startAutoResumeWatch(chatId,state);return;}
  if(command==='/checkuaepass'){const result=await runBrowserTask('check_ua_pass',{},40000).catch(()=>runBrowserTask('check_uae_pass',{},40000));await sendMessage(chatId,resultMessage(result));await maybePrepareListing(chatId,state,result);return;}

  caseState=listingCaseState.get(chatId);if(caseState&&!raw.startsWith('/')&&await handleListingText(chatId,raw,caseState))return;
  const aiState=listingAiState.get(chatId);if(aiState&&!raw.startsWith('/')){if(await handleListingAiInput(chatId,raw,aiState)){await saveListingAiState(chatId,aiState);return;}}
  if(state?.step==='purpose'&&/^(rent|sale)$/i.test(raw)){state.purpose=raw.toUpperCase();state.step='property_type';await sendMessage(chatId,'Select property type: LAND, BUILDING, VILLA, or UNIT');return;}
  if(state?.step==='property_type'&&/^(land|building|villa|unit)$/i.test(raw)){state.propertyType=raw.toUpperCase();state.step='ready_for_dld';if(state.propertyType==='UNIT')await sendMessage(chatId,`Unit details ready for DLD:\nArea: ${state.deed.area}\nLand No: ${state.deed.landNo}\nBuilding: ${state.deed.buildingName}\nUnit: ${state.deed.unitNo}\n\nSend /testlogin.`);else await sendMessage(chatId,`${state.propertyType} selected. Automatic DLD mapping is currently defined only for UNIT.`);return;}
  if(state?.step==='value'){const c=raw.replace(/,/g,'');if(!/^\d+(?:\.\d{1,2})?$/.test(c)||Number(c)<=0){await sendMessage(chatId,'Please send a valid positive VALUE.');return;}state.value=c;state.step='marketing_contract';await sendMessage(chatId,'Now upload the Marketing Contract from the Owner.');return;}
}

async function startup(){const me=await telegram('getMe');console.log(`Connected to Telegram as @${me.username} (${me.id})`);await telegram('deleteWebhook',{drop_pending_updates:false});console.log('Telegram webhook cleared');}
async function poll(){startAgentRelay();await initRuntimeState();for(const[k,v]of await loadListingAiStates())listingAiState.set(k,v);for(const[k,v]of await loadListingCaseStates())listingCaseState.set(k,v);console.log(`Restored ${listingCaseState.size} integrated listing case state(s)`);await startup();await waitForTelegramLease();console.log('JnA Permit Bot is running in integrated listing/permit mode; Telegram long polling active');while(true){try{const updates=await telegram('getUpdates',{offset,timeout:25,allowed_updates:['message']});for(const update of updates){offset=update.update_id+1;try{await handleUpdate(update);}catch(err){console.error('Update handling error:',err);try{if(update.message?.chat?.id)await sendMessage(update.message.chat.id,`Bot error: ${err.message}`);}catch{}}}}catch(err){console.error('Polling error:',err);await new Promise(r=>setTimeout(r,/getUpdates failed \(409\)/.test(err.message||'')?15000:3000));}}}
let shuttingDown=false;async function shutdown(signal){if(shuttingDown)return;shuttingDown=true;console.log(`${signal} received; releasing Telegram lease...`);await closeRuntimeState().catch(()=>{});process.exit(0);}process.on('SIGTERM',()=>void shutdown('SIGTERM'));process.on('SIGINT',()=>void shutdown('SIGINT'));poll().catch(async err=>{console.error('Fatal bot error:',err);await closeRuntimeState().catch(()=>{});process.exit(1);});
