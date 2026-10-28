import assert from "node:assert/strict";
import { test } from "node:test";
import * as cheerio from "cheerio";
import { readable } from "@aihot/backend/content/extract";
import http from "node:http";
import { config } from "@aihot/backend/config";
import { fetchRss } from "@aihot/backend/sources/rss";

test("Ecology & Society keeps the full article, figure captions and PDF appendices", () => {
  const page = `<html><head><title>Research</title></head><body><article>
    <div class="article__content"><div class="article__text"><h2>ABSTRACT</h2>
    <p>${"Research findings. ".repeat(4000)}</p><h2>LITERATURE CITED</h2><p>FINAL REFERENCE.</p></div>
    <div class="article__figures"><div class="article__figure"><figure><h5>Fig. 1</h5>
      <div class="article__figure-preview"><img src="figure1.png"><div class="article__figure-full">
      <div id="article_attachment"><h1>Fig. 1. Original caption.</h1><img src="figure1.png"></div>
      </div></div></figure></div>
      <div class="article__figure"><figure><h5><a href="appendix1.pdf">Appendix 1<img src="/Download.svg"></a></h5></figure></div>
    </div></div></article></body></html>`;
  const got = readable(page, "https://ecologyandsociety.org/vol31/iss4/art17/");
  assert.ok(got);
  const $ = cheerio.load(got.html);
  assert.ok($.root().text().includes("FINAL REFERENCE."));
  assert.equal($("img").length, 1, "keep the figure once, without preview copies and UI icons");
  assert.equal($("img").attr("src"), "https://ecologyandsociety.org/vol31/iss4/art17/figure1.png?geohot=original");
  assert.ok($("figcaption").text().includes("Original caption."));
  assert.equal($("a").last().attr("href"), "https://ecologyandsociety.org/vol31/iss4/art17/appendix1.pdf");
  assert.equal($(".article__text").length, 0);
  assert.ok(got.text.length > 64000);
});

test("the journal feed queues article extraction instead of confirming an attachment-free feed body", async () => {
  const old = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/rss+xml");
    res.end(`<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Research</title>
      <item><title>Article</title><link>https://ecologyandsociety.org/vol31/iss4/art17/</link>
      <description>Abstract</description><content:encoded><![CDATA[<p>${"Full text without attachments. ".repeat(30)}</p>]]></content:encoded></item></channel></rss>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const source = { id: "rss-ecsociety", participation_mode: "editorial", config: { feedUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/` } };
    const [candidate] = (await fetchRss(source as never)).candidates;
    assert.equal(candidate!.bodyStatus, "pending");
    assert.equal(candidate!.bodyText, null);
    assert.equal(candidate!.excerpt, "Abstract");
    const [other] = (await fetchRss({ ...source, id: "other-journal" } as never)).candidates;
    assert.equal(other!.bodyStatus, "ok", "other publishers keep their existing feed behavior");
  } finally {
    config.allowPrivateNetworkFetch = old;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
