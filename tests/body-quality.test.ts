import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { dedupeConsecutiveFigures, isNhcProseBulletin, translationTextDefect, classifyBodyQuality, BODY_QUALITY_RULE_VERSION } from "../packages/backend/src/content/body-quality.ts";
import { stripReaderChrome, stripConsentWall } from "../packages/backend/src/lib/text.ts";

test("identical adjacent images and captions collapse while different captions and separated repetitions stay", () => {
  const f = '<figure><img src="https://example.org/a.jpg"><figcaption>Coffee</figcaption></figure>';
  assert.equal(dedupeConsecutiveFigures(`<p>News</p>${f}${f}${f}<p>End</p>`), `<p>News</p>${f}<p>End</p>`);
  assert.equal(dedupeConsecutiveFigures(`${f}<p>Different discussion</p>${f}`), `${f}<p>Different discussion</p>${f}`);
  const other = f.replace("Coffee", "A different view");
  assert.equal(dedupeConsecutiveFigures(f + other), f + other);
});
test("Spanish and English NHC prose qualify without treating arbitrary code or other hosts as prose", () => {
  const url = "https://www.nhc.noaa.gov/text/refresh/MIATDSEP2+shtml/260239.shtml";
  assert.equal(isNhcProseBulletin(url, "WTPZ52 KNHC 260239\nCentro Nacional de Huracanes del SNM Miami FL"), true);
  assert.equal(isNhcProseBulletin(url, "WTPZ52 KNHC 260239\nNWS National Hurricane Center Miami FL"), true);
  assert.equal(isNhcProseBulletin("https://example.com/", "WTPZ52 KNHC 260239\nNWS National Hurricane Center"), false);
  assert.equal(isNhcProseBulletin(url, "const code = 3;"), false);
});
test("damaged text and leaked translation tokens fail; ordinary Unicode, data tables and units remain valid", () => {
  for (const text of ["中文\uFFFD", "中文\u0001", "中文⟦G0⟧", "的".repeat(30), "\\u4e2d\\u6587\\u6d4b\\u8bd5"]) assert.ok(translationTextDefect(text));
  for (const text of ["预计风速55 kt，坐标15.0N、104.7W。", "Discusión Número 19", "\n——————\n000 WTPZ52 KNHC 260239"]) assert.equal(translationTextDefect(text), null);
});

// --- Fixtures (sanitized) ---

const FIXTURE_CGTN_CONSENT_WALL = {
  url: "https://news.cgtn.com/news/2026-11-16/some-article/index.html",
  html: `<html><body><div class="consent">我们使用 Cookie 来改善您的浏览体验。继续浏览即表示您同意我们使用 Cookie。查看隐私政策。</div><article>真正的正文在这里，大约有一百多字，讲的是地理热点事件。</article></body></html>`,
  text: "我们使用 Cookie 来改善您的浏览体验。继续浏览即表示您同意我们使用 Cookie。查看隐私政策。真正的正文在这里，大约有一百多字，讲的是地理热点事件。",
};

const FIXTURE_STATS_READER_CHROME = {
  url: "https://www.stats.gov.cn/sj/zxfb/202611/t20261116_12345.html",
  text: "2026-11-16 10:30:00 | 字号：大 中 小 | 打印 | 关闭 2026年1-10月份，全国规模以上工业增加值同比增长5.8%。分三大门类看，采矿业增加值增长2.1%，制造业增长6.2%。 2026-11-16 10:30:00 | 字号：大 中 小 | 打印",
};

const FIXTURE_NORMAL_PRIVACY_ARTICLE = {
  url: "https://example.com/news/2026-11/privacy-regulation",
  text: "欧盟新隐私法规对新闻网站的影响 2026年11月，欧盟正式实施新版隐私保护法规，要求所有新闻网站明确告知用户 Cookie 的使用范围。本文分析了该法规对欧洲媒体行业的实际影响，包括合规成本、用户体验变化和广告收入波动。 据报道，超过七成的新闻网站已经在首页添加了 Cookie 同意弹窗，但只有不到三成提供了拒绝全部的选项。",
  title: "欧盟新隐私法规对新闻网站的影响",
};

const FIXTURE_GOV_CN_NEWS = {
  url: "https://www.gov.cn/yaowen/202611/content_123456.htm",
  text: "国务院部署今冬明春农田水利建设 新华社北京11月15日电 国务院办公厅近日印发关于切实做好今冬明春农田水利建设的通知，要求各地抢抓施工窗口期，加快推进重大水利工程建设，确保明年春耕生产用水需求。 通知强调，要聚焦水利薄弱环节，补齐防汛抗旱短板，提升水资源集约节约利用水平。",
  title: "国务院部署今冬明春农田水利建设",
};

const FIXTURE_SHORT_BULLETIN = {
  url: "https://example.gov.cn/bulletin/2026-11-16-earthquake",
  text: "中国地震台网正式测定：11月16日10时23分在云南德宏州盈江县发生5.1级地震，震源深度10千米。",
};

const FIXTURE_TEMPLATE_SHELL = {
  url: "https://example.com/article/123",
  text: "{{article.title}} {{article.author}} 作者信息 + {{article.date}} {{javascript:window.custom_author_cn_index=0;}} {{article.zuoZhe_CN}} PDF(8989 KB) 正文内容占位。",
};

describe("classifyBodyQuality", () => {
  test("ruleVersion is stamped on every result", () => {
    const r = classifyBodyQuality(FIXTURE_GOV_CN_NEWS.url, "", FIXTURE_GOV_CN_NEWS.text, { title: FIXTURE_GOV_CN_NEWS.title });
    assert.equal(r.ruleVersion, BODY_QUALITY_RULE_VERSION);
  });

  test("CGTN consent wall: leading consent block with little real body → defect consent-wall-only", () => {
    const r = classifyBodyQuality(FIXTURE_CGTN_CONSENT_WALL.url, FIXTURE_CGTN_CONSENT_WALL.html, FIXTURE_CGTN_CONSENT_WALL.text);
    assert.equal(r.status, "defect");
    assert.ok(r.reasons.includes("consent-wall-only"), `expected consent-wall-only, got ${r.reasons}`);
  });

  test("normal article ABOUT Cookie regulation: NOT a false positive", () => {
    const r = classifyBodyQuality(FIXTURE_NORMAL_PRIVACY_ARTICLE.url, "", FIXTURE_NORMAL_PRIVACY_ARTICLE.text, { title: FIXTURE_NORMAL_PRIVACY_ARTICLE.title });
    assert.equal(r.status, "ok", `unexpected defect: ${r.reasons.join(", ")}`);
  });

  test("Chinese government news: passes", () => {
    const r = classifyBodyQuality(FIXTURE_GOV_CN_NEWS.url, "", FIXTURE_GOV_CN_NEWS.text, { title: FIXTURE_GOV_CN_NEWS.title });
    assert.equal(r.status, "ok", `unexpected defect: ${r.reasons.join(", ")}`);
  });

  test("short earthquake bulletin: NOT killed by consent-wall or template-shell; passes as a structured bulletin", () => {
    const r = classifyBodyQuality(FIXTURE_SHORT_BULLETIN.url, "", FIXTURE_SHORT_BULLETIN.text);
    assert.ok(!r.reasons.includes("consent-wall-only"));
    assert.ok(!r.reasons.includes("template-shell"));
    assert.ok(!r.reasons.includes("title-body-mismatch"));
    assert.equal(r.status, "ok", `structured short bulletin should pass, got ${r.reasons.join(",")}`);
  });

  test("NHC short advisory: passes as a structured short bulletin", () => {
    const text = "WTPZ52 KNHC 160239\nNWS National Hurricane Center\nTropical Storm Alert: winds 55 kt near 15.0N 104.7W, moving NW. Warning in effect.";
    const r = classifyBodyQuality("https://www.nhc.noaa.gov/text/refresh/MIATDSEP2+shtml/260239.shtml", "", text);
    assert.equal(r.status, "ok", `NHC advisory should pass, got ${r.reasons.join(",")}`);
  });

  test("short Cookie wall (<80 chars): still hard defect, NOT exempt", () => {
    const text = "我们使用 Cookie。继续浏览即表示您同意。查看隐私政策。同意并继续。";
    const r = classifyBodyQuality("https://example.com/cookie", "", text);
    assert.ok(r.reasons.includes("consent-wall-only"), `short cookie wall must stay defect, got ${r.reasons.join(",")}`);
    assert.equal(r.status, "defect");
  });

  test("short template shell (<80 chars): still hard defect, NOT exempt", () => {
    const text = "{{article.title}} {{article.author}} {{article.date}}";
    const r = classifyBodyQuality("https://example.com/tpl", "", text);
    assert.ok(r.reasons.includes("template-shell"), `short template shell must stay defect, got ${r.reasons.join(",")}`);
    assert.equal(r.status, "defect");
  });

  test("10-char placeholder: hard defect too-short, not exempt", () => {
    const r = classifyBodyQuality("https://example.com/placeholder", "", "待更新。");
    assert.ok(r.reasons.includes("too-short"), `10-char placeholder must be defect, got ${r.reasons.join(",")}`);
    assert.equal(r.status, "defect");
  });

  test("template shell: 3+ {{placeholders}} → defect template-shell", () => {
    const r = classifyBodyQuality(FIXTURE_TEMPLATE_SHELL.url, "", FIXTURE_TEMPLATE_SHELL.text);
    assert.equal(r.status, "defect");
    assert.ok(r.reasons.includes("template-shell"), `expected template-shell, got ${r.reasons}`);
  });
});

describe("stripReaderChrome", () => {
  test("removes reader bar (timestamp | 字号 | 打印) and keeps article body", () => {
    const cleaned = stripReaderChrome(FIXTURE_STATS_READER_CHROME.text);
    assert.ok(!cleaned.includes("字号"), "reader chrome should be stripped");
    assert.ok(!cleaned.includes("打印"), "print button should be stripped");
    assert.ok(cleaned.includes("规模以上工业增加值"), "real body must survive");
    assert.ok(cleaned.includes("采矿业"), "real body must survive");
  });
});

describe("stripConsentWall", () => {
  test("removes leading consent block and keeps real article", () => {
    const text = "我们使用 Cookie 来改善您的浏览体验。继续浏览即表示您同意。这是真正的新闻正文，讲的是地理热点事件。";
    const cleaned = stripConsentWall(text);
    assert.ok(!cleaned.includes("Cookie 来改善"), "consent block should be stripped");
    assert.ok(cleaned.includes("真正的新闻正文"), "real article must survive");
  });
});

describe("NBS reader chrome contamination", () => {
  const nbsUrl = "https://www.stats.gov.cn/sj/zxfb/202611/t20261117_1234567.html";

  test("body containing 'Aa / 字体：小 中 大' reader controls is defect, not silently stripped", () => {
    const html = "<p>Aa / 字体：小 中 大</p><p>2026年11月17日10时30分发布规模以上工业增加值同比增长5.8%。</p>";
    const text = "Aa / 字体：小 中 大\n2026年11月17日10时30分发布规模以上工业增加值同比增长5.8%。";
    const r = classifyBodyQuality(nbsUrl, html, text, { title: "规模以上工业增加值同比增长5.8%" });
    assert.equal(r.status, "defect", `NBS reader chrome must be defect, got: ${JSON.stringify(r)}`);
    assert.ok(r.reasons.includes("reader-chrome-contamination"), `expected reader-chrome-contamination, got: ${r.reasons}`);
  });

  test("body with '字体：小 中 大' variant (no Aa) is also defect", () => {
    const html = "<p>字体：小 中 大</p><p>经初步核算，前三季度国内生产总值同比增长5.2%。</p>";
    const text = "字体：小 中 大\n经初步核算，前三季度国内生产总值同比增长5.2%。";
    const r = classifyBodyQuality(nbsUrl, html, text, { title: "前三季度国内生产总值同比增长5.2%" });
    assert.equal(r.status, "defect", `'字体：小 中 大' must be defect, got: ${JSON.stringify(r)}`);
  });

  test("short bulletin exemption does NOT cover reader chrome contamination", () => {
    // Even if the body is short and looks structured, reader chrome means extraction is broken.
    const html = "<p>Aa / 字体：小 中 大 | 打印 | 关闭</p>";
    const text = "Aa / 字体：小 中 大 | 打印 | 关闭";
    const r = classifyBodyQuality(nbsUrl, html, text, { title: "国家统计局发布数据" });
    assert.equal(r.status, "defect", "short bulletin exemption must not override reader chrome defect");
    assert.ok(r.reasons.includes("reader-chrome-contamination"));
  });

  test("normal article without reader chrome stays ok", () => {
    const html = "<p>经初步核算，前三季度国内生产总值105万亿元，按不变价格计算，同比增长5.2%。分季度看，一季度增长5.3%，二季度增长5.1%，三季度增长5.2%。</p>";
    const text = "经初步核算，前三季度国内生产总值105万亿元，按不变价格计算，同比增长5.2%。分季度看，一季度增长5.3%，二季度增长5.1%，三季度增长5.2%。";
    const r = classifyBodyQuality(nbsUrl, html, text, { title: "前三季度国内生产总值同比增长5.2%" });
    assert.equal(r.status, "ok", `normal article must pass, got: ${JSON.stringify(r)}`);
  });
});
