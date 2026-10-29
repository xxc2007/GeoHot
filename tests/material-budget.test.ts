import assert from "node:assert/strict";
import { test } from "node:test";
import { materialBodyChars, copyBodyChars } from "../packages/backend/src/editorial/material-budget.ts";

test("wide-window analysis budgets retain registry defaults for unverified doors", () => {
  assert.equal(materialBodyChars('default'), 7000);
  assert.equal(copyBodyChars('default'), 60000);
  for (const model of ['minimax-code-m3.1-flash', 'codearts-deepseek-v4.1-flash', 'qoder-cn-dfmodel']) {
    assert.equal(materialBodyChars(model), 60000);
    assert.equal(copyBodyChars(model), 120000);
  }
});
