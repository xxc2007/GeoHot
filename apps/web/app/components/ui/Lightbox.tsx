import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Presence } from "./Presence";
import { IconArrowLeft, IconArrowRight, IconClose } from "../icons.tsx";
import { focusWhenReady, returnFocus } from "../../lib/focus-when-ready.ts";
export interface LightboxImage { src: string; alt?: string | null }
type Pose = { scale: number; x: number; y: number };
const FIT: Pose = { scale: 1, x: 0, y: 0 };
/** Image zoom has its own viewport; controls stay fixed and the page behind never moves. */
export function Lightbox({ images, index, onIndex, onClose }: { images: LightboxImage[]; index: number | null; onIndex: (i: number) => void; onClose: () => void }) {
 const open = index !== null && !!images[index];
 const dialog=useRef<HTMLDivElement>(null), viewport=useRef<HTMLDivElement>(null), picture=useRef<HTMLImageElement>(null), close=useRef<HTMLButtonElement>(null);
 const state=useRef({index,images,onIndex,onClose});state.current={index,images,onIndex,onClose};
 const pose=useRef<Pose>(FIT), points=useRef(new Map<number,{x:number;y:number}>());
 const [scale,setScale]=useState(1), lastTap=useRef(0),lastTouch=useRef(0),multi=useRef(false);
 const gesture=useRef<{pose:Pose;x:number;y:number;distance:number;dx:number;dy:number}|null>(null);
 const maxZoom=()=>{const img=picture.current;return Math.max(12,img&&img.clientWidth?img.naturalWidth/img.clientWidth:1,img&&img.clientHeight?img.naturalHeight/img.clientHeight:1);};
 const paint=(next:Pose)=>{
  const box=viewport.current,img=picture.current,s=Math.max(1,Math.min(maxZoom(),next.scale));
  const bx=box&&img?Math.max(0,(img.clientWidth*s-box.clientWidth)/2):0,by=box&&img?Math.max(0,(img.clientHeight*s-box.clientHeight)/2):0;
  const p={scale:s,x:Math.max(-bx,Math.min(bx,next.x)),y:Math.max(-by,Math.min(by,next.y))};pose.current=p;setScale(s);
  if(img)img.style.transform=`translate(${p.x}px,${p.y}px) scale(${s})`;
 };
 const zoom=(s:number,x=0,y=0)=>{const p=pose.current,n=Math.max(1,Math.min(maxZoom(),s)),r=n/p.scale;paint({scale:n,x:x-(x-p.x)*r,y:y-(y-p.y)*r});};
 const step=(by:number)=>{const s=state.current;if(s.index!==null&&s.images.length>1)s.onIndex((s.index+by+s.images.length)%s.images.length);};
 useEffect(()=>{points.current.clear();multi.current=false;gesture.current=null;paint(FIT);},[index,open]);
 useEffect(()=>{
  if(!open)return;
  const opener=document.activeElement instanceof HTMLElement?document.activeElement:null,root=document.documentElement,prior=root.style.overflow;root.style.overflow='hidden';
  const stop=focusWhenReady(()=>close.current);
  const key=(e:KeyboardEvent)=>{
   if(e.key==='Escape')state.current.onClose();
   else if(e.key==='+'||e.key==='=')zoom(pose.current.scale*1.5);
   else if(e.key==='-')zoom(pose.current.scale/1.5);
   else if(e.key==='0')paint(FIT);
   else if(e.key.startsWith('Arrow')){
    if(pose.current.scale>1)paint({...pose.current,x:pose.current.x+(e.key==='ArrowLeft'?60:e.key==='ArrowRight'?-60:0),y:pose.current.y+(e.key==='ArrowUp'?60:e.key==='ArrowDown'?-60:0)});
    else if(e.key==='ArrowLeft'||e.key==='ArrowRight')step(e.key==='ArrowLeft'?-1:1);
   }else if(e.key==='Tab'){
    const all=[...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled)')??[])],at=all.indexOf(document.activeElement as HTMLElement);
    all[(at+(e.shiftKey?-1:1)+all.length)%all.length]?.focus();
   }else return;e.preventDefault();
  };
  const resize=()=>paint(pose.current),box=viewport.current;
  const wheel=(e:WheelEvent)=>{e.preventDefault();const b=box!.getBoundingClientRect();zoom(pose.current.scale*Math.exp(-e.deltaY*.002),e.clientX-b.left-b.width/2,e.clientY-b.top-b.height/2);};
  document.addEventListener('keydown',key);window.addEventListener('resize',resize);box?.addEventListener('wheel',wheel,{passive:false});
  return()=>{stop();document.removeEventListener('keydown',key);window.removeEventListener('resize',resize);box?.removeEventListener('wheel',wheel);root.style.overflow=prior;returnFocus(opener);};
 },[open]);
 const begin=()=>{const [a,b]=[...points.current.values()];gesture.current=a?{pose:{...pose.current},x:b?(a.x+b.x)/2:a.x,y:b?(a.y+b.y)/2:a.y,distance:b?Math.hypot(a.x-b.x,a.y-b.y):0,dx:0,dy:0}:null;};
 const current=open?images[index!]:null,button='grid min-h-11 min-w-11 place-items-center rounded-full px-3 text-white hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-35';
 if(typeof document==='undefined')return null;
 return createPortal(<Presence show={open} enter="anim-fade-in" exit="anim-fade-out" duration={160}>
  <div ref={dialog} role="dialog" aria-modal="true" aria-label={`图片查看器 ${index!==null?index+1:0} / ${images.length}`} className="fixed inset-0 z-[80] overflow-hidden bg-black/90 text-white">
   <div className="absolute inset-x-2 top-[max(12px,env(safe-area-inset-top))] z-20 flex items-center justify-between gap-1">
    <span className="hidden shrink-0 rounded-full bg-black/60 px-2 py-2 text-xs min-[360px]:block">{index!==null?index+1:0} / {images.length}</span>
    <div role="toolbar" aria-label="图片缩放" className="flex items-center rounded-full bg-black/70">
     <button type="button" aria-label="缩小图片" disabled={scale<=1} className={button} onClick={()=>zoom(scale/1.5)}>−</button>
     <span className="min-w-10 text-center text-xs tabular-nums" aria-live="polite">{Math.round(scale*100)}%</span>
     <button type="button" aria-label="放大图片" disabled={scale>=maxZoom()} className={button} onClick={()=>zoom(scale*1.5)}>＋</button>
     <button type="button" aria-label="适应窗口" className={`${button} text-xs`} onClick={()=>paint(FIT)}>适应</button>
     <button type="button" aria-label="原始尺寸" className={`${button} text-xs`} onClick={()=>{const img=picture.current;if(img)zoom(Math.max(1,img.naturalWidth/img.clientWidth));}}>1:1</button>
    </div>
    <button ref={close} type="button" aria-label="关闭" className={`${button} shrink-0 bg-black/60`} onClick={onClose}><IconClose size={20}/></button>
   </div>
   <div ref={viewport} className="absolute inset-x-3 bottom-16 top-20 grid touch-none place-items-center overflow-hidden sm:inset-x-16" style={{cursor:scale>1?'grab':'zoom-in'}}
    onPointerDown={e=>{if(e.pointerType==='mouse'&&e.button!==0)return;points.current.set(e.pointerId,{x:e.clientX,y:e.clientY});if(points.current.size>1){multi.current=true;lastTap.current=0;}e.currentTarget.setPointerCapture(e.pointerId);begin();}}
    onPointerMove={e=>{
     if(!points.current.has(e.pointerId))return;points.current.set(e.pointerId,{x:e.clientX,y:e.clientY});const g=gesture.current,[a,b]=[...points.current.values()];if(!g||!a)return;
     const x=b?(a.x+b.x)/2:a.x,y=b?(a.y+b.y)/2:a.y;g.dx=x-g.x;g.dy=y-g.y;
     if(b&&g.distance>0){const n=Math.max(1,Math.min(maxZoom(),g.pose.scale*Math.hypot(a.x-b.x,a.y-b.y)/g.distance)),box=viewport.current!.getBoundingClientRect(),cx=g.x-box.left-box.width/2,cy=g.y-box.top-box.height/2,r=n/g.pose.scale;paint({scale:n,x:cx-(cx-g.pose.x)*r+g.dx,y:cy-(cy-g.pose.y)*r+g.dy});}
     else if(g.pose.scale>1)paint({scale:g.pose.scale,x:g.pose.x+g.dx,y:g.pose.y+g.dy});
    }}
    onPointerUp={e=>{
     if(e.pointerType!=='mouse')lastTouch.current=Date.now();const g=gesture.current,single=points.current.size===1;points.current.delete(e.pointerId);
     if(single&&!multi.current&&g&&g.distance===0){
      if(g.pose.scale===1&&Math.abs(g.dx)>60&&Math.abs(g.dx)>Math.abs(g.dy))step(g.dx<0?1:-1);
      else if(g.pose.scale===1&&g.dy>110&&Math.abs(g.dy)>Math.abs(g.dx))onClose();
      else if(Math.hypot(g.dx,g.dy)<8&&e.pointerType!=='mouse'){const now=Date.now();if(now-lastTap.current<300){zoom(pose.current.scale>1?1:2.5);lastTap.current=0;}else lastTap.current=now;}
     }if(!points.current.size)multi.current=false;begin();
    }} onPointerCancel={e=>{points.current.delete(e.pointerId);if(!points.current.size)multi.current=false;begin();}} onDoubleClick={()=>{if(Date.now()-lastTouch.current>500)zoom(pose.current.scale>1?1:2.5);}}>
    {current&&<img key={current.src} ref={picture} src={current.src} alt={current.alt??''} draggable={false} decoding="async" onLoad={()=>paint(FIT)} className="max-h-full max-w-full select-none object-contain shadow-2xl" style={{transformOrigin:'center',willChange:'transform'}}/>}
   </div>
   {images.length>1&&<><button type="button" aria-label="上一张" className={`${button} absolute bottom-3 left-4 bg-black/60 sm:bottom-1/2`} onClick={()=>step(-1)}><IconArrowLeft size={20}/></button><button type="button" aria-label="下一张" className={`${button} absolute bottom-3 right-4 bg-black/60 sm:bottom-1/2`} onClick={()=>step(1)}><IconArrowRight size={20}/></button></>}
   <p className="pointer-events-none absolute inset-x-16 bottom-5 text-center text-xs text-white/70">双击或双指缩放 · 放大后拖动查看</p>
  </div>
 </Presence>,document.body);
}
