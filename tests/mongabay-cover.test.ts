import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import {readable} from '@aihot/backend/content/extract';

const cover='https://imgs.mongabay.com/wp-content/uploads/fixture-hornbill.jpg';
const paragraphs=Array.from({length:14},(_,i)=>`<p>Paragraph ${i}: ${'Species recovery needs coordinated conservation funding and scientific evidence. '.repeat(4)}<a href="https://example.org/evidence/${i}">Evidence ${i}</a></p>`).join('');
const page=(image=cover)=>`<html><head><title>Species recovery</title></head><body><div class="article-cover-image__bg" style="--cover-image-large:url('${image}');"></div><article><h1>Species recovery</h1><p><img src="https://secure.gravatar.com/avatar/fixture?s=32"></p>${paragraphs}</article></body></html>`;

test('CSS article cover and every prose paragraph/link survive Mongabay extraction',()=>{
  const got=readable(page(),'https://news.mongabay.com/short-article/fixture/');assert.ok(got);
  const $=cheerio.load(got.html);
  assert.deepEqual(got.images.map(i=>i.url),[cover]);
  for(let i=0;i<14;i++){assert.ok(got.text.includes(`Paragraph ${i}:`));assert.equal($(`a[href="https://example.org/evidence/${i}"]`).length,1);}
  assert.doesNotMatch(got.html,/gravatar\.com/);
});
test('CSS cover recovery is restricted to this publisher',()=>{
  const got=readable(page(),'https://example.org/fixture/');assert.ok(got);
  assert.ok(!got.images.some(i=>i.url===cover));
});
test('cover recovery refuses HTTP, credentials, foreign hosts and unexpected ports',()=>{
  for(const src of ['http://imgs.mongabay.com/a.jpg','https://evil.example/a.jpg','https://user:secret@imgs.mongabay.com/a.jpg','https://imgs.mongabay.com:8443/a.jpg']){
    const got=readable(page(src),'https://news.mongabay.com/fixture/');assert.ok(got);
    assert.equal(got.images.length,0);
  }
});
