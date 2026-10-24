import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceErrorMessage } from "../packages/backend/src/sources/errors.ts";
test("source failures keep safe nested transport codes without copying secret-bearing cause messages", () => {
  const inner = Object.assign(new Error("proxy https://private:secret@example.org"),{code:"UND_ERR_CONNECT_TIMEOUT"});
  assert.equal(sourceErrorMessage(new Error("fetch failed",{cause:inner})),"fetch failed [UND_ERR_CONNECT_TIMEOUT]");
  assert.equal(sourceErrorMessage(new Error("HTTP 403")),"HTTP 403");
  inner.code="https://private:secret@example.org";
  assert.equal(sourceErrorMessage(new Error("fetch failed",{cause:inner})),"fetch failed");
});
