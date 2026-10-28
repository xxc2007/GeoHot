// Rasterise the existing SVG without changing its nodes, labels or layout.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';

export function exportDiagram({ directory, language, svg, svgFilename }) {
 const config=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
 const png=new Resvg(svg,{fitTo:{mode:'width',value:3600},font:{loadSystemFonts:true}}).render();
 const bytes=png.asPng();
 const digest=createHash('sha256').update(bytes).digest('hex');
 const filename='flow.'+language+'.'+digest.slice(0,12)+'.png';
 const relative='docs/architecture/'+filename;
 const raw='https://raw.githubusercontent.com/'+config.diagramRepository+'/main/'+relative;
 const readmePath=path.resolve(directory,'../..',language==='zh'?'README.md':'README.en.md');
 let readme=fs.readFileSync(readmePath,'utf8');
 const image=/^\[!\[([^\]]+)\]\((docs\/architecture\/flow\.(zh|en)(?:\.[a-f0-9]{12})?\.(?:svg|png))\)\]\([^\n]+\)$/m;
 const match=readme.match(image);
 if(!match || match[3]!==language)throw new Error('Missing diagram image in '+readmePath);
 fs.writeFileSync(path.join(directory,filename),bytes);
 readme=readme.replace(image,(_match,alt)=>'[!['+alt+']('+relative+')]('+raw+')');
 fs.writeFileSync(readmePath,readme);
 const manifestPath=path.join(directory,'images.json');
 const manifest=fs.existsSync(manifestPath)?JSON.parse(fs.readFileSync(manifestPath,'utf8')):{};
 manifest[language]={source:svgFilename,sourceSha256:createHash('sha256').update(svg).digest('hex'),png:filename,sha256:digest,width:png.width,height:png.height,bytes:bytes.length};
 fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
 console.log('Exported '+filename+' ('+png.width+' x '+png.height+') and linked directly to the PNG');
}
