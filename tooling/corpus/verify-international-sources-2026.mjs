import { fromHtml } from '../../packages/backend/src/sources/web-list.ts';
import { fetchRss } from '../../packages/backend/src/sources/rss.ts';
import { unsupportedConfig } from '../../packages/backend/src/sources/config-keys.ts';
import { readFile, writeFile } from 'node:fs/promises';
const specs = [
 ['web-unfpa-news','联合国人口基金 UNFPA · 新闻','unfpa','T1','联合国人口机构自有官网的一手新闻', {url:'https://www.unfpa.org/news',parseMode:'html',itemSelector:'.listing-row',linkSelector:'h5 a',titleSelector:'h5 a',publishedAtSelector:'time',allowUrlPrefixes:['https://www.unfpa.org/news/']},'https://www.unfpa.org/news?page=1'],
 ['web-iom-news','国际移民组织 IOM · 新闻','iom','T1','联合国移民机构自有官网的一手新闻',{url:'https://www.iom.int/news',parseMode:'html',itemSelector:'.node--type-press-release',linkSelector:'a.text-body',titleSelector:'.card-title',publishedAtSelector:'.date',allowUrlPrefixes:['https://www.iom.int/news/'],publishedAtUtcOffset:'+00:00'},'https://www.iom.int/news?page=1'],
 ['web-adb-news','亚洲开发银行 ADB · 新闻','adb','T1','多边开发银行自有官网，项目报道属机构一手声明',{url:'https://www.adb.org/news/releases',parseMode:'html',itemSelector:'.views-list li',linkSelector:'a[href^="/news/"]',titleSelector:'a[href^="/news/"]',publishedAtRegex:'(\\d{1,2} [A-Za-z]{3} \\d{4})',publishedAtUtcOffset:'+00:00',allowUrlPrefixes:['https://www.adb.org/news/'],denyUrlPrefixes:['https://www.adb.org/news/videos/','https://www.adb.org/news/events/']},'https://www.adb.org/news/releases?page=1'],
 ['web-eclac-news','联合国拉美经委会 ECLAC · 新闻','eclac','T1','联合国区域委员会自有官网；只收官网原文，拒绝外部媒体转载',{url:'https://www.cepal.org/en/list/cepal_pr',parseMode:'html',itemSelector:'.search-list',linkSelector:'h4 a',titleSelector:'h4 a',publishedAtRegex:'(\\d{1,2} [A-Za-z]{3} \\d{4})',publishedAtUtcOffset:'+00:00',allowUrlPrefixes:['https://www.cepal.org/en/news/','https://www.cepal.org/en/pressreleases/']},'https://www.cepal.org/en/list/cepal_pr?page=1'],
 ['rss-itdp-news','交通与发展政策研究所 ITDP · 新闻','itdp','T2','非政府组织的交通政策报道和倡议，有立场，应按媒体及机构评论档严格筛选',{feedUrl:'https://www.itdp.org/feed/',allowUrlPrefixes:['https://itdp.org/','https://www.itdp.org/']},'https://www.itdp.org/feed/?paged=2'],
];
const registered = JSON.parse(await readFile('industry/sources.json','utf8')).sources;
const proposals = [];
for (const [id,name,owner,tier,tierBasis,config,archiveUrl] of specs) {
 const kind = config.feedUrl ? 'rss':'web_list';
 const source = {id,name,kind,config:{...config,sortByPublishedAt:true,_aihot:{initialBackfillLimit:8}},tier,first_party:true,owner_entity_id:owner,participation_mode:'editorial',interval_minutes:240,tags:['英文','人文地理','区域地理'],site_fulltext:false,syndicate_fulltext:false,enabled:true};
 const duplicate = registered.some(s=>s.id===id || (config.feedUrl && s.config.feedUrl===config.feedUrl) || (config.url && s.config.url===config.url));
 const validation = {unsupportedKeys:unsupportedConfig(kind,source.config),registeredDuplicate:!!duplicate};
 const runtime = {...source,cursor:null,fail_count:0};
 let evidence;
 try {
  let items,status=200;
  if(kind==='rss') items=(await fetchRss(runtime,{force:true})).candidates;
  else {let r=await fetch(config.url,{signal:AbortSignal.timeout(25000)});status=r.status;items=fromHtml(await r.text(),config.url,runtime);}
  const dated=items.filter(x=>x.publishedAt); evidence={status,parsedCount:items.length,datedCount:dated.length,samples:dated.slice(0,3).map(x=>({title:x.title,url:x.url,publishedAt:x.publishedAt.toISOString()}))};
 }catch(e){evidence={error:e.message};}
 let history;
 try {const r=await fetch(archiveUrl,{signal:AbortSignal.timeout(25000)});const html=await r.text();let items=[];
  if(kind==='rss') items=(await fetchRss({...runtime,config:{...source.config,feedUrl:archiveUrl}},{force:true})).candidates;
  else items=fromHtml(html,archiveUrl,{...runtime,config:{...source.config,url:archiveUrl}});
  const dated=items.filter(x=>x.publishedAt); const dates=dated.map(x=>x.publishedAt.toISOString()).sort();
  history={url:archiveUrl,status:r.status,parsedCount:items.length,datedCount:dated.length,earliest:dates[0]??null,latest:dates.at(-1)??null,verifiedChangedItems:!!dated.length && dated[0].url!==evidence.samples?.[0]?.url,coversJanuary:false};
 }catch(e){history={url:archiveUrl,error:e.message,coversJanuary:false};}
 proposals.push({source,tierBasis,validation,evidence,history}); console.log(id,JSON.stringify({validation,evidence,history}));
}
await writeFile('tooling/corpus/source-proposals-international-2026.json',JSON.stringify({checkedAt:new Date().toISOString(),baselineSourceCount:registered.length,scope:'2026-01-01 through 2026-10-10; source proposals only; no production registration or ingest',proposals,failedCandidates:[{url:'https://www.statssa.gov.za/?feed=rss2',failure:'Node fetch failed on 2026-10-10; not proposed'},{url:'https://agenciadenoticias.ibge.gov.br/en/agencia-news.html',failure:'HTTP 403 on 2026-10-10; not proposed'},{url:'https://blogs.worldbank.org/en/transport/rss.xml',failure:'HTTP 404 on 2026-10-10; not proposed'},{url:'https://www.adb.org/news/rss.xml',failure:'HTTP 404; ADB HTML is used instead'}]},null,2)+'\n');
