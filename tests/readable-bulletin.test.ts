import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as cheerio from 'cheerio';
import {readableBulletin} from '../packages/backend/src/content/readable-bulletin.ts';
const url='https://www.nhc.noaa.gov/text/refresh/MIATCDEP2.shtml';
test('official prose wraps as paragraphs while fixed data columns remain literal',()=>{
 const text='WTPZ42 KNHC 281433\nNWS National Hurricane Center Miami FL\n\nA long discussion of the storm\ncontinues here with measured wind 35 kt.\n\nFORECAST POSITIONS\n12H  15.0N  100.0W  35 KT\n24H  16.0N  101.0W  40 KT\n\nFINAL paragraph.';
 const out=readableBulletin(url,'<pre>'+text+'</pre>'),$=cheerio.load(out);
 assert.ok($('p').text().includes('storm continues here'));assert.equal($('pre.bulletin-data').length,1);assert.ok($('pre').text().includes('15.0N  100.0W'));assert.ok($('p').last().text().includes('FINAL'));
 assert.deepEqual(out.match(/\d+(?:\.\d+)?/g),text.match(/\d+(?:\.\d+)?/g));
});
test('translated official prose gets the same layout without treating ordinary source code as prose',()=>{
 const input='<pre>KNHC 281433\n\n国家飓风中心\n\n热带风暴讨论\n最后一段。</pre>';
 assert.equal(cheerio.load(readableBulletin(url,input))('pre').length,0);
 assert.equal(readableBulletin('https://example.com/code',input),input);
 assert.ok(readableBulletin(url,'<pre><code>NWS National Hurricane Center code example</code></pre>').includes('<code>'));
});
