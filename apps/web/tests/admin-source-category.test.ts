// 信源表单新增的「默认分类」那一栏，两组不变量（纯单元测试：读分类表与两份路由源码，
// 不起服务、不连数据库、不写任何文件）：
//   1. 选项就是 taxonomy 的真 key（CATEGORY_KEYS）配人话标签（CATEGORY_LABELS）——
//      select 里没有自由文本，拼不出一个后端 isCategoryKey 会 400 的 key；
//   2. 空一直是一等选项：编辑页从已保存值初始化、空在 patch 里落成 null（后端 null 表示清除）；
//      新建页默认空、绝不预选 —— 预选等于用惯性替编辑做了判断。
// 空串不能原样发出去：CreateSchema 与 EDITABLE 都只认真 key 或 null，"" 会被 400 拒掉。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CATEGORY_KEYS, CATEGORY_LABELS, isCategoryKey } from "@aihot/contracts/taxonomy";

const ROUTES = path.resolve(import.meta.dirname, "../app/routes/admin");
const edit = readFileSync(path.join(ROUTES, "source.tsx"), "utf8");
const create = readFileSync(path.join(ROUTES, "source-new.tsx"), "utf8");

// 两个屏幕共用的选项表达式：值是真 key，标签查分类表。
const OPTIONS = "CATEGORY_KEYS.map((k) => <option key={k} value={k}>{CATEGORY_LABELS[k]}</option>)";

test("选项表就是 taxonomy：每个 key 一个人话标签，key 不重复，标签不拿 key 顶替", () => {
  // 精确钉住条数：2026-10-03 把「地理信息技术」与「地理信息系统」并成一个区域后是九个，同一天晚些时候
  // 站长要求删掉「野外与考察」与「观点与解读」，于是是七个（这里原来写的是 `>= 10`，合并当天就红了
  // ——计数就该写成等于，红的时候才有人看一眼）。
  assert.equal(CATEGORY_KEYS.length, 7, "本站七个分类（industry/taxonomy.ts）都该在列表里");
  assert.equal(new Set(CATEGORY_KEYS).size, CATEGORY_KEYS.length, "不能有重复的 key");
  assert.deepEqual(Object.keys(CATEGORY_LABELS).sort(), [...CATEGORY_KEYS].sort(), "每个 key 恰好一个标签");
  for (const key of CATEGORY_KEYS) {
    assert.ok(isCategoryKey(key));
    const label = CATEGORY_LABELS[key];
    assert.ok(label.length > 0 && label !== key, `${key} 的标签要是人能读的，不是 key 本身`);
  }
});

test("编辑页：default_category 进类型、进初值、进 patch；空落成 null；选项来自分类表", () => {
  assert.match(edit, /import \{ CATEGORY_KEYS, CATEGORY_LABELS \} from "@aihot\/contracts\/taxonomy";/);
  assert.match(edit, /interface Source \{[\s\S]*?\n  default_category: string \| null;/, "Source 类型要带上这个字段");
  assert.match(edit, /Pick<Source, [^>]*"default_category">/, "Draft 要拾取它，表单才管得着");
  assert.match(edit, /default_category: s\.default_category,/, "初值来自已保存的信源");
  assert.match(edit, /default_category: draft\.default_category \|\| null,/, "空串必须在 patch 里落成 null");
  assert.ok(edit.includes(OPTIONS), "选项来自 CATEGORY_KEYS×CATEGORY_LABELS，没有自由文本");
  assert.match(edit, /<option value="">不设<\/option>/, "要留一个可清空的空选项");
});

test("新建页：默认空、不预选任何分类；发出前空串同样落成 null", () => {
  assert.match(create, /import \{ CATEGORY_KEYS, CATEGORY_LABELS \} from "@aihot\/contracts\/taxonomy";/);
  assert.match(create, /default_category: ""/, "默认空 —— 预选就是用惯性替编辑做判断");
  assert.match(create, /default_category: form\.default_category \|\| null,/, "空串必须在发请求前落成 null");
  assert.ok(create.includes(OPTIONS), "选项来自 CATEGORY_KEYS×CATEGORY_LABELS");
  assert.match(create, /<option value="">不设<\/option>/, "空选项与编辑页一致");
});
