import {tag} from './setup.ts';
import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {readFileSync} from 'node:fs';
import {sql,closeDb} from '@aihot/backend/db';
import {stopBoss} from '@aihot/backend/jobs/queue';
import {upsertMaterial} from '@aihot/backend/content/materials';
import {publishArticle} from '@aihot/backend/publication/publish';
import {loadTopicPage,topicPageCounts} from '@aihot/backend/publication/topics';
const id='volcano-scope-'+tag();
after(async()=>{await sql`DELETE FROM articles WHERE source_id=${id}`;await sql`DELETE FROM topics WHERE slug=${id}`;await sql`DELETE FROM sources WHERE id=${id}`;await stopBoss();await closeDb()});
test('a volcano topic excludes cyclone alerts and ordinary landforms from its actual public counts and page',async()=>{
 const pack=JSON.parse(readFileSync(new URL('../industry/topics.json',import.meta.url),'utf8'));
 const topic=pack.topics.find((t:{slug:string})=>t.slug==='volcanoes');
 await sql`INSERT INTO sources(id,name,kind,tier,site_fulltext,syndicate_fulltext) VALUES(${id},'Topic scope fixture','rss','T1',true,true)`;
 await sql`INSERT INTO topics(slug,name,grp,tags,definition,related,position) VALUES(${id},'火山范围测试','field',${topic.tags},${topic.definition},'{}',9999)`;
 const now=new Date(Date.now()+60000),before=(await topicPageCounts(now)).find(t=>t.slug===id)!.total;
 const made:string[]=[];
 for(const [title,tags]of [['火山灰扩散的观测结果',['火山','灾害事件']],['台风路径预报',['台风与寒潮','灾害事件']],['河流侵蚀形成的地貌',['地貌']]] as const){
  const material=await upsertMaterial({sourceId:id,url:`https://example.org/${id}/${made.length}`,title,bodyText:'观测正文报告给出明确地点、测量数据以及变化范围。',bodyStatus:'ok',via:'fetch',publishedAt:new Date()});made.push(material.articleId);
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,tags,title_zh,summary_zh,reason_zh,score,selected) VALUES(${material.articleId},1,'model','pass','physical',${[...tags]},${title},'观测结果包含地点和测量依据。','可供核对的观测材料。',90,true)`;
  await publishArticle(material.articleId,{releasedAt:new Date(Date.now()-1000)});
 }
 assert.equal((await topicPageCounts(now)).find(t=>t.slug===id)!.total-before,1);
 const page=await loadTopicPage(id,1,now);assert.ok(page);
 assert.ok(!page.items.some(item=>made.slice(1).includes(item.id)),'unrelated disaster and landform cards must not enter the volcano page');
});
