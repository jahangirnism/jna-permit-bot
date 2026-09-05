import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const sourcePath=path.join(__dirname,'index-v2.js');
const runtimePath=path.join(__dirname,'.index-v2-runtime.mjs');
let source=await fs.readFile(sourcePath,'utf8');

function replaceExact(from,to,label){
  if(!source.includes(from))throw new Error(`Startup patch failed: ${label}`);
  source=source.replace(from,to);
}

// Private bot: only these Telegram user IDs may interact with the bot.
// IDs are used instead of usernames because Telegram usernames can change.
replaceExact(
  "async function handleUpdate(update){",
  `const ALLOWED_TELEGRAM_USER_IDS=new Set(['8824174298','1124582593']);
function telegramUserId(update){return String(update?.message?.from?.id??update?.callback_query?.from?.id??update?.edited_message?.from?.id??'');}
async function handleUpdate(update){
  const senderId=telegramUserId(update);
  if(!senderId||!ALLOWED_TELEGRAM_USER_IDS.has(senderId)){
    const deniedChatId=update?.message?.chat?.id??update?.callback_query?.message?.chat?.id??update?.edited_message?.chat?.id;
    if(deniedChatId)await sendMessage(deniedChatId,'Access denied. This is a private JnA House bot.').catch(()=>{});
    return;
  }`,
  'approved Telegram users'
);

replaceExact(
  "if(!state.crmHouseType){state.step='crm_house_type';return sendMessage(chatId,'Property type? APARTMENT, VILLA, TOWNHOUSE, OFFICE, or LAND');}",
  "if(!state.crmHouseType){state.step='crm_house_type';return sendMessage(chatId,'Select property type:',replyChoices(['APARTMENT','VILLA','TOWNHOUSE','OFFICE','LAND']));}",
  'property type choices'
);

replaceExact(
  "if(state.bedrooms===undefined||state.bedrooms===null||state.bedrooms===''){state.step='bedrooms';return sendMessage(chatId,'Bedrooms? Example: Studio, 1 BR, 2 BR');}",
  `if(state.bedrooms===undefined||state.bedrooms===null||state.bedrooms===''){state.step='bedrooms';return sendMessage(chatId,'Bedrooms? Enter a number only.\\n0 = Studio, 1 = 1 BR, 2 = 2 BR, etc.');}
  if(state.bathrooms===undefined||state.bathrooms===null||state.bathrooms===''){state.step='bathrooms';return sendMessage(chatId,'Bathrooms? Enter a number only.\\nExample: 1, 2, 3');}`,
  'bedroom and bathroom prompts'
);

replaceExact(
  "if(!state.furnishing){state.step='furnishing';return sendMessage(chatId,'Furnishing? Furnished, Unfurnished, or Semi Furnished');}",
  "if(!state.furnishing){state.step='furnishing';return sendMessage(chatId,'Select furnishing:',replyChoices(['Furnished','Semi Furnished','Unfurnished']));}",
  'furnishing choices'
);

replaceExact(
  "case'crm_house_type':try{state.crmHouseType=normalizeHouseType(v);}catch(e){await sendMessage(chatId,e.message);return true;}break;",
  "case'crm_house_type':try{state.crmHouseType=normalizeHouseType(v);}catch(e){await sendMessage(chatId,'Please choose a property type.',replyChoices(['APARTMENT','VILLA','TOWNHOUSE','OFFICE','LAND']));return true;}break;",
  'property type validation'
);

replaceExact(
  "case'bedrooms':state.bedrooms=v;break;",
  `case'bedrooms':if(!/^\\d+$/.test(v)){await sendMessage(chatId,'Bedrooms must be numeric. Use 0 for Studio, then 1, 2, 3, etc.');return true;}state.bedrooms=v;break;
case'bathrooms':if(!/^\\d+$/.test(v)){await sendMessage(chatId,'Bathrooms must be numeric. Example: 1, 2, 3.');return true;}state.bathrooms=v;break;`,
  'numeric bedroom bathroom validation'
);

replaceExact(
  "case'furnishing':state.furnishing=v;break;",
  `case'furnishing':{
    const f=v.toUpperCase().replace(/[\\s_-]+/g,' ').trim();
    if(f==='FURNISHED'||f==='FULLY FURNISHED')state.furnishing='Furnished';
    else if(f==='SEMI FURNISHED'||f==='SEMI')state.furnishing='Semi Furnished';
    else if(f==='UNFURNISHED'||f==='UN FURNISHED')state.furnishing='Unfurnished';
    else{await sendMessage(chatId,'Please select one of the furnishing options below.',replyChoices(['Furnished','Semi Furnished','Unfurnished']));return true;}
    break;
  }`,
  'furnishing validation choices'
);

replaceExact(
  "  const sync=await runBrowserTask('sync_listing_case',{listingRef:state.listingRef,titleDeed:state.titleDeedFile,idCopy:state.idFile},60000);\n  if(sync.status!=='listing_case_synced')await sendMessage(chatId,`CRM listing created, but the office case folder could not be confirmed: ${sync.message||sync.status}`);\n  else await sendMessage(chatId,`Pixxi listing created.\\n\\nJnA Case Reference: ${state.listingRef}${state.pixxiListingRef!==state.listingRef?`\\nPixxi raw reference: ${state.pixxiListingRef}`:''}\\nLocal case folder: Listing/${state.listingRef}/\\nTitle Deed and ID have been saved there.`);\n  await sendMessage(chatId,'Generating the A2/NOC PDF from the same extracted owner/property information…');",
  `  const sync=await runBrowserTask('sync_listing_case',{listingRef:state.listingRef,titleDeed:state.titleDeedFile,idCopy:state.idFile},60000).catch(error=>({status:'agent_error',message:error.message}));
  if(sync.status!=='listing_case_synced')await sendMessage(chatId,\`CRM listing created, but the office case folder could not be confirmed: \${sync.message||sync.status}\`);
  else await sendMessage(chatId,\`Pixxi listing created.\\n\\nJnA Case Reference: \${state.listingRef}\${state.pixxiListingRef!==state.listingRef?\`\\nPixxi raw reference: \${state.pixxiListingRef}\`:''}\\nLocal case folder: Listing/\${state.listingRef}/\\nTitle Deed and ID have been saved there.\`);

  await sendMessage(chatId,'Creating MKTG.png from the exact CRM listing data and saving it in the case folder…');
  const mktg=await runBrowserTask('generate_mktg_image',{listingRef:state.listingRef,listing:{
    listingType:state.listingType,title:state.generated?.title||'',description:state.generated?.description||'',
    building:state.building,area:state.area,propertyType:state.crmHouseType,unitNo:state.unitNo,
    price:state.price,size:state.size,bedrooms:state.bedrooms,bathrooms:state.bathrooms,
    furnishing:state.furnishing,view:state.view
  }},90000).catch(error=>({status:'agent_error',message:error.message}));
  if(mktg.status==='mktg_saved'){
    state.mktgPath=mktg.path;state.mktgSaved=true;await saveListingCaseState(chatId,state);
    await sendMessage(chatId,\`MKTG.png saved successfully.\\n\\nListing/\${state.listingRef}/MKTG.png\\n\\nThis file is retained for the Trakheesi Copy of Advertisement Format upload.\`);
  }else{
    await sendMessage(chatId,\`CRM listing is safe, but MKTG.png could not be saved yet: \${mktg.message||mktg.status}. The listing case remains stored and MKTG can be retried when the office agent is online.\`);
  }
  await sendMessage(chatId,'Generating the A2/NOC PDF from the same extracted owner/property information…');`,
  'post-CRM MKTG generation'
);

// Recovery for a CRM listing that was already created while the local office agent was offline.
// This never creates another Pixxi listing; it only retries local case sync + MKTG.png.
replaceExact(
  "  if(command==='/createcrm'){try{await createCrmAndNoc(chatId,caseState);}catch(e){if(caseState){caseState.step='draft_ready';await saveListingCaseState(chatId,caseState);}await sendMessage(chatId,`CRM/NOC workflow failed: ${e.message}`);}return;}",
  `  if(command==='/syncase'){
    if(!caseState?.listingRef){await sendMessage(chatId,'No existing CRM case is available to sync. Create the CRM listing first.');return;}
    await sendMessage(chatId,\`Retrying local case sync for \${caseState.listingRef}. This will NOT create another Pixxi listing.\`);
    const sync=await runBrowserTask('sync_listing_case',{listingRef:caseState.listingRef,titleDeed:caseState.titleDeedFile,idCopy:caseState.idFile},60000).catch(error=>({status:'agent_error',message:error.message}));
    if(sync.status!=='listing_case_synced'){
      await sendMessage(chatId,\`Case folder sync failed: \${sync.message||sync.status}. Make sure the office agent is running, then send /syncase again.\`);return;
    }
    await sendMessage(chatId,\`Case folder synced: Listing/\${caseState.listingRef}/\\nTitle Deed and ID saved. Creating MKTG.png…\`);
    const mktg=await runBrowserTask('generate_mktg_image',{listingRef:caseState.listingRef,listing:{
      listingType:caseState.listingType,title:caseState.generated?.title||'',description:caseState.generated?.description||'',
      building:caseState.building,area:caseState.area,propertyType:caseState.crmHouseType,unitNo:caseState.unitNo,
      price:caseState.price,size:caseState.size,bedrooms:caseState.bedrooms,bathrooms:caseState.bathrooms,
      furnishing:caseState.furnishing,view:caseState.view
    }},90000).catch(error=>({status:'agent_error',message:error.message}));
    if(mktg.status!=='mktg_saved'){
      await sendMessage(chatId,\`Case folder is safe, but MKTG.png failed: \${mktg.message||mktg.status}. Send /syncase again after the office agent is ready.\`);return;
    }
    caseState.mktgPath=mktg.path;caseState.mktgSaved=true;await saveListingCaseState(chatId,caseState);
    await sendMessage(chatId,\`Case \${caseState.listingRef} synced successfully.\\n\\nTitle Deed: saved\\nID: saved\\nMKTG.png: saved\\n\\nNo duplicate Pixxi listing was created.\`);return;
  }
  if(command==='/createcrm'){try{await createCrmAndNoc(chatId,caseState);}catch(e){if(caseState){caseState.step='draft_ready';await saveListingCaseState(chatId,caseState);}await sendMessage(chatId,\`CRM/NOC workflow failed: \${e.message}\`);}return;}`,
  'sync existing CRM case command'
);

await fs.writeFile(runtimePath,source,'utf8');
await import(`./.index-v2-runtime.mjs?ts=${Date.now()}`);
