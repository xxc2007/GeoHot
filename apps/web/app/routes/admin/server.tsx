import { useEffect } from "react";
import { useRevalidator } from "react-router";
import type { Route } from "./+types/server";
import { adminGet } from "../../lib/admin.server";
import { AdminPage, Card, Stat } from "../../features/admin/ui";

interface Sample { checkedAt:string; stale?:boolean; host:string; os:string; kernel:string; cpus:number; cpuPercent:number|null; uptime:number; load:number[]; memory:{total:number;available:number;swapTotal:number;swapFree:number}; disk:{total:number;free:number}; pressure:Record<string,number>; services:Array<{name:string;state:string;memory:number;restarts:number}>; ports:string[]; versions:Record<string,string> }
export async function loader({request}:Route.LoaderArgs){return adminGet<Sample>(request,"/api/admin/server",5000);}
const mb=(n:number)=>`${Math.round(n/1024/1024).toLocaleString()} MB`;
const gb=(n:number)=>`${(n/1024**3).toFixed(1)} GB`;
export default function Server({loaderData:s}:Route.ComponentProps){
 const r=useRevalidator();useEffect(()=>{const timer=setInterval(()=>{if(document.visibilityState==="visible"&&r.state==="idle")r.revalidate();},20_000);return()=>clearInterval(timer);},[r.state,r.revalidate]);
 return <AdminPage title="服务器" subtitle={`每 20 秒更新 · 采样时间 ${new Date(s.checkedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}${s.stale?' · 当前为上次采样':''}`}>
  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Stat label="CPU 使用率" value={s.cpuPercent===null?"等待采样":`${s.cpuPercent}%`} hint={`${s.cpus} 核 · 负载 ${s.load.join(' / ')}`}/><Stat label="可用内存" value={mb(s.memory.available)} hint={`总内存 ${mb(s.memory.total)}`} tone={s.memory.available/s.memory.total<.15?'bad':'ok'}/><Stat label="交换空间已用" value={mb(s.memory.swapTotal-s.memory.swapFree)} hint={`总交换空间 ${mb(s.memory.swapTotal)}`}/><Stat label="磁盘剩余" value={gb(s.disk.free)} hint={`总容量 ${gb(s.disk.total)}`}/></div>
  <Card title="运行状态"><dl className="grid gap-4 text-sm sm:grid-cols-2"><div><dt className="text-ink-3">系统</dt><dd>{s.os} · {s.kernel}</dd></div><div><dt className="text-ink-3">主机与开机时长</dt><dd>{s.host} · {Math.floor(s.uptime/86400)} 天 {Math.floor(s.uptime%86400/3600)} 小时</dd></div>{Object.entries(s.pressure).map(([k,v])=><div key={k}><dt className="text-ink-3">{k==='memory'?'内存':k==='io'?'磁盘 I/O':'CPU'}压力（10 秒）</dt><dd>{v}%</dd></div>)}<div><dt className="text-ink-3">内部监听端口</dt><dd>{s.ports.join('、')}</dd></div></dl></Card>
  <Card title="服务"><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="text-ink-3"><th className="py-2">服务</th><th>状态</th><th>内存</th><th>自动重启次数</th></tr></thead><tbody>{s.services.map(v=><tr key={v.name} className="border-t border-line"><td className="py-3">{v.name}</td><td className={v.state==='active'?'text-ok-ink':'text-amber-ink'}>{v.state==='active'?'运行中':v.state==='inactive'?'已停止':v.state}</td><td>{mb(v.memory)}</td><td>{v.restarts}</td></tr>)}</tbody></table></div></Card>
  <Card title="软件与配置"><dl className="grid gap-3 text-sm sm:grid-cols-2">{Object.entries(s.versions).map(([k,v])=><div key={k}><dt className="text-ink-3">{k}</dt><dd>{v}</dd></div>)}</dl><p className="mt-4 text-xs text-ink-3">仅展示运行指标与配置摘要。服务停止可能由读者保护机制触发，具体原因见运行页与服务器日志。</p></Card>
 </AdminPage>;
}
