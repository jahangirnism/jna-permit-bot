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

await fs.writeFile(runtimePath,source,'utf8');
await import(`./.index-v2-runtime.mjs?ts=${Date.now()}`);
