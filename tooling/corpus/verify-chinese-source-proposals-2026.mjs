// Read-only network verification; no environment files, database writes, model calls or credentials.
import fs from 'node:fs';
import {fetchWebList,fromHtml} from '../../packages/backend/src/sources/web-list.ts';
import {assertSupportedConfig} from '../../packages/backend/src/sources/config-keys.ts';
const proposed=JSON.parse(fs.readFileSync(new URL('./source-proposals-chinese-2026.json',import.meta.url))).sources;
const existing=JSON.parse(fs.readFileSync(new URL('../../industry/sources.json',import.meta.url))).sources;
for(const s of proposed){
  assertSupportedConfig(s.kind,s.config);
  if(existing.some(x=>x.id===s.id || x.config.url===s.config.url)) throw Error('Already registered: '+s.id);
  try{
    const found=await fetchWebList({...s,cursor:null,fail_count:0});
    const dated=found.filter(x=>x.publishedAt);
    console.log(JSON.stringify({id:s.id,count:found.length,dated:dated.length,newest:dated[0]?.publishedAt,oldest:dated.at(-1)?.publishedAt,sample:found.slice(0,3).map(x=>({title:x.title,url:x.url,publishedAt:x.publishedAt}))}));
    if(!found.length||dated.length!==found.length) process.exitCode=1;
  }catch(e){console.log(JSON.stringify({id:s.id,error:e.message}));process.exitCode=1;}
}
const archives=[
  ['cn-web-nda-news','https://www.nda.gov.cn/sjj/swdt/xwfb/list/index_pc_7.html'],
  ['cn-web-beijing-departments','https://www.beijing.gov.cn/ywdt/gzdt/index_39.html'],
  ['cn-web-shanghai-news','https://www.shanghai.gov.cn/nw4411/index_150.html'],
  ['cn-web-guangzhou-government','https://www.gz.gov.cn/xw/zwlb/index_14.html'],
  ['cn-web-shanghai-statistics','https://tjj.sh.gov.cn/sjxx/index_4.html'],
  ['cn-web-shanghai-statistical-bulletins','https://tjj.sh.gov.cn/tjgb/index_2.html']
];
for(const [id,url] of archives){try{
  const s=proposed.find(x=>x.id===id);const r=await fetch(url,{signal:AbortSignal.timeout(25000)});const html=await r.text();
  const found=fromHtml(html,url,{...s,config:{...s.config,url}});
  console.log(JSON.stringify({archive:id,url,status:r.status,bytes:Buffer.byteLength(html),count:found.length,newest:found[0]?.publishedAt,oldest:found.at(-1)?.publishedAt,sample:found.slice(0,1)}));
}catch(e){console.log(JSON.stringify({archive:id,url,error:e.message}));}}
