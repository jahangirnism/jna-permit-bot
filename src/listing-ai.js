const ANTHROPIC_URL='https://api.anthropic.com/v1/messages';
const MODEL=process.env.LISTING_AI_MODEL||'claude-sonnet-4-6';
const MIN_TITLE=45,MAX_TITLE=50,MIN_DESCRIPTION=1200,MAX_DESCRIPTION=1500;

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
    // Claude sometimes emits literal line breaks inside the description JSON string.
    // Recover the two expected fields without accepting any other structure.
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
  // Final conservative fallback for responses containing only TITLE/DESCRIPTION labels.
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
  const size=cleanText(input.size)||'Not specified';
  const listingType=/sale|sell/i.test(cleanText(input.listingType))?'For Sale':'For Rent';
  const price=cleanText(input.price)||'Not specified';
  const furnishing=cleanText(input.furnishing)||'Not specified';
  const view=cleanText(input.view)||'Not specified';
  const notes=cleanText(input.notes)||'none';
  if(!building)throw new Error('Building is required for listing copy');

  const system=`You are an expert Dubai real estate listing copywriter for JnA House.
RULES:
- Title: strictly 45-50 characters including spaces, NO special symbols, scroll-stopping, forces the click
- Title must NOT mention area, community, location, unit or exact floor number
- Title CAN say "High Floor" or "Mid Floor" only
- Description: strictly 1200-1500 characters including spaces
- ZERO prose paragraphs after the one-line opener
- Every line after opener = section header OR short bullet starting with a dash
- Prefer short bullets, but include enough useful factual bullets to reach 1200-1500 characters
- Agent Notes are priority facts. Preserve them when relevant and do not contradict them
- NEVER invent or imply unverified facts, rankings or comparisons. Do not claim best-managed, most sought-after, low service charges, highest ROI, cheapest, best value, rare, minutes-to, exact travel times, amenities, views or availability unless supplied in the input
- You do NOT have live PropertyFinder/Bayut browsing in this request. Treat competitor research as context only and never fabricate research findings
- If a building/community fact is not confidently known from the supplied input, omit it rather than guess
- Output must be ONE valid JSON object. Escape every line break inside description as \\n. Do not use markdown fences or commentary.

Use this exact description structure:
[One-line opener]
UNIT FEATURES
- [short factual bullets]
BUILDING HIGHLIGHTS
- [short factual bullets]
LOCATION
- [short factual bullets]

JnA House — Premium Data-Driven Dubai Brokerage
Contact: info@jnahouse.com or WhatsApp 971585719898
Return ONLY valid JSON: {"title":"...","description":"..."}`;

  const user=`Building: ${building}\nArea: ${area}\nBedrooms: ${bedrooms}\nSize: ${size} sq ft\nType: ${listingType}\nPrice: AED ${price}\nFurnishing: ${furnishing}\nView: ${view}\nNotes: ${notes}\n\nCreate a factual listing using the supplied facts. Do not pretend that live competitor research was performed.\nReturn ONLY JSON: {"title":"...","description":"..."}`;
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

function validationIssues(draft){
  const issues=[];
  const tc=charCount(draft.title),dc=charCount(draft.description);
  if(tc<MIN_TITLE||tc>MAX_TITLE)issues.push(`title is ${tc} characters; required ${MIN_TITLE}-${MAX_TITLE}`);
  if(dc<MIN_DESCRIPTION||dc>MAX_DESCRIPTION)issues.push(`description is ${dc} characters; required ${MIN_DESCRIPTION}-${MAX_DESCRIPTION}`);
  return issues;
}

export async function generateListingCopy(input={}){
  const {system,user}=buildListingPrompts(input);
  let draft=await callClaude(system,user);
  let issues=validationIssues(draft);
  const maxAttempts=3;
  for(let attempt=2;issues.length&&attempt<=maxAttempts;attempt++){
    const correction=`The previous draft failed mechanical validation:\n- ${issues.join('\n- ')}\n\nRewrite it now. Preserve only supported facts from the original property input. Do not add unsupported claims just to increase length. The title MUST be 45-50 characters and description MUST be 1200-1500 characters including spaces. Return ONLY valid JSON with title and description.\n\nPrevious draft:\n${JSON.stringify({title:draft.title,description:draft.description})}`;
    draft=await callClaude(system,`${user}\n\n${correction}`);
    issues=validationIssues(draft);
  }
  if(issues.length)throw new Error(`Claude could not produce a compliant listing after ${maxAttempts} attempts: ${issues.join('; ')}`);
  return{
    title:draft.title,
    description:draft.description,
    titleChars:charCount(draft.title),
    descriptionChars:charCount(draft.description),
    model:draft.model,
    validated:true
  };
}
