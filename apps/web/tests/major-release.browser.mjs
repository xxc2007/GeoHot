/** Local fixture-only regression; no database, model call or production writes. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync,writeFileSync,readdirSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const releases=JSON.parse(readFileSync(new URL('../../../industry/changelog.json',import.meta.url)));
// Exercise pinning after a future ordinary release and a mixed major/ordinary date.
const majorDate=releases.releases.find(r=>r.major).date;
releases.releases.push({date:'2026-10-25',time:'08:00',kind:'优化',title:'Fixture newer ordinary release',body:['Fixture only.']},{date:majorDate,time:'06:00',kind:'修复',title:'Fixture same-date ordinary release',body:['Fixture only.']});
releases.releases.sort((a,b)=>(b.date+'T'+b.time).localeCompare(a.date+'T'+a.time));
releases.latestVersion='2026-10-25T08:00';
const output=new URL('../../../.tmp/major-release/',import.meta.url);mkdirSync(output,{recursive:true});
const api=createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url?.startsWith('/api/site/changelog'))res.end(JSON.stringify(releases));else if(req.url?.startsWith('/api/site/meta'))res.end(JSON.stringify({changelogVersion:releases.latestVersion}));else{res.statusCode=503;res.end('{}');}});
await new Promise(resolve=>api.listen(8944,'127.0.0.1',resolve));
const server=spawn(process.execPath,['apps/web/server.ts'],{cwd:root,env:{...process.env,WEB_PORT:'8945',API_BASE_URL:'http://127.0.0.1:8944',SITE_URL:'http://127.0.0.1:8945/geohot',BASE_PATH:'/geohot',COLLECT_ENABLED:'false',MODEL_CALLS_ENABLED:'false',EMBEDDINGS_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
let serverLog='';server.stdout.on('data',data=>serverLog+=data);server.stderr.on('data',data=>serverLog+=data);
const base='http://127.0.0.1:8945/geohot/changelog';
let browser;
const results=[];
try{
 for(let attempt=0;attempt<60;attempt++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));if(attempt===59)throw Error(serverLog);}
 browser=await chromium.launch({channel:'chrome',headless:true});
 for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:1000}}),errors=[],requests=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
  await page.goto(base,{waitUntil:'networkidle'});
  const article=page.locator('.major-release'),canvas=article.locator('canvas');
  assert.equal(await article.count(),1);
  assert.equal(await page.evaluate(()=>{const title=document.querySelector('h1'),major=document.querySelector('.major-release'),ordinary=document.querySelector('[id^="d-"] .card:not(.major-release)');return !!title&&!!major&&!!ordinary&&!!(title.compareDocumentPosition(major)&Node.DOCUMENT_POSITION_FOLLOWING)&&!!(major.compareDocumentPosition(ordinary)&Node.DOCUMENT_POSITION_FOLLOWING);}),true,'major follows h1 and precedes ordinary logs');
  assert.equal(await page.locator('#d-'+releases.releases.find(r=>r.major).date).count(),1,'pinned date anchor survives once');
  const total=await page.locator('nav[aria-label="按月份"] a span').allTextContents();
  assert.equal(total.reduce((n,s)=>n+parseInt(s),0),releases.releases.length,'month statistics include pinned item once');
  await canvas.scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('.major-release canvas').dataset.running==='true');
  await article.getByRole('button',{name:'暂停动态',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.major-release canvas').dataset.running==='false');
  const still=await canvas.screenshot();await page.waitForTimeout(160);assert.ok((await canvas.screenshot()).equals(still),'paused canvas retains identical pixels');
  await canvas.focus();await page.keyboard.press('ArrowLeft');assert.ok(!(await canvas.screenshot()).equals(still),'keyboard changes actual ridge pixels');
  const box=await canvas.boundingBox();await page.mouse.click(box.x+box.width*.88,box.y+box.height*.35);assert.ok(!(await canvas.screenshot()).equals(still),'pointer changes actual ridge pixels');
  await article.getByRole('button',{name:'重播 / 复位',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.major-release canvas').dataset.running==='true');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal(await canvas.getAttribute('data-running'),'false','simulated background visibility event stops frame loop');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{value:false,configurable:true});document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(()=>document.querySelector('.major-release canvas').dataset.running==='true');
  const stations=article.getByRole('tablist',{name:'消息的五个阶段'});
  await stations.getByRole('tab',{name:'03 归组'}).click();assert.match(await article.locator('.major-stage-panel').innerText(),/把来龙去脉串起来/);
  await page.keyboard.press('End');assert.equal(await stations.getByRole('tab',{selected:true}).innerText(),'05\n接入');
  await page.keyboard.press('Home');assert.equal(await stations.getByRole('tab',{selected:true}).innerText(),'01\n采集');
  await article.getByRole('button',{name:'优化前 54,210 B'}).click();assert.match(await article.locator('.major-measure-result').innerText(),/54,210/);
  await article.getByRole('button',{name:'优化后 20,027 B'}).click();assert.match(await article.locator('.major-measure-result').innerText(),/20,027/);
  await article.getByRole('tab',{name:'分批浏览',exact:true}).click();assert.equal(await article.locator('.major-batch-dots [data-loaded=true]').count(),12);
  await article.getByRole('button',{name:'演示继续浏览',exact:true}).click();assert.equal(await article.locator('.major-batch-dots [data-loaded=true]').count(),52);
  await page.locator('footer').last().scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('.major-release canvas').dataset.running==='false');
  await article.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal overflow');
  await page.screenshot({path:fileURLToPath(new URL(`major-${width}.png`,output)),fullPage:true});
  await page.goto(base+'?kind='+encodeURIComponent('优化'),{waitUntil:'networkidle'});assert.equal(await page.locator('.major-release').count(),0,'nonmatching kind hides pinned major');
  const filtered=releases.releases.filter(r=>r.kind==='优化');
  const filteredMonths=await page.locator('nav[aria-label="按月份"] a span').allTextContents();assert.equal(filteredMonths.reduce((n,s)=>n+parseInt(s),0),filtered.length);
  assert.equal(requests.some(url=>!/^(http:\/\/127\.0\.0\.1:8945|data:)/.test(url)),false,'visual interaction adds no external requests');
  assert.deepEqual(errors,[]);results.push(`${width}px: pin/order/anchor/counts/filter, canvas pause/keyboard/pointer/replay/visibility/offscreen, workflow tabs, payload/batch controls, overflow OK`);await page.close();
 }
 for(const mode of ['reduced','no-js']){
  const page=await browser.newPage({viewport:{width:390,height:900},reducedMotion:mode==='reduced'?'reduce':'no-preference',javaScriptEnabled:mode!=='no-js',hasTouch:mode==='reduced'});
  await page.goto(base,{waitUntil:'networkidle'});
  if(mode==='reduced'){await page.waitForFunction(()=>document.querySelector('.major-release canvas').dataset.painted==='true');assert.equal(await page.locator('.major-release canvas').getAttribute('data-running'),'false');assert.equal(await page.getByRole('button',{name:'已减少动态'}).isDisabled(),true);const shot=await page.locator('.major-release canvas').screenshot();await page.waitForTimeout(150);assert.ok((await page.locator('.major-release canvas').screenshot()).equals(shot));const bounds=await page.locator('.major-release canvas').boundingBox();await page.touchscreen.tap(bounds.x+bounds.width*.9,bounds.y+bounds.height*.3);assert.ok(!(await page.locator('.major-release canvas').screenshot()).equals(shot),'touch changes ridge even when automatic motion is reduced');}
  else{assert.equal(await page.locator('.major-terrain-fallback').isVisible(),true);assert.match(await page.locator('.major-release').innerText(),/每一条线索保留来源入口/);}
  results.push(`${mode}: static rendering and content fallback OK`);await page.close();
 }
 const assets=readdirSync(new URL('../../../apps/web/build/client/assets/',import.meta.url)).filter(name=>/^changelog-.*\.(js|css)$/.test(name));
 const sizes=assets.map(name=>{const bytes=readFileSync(new URL('../../../apps/web/build/client/assets/'+name,import.meta.url));return {name,raw:bytes.length,gzip:gzipSync(bytes).length};});
 writeFileSync(new URL('results.json',output),JSON.stringify({results,sizes},null,2));console.log(JSON.stringify({results,sizes},null,2));
}catch(error){console.error(serverLog);throw error;}finally{await browser?.close();server.kill();await new Promise(resolve=>api.close(resolve));}
