// Bounded, keyset-resumable legacy alias registration. No canonical/revision/receipt changes.
import {parseArgs} from 'node:util';
import {sql,closeDb} from '@aihot/backend/db';
import {strongMaterialKeys,resolveMaterialIdentity,claimMaterialAliases,observeMaterial} from '@aihot/backend/content/material-identity';
import type {MaterialInput} from '@aihot/backend/content/materials';
const {values}=parseArgs({options:{after:{type:'string',default:''},limit:{type:'string',default:'25'},apply:{type:'boolean',default:false},'database-url-env':{type:'string'}}});
try {
 if(!process.env.DATABASE_URL)throw new Error('Explicit DATABASE_URL required');
 const limit=Number(values.limit);if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('limit must be1..100');
 if(values.apply&&values['database-url-env']!=='DATABASE_URL')throw new Error('Apply acknowledgement required');
 // A bounded read, never OFFSET or an all-table text scan. A maintenance owner must exclude old writers.
 const rows=await sql`SELECT id,source_id,identity_key,url,title,body_text,body_html,excerpt,raw,published_at FROM articles WHERE id>${values.after!} ORDER BY id LIMIT ${limit}`;
 let registered=0,conflicts=0;
 for(const r of rows) {
  const m:MaterialInput={sourceId:r.source_id,url:r.url,title:r.title,identityKey:r.identity_key,bodyText:r.body_text,bodyHtml:r.body_html,excerpt:r.excerpt,raw:r.raw,publishedAt:r.published_at,via:'import',observation:{legacySnapshot:true,articleId:r.id}};
  if(!values.apply)continue;
  await sql.begin(async tx=>{
   await tx`SET LOCAL lock_timeout='1500ms'`;await tx`SET LOCAL statement_timeout='5s'`;
   const keys=strongMaterialKeys(m,r.identity_key),resolved=await resolveMaterialIdentity(tx,m,keys);
   if(resolved.conflictId!==null){conflicts++;return;}
   if(resolved.id!==r.id)throw new Error('Legacy identity changed; refuse checkpoint');
   const [current]=await tx`SELECT identity_key,url FROM articles WHERE id=${r.id} FOR UPDATE`;
   if(!current||current.identity_key!==r.identity_key||current.url!==r.url)throw new Error('Legacy snapshot changed; refuse checkpoint');
   await claimMaterialAliases(tx,keys,r.id);await observeMaterial(tx,m,r.id,null);registered++;
  });
 }
 console.log(JSON.stringify({mode:values.apply?'apply':'dry-run',seen:rows.length,registered,conflicts,nextAfter:rows.at(-1)?.id??values.after,exhausted:rows.length<limit,fullyMerged:false}));
 if(conflicts)process.exitCode=2;
}finally{await closeDb();}
