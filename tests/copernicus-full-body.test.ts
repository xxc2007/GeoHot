import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as cheerio from 'cheerio';
import {readable} from '@aihot/backend/content/extract';
import {originalBodyDefect} from '@aihot/backend/content/body-quality';
const url='https://nhess.copernicus.org/articles/26/5261/2026/';
const refs='Ata, M. Y.: Citation, https://doi.org/10.1/one, 2007. Behrens, J.: Citation, https://doi.org/10.1/two, 2020. Author, A.: Citation, https://doi.org/10.1/three, 2021.';
test('a references-only extraction cannot masquerade as the full scientific article',()=>{
 assert.equal(originalBodyDefect(url,'<h2>References</h2><p>'+refs+'</p>',refs),'source:references-only');
 assert.equal(originalBodyDefect('https://doi.org/10.5194/nhess-26-5261-2026','<p>'+refs+'</p>',refs),'source:references-only');
 assert.equal(originalBodyDefect(url,'<h2>Abstract</h2><p>Full narrative</p><h2>References</h2>', 'Full narrative. '+refs),null);
});
test('structured Copernicus sections retain narrative, figures, equations, bibliography and PDF links',()=>{
 const html=`<html><body><div class="article"><div id="abstract"><div class="h1">Abstract</div><p>${'A complete scientific abstract. '.repeat(30)}</p></div>
 <div id="section1"><div class="h1"><span>1</span> Introduction</div><p>FIRST NARRATIVE PARAGRAPH.</p><div class="fig"><img src="thumb.png" data-webversion="figure-web.png"><div class="caption"><p>Full figure caption.</p></div></div>
 <p>Equation <span class="inline-formula"><math xmlns="http://www.w3.org/1998/Math/MathML"><mfrac><mi>a</mi><mi>b</mi></mfrac></math><span><svg xmlns="http://www.w3.org/2000/svg"><image xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="equation.svg" src="equation.png"></image></svg></span></span></p></div>
 <div id="section2"><div class="h1">Conclusions</div><p>FINAL NARRATIVE PARAGRAPH.</p></div>
 <div id="section3"><div class="h1">References</div><p>${refs}</p></div></div><a href="nhess-26-5261-2026.pdf">Full PDF</a><script>BAD_SCRIPT()</script></body></html>`;
 const body=readable(html,url);assert.ok(body);const $=cheerio.load(body.html);
 for(const text of ['Abstract','FIRST NARRATIVE PARAGRAPH','FINAL NARRATIVE PARAGRAPH','References','Full figure caption'])assert.ok(body.text.includes(text),text);
 assert.equal($('figure').length,1);assert.equal($('img[src$="figure-web.png"]').length,1);assert.equal($('img[src$="equation.svg"]').length,1,body.html);
 assert.equal($('a[href$="nhess-26-5261-2026.pdf"]').length,1);assert.equal($('script').length,0);assert.equal(originalBodyDefect(url,body.html,body.text),null);
});
test('an explicit Mongabay feed truncation is not complete merely because it is long',()=>{
 assert.equal(originalBodyDefect('https://news.mongabay.com/story','', 'Source prose. '.repeat(100)+'…This article was originally published on Mongabay'),'source:feed-teaser');
 assert.equal(originalBodyDefect('https://example.com/story','', 'A complete story with a quoted pause… and its final paragraph.'),null);
});

test('Mongabay attribution quoted inside complete prose is not a truncation signal',()=>{
 const text='Narrative …This article was originally published on Mongabay. Further complete paragraphs and the final conclusion.';
 assert.equal(originalBodyDefect('https://news.mongabay.com/story','',text),null);
 assert.equal(originalBodyDefect('https://example.com/story','', 'Quoted …This article was originally published on Mongabay'),null);
});
