const ANTHROPIC_URL='https://api.anthropic.com/v1/messages';
const MODEL=process.env.LISTING_AI_MODEL||'claude-sonnet-4-6';

function anthropicKey(){
  const key=process.env.ANTHROPIC_API_KEY||'';
  if(!key)throw new Error('Missing ANTHROPIC_API_KEY');
  return key;
}
function cleanText(value){return String(value??'').trim();}
function charCount(value){return [...cleanText(value)].length;}
function decodeJsonishString(value){
  return cleanText(String(value??''))
    .replace(/\\r\\n/g,'\n').replace(/\\n/g,'\n').replace(/\\t/g,'\t')
    .replace(/\\"/g,'"').replace(/\\\\/g,'\\');
}
function extractJson(text){
  const raw=cleanText(text);
  if(!raw)throw new Error('Claude returned an empty response');
  try{return JSON.parse(raw);}catch{}
  const fenced=raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(fenced){try{return JSON.parse(fenced[1].trim());}catch{}}
  const first=raw.indexOf('{'),last=raw.lastIndexOf('}');
  if(first>=0&&last>first){
    const candidate=raw.slice(first,last+1);
    try{return JSON.parse(candidate);}catch{}
    const titleMatch=candidate.match(/["“”']?title["“”']?\s*:\s*["“]([\s\S]*?)["”]\s*,\s*["“”']?description["“”']?\s*:/i);
    const descStart=candidate.match(/["“”']?description["“”']?\s*:\s*["“]/i);
    if(titleMatch&&descStart){
      const start=(descStart.index||0)+descStart[0].length;
      let tail=candidate.slice(start).trim();
      tail=tail.replace(/["”]\s*}\s*$/,'');
      const title=decodeJsonishString(titleMatch[1]);
      const description=decodeJsonishString(tail);
      if(title&&description)return{title,description};
    }
  }
  const labelled=raw.match(/(?:^|\n)\s*TITLE\s*[:\-]\s*(.+?)\s*\n+\s*DESCRIPTION\s*[:\-]\s*([\s\S]+)$/i);
  if(labelled){
    const title=cleanText(labelled[1]),description=cleanText(labelled[2]);
    if(title&&description)return{title,description};
  }
  throw new Error('Claude did not return valid listing JSON');
}

export function buildListingPrompts(input={}){
  const building=cleanText(input.building);
  const area=cleanText(input.area)||'Dubai';
  const bedrooms=cleanText(input.bedrooms)||'Not specified';
  const bathrooms=cleanText(input.bathrooms)||'Not specified';
  const size=cleanText(input.size)||'Not specified';
  const listingType=/sale|sell/i.test(cleanText(input.listingType))?'For Sale':'For Rent';
  const price=cleanText(input.price)||'Not specified';
  const furnishing=cleanText(input.furnishing)||'Not specified';
  const view=cleanText(input.view)||'Not specified';
  const notes=cleanText(input.notes)||'none';
  if(!building)throw new Error('Building is required for listing copy');

  const system=`You are an expert Dubai real estate listing copywriter for JnA House.
Write the listing naturally and professionally. You decide the appropriate title and description length; there are no character-count limits.
Agent Notes are priority facts. Preserve them when relevant and do not contradict them.
Never invent or imply unverified facts, rankings or comparisons. Do not claim best-managed, most sought-after, low service charges, highest ROI, cheapest, best value, rare, minutes-to, exact travel times, amenities, views or availability unless supplied in the input.
You do not have live PropertyFinder/Bayut browsing in this request. Do not fabricate research findings.
If a building/community fact is not confidently known from the supplied input, omit it rather than guess.
Use clear, useful real-estate listing copy. You may structure it with a short opener, headings and bullets when helpful.
End with:
JnA House — Premium Data-Driven Dubai Brokerage
Contact: info@jnahouse.com or WhatsApp 971585719898
Output must be ONE valid JSON object with exactly two string fields: title and description. Escape line breaks inside description as \\n. Do not use markdown fences or commentary.`;

  const user=`Building: ${building}\nArea: ${area}\nBedrooms: ${bedrooms}\nBathrooms: ${bathrooms}\nSize: ${size} sq ft\nType: ${listingType}\nPrice: AED ${price}\nFurnishing: ${furnishing}\nView: ${view}\nNotes: ${notes}\n\nCreate the best factual listing you can from these details. Choose the title and description length yourself. Return ONLY JSON: {"title":"...","description":"..."}`;
  return{system,user};
}

async function rawClaude(system,user){
  const response=await fetch(ANTHROPIC_URL,{
    method:'POST',
    headers:{'content-type':'application/json','x-api-key':anthropicKey(),'anthropic-version':'2023-06-01'},
    body:JSON.stringify({model:MODEL,max_tokens:2200,system,messages:[{role:'user',content:user}]})
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    const message=data?.error?.message||data?.message||'unknown error';
    throw new Error(`Claude listing generation failed (${response.status}): ${message}`);
  }
  const text=(Array.isArray(data?.content)?data.content:[]).filter(x=>x?.type==='text').map(x=>x.text).join('\n').trim();
  return{text,model:data?.model||MODEL};
}

async function callClaude(system,user){
  let lastError;
  for(let attempt=1;attempt<=2;attempt++){
    const prompt=attempt===1?user:`${user}\n\nYour previous response was not parseable as the required JSON object. Return ONLY one valid JSON object with exactly two string fields: title and description. Escape all description line breaks as \\n. No markdown fences.`;
    const {text,model}=await rawClaude(system,prompt);
    try{
      const parsed=extractJson(text);
      const title=cleanText(parsed?.title),description=cleanText(parsed?.description);
      if(!title||!description)throw new Error('Claude listing response is missing title or description');
      return{title,description,model};
    }catch(error){lastError=error;console.warn(`Claude listing parse attempt ${attempt} failed:`,error.message);}
  }
  throw lastError||new Error('Claude did not return valid listing JSON');
}

export async function generateListingCopy(input={}){
  const {system,user}=buildListingPrompts(input);
  const draft=await callClaude(system,user);
  return{
    title:draft.title,
    description:draft.description,
    titleChars:charCount(draft.title),
    descriptionChars:charCount(draft.description),
    model:draft.model,
    validated:true
  };
}
