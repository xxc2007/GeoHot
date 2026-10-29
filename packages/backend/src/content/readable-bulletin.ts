import * as cheerio from 'cheerio';
import {sanitizeBody} from './sanitize.ts';
/** NHC's plain-text transport uses pre for prose. Format only this official publisher's bulletins. */
export function readableBulletin(url:string,html:string):string{
 let host='';try{host=new URL(url).hostname;}catch{return html;}
 if(!/^(www\.)?nhc\.noaa\.gov$/i.test(host))return html;
 const $=cheerio.load(html,null,false);
 $('pre').each((_,el)=>{
  if($(el).find('code').length)return;
  const text=$(el).text().replace(/\r\n/g,'\n');
  // Attribution/translation can change the header words, so the official transport identifier qualifies.
  if(!/\bKNHC\s+\d{6}\b|NWS National Hurricane Center|国家飓风中心|Centro Nacional de Huracanes/i.test(text))return;
  const out=$('<div></div>');
  for(const block of text.split(/\n[ \t]*\n+/)){
   if(!block.trim())continue;
   const lines=block.trim().split('\n');
   // Preserve fixed-column probability/forecast grids exactly; they have their own scroll viewport.
   const grid=lines.length>=2&&lines.filter(line=>/\d/.test(line)&&/\S+\s{2,}\S+\s{2,}\S+/.test(line)).length>=2;
   if(grid)out.append($('<pre class="bulletin-data"></pre>').text(block));
   else out.append($('<p></p>').text(block.replace(/\n[ \t]*/g,' ')));
  }
  $(el).replaceWith(out.children());
 });
 return sanitizeBody($.html());
}
