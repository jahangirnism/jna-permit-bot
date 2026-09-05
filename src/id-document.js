import { extractDocumentText } from './titleDeed.js';

function clean(v){return String(v||'').replace(/\s+/g,' ').trim();}
function ascii(v){return clean(String(v||'').replace(/[^\x20-\x7E]/g,' '));}
function lineAfter(text,labels=[]){
  const lines=String(text||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  for(let i=0;i<lines.length;i++){
    for(const label of labels){
      const m=lines[i].match(new RegExp(`^${label}\\s*[:.-]?\\s*(.*)$`,'i'));
      if(!m)continue;
      const inline=clean(m[1]);if(inline)return ascii(inline);
      if(lines[i+1])return ascii(lines[i+1]);
    }
  }
  return '';
}
function parseMrz(text){
  const lines=String(text||'').split(/\r?\n/).map(x=>x.replace(/\s/g,'').toUpperCase()).filter(x=>x.length>=30&&/[A-Z0-9<]{25,}/.test(x));
  const p=lines.find(x=>x.startsWith('P<'));
  if(!p)return{};
  const namePart=p.slice(5).split('<<');
  const surname=clean((namePart[0]||'').replace(/</g,' '));
  const givenNames=clean((namePart[1]||'').replace(/</g,' '));
  const idx=lines.indexOf(p),second=idx>=0?lines[idx+1]||'':'';
  const passportNo=clean(second.slice(0,9).replace(/</g,''));
  return{firstName:givenNames,lastName:surname,fullName:clean(`${givenNames} ${surname}`),idNo:passportNo,documentType:'PASSPORT'};
}

export function extractIdFields(text){
  const mrz=parseMrz(text);
  const emirates=String(text||'').match(/784[-\s]?\d{4}[-\s]?\d{7}[-\s]?\d/i)?.[0]?.replace(/\s/g,'')||'';
  const explicitPassport=lineAfter(text,['Passport\\s*(?:No|Number)','Passport']);
  let fullName=lineAfter(text,['Name','Full\\s*Name','Cardholder\\s*Name']);
  let firstName=lineAfter(text,['First\\s*Name','Given\\s*Names?']);
  let lastName=lineAfter(text,['Last\\s*Name','Surname','Family\\s*Name']);
  if(mrz.fullName){fullName=mrz.fullName;firstName=mrz.firstName;lastName=mrz.lastName;}
  if(!fullName&&firstName)fullName=clean(`${firstName} ${lastName}`);
  if(!firstName&&fullName){const parts=fullName.split(/\s+/);firstName=parts.shift()||'';lastName=parts.join(' ');}
  const idNo=emirates||mrz.idNo||explicitPassport.replace(/[^A-Za-z0-9-]/g,'');
  return{
    firstName:firstName||null,
    lastName:lastName||null,
    fullName:fullName||null,
    idNo:idNo||null,
    documentType:emirates?'EMIRATES_ID':(mrz.documentType||(/passport/i.test(text)?'PASSPORT':'ID'))
  };
}

export async function extractIdFromFile(filePath){const text=await extractDocumentText(filePath);return{fields:extractIdFields(text),text};}
