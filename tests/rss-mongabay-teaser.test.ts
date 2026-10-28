import assert from 'node:assert/strict';
import {test, after} from 'node:test';
import http from 'node:http';
import {isTeaser, fetchRss} from '@aihot/backend/sources/rss';
import {config} from '@aihot/backend/config';
const lead = 'A species recovery announcement with conservation context. '.repeat(28);
const teaser = `${lead}Its members will coordinate investments and support…This article was originally published on Mongabay`;

test('long Mongabay feed truncation before attribution remains a teaser', () => {
  assert.ok(teaser.length > 1200);
  assert.equal(isTeaser(teaser), true);
  assert.equal(isTeaser(teaser.replace('…', '...')), true);
});
test('complete articles, ordinary attribution, and existing length rules are retained', () => {
  assert.equal(isTeaser(`${lead}This article was originally published on Mongabay`), false);
  assert.equal(isTeaser(`${lead}The conservation initiative is complete.`), false);
  assert.equal(isTeaser(`${lead}Read more`), false);
  assert.equal(isTeaser('Short article excerpt. Read more'), true);
});
const previous = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
const server = http.createServer((req,res) => {
  const body = req.url === '/full' ? `${lead}The final complete paragraph.` : teaser;
  res.setHeader('content-type', 'application/rss+xml');
  res.end(`<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Mongabay</title><item><title>Species recovery</title><link>https://news.mongabay.com/example/</link><description>Publisher summary</description><content:encoded><![CDATA[<p>${body}</p>]]></content:encoded></item></channel></rss>`);
});
await new Promise<void>(resolve => server.listen(0,'127.0.0.1',()=>resolve()));
after(async () => {config.allowPrivateNetworkFetch=previous; await new Promise(resolve => server.close(resolve));});
const read = async (path: string) => (await fetchRss({id:'rss-mongabay',participation_mode:'editorial',config:{feedUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}${path}`}} as never)).candidates[0];
test('RSS teaser enters extraction queue instead of becoming confirmed body', async () => {
  const item=await read('/teaser');
  assert.equal(item.bodyStatus,'pending');
  assert.equal(item.bodyHtml,null);
  assert.equal(item.bodyText,null);
  assert.equal(item.excerpt,'Publisher summary');
});
test('full RSS body still bypasses extraction', async () => {
  const item=await read('/full');
  assert.equal(item.bodyStatus,'ok');
  assert.match(item.bodyText!,/final complete paragraph/);
});
