import {stopBoss} from "@aihot/backend/jobs/queue";
// Explicit complete evidence for tests concerned with story layout/heat, not article admission.
import {sql} from '@aihot/backend/db';
import {upsertMaterial} from '@aihot/backend/content/materials';
import {publishArticle} from '@aihot/backend/publication/publish';
export async function supportStory(storyId:number, token:string) {
 const source='reader-fixture-'+token;
 await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext,next_fetch_at)
 VALUES(${source},'完整文章测试来源','rss','T1','editorial',true,'2100-01-01') ON CONFLICT DO NOTHING`;
 const {articleId}=await upsertMaterial({sourceId:source,url:`https://example.com/${source}/${storyId}`,title:'完整的中文测试文章',bodyText:'这是一篇完整的中文测试文章正文。',bodyStatus:'ok',via:'fetch'});
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
