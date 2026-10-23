import assert from "node:assert/strict";
import { after, test } from "node:test";
import "./setup.ts";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { passwordLogin } from "@aihot/backend/admin/auth";
import { sha256 } from "@aihot/backend/lib/ids";

after(closeDb);
test("the owner-selected nine-character password signs in; mismatches and shorter configurations do not", async () => {
  const original = config.adminPassword;
  let token: string | undefined;
  try {
    config.adminPassword = "test-pw09";
    const result = await passwordLogin("test-pw09", "/admin/feedback", "isolated-auth-test");
    token = result.token;
    assert.equal(result.returnTo, "/admin/feedback");
    await assert.rejects(passwordLogin("incorrect", "/admin", undefined), /密码不对/);
    config.adminPassword = "short-pw";
    await assert.rejects(passwordLogin("short-pw", "/admin", undefined), /至少 9 位/);
  } finally {
    config.adminPassword = original;
    if (token) await sql`DELETE FROM admin_sessions WHERE id_hash = ${sha256(token)}`;
  }
});
