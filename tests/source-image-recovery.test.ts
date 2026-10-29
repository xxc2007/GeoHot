import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSourceImageUrl } from "../packages/backend/src/media/source-image-url.ts";
import { fetchImageOriginal } from "../packages/backend/src/media/images.ts";

test("only the known DW rendition placeholder is normalised", () => {
  assert.equal(normalizeSourceImageUrl('https://static.dw.com/image/123_${formatId}.jpg'), 'https://static.dw.com/image/123_605.jpg');
  for (const url of ['https://static.dw.com.evil/image/123_${formatId}.jpg', 'http://static.dw.com/image/123_${formatId}.jpg', 'https://static.dw.com/other/123_${formatId}.jpg', 'https://static.dw.com/image/123_960.jpg']) assert.equal(normalizeSourceImageUrl(url), url);
});

test("a publisher's empty 200 image gets one bounded cache retry; other failures do not", async () => {
  const urls: string[] = [];
  const fetcher = async (url: string) => {
    urls.push(url);
    const body = urls.length === 1 ? Buffer.alloc(0) : Buffer.from('image fixture');
    return { status: 200, url, headers: new Headers(), body, text: () => body.toString() };
  };
  const result = await fetchImageOriginal('https://www.ecologyandsociety.org/vol31/iss4/art1/figure1.png', fetcher);
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[1]!).pathname, new URL(urls[0]!).pathname);
  assert.ok(new URL(urls[1]!).searchParams.has('geohot_retry'));
  assert.ok(result.body.length > 0);
  urls.length = 0;
  await fetchImageOriginal('https://other.example/figure.png', fetcher);
  assert.equal(urls.length, 1);
});
