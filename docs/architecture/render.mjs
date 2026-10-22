// Edit bilingual copy and layout in spec; run: node docs/architecture/render.mjs
const spec = {
  "title": [
    "GEOHOT · 从公开信源到读者",
    "GEOHOT · From public sources to readers"
  ],
  "subtitle": [
    "后台生成与前台读取分开；数据与任务共用 PostgreSQL。",
    "Background generation and public reading are separate; data and jobs share PostgreSQL."
  ],
  "height": 2240,
  "nodes": [
    [
      "entry",
      600,
      215,
      "公开信源与合法外部投递\nindustry/ 定义信源、提示词与规则",
      "Public sources and authorised ingestion\nindustry/ defines sources, prompts and rules"
    ],
    [
      "collect",
      600,
      350,
      "worker：采集、URL 判重、正文提取\npg-boss 在 PostgreSQL 中调度任务",
      "worker: collect, deduplicate, extract text\npg-boss schedules jobs in PostgreSQL"
    ],
    [
      "prefilter",
      600,
      505,
      "地理预筛结果？",
      "Geography prefilter result?",
      "decision"
    ],
    [
      "blocked",
      220,
      670,
      "BLOCK：保留拦截依据\n停止后续分析，不进入公开池",
      "BLOCK: retain the rejection reason\nStop analysis; exclude from public pool",
      "guard"
    ],
    [
      "analyze",
      600,
      670,
      "PASS / UNKNOWN：继续分析\n两次独立评分；并行提取结构",
      "PASS / UNKNOWN: continue analysis\nTwo independent scores; extract structure"
    ],
    [
      "receipt",
      980,
      670,
      "所有模型调用经过回执与预算\n复用已完成结果；超预算等待",
      "Model calls use receipts and budgets\nReuse completed results; wait on budget",
      "guard"
    ],
    [
      "writing",
      600,
      835,
      "按评分与内容生成标题和摘要\n分类、标签、实体写入分析结果",
      "Write titles and summaries by score/type\nStore categories, tags and entities"
    ],
    [
      "eligible",
      600,
      990,
      "满足公开池条件？",
      "Eligible for the public pool?",
      "decision"
    ],
    [
      "hold",
      220,
      1155,
      "缺少可用文案或不符合规则\n保留后台状态，不公开",
      "Missing usable copy or ineligible\nKeep backend state; do not publish",
      "guard"
    ],
    [
      "select",
      600,
      1155,
      "两次评分之和达标？\n信源允许入选？",
      "Score sum meets threshold?\nSource permits selection?",
      "decision"
    ],
    [
      "pool",
      220,
      1320,
      "未入选但符合公开条件\n进入全部动态",
      "Eligible but not selected\nAvailable in all updates",
      "result"
    ],
    [
      "selected",
      600,
      1320,
      "入选后仍经过可见性门槛\n写入发布状态与可见时间",
      "Selected items pass the release gate\nStore publication state and release time"
    ],
    [
      "events",
      980,
      1320,
      "后台任务归并事件、计算热度\n组织事件综述与定期刊物",
      "Jobs group events and calculate heat\nPrepare overviews and periodical editions"
    ],
    [
      "db",
      600,
      1500,
      "PostgreSQL 保存已生成结果\n条目、分析、事件、刊物、队列与回执",
      "PostgreSQL stores generated results\nItems, analyses, events, editions, jobs, receipts"
    ],
    [
      "pub",
      600,
      1665,
      "Fastify API → publication/\n统一执行公开内容与可见性规则",
      "Fastify API → publication/\nApply shared public-content and release rules"
    ],
    [
      "web",
      220,
      1840,
      "React Router 服务端渲染\nweb 仅通过 HTTP 读取 API",
      "React Router server rendering\nweb reads the API over HTTP"
    ],
    [
      "feeds",
      600,
      1840,
      "RSS · API v1 · MCP\n共享同一公开读取层",
      "RSS · API v1 · MCP\nShare the same publication read layer"
    ],
    [
      "public",
      980,
      1840,
      "站点地图 · llms.txt · 分享图\n沿用公开读取规则",
      "Sitemap · llms.txt · share images\nUse the public reading rules"
    ],
    [
      "reader",
      600,
      2020,
      "读者浏览已生成的内容，不触发模型\n收藏与已读保存在当前浏览器",
      "Readers view stored content without model calls\nBookmarks and read state stay in the browser",
      "result"
    ]
  ],
  "edges": [
    [
      "entry",
      "collect"
    ],
    [
      "collect",
      "prefilter"
    ],
    [
      "prefilter",
      "blocked",
      "BLOCK",
      "BLOCK"
    ],
    [
      "prefilter",
      "analyze",
      "PASS / UNKNOWN",
      "PASS / UNKNOWN"
    ],
    [
      "analyze",
      "receipt",
      "调用约束",
      "Call controls",
      "side"
    ],
    [
      "analyze",
      "writing"
    ],
    [
      "writing",
      "eligible"
    ],
    [
      "eligible",
      "hold",
      "否",
      "No"
    ],
    [
      "eligible",
      "select",
      "是",
      "Yes"
    ],
    [
      "select",
      "pool",
      "否 / 不评分",
      "No / unscored"
    ],
    [
      "select",
      "selected",
      "是",
      "Yes"
    ],
    [
      "selected",
      "events",
      "后续任务",
      "Follow-up jobs",
      "side"
    ],
    [
      "pool",
      "db"
    ],
    [
      "selected",
      "db"
    ],
    [
      "events",
      "db"
    ],
    [
      "db",
      "pub"
    ],
    [
      "pub",
      "web",
      "网页",
      "Web"
    ],
    [
      "pub",
      "feeds",
      "订阅与集成",
      "Feeds and integrations"
    ],
    [
      "pub",
      "public",
      "发现与分享",
      "Discovery and sharing"
    ],
    [
      "web",
      "reader"
    ],
    [
      "feeds",
      "reader"
    ],
    [
      "public",
      "reader"
    ]
  ],
  "notes": [],
  "foot": [
    "逻辑流程图，不是部署实例或完成进度图。实际门槛与发布条件以代码为准。",
    "Logical flow, not a deployment inventory or progress chart. Code defines current thresholds and publication conditions."
  ],
  "sources": [
    "apps/worker/src/main.ts",
    "packages/backend/src/editorial/analyze.ts",
    "packages/backend/src/providers/receipts.ts",
    "packages/backend/src/publication/rules.ts",
    "packages/backend/src/publication/",
    "industry/selection.ts",
    "apps/web/server.ts"
  ],
  "intro": [
    "上半部分沿着一条材料展开采集、预筛、评分与公开条件的分支，下半部分说明已生成结果如何经统一读取层到达不同出口。橙色表示拦截、等待或控制条件，绿色表示公开结果。图中不固化信源数量、模型名称或评分门槛，避免把运行配置变成过时的架构说明。",
    "The upper half follows an item through collection, prefiltering, scoring and publication decisions. The lower half shows how stored results reach each public interface through a shared read layer. Amber marks blocking, waiting or control conditions; green marks public results. Source counts, model names and numeric thresholds remain in configuration rather than being frozen into the diagram."
  ],
  "anchor": [
    "## 技术架构",
    "## Architecture"
  ]
};


import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = path.dirname(fileURLToPath(import.meta.url));
const escape = s => String(s).replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const height = n => n[5] === 'decision' ? (n[3].includes('\n') || n[4].includes('\n') ? 156 : 104) : 86;
const units = line => Array.from(line).reduce((sum,c)=>sum+(/[^\u0000-\u00ff]/.test(c)?1:.56),0);
for (let lang=0; lang<2; lang++) {
 const language=lang?'en':'zh', elements=[], labels=[];
 const text=(x,y,lines,size=20,weight=400,anchor='middle',fill='#252a2e',attrs='')=>{
   const rows=String(lines).split('\n');
   elements.push('<text '+attrs+' x="'+x+'" y="'+y+'" text-anchor="'+anchor+'" font-size="'+size+'" font-weight="'+weight+'" fill="'+fill+'">'+rows.map((s,i)=>'<tspan x="'+x+'" dy="'+(i?27:0)+'">'+escape(s)+'</tspan>').join('')+'</text>');
 };
 const nodes=new Map(spec.nodes.map(n=>[n[0],n]));
 const colors={result:['#edf6ee','#267349'],guard:['#fff5e9','#aa681f'],decision:['#ffffff','#68737b']};
 for (const [from,to,zh,en,kind] of spec.edges) {
  const a=nodes.get(from),b=nodes.get(to); let d,lx,ly,anchor='middle';
  const fork=['base','shared','pub'].includes(from);
  if(kind==='side') {
   d='M '+(a[1]+165)+' '+a[2]+' H '+(b[1]-165);lx=(a[1]+b[1])/2;ly=a[2]-height(a)/2-16;
  } else if(kind==='gutter') {
   d='M '+(a[1]-165)+' '+a[2]+' H 790 V '+(b[2]-90)+' H '+b[1]+' V '+(b[2]-height(b)/2);lx=774;ly=1065;anchor='end';
  } else if(kind==='outer') {
   const x=1182; d='M '+(a[1]+165)+' '+a[2]+' H '+x+' V '+b[2]+' H '+(b[1]+165);lx=x-16;ly=1080;anchor='end';
  } else {
   const y1=a[2]+height(a)/2,y2=b[2]-height(b)/2,mid=(y1+y2)/2;
   d='M '+a[1]+' '+y1+' V '+mid+' H '+b[1]+' V '+y2;
   lx=fork?b[1]:a[1]===b[1]?a[1]+18:(a[1]+b[1])/2;ly=mid-12;
   if(a[1]===b[1]){anchor='start';if(fork)lx=b[1]+18;}
   // This horizontal label shares a gutter with the read path; keep it entirely to its left.
   if(from==='moderate' && to==='readwall'){lx=768;anchor='end';}
  }
  elements.push('<path data-edge="'+from+'-'+to+'" d="'+d+'" fill="none" stroke="#4e585f" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#arrow)"/>');
  if(zh)labels.push({from,to,x:lx,y:ly,copy:lang?en:zh,anchor});
 }
 elements.push('<circle cx="600" cy="146" r="7" fill="#252a2e"/><path d="M 600 153 V 172" stroke="#4e585f" stroke-width="1.7" marker-end="url(#arrow)"/>');
 for (const n of spec.nodes) {
   const [id,x,y,zh,en,type]=n,[fill,stroke]=colors[type]||['#f4f5f6','#899198'],half=height(n)/2;
   elements.push('<g data-node="'+id+'" data-kind="'+(type||'process')+'" data-cx="'+x+'" data-cy="'+y+'" data-half-height="'+half+'">');
   if(type==='decision')elements.push('<path d="M '+x+' '+(y-half)+' L '+(x+165)+' '+y+' L '+x+' '+(y+half)+' L '+(x-165)+' '+y+' Z" fill="'+fill+'" stroke="'+stroke+'" stroke-width="1.7"/>');
   else elements.push('<rect x="'+(x-165)+'" y="'+(y-half)+'" width="330" height="'+height(n)+'" rx="7" fill="'+fill+'" stroke="'+stroke+'" stroke-width="'+(type?2:1.5)+'"/>');
   const copy=lang?en:zh,lines=copy.split('\n');
   let size=lang?17:20;
   // Fit every line to the available diamond width at its top AND bottom, with padding.
   // A rectangle-width check alone misses text touching the diagonal border.
   for(;size>10;size-=.25){
    const fits=lines.every((line,i)=>{
     const baseline=(i-(lines.length-1)/2)*27+size*.32;
     const edge=Math.max(Math.abs(baseline-size*.9),Math.abs(baseline+size*.3));
     const available=type==='decision'?330*(1-edge/half)-28:300;
     return units(line)*size<=available;
    });
    if(fits)break;
   }
   text(x,y-(lines.length-1)*13.5+size*.32,copy,size,type==='decision'?500:400,'middle','#252a2e','data-node-label="'+id+'"');
   elements.push('</g>');
 }
 // Labels are placed in clear gutters with explicit anchors; no line runs through their text.
 for(const label of labels)text(label.x,label.y,label.copy,16,400,label.anchor,'#252a2e','data-edge-label="'+label.from+'-'+label.to+'"');
 for(const [id,zh,en] of spec.notes||[]) { const n=nodes.get(id);text(600,n[2]-64,lang?en:zh,16,400,'middle','#626c74'); }
 text(600,45,spec.title[lang],30,600);
 text(600,82,spec.subtitle[lang],18,400,'middle','#59646c');
 const legend=lang?['Process','Decision','Visible result','Guard / fallback']:['处理步骤','条件判断','可见结果','约束 / 后备路径'];
 for(let i=0;i<4;i++){
  const x=190+i*245,[fill,stroke]=i===2?colors.result:i===3?colors.guard:['#f4f5f6','#899198'];
  if(i===1)elements.push('<path d="M '+x+' 102 l 13 11 l -13 11 l -13 -11 Z" fill="white" stroke="'+stroke+'"/>');
  else elements.push('<rect x="'+(x-13)+'" y="103" width="26" height="21" rx="3" fill="'+fill+'" stroke="'+stroke+'"/>');
  text(x+23,119,legend[i],16,400,'start','#59646c');
 }
 // The Chinese editions omit the bottom annotations requested for removal.
 const outputHeight=lang?spec.height:Math.max(...spec.nodes.map(n=>n[2]+height(n)/2))+55;
 if(lang){
  text(600,outputHeight-67,spec.foot?.[1]||'Logical flow based on repository source. Each website has its own release boundary.',16,400,'middle','#626c74');
  text(600,outputHeight-35,'Documentation illustration · 22 October 2026 · SVG, editable text and paths',15,400,'middle','#78838b');
 }
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="'+outputHeight+'" viewBox="0 0 1200 '+outputHeight+'" role="img" aria-labelledby="title description" xml:lang="'+language+'"><title id="title">'+escape(spec.title[lang])+'</title><desc id="description">'+escape(spec.intro[lang])+'</desc><defs><marker id="arrow" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto"><path d="M 0 0 L 9 3.5 L 0 7 L 2 3.5 Z" fill="#4e585f"/></marker></defs><rect width="1200" height="'+outputHeight+'" fill="#ffffff"/><g font-family="Segoe UI, Microsoft YaHei, Noto Sans CJK SC, Arial, sans-serif">'+elements.join('')+'</g></svg>\n';
 fs.writeFileSync(path.join(directory,'flow.'+language+'.svg'),svg);
 console.log('Rendered flow.'+language+'.svg');
}
