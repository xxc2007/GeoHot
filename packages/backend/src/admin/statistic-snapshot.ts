import {balancedResources,readResourceSample} from "../operations/resource-budget.ts";
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,readdir,stat,unlink} from 'node:fs/promises';
import path from 'node:path';
import {config} from '../config.ts';

export interface Snapshot<T>{rows:T[];status:{state:'ready'|'stale'|'unavailable';asOf:string|null;message?:string}}
interface Saved<T>{at:number;rows:T[]}
/** One heavy admin aggregate at a time across ranges and pages. Never queue scans on refresh storms. */
let aggregateBusy=false;
function aggregateHeadroom(){try{const s=readResourceSample();return s.availableMiB>=128&&s.memoryFull<2&&s.ioFull<8&&s.cpuSome<30&&s.diskFreeMiB>=3072;}catch{return false;}}
export function snapshotReader<T>(read:()=>PromiseLike<readonly T[]>,store?:{load:()=>Promise<Saved<T>|null>;save:(v:Saved<T>)=>Promise<void>},now=Date.now,policy?:{freshMs:number;canRefresh:()=>boolean}){
  let saved:Saved<T>|null=null,loaded=false,loading:Promise<void>|undefined,pending:Promise<void>|undefined,retryAt=0;
  const refresh=()=>{
    if(pending)return pending;
    if(aggregateBusy||now()<retryAt||(balancedResources()&&!(policy?.canRefresh??aggregateHeadroom)()))return Promise.resolve();
    aggregateBusy=true;
    pending=Promise.resolve().then(read).then(async rows=>{
      saved={at:now(),rows:[...rows]};retryAt=0;
      try{await store?.save(saved);}catch{/* In-memory success remains usable if disk persistence fails. */}
    },()=>{retryAt=now()+30_000;}).finally(()=>{aggregateBusy=false;pending=undefined;});
    return pending;
  };
  const get=async():Promise<Snapshot<T>>=>{
    if(!loaded){loading??=(async()=>{try{const v=await store?.load();if(v&&v.at<=now()+60_000&&now()-v.at<86400_000)saved=v;}catch{}loaded=true;})();await loading;}
    const fresh=!!saved&&now()-saved.at<(policy?.freshMs??(balancedResources()?300_000:30_000));
    if(!fresh)void refresh();
    if(saved&&now()-saved.at<86400_000)return {rows:saved.rows,status:{state:fresh?'ready':'stale',asOf:new Date(saved.at).toISOString(),...(!fresh?{message:pending?'显示上次成功统计，正在后台更新；更新时间见上方。':'统计更新暂缓（服务器繁忙或正在重试），保留上次成功数据；页面会继续尝试。'}:{})}};
    return {rows:[],status:{state:'unavailable',asOf:null,message:'正在生成统计，页面会自动更新；尚未取得数据，不代表用量为零。'}};
  };
  return {get,refresh};
}

/** Private, versioned derived snapshots survive API restarts; no cookies, prompts or credentials. */
export function snapshotStore<T>(key:string){
  const dir=path.join(config.dataDir,'admin-statistic-snapshots');
  const version='20261025-cny-swr-v1';const digest=createHash('sha256').update(version+key).digest('hex');
  const file=path.join(dir,digest+'.json');
  return {
    async load():Promise<Saved<T>|null>{
      try{if((await stat(file)).size>2_000_000)return null;const v=JSON.parse(await readFile(file,'utf8'));
        return v.version===version&&v.key===key&&Number.isFinite(v.at)&&Array.isArray(v.rows)?{at:v.at,rows:v.rows}:null;
      }catch{return null;}
    },
    async save(v:Saved<T>){
      await mkdir(dir,{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID()+'.tmp';
      try{await writeFile(tmp,JSON.stringify({version,key,...v}),{mode:0o600});await rename(tmp,file);}finally{await unlink(tmp).catch(()=>{});}
      const files=await readdir(dir);const ordered=await Promise.all(files.filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).map(async n=>({n,at:(await stat(path.join(dir,n))).mtimeMs})));
      for(const f of ordered.sort((a,b)=>b.at-a.at).slice(32))await unlink(path.join(dir,f.n)).catch(()=>{});
    }
  };
}
