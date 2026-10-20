import type {Db} from '../db.ts';
import type {MaterialInput} from './materials.ts';
import {identityKeyForUrl} from '../lib/url.ts';
import {sha256,stableJson} from '../lib/ids.ts';

/** Structured identifiers only. Never search title/body/reference text for DOI-looking strings. */
export function normalizeDoi(input: string): string | null {
  let value=input.trim().replace(/^doi:\s*/i,'');
  if(/^https?:\/\//i.test(value)) {
    let u:URL;try{u=new URL(value)}catch{return null}
    if(!['doi.org','dx.doi.org'].includes(u.hostname.toLowerCase())||u.search||u.hash)return null;
    value=u.pathname.slice(1);
  }
  try{value=decodeURIComponent(value)}catch{return null}
  return /^10\.\d{4,9}\/[^\s\u0000-\u001f]+$/i.test(value)?value.toLowerCase():null;
}
export function strongMaterialKeys(m:MaterialInput,primary:string):string[] {
  const canonicalPrimary=primary.startsWith('doi:')?normalizeDoi(primary):null;
  const keys=new Set([canonicalPrimary?'doi:'+canonicalPrimary:primary]);
  // A fragment-specific entry is a section, not its parent document or that document's DOI.
  const fragmentScoped=primary.startsWith('url:')&&primary.includes('#');
  if(!fragmentScoped) {
    const url=identityKeyForUrl(m.url);if(url)keys.add(url);
    const explicit=m.doi??(primary.startsWith('doi:')?primary.slice(4):null);
    const doi=explicit?normalizeDoi(explicit):normalizeDoi(m.url);
    if(doi)keys.add('doi:'+doi);
  }
  return [...keys].sort();
}
export async function lockMaterialKeys(db:Db,keys:string[]) {
  for(const key of [...new Set(keys)].sort())await db`SELECT pg_advisory_xact_lock(hashtextextended(${key},734073))`;
}
export async function observeMaterial(db:Db,m:MaterialInput,articleId:string|null,conflictId:number|null) {
  const payload=stableJson(m),hash=sha256(stableJson({...m,discoveredAt:undefined}));
  const key=sha256(stableJson([articleId,conflictId,m.sourceId,m.via,hash]));
  await db`INSERT INTO material_observations(article_id,conflict_id,source_id,via,payload_hash,payload,observation_key)
    VALUES(${articleId},${conflictId},${m.sourceId},${m.via},${hash},${db.json(JSON.parse(payload))},${key}) ON CONFLICT(observation_key) DO NOTHING`;
}
export async function resolveMaterialIdentity(db:Db,m:MaterialInput,keys:string[]) {
  await lockMaterialKeys(db,keys);
  // The existing indexed raw URL lookup bridges legacy DOI-only rows without a table rewrite.
  // Verify normalized identities in JS so fragment-scoped rows never gain a parent-page alias.
  const legacy=await db<{id:string;identity_key:string;url:string}[]>`SELECT id,identity_key,url FROM articles
    WHERE identity_key=ANY(${keys}::text[]) OR url=${m.url} ORDER BY id`;
  const exact=identityKeyForUrl(m.url);
  const ids=new Set(legacy.filter(r=>keys.includes(r.identity_key)||(!r.identity_key.includes('#')&&keys.includes(exact??'')&&identityKeyForUrl(r.url)===exact)).map(r=>r.id));
  for(const row of await db<{article_id:string}[]>`SELECT article_id FROM article_identity_aliases WHERE alias_key=ANY(${keys}::text[])`)ids.add(row.article_id);
  const candidates=[...ids].sort();
  const incomingDois=keys.filter(k=>k.startsWith('doi:')).map(k=>k.slice(4));
  const storedDois=candidates.length===1?[
    ...legacy.filter(r=>r.id===candidates[0]&&r.identity_key.startsWith('doi:')).map(r=>normalizeDoi(r.identity_key)),
    ...(await db<{alias_key:string}[]>`SELECT alias_key FROM article_identity_aliases WHERE article_id=${candidates[0]!} AND alias_key LIKE 'doi:%'`).map(r=>r.alias_key.slice(4))
  ].filter(Boolean):[];
  const contradictoryDoi=new Set(incomingDois).size>1 || incomingDois.some(doi=>storedDois.length&&!storedDois.includes(doi));
  if(candidates.length>1||contradictoryDoi) {
    const fingerprint=sha256(stableJson([keys,candidates]));
    const [conflict]=await db<{id:number}[]>`INSERT INTO material_identity_conflicts(fingerprint,alias_keys,article_ids)
      VALUES(${fingerprint},${keys},${candidates}) ON CONFLICT(fingerprint) DO UPDATE SET fingerprint=EXCLUDED.fingerprint RETURNING id`;
    await observeMaterial(db,m,null,conflict!.id);
    return {conflictId:conflict!.id,id:null};
  }
  return {id:candidates[0]??null,conflictId:null};
}
export async function claimMaterialAliases(db:Db,keys:string[],id:string) {
  for(const key of keys) {
    await db`INSERT INTO article_identity_aliases(alias_key,article_id,evidence_kind) VALUES(${key},${id},${key.startsWith('doi:')?'structured-doi':'exact-identity'}) ON CONFLICT(alias_key) DO NOTHING`;
    const [row]=await db`SELECT article_id FROM article_identity_aliases WHERE alias_key=${key}`;
    if(row!.article_id!==id)throw new Error('Material alias ownership changed; transaction aborted');
  }
}
