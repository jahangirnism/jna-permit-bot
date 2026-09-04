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
function lineValue(text,label,nextLabels=[]){
  const lines=text.split(/\r?\n/).map(clean).filter(Boolean);
  const rx=new RegExp(`^${label}\\s*[:.-]?\\s*(.*)$`,'i');
  for(let i=0;i<lines.length;i++){
    const m=lines[i].match(rx);
    if(!m)continue;
    let value=clean(m[1]);
    if(value)return value;
    if(i+1<lines.length){
      const n=lines[i+1];
      if(!nextLabels.some(x=>new RegExp(`^${x}\\b`,'i').test(n)))return clean(n);
    }
  }
  return '';
}

export function extractTitleDeedFields(text){
  const labels=['Community','Plot No','Municipality No','Building No','Building Name','Property No','Floor No','Parkings','Area Sq Meter','Area Sq Feet','Common Area'];
  let community=lineValue(text,'Community',labels);
  let plotNo=lineValue(text,'Plot\\s*No',labels);
  let buildingName=lineValue(text,'Building\\s*Name',labels);
  let propertyNo=lineValue(text,'Property\\s*No',labels);

  // Conservative fallback for OCR that separates label/value with unusual spacing.
  const one=text.replace(/\r/g,'');
  const capture=(name,next)=>{
    const r=new RegExp(`${name}\\s*[:.-]?\\s*([^\\n]{1,80}?)(?=\\s{2,}|\\n|${next}|$)`,'i');
    return clean(one.match(r)?.[1]||'');
  };
  if(!community)community=capture('Community','Plot\\s*No');
  if(!plotNo)plotNo=capture('Plot\\s*No','Municipality\\s*No');
  if(!buildingName)buildingName=capture('Building\\s*Name','Property\\s*No');
  if(!propertyNo)propertyNo=capture('Property\\s*No','Floor\\s*No');

  // Strip common Arabic/OCR spillover after the English value where possible.
  const englishPart=v=>clean(v.split(/[\u0600-\u06FF]/)[0]);
  community=englishPart(community);
  buildingName=englishPart(buildingName);
  plotNo=clean(plotNo.match(/[A-Za-z0-9\/-]+/)?.[0]||plotNo);
  propertyNo=clean(propertyNo.match(/[A-Za-z0-9][A-Za-z0-9\/-]*/)?.[0]||propertyNo);

  return {
    area: community || null,
    landNo: plotNo || null,
    buildingName: buildingName || null,
    unitNo: propertyNo || null,
    sourceMapping:{area:'Community',landNo:'Plot No',buildingName:'Building Name',unitNo:'Property No'}
  };
}

export async function extractTitleDeedFromFile(filePath){
  const ext=path.extname(filePath).toLowerCase();
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jna-deed-'));
  try{
    let text='';
    if(ext==='.pdf'){
      text=await run('pdftotext',['-layout',filePath,'-']).catch(()=> '');
      if(text.replace(/\s/g,'').length<40){
        const prefix=path.join(dir,'page');
        await run('pdftoppm',['-f','1','-singlefile','-r','220','-png',filePath,prefix],{timeout:60000});
        text=await run('tesseract',[`${prefix}.png`,'stdout','-l','eng','--psm','6'],{timeout:60000});
      }
    }else{
      text=await run('tesseract',[filePath,'stdout','-l','eng','--psm','6'],{timeout:60000});
    }
    const fields=extractTitleDeedFields(text);
    return {fields,text};
  }finally{
    await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}
