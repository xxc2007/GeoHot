import { useEffect } from "react";
import { useRevalidator } from "react-router";
import type { Route } from "./+types/server";
import { adminGet } from "../../lib/admin.server";
import { AdminPage, Card, Stat } from "../../features/admin/ui";

interface Sample { checkedAt:string; stale?:boolean; host:string; os:string; kernel:string; cpus:number; cpuPercent:number|null; uptime:number; load:number[]; memory:{total:number;available:number;swapTotal:number;swapFree:number}; disk:{total:number;free:number}; pressure:Record<string,number>; services:Array<{name:string;state:string;memory:number;restarts:number}>; ports:string[]; versions:Record<string,string>; nodes?:Array<{role:string;host:string;release:string;slots:number|null;load:number|null;loadAll:number[]|null;cpus:number|null;cpuPercent:number|null;memTotal:number|null;memFree:number|null;swapTotal:number|null;swapFree:number|null;diskFree:number|null;diskTotal:number|null;uptime:number|null;platform:string|null;kernel:string|null;services:Array<{name:string;state:string;memory:number;restarts:number}>;ports:string[];at:string|null;alive:boolean}> }
export async function loader({request}:Route.LoaderArgs){return adminGet<Sample>(request,"/api/admin/server",5000);}
const mb=(n:number)=>`${Math.round(n/1024/1024).toLocaleString()} MB`;
const gb=(n:number)=>`${(n/1024**3).toFixed(1)} GB`;
export function ErrorBoundary() {
 const r=useRevalidator();
 useEffect(()=>{const timer=setInterval(()=>{if(document.visibilityState==="visible"&&r.state==="idle")void r.revalidate();},20_000);return()=>clearInterval(timer);},[r.state,r.revalidate]);
 return <AdminPage title="服务器" subtitle="服务器指标暂时未能读取，正在自动重试。"><Card title="指标暂不可用"><p className="text-sm text-ink-3">本次没有取得新的采样数据，请稍后重新连接。</p><button className="mt-4 rounded-lg bg-ink px-4 py-2 text-white" disabled={r.state!=="idle"} onClick={()=>void r.revalidate()}>重新连接</button></Card></AdminPage>;
}
// 2026-11-07 站长：别在页面上显示 iZbp14vh9sicf5z7law47aZ 这种实例 id。
// 已知机器按所在地称呼，未知机器退回主机名，本机永远叫「本机」。
const PLACES: Array<[string, string]> = [
  ["iZbp14vh9sicf5z7law47aZ", "杭州"],
  ["iZn4a5we2sy73dqo3yih50Z", "武汉"],
];
function place(host: string, self: string): string {
  if (host === self) return "本机";
  const hit = PLACES.find(([prefix]) => host.startsWith(prefix));
  return hit ? hit[1] : host;
}

export default function Server({loaderData:s}:Route.ComponentProps){
 const r=useRevalidator();useEffect(()=>{const timer=setInterval(()=>{if(document.visibilityState==="visible"&&r.state==="idle")r.revalidate();},20_000);return()=>clearInterval(timer);},[r.state,r.revalidate]);
 return <AdminPage title="服务器" subtitle={`每 20 秒更新 · 采样时间 ${new Date(s.checkedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}${s.stale?' · 当前为上次采样':''}`}>
  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Stat label="CPU 使用率" value={s.cpuPercent===null?"等待采样":`${s.cpuPercent}%`} hint={`${s.cpus} 核 · 负载 ${s.load.join(' / ')}`}/><Stat label="可用内存" value={mb(s.memory.available)} hint={`总内存 ${mb(s.memory.total)}`} tone={s.memory.available/s.memory.total<.15?'bad':'ok'}/><Stat label="交换空间已用" value={mb(s.memory.swapTotal-s.memory.swapFree)} hint={`总交换空间 ${mb(s.memory.swapTotal)}`}/><Stat label="磁盘剩余" value={gb(s.disk.free)} hint={`总容量 ${gb(s.disk.total)}`}/></div>
  <Card title="运行状态"><dl className="grid gap-4 text-sm sm:grid-cols-2"><div><dt className="text-ink-3">系统</dt><dd>{s.os} · {s.kernel}</dd></div><div><dt className="text-ink-3">主机与开机时长</dt><dd>{s.host} · {Math.floor(s.uptime/86400)} 天 {Math.floor(s.uptime%86400/3600)} 小时</dd></div>{Object.entries(s.pressure).map(([k,v])=><div key={k}><dt className="text-ink-3">{k==='memory'?'内存':k==='io'?'磁盘 I/O':'CPU'}压力（10 秒）</dt><dd>{v}%</dd></div>)}<div><dt className="text-ink-3">内部监听端口</dt><dd>{s.ports.join('、')}</dd></div></dl></Card>
  <Card title="服务"><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="text-ink-3"><th className="py-2">服务</th><th>状态</th><th>内存</th><th>自动重启次数</th></tr></thead><tbody>{s.services.map(v=><tr key={v.name} className="border-t border-line"><td className="py-3">{v.name}</td><td className={v.state==='active'?'text-ok-ink':'text-amber-ink'}>{v.state==='active'?'运行中':v.state==='inactive'?'已停止':v.state}</td><td>{mb(v.memory)}</td><td>{v.restarts}</td></tr>)}</tbody></table></div></Card>
  <Card title="协同节点">
  <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="text-ink-3">
    <th className="py-2">角色</th><th>主机</th><th>并发槽</th><th>负载</th><th>内存</th><th>磁盘</th><th>最后心跳</th><th>状态</th>
  </tr></thead><tbody>{(s.nodes??[]).length===0
    ?<tr><td className="py-3 text-ink-3" colSpan={8}>还没有辅助节点上报心跳。</td></tr>
    :(s.nodes??[]).map(n=>
      <tr key={`${n.role}@${n.host}`} className="border-t border-line">
        <td className="py-3">{n.role}</td>
        <td title={n.host}>{place(n.host, s.host)}</td>
        <td>{n.slots??"—"}</td>
        <td>{n.load===null?"—":n.load.toFixed(2)}</td>
        <td>{n.memTotal&&n.memFree!==null?`${gb(n.memTotal-n.memFree)} / ${gb(n.memTotal)}`:"—"}</td>
        <td>{n.diskTotal&&n.diskFree!==null?`剩 ${gb(n.diskFree)} / ${gb(n.diskTotal)}`:"—"}</td>
        <td>{n.at?new Date(n.at).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false}):"—"}</td>
        <td className={n.alive?"text-ok-ink":"text-amber-ink"}>{n.alive?"在岗":"离线"}</td>
      </tr>)}
  </tbody></table></div>
  <p className="mt-4 text-xs text-ink-3">心跳来自各机器自己的 worker 进程（settings 表的 heartbeat.*@host 行）。负载是一分钟均值，内存是「已用 / 总量」，三分钟内无心跳即判离线。远端节点的读数由该机 worker 自己采集，主库不需要 SSH 出去，辅助机也不必对外开端口。</p>
</Card>
  {(s.nodes??[]).filter(n=>n.alive&&n.host!==s.host).map(n=>
    <div key={`node-${n.host}`} className="space-y-3">
      <div className="flex items-baseline gap-3 pt-2"><h2 className="text-lg font-semibold">{place(n.host, s.host)}</h2><span className="text-xs text-ink-3">{n.role} · {n.host} · release {n.release||"—"} · 并发槽 {n.slots??"—"} · {n.kernel||n.platform||""}</span></div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="CPU 使用率" value={n.cpuPercent===null?"等待采样":`${n.cpuPercent}%`} hint={`${n.cpus??"?"} 核 · 负载 ${(n.loadAll??[n.load??0]).join(" / ")}`}/>
        <Stat label="可用内存" value={n.memFree===null?"—":mb(n.memFree)} hint={`总内存 ${n.memTotal===null?"—":mb(n.memTotal)}`} tone={n.memTotal&&n.memFree!==null&&n.memFree/n.memTotal<.15?"bad":"ok"}/>
        <Stat label="交换空间已用" value={n.swapTotal===null?"—":mb(n.swapTotal-(n.swapFree??0))} hint={`总交换空间 ${mb(n.swapTotal??0)}`}/>
        <Stat label="磁盘剩余" value={n.diskFree===null?"—":gb(n.diskFree)} hint={`总容量 ${n.diskTotal===null?"—":gb(n.diskTotal)}`}/>
      </div>
      <Card title="运行状态"><dl className="grid gap-4 text-sm sm:grid-cols-2">
        <div><dt className="text-ink-3">主机与开机时长</dt><dd>{n.host} · {n.uptime===null?"—":`${Math.floor(n.uptime/86400)} 天 ${Math.floor(n.uptime%86400/3600)} 小时`}</dd></div>
        <div><dt className="text-ink-3">最后心跳</dt><dd>{n.at?new Date(n.at).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false}):"—"}</dd></div>
        <div><dt className="text-ink-3">内部监听端口</dt><dd>{(n.ports??[]).length?n.ports.join("、"):"—"}</dd></div>
      </dl></Card>
      <Card title="服务"><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="text-ink-3"><th className="py-2">服务</th><th>状态</th><th>内存</th><th>自动重启次数</th></tr></thead><tbody>{(n.services??[]).length===0
        ?<tr><td className="py-3 text-ink-3" colSpan={4}>这台机器没有上报单元状态。</td></tr>
        :(n.services??[]).map(v=><tr key={v.name} className="border-t border-line"><td className="py-3">{v.name}</td><td className={v.state==="active"?"text-ok-ink":"text-amber-ink"}>{v.state==="active"?"运行中":v.state==="inactive"?"已停止":v.state}</td><td>{mb(v.memory)}</td><td>{v.restarts}</td></tr>)}</tbody></table></div></Card>
    </div>)}
  <Card title="软件与配置"><dl className="grid gap-3 text-sm sm:grid-cols-2">{Object.entries(s.versions).map(([k,v])=><div key={k}><dt className="text-ink-3">{k}</dt><dd>{v}</dd></div>)}</dl><p className="mt-4 text-xs text-ink-3">仅展示运行指标与配置摘要。服务停止可能由读者保护机制触发，具体原因见运行页与服务器日志。</p></Card>
 </AdminPage>;
}
