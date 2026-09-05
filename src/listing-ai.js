const ANTHROPIC_URL='https://api.anthropic.com/v1/messages';
const MODEL=process.env.LISTING_AI_MODEL||'claude-sonnet-4-6';

function anthropicKey(){
  const key=process.env.ANTHROPIC_API_KEY||'';
  if(!key)throw new Error('Missing ANTHROPIC_API_KEY');
  return key;
}

function cleanText(value){return String(value??'').trim();}

function extractJson(text){
  const raw=cleanText(text);
  if(!raw)throw new Error('Claude returned an empty response');
  try{return JSON.parse(raw);}catch{}
  const fenced=raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(fenced){try{return JSON.parse(fenced[1].trim());}catch{}}
  const first=raw.indexOf('{'),last=raw.lastIndexOf('}');
  if(first>=0&&last>first){try{return JSON.parse(raw.slice(first,last+1));}catch{}}
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

  // Ported from the existing jahangirnism/listing Claude workflow.
  const system=`You are an expert Dubai real estate listing copywriter for JnA House.
RULES:
- Title: strictly 45-50 chars, NO special symbols, scroll-stopping, forces the click
- Title must NOT mention area, community, location, unit or exact floor number
- Title CAN say "High Floor" or "Mid Floor" only
- Description: strictly 1200-1500 chars, NO special symbols, ZERO prose paragraphs
- Every line after opener = section header OR short bullet (max 5-6 words) starting with a dash
- Use factual, useful language and avoid invented unit-specific facts not supplied by the agent
- Agent Notes are priority facts. Preserve them when relevant and do not contradict them

Use this exact description structure:
[One-line opener]
UNIT FEATURES
- [max 5 words]
BUILDING HIGHLIGHTS
- [max 6 words — lead with what competitors miss]
LOCATION
- [max 7 words]

JnA House — Premium Data-Driven Dubai Brokerage
Contact: info@jnahouse.com or WhatsApp 971585719898
Return ONLY valid JSON: {"title":"...","description":"..."}`;

  const user=`Building: ${building}\nArea: ${area}\nBedrooms: ${bedrooms}\nSize: ${size} sq ft\nType: ${listingType}\nPrice: AED ${price}\nFurnishing: ${furnishing}\nView: ${view}\nNotes: ${notes}\n\nResearch what makes ${building} unique vs competitors on PropertyFinder and Bayut. Lead BUILDING HIGHLIGHTS with angles competitors miss.\nReturn ONLY JSON: {"title":"...","description":"..."}`;
  return{system,user};
}

export async function generateListingCopy(input={}){
  const {system,user}=buildListingPrompts(input);
  const response=await fetch(ANTHROPIC_URL,{
    method:'POST',
    headers:{
      'content-type':'application/json',
      'x-api-key':anthropicKey(),
      'anthropic-version':'2023-06-01'
    },
    body:JSON.stringify({
      model:MODEL,
      max_tokens:1500,
      system,
      messages:[{role:'user',content:user}]
    })
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    const message=data?.error?.message||data?.message||'unknown error';
    throw new Error(`Claude listing generation failed (${response.status}): ${message}`);
  }
  const text=(Array.isArray(data?.content)?data.content:[]).filter(x=>x?.type==='text').map(x=>x.text).join('\n').trim();
  const parsed=extractJson(text);
  const title=cleanText(parsed?.title);
  const description=cleanText(parsed?.description);
  if(!title||!description)throw new Error('Claude listing response is missing title or description');
  return{
    title,
    description,
    titleChars:[...title].length,
    descriptionChars:[...description].length,
    model:data?.model||MODEL
  };
}
