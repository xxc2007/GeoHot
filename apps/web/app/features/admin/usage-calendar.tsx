import { Link } from 'react-router';
import { calendarCells, shiftMonth, WEEKDAYS } from '../calendar/grid';
import { Halftone } from '../report/Halftone';
import { beijingWeekday } from '../../lib/format';

export interface UsageCalendarData {
  month: string; today: string;
  status: {state: string; asOf: string | null};
  days: Array<{date: string; calls: number; tokens: number}>;
}
export function UsageCalendar({calendar:c, date, href}:{calendar:UsageCalendarData; date:string|null; href:(updates:Record<string,string>)=>string}) {
  const [year,month]=c.month.split('-').map(Number);
  const focus=date?.startsWith(c.month)?date:c.month===c.today.slice(0,7)?c.today:null;
  const ready=!!c.status.asOf;
  const count=(day:string)=>c.days.find(d=>d.date===day)?.calls??0;
  const nav=(offset:number,label:string,glyph:string)=>{
    const target=shiftMonth(c.month,offset),disabled=target>c.today.slice(0,7)||target<'2000-01';
    return disabled?<span aria-hidden="true" className="grid h-11 w-11 place-items-center text-ink-4/40">{glyph}</span>:<Link aria-label={label} title={label} to={href({month:target})} className="grid h-11 w-11 place-items-center rounded-full text-lg text-ink-3 hover:bg-bg-sunk focus-visible:outline-2 focus-visible:outline-accent">{glyph}</Link>;
  };
  return <nav aria-label="按日查看用量" className="well mb-5 flex max-w-[780px] flex-col overflow-hidden rounded-panel border border-line lg:flex-row">
    <div className="flex flex-col items-center justify-center gap-1 border-b border-line p-4 text-center lg:w-[180px] lg:shrink-0 lg:border-b-0 lg:border-r">
      <span className="text-label tracking-widest text-ink-4">{focus?'每日用量':'按月浏览'}</span>
      {focus&&<Halftone seed={`usage-${focus}`} className="num text-[54px] font-black leading-none text-ink">{Number(focus.slice(8))}</Halftone>}
      <p className="text-xs text-ink-2">{year} 年 {month} 月{focus?` · ${beijingWeekday(focus)}`:''}</p>
      <p className="text-xs text-ink-4">{ready?(focus?`当天 ${count(focus).toLocaleString()} 次请求`:`本月 ${c.days.reduce((n,d)=>n+d.calls,0).toLocaleString()} 次请求`):'日历统计加载中'}</p>
      <div className="mt-1 flex items-center">{nav(-1,'用量日历上一个月','‹')}{nav(1,'用量日历下一个月','›')}{c.month!==c.today.slice(0,7)&&<Link className="p-2 text-xs text-accent" to={href({month:c.today.slice(0,7)})}>回到本月</Link>}</div>
    </div>
    <div className="min-w-0 flex-1 p-3 lg:p-4">
      <div className="flex items-center justify-between gap-2 text-sm"><strong>{month} 月</strong><span className="text-xs text-ink-4">{ready?`本月 ${c.days.reduce((n,d)=>n+d.calls,0).toLocaleString()} 次请求`:'统计尚未取得'}</span></div>
      <div className="mt-2 grid grid-cols-7 text-center text-xs text-ink-4">{WEEKDAYS.map(w=><span key={w}>{w}</span>)}</div>
      <div className="mt-1 grid grid-cols-7">{calendarCells(c.month).map((cell,i)=>{
        if(!cell.date)return <span key={`blank-${i}`} className="h-11"/>;
        const day=cell.date,n=count(day),selected=day===date,future=day>c.today;
        const label=`${day} · ${ready?`${n.toLocaleString()} 次请求`:'统计尚未取得'}${selected?'（已选择）':''}`;
        return <div key={day} className="grid h-11 place-items-center">{future?<span className="h-1 w-1 rounded-full bg-line-strong" title={`${day} · 尚未到来`}/>:<Link to={href({date:day,range:'date',month:c.month})} aria-label={label} title={label} aria-current={selected?'date':undefined} className={`group relative grid h-10 w-10 place-items-center rounded-full hover:bg-bg-sunk focus-visible:outline-2 focus-visible:outline-accent ${selected?'ring-2 ring-accent ring-offset-2 ring-offset-paper':''}`}>
          <span aria-hidden="true" className={`rounded-full ${n?'h-2.5 w-2.5':'h-1 w-1'} ${selected||day===c.today?'bg-accent':n?'bg-ink':'bg-line-strong'}`}/><span className="absolute inset-0 grid place-items-center rounded-full bg-accent text-xs font-semibold text-paper opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">{cell.day}</span>
        </Link>}</div>;
      })}</div>
      <p className="mt-2 text-[11px] text-ink-4">北京时间 · 点击日期查看当天全部指标；空白日期也可查看。{c.status.state==='stale'?' 日历保留上次成功统计。':''}</p>
    </div>
  </nav>;
}
