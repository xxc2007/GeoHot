import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupeConsecutiveFigures, isNhcProseBulletin, translationTextDefect } from "../packages/backend/src/content/body-quality.ts";

test("identical adjacent images and captions collapse while different captions and separated repetitions stay", () => {
  const f='<figure><img src="https://example.org/a.jpg"><figcaption>Coffee</figcaption></figure>';
  assert.equal(dedupeConsecutiveFigures(`<p>News</p>${f}${f}${f}<p>End</p>`),`<p>News</p>${f}<p>End</p>`);
  assert.equal(dedupeConsecutiveFigures(`${f}<p>Different discussion</p>${f}`),`${f}<p>Different discussion</p>${f}`);
  const other=f.replace('Coffee','A different view');
  assert.equal(dedupeConsecutiveFigures(f+other),f+other);
});
test("Spanish and English NHC prose qualify without treating arbitrary code or other hosts as prose", () => {
  const url='https://www.nhc.noaa.gov/text/refresh/MIATDSEP2+shtml/260239.shtml';
  assert.equal(isNhcProseBulletin(url,'WTPZ52 KNHC 260239\nCentro Nacional de Huracanes del SNM Miami FL'),true);
  assert.equal(isNhcProseBulletin(url,'WTPZ52 KNHC 260239\nNWS National Hurricane Center Miami FL'),true);
  assert.equal(isNhcProseBulletin('https://example.com/','WTPZ52 KNHC 260239\nNWS National Hurricane Center'),false);
  assert.equal(isNhcProseBulletin(url,'const code = 3;'),false);
});
test("damaged text and leaked translation tokens fail; ordinary Unicode, data tables and units remain valid", () => {
  for(const text of ['中文\uFFFD','中文\u0001','中文⟦G0⟧','的'.repeat(30),'\\u4e2d\\u6587\\u6d4b\\u8bd5']) assert.ok(translationTextDefect(text));
  for(const text of ['预计风速55 kt，坐标15.0N、104.7W。','Discusión Número 19','\n——————\n000 WTPZ52 KNHC 260239']) assert.equal(translationTextDefect(text),null);
});
