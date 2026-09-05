import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function run(cmd,args,{timeout=45000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(cmd,args,{stdio:['ignore','pipe','pipe']});
    let out='',err='';
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`${cmd} timed out`));},timeout);
    child.stdout.on('data',d=>out+=d);
    child.stderr.on('data',d=>err+=d);
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);code===0?resolve(out):reject(new Error(`${cmd} failed (${code}): ${err.slice(0,500)}`));});
  });
}

function clean(v){return (v||'').replace(/\s+/g,' ').replace(/^[\s:;|_-]+|[\s:;|_-]+$/g,'').trim();}
function englishOnly(v,{identifier=false}={}){
  let s=String(v||'');
  s=s.split(/[\u0600-\u06FF]/)[0];
  s=s.split(/[_\[\]{}()<>]/)[0];
  s=s.replace(/[^\x20-\x7E]/g,' ');
  if(identifier){const token=s.match(/[A-Za-z0-9][A-Za-z0-9\/-]*/)?.[0]||'';return clean(token);}
  s=s.replace(/[^A-Za-z0-9&.'\/-]+/g,' ');
  return clean(s);
}
function lineValue(text,label,nextLabels=[]){
  const rawLines=text.split(/\r?\n/).filter(x=>x.trim());
  const rx=new RegExp(`^\\s*${label}\\s*[:.-]?\\s*(.*)$`,'i');
  for(let i=0;i<rawLines.length;i++){
    const m=rawLines[i].match(rx);if(!m)continue;
    let rawValue=(m[1]||'').split(/\s{2,}/)[0];
    let value=clean(rawValue);if(value)return value;
    if(i+1<rawLines.length){const n=rawLines[i+1];const trimmed=clean(n);if(!nextLabels.some(x=>new RegExp(`^${x}\\b`,'i').test(trimmed)))return clean(n.split(/\s{2,}/)[0]);}
  }
  return '';
}
function firstLabel(text,labels,next=[]){for(const label of labels){const v=lineValue(text,label,next);if(v)return v;}return '';}
function numericText(v){const m=String(v||'').replace(/,/g,'').match(/\d+(?:\.\d+)?/);return m?m[0]:'';}

export function extractTitleDeedFields(text){
  const labels=['Community','Plot No','Municipality No','Building No','Building Name','Property No','Floor No','Parkings','Area Sq Meter','Area Sq Feet','Common Area','Owner Name','Owner','Title Deed No','Title Deed Number','Certificate No','Property Type'];
  let community=lineValue(text,'Community',labels);
  let plotNo=lineValue(text,'Plot\\s*No',labels);
  let buildingName=lineValue(text,'Building\\s*Name',labels);
  let propertyNo=lineValue(text,'Property\\s*No',labels);
  let ownerName=firstLabel(text,['Owner\\s*Name','Owner'],labels);
  let titleDeedNo=firstLabel(text,['Title\\s*Deed\\s*(?:No|Number)','Certificate\\s*No'],labels);
  let areaSqFeet=firstLabel(text,['Area\\s*Sq\\s*Feet','Area\\s*Sq\\s*Ft'],labels);
  let parkings=firstLabel(text,['Parkings?','No\\.?\\s*of\\s*Parking'],labels);
  let propertyType=firstLabel(text,['Property\\s*Type','Type'],labels);

  const one=text.replace(/\r/g,'');
  const capture=(name,next)=>{const r=new RegExp(`${name}\\s*[:.-]?\\s*([^\\n]{1,100}?)(?=\\s{2,}|\\n|${next}|$)`,'i');return clean(one.match(r)?.[1]||'');};
  if(!community)community=capture('Community','Plot\\s*No');
  if(!plotNo)plotNo=capture('Plot\\s*No','Municipality\\s*No');
  if(!buildingName)buildingName=capture('Building\\s*Name','Property\\s*No');
  if(!propertyNo)propertyNo=capture('Property\\s*No','Floor\\s*No');

  community=englishOnly(community);buildingName=englishOnly(buildingName);
  plotNo=englishOnly(plotNo,{identifier:true});propertyNo=englishOnly(propertyNo,{identifier:true});
  ownerName=englishOnly(ownerName);titleDeedNo=englishOnly(titleDeedNo,{identifier:true});propertyType=englishOnly(propertyType);
  propertyNo=propertyNo.replace(/O/g,'0').replace(/o/g,'0');

  return {
    area:community||null,
    landNo:plotNo||null,
    buildingName:buildingName||null,
    unitNo:propertyNo||null,
    ownerName:ownerName||null,
    titleDeedNo:titleDeedNo||null,
    sizeSqFt:numericText(areaSqFeet)||null,
    parking:numericText(parkings)||null,
    propertyType:propertyType||null,
    sourceMapping:{area:'Community',landNo:'Plot No',buildingName:'Building Name',unitNo:'Property No',ownerName:'Owner Name',titleDeedNo:'Title Deed No/Certificate No',sizeSqFt:'Area Sq Feet',parking:'Parkings',propertyType:'Property Type'}
  };
}

export async function extractDocumentText(filePath){
  const ext=path.extname(filePath).toLowerCase();
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jna-doc-'));
  try{
    let text='';
    if(ext==='.pdf'){
      text=await run('pdftotext',['-layout',filePath,'-']).catch(()=> '');
      if(text.replace(/\s/g,'').length<40){const prefix=path.join(dir,'page');await run('pdftoppm',['-f','1','-singlefile','-r','220','-png',filePath,prefix],{timeout:60000});text=await run('tesseract',[`${prefix}.png`,'stdout','-l','eng','--psm','6'],{timeout:60000});}
    }else{text=await run('tesseract',[filePath,'stdout','-l','eng','--psm','6'],{timeout:60000});}
    return text;
  }finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}
}

export async function extractTitleDeedFromFile(filePath){const text=await extractDocumentText(filePath);return{fields:extractTitleDeedFields(text),text};}
