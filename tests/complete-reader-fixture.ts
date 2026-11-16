import {stopBoss} from "@aihot/backend/jobs/queue";
// Explicit complete evidence for tests concerned with story layout/heat, not article admission.
import {sql} from '@aihot/backend/db';
import {upsertMaterial} from '@aihot/backend/content/materials';
import {publishArticle} from '@aihot/backend/publication/publish';
export async function supportStory(storyId:number, token:string) {
 const source='reader-fixture-'+token;
 await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext,next_fetch_at)
 VALUES(${source},'完整文章测试来源','rss','T1','editorial',true,'2100-01-01') ON CONFLICT DO NOTHING`;
 const {articleId}=await upsertMaterial({sourceId:source,url:`https://example.com/${source}/${storyId}`,title:'完整的中文测试文章',bodyText:'这是一篇完整的中文测试文章正文，记录一次典型的地理热点事件观察。文章交代了事件发生的时间、地点与主要过程，引用了现场观测数据与官方通报，分析了事件的成因、影响范围与后续应对措施，并给出可供读者进一步核实的背景资料来源。正文段落连贯、信息充分，既不只是一句话快讯，也不是模板占位或同意墙，足以作为版面与热榜测试的完整素材。',bodyStatus:'ok',via:'fetch'});
 await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected)
 VALUES(${articleId},1,'rule','pass','完整的中文测试文章','完整的中文测试文章摘要。',80,false)`;
 await publishArticle(articleId);
 const [fact]=await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${source+'-'+storyId},${storyId},'完整报道事实') RETURNING id`;
 await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${fact!.id},${articleId},'report')`;
}
export async function cleanupReaderFixtures(token:string) {
 const source='reader-fixture-'+token;
 await sql`DELETE FROM fact_articles WHERE fact_id IN (SELECT id FROM facts WHERE public_id LIKE ${source+'-%'})`;
 await sql`DELETE FROM facts WHERE public_id LIKE ${source+'-%'}`;
 await sql`DELETE FROM articles WHERE source_id=${source}`;
 await sql`DELETE FROM sources WHERE id=${source}`;
 await stopBoss();
}
