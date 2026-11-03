import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { adminRead, adminReadOrBusy } from "@aihot/backend/admin/admin-read";
import { listFeedback } from "@aihot/backend/admin/feedback";

const T = tag();
let savedBudgets: { service: string }[] = [];
before(async () => {
  savedBudgets = await sql`SELECT service FROM budgets`;
});
after(async () => {
  // The write-rejection probe must leave no trace: adminRead is READ ONLY, but assert anyway.
  await sql`DELETE FROM budgets WHERE service NOT IN ${sql(savedBudgets.length ? savedBudgets.map((b) => b.service) : ["__none__"])}`;
  await closeDb();
});

test("adminRead is transparent on the happy path", async () => {
  const rows = await adminRead((db) => db<{ one: number }[]>`SELECT 1 AS one`);
  assert.deepEqual(rows, [{ one: 1 }]);
});

test("a scan past the deadline is stopped database-side, mapped to a refresh message, with no leftover settings", async () => {
  await assert.rejects(
    adminReadOrBusy((db) => db`SELECT pg_sleep(3)`, 500),
    (error: unknown) => (error as Error).message === "后台读取暂时超时，请稍后刷新",
  );
  // SET LOCAL must not leak past the failed transaction into the next one.
  const slow = await adminReadOrBusy((db) => db`SELECT pg_sleep(0.2) AS ok`, 5_000);
  assert.ok(slow.length === 1);
  const [setting] = await sql<{ value: string }[]>`SELECT current_setting('statement_timeout') AS value`;
  assert.equal(setting!.value, "0", "the deadline is transaction-local, the shared pool stays untouched");
});

test("adminRead is READ ONLY: wrapping a write fails loudly instead of half-applying", async () => {
  await assert.rejects(
    adminRead((db) => db`INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES (${'admin-read-probe'}, 0, 0, 0, 'read-only guard')`),
    (error: unknown) => /read-only/i.test(String((error as Error).message)),
  );
  const [row] = await sql`SELECT 1 FROM budgets WHERE service = 'admin-read-probe'`;
  assert.equal(row, undefined);
});

test("listFeedback keeps its contract after the deadline wrapper", async () => {
  const sender = `fb-deadline-${T}`;
  const rows = [
    { content: "包装后行为不变 甲", status: "new" },
    { content: "包装后行为不变 乙", status: "triaged" },
    { content: "包装后行为不变 丙", status: "new" },
  ];
  const inserted: number[] = [];
  try {
    for (const r of rows) {
      const [row] = await sql`INSERT INTO feedback (content, status, source_hash) VALUES (${r.content}, ${r.status}, ${sender}) RETURNING id`;
      inserted.push(row!.id);
    }
    // Same-second rows need the id tiebreak; assert the exact documented order, then the filter.
    const all = await listFeedback({});
    const allRows = [...all.rows] as unknown as Array<{ id: number; status: string }>;
    const mine = allRows.filter((r) => inserted.includes(r.id));
    assert.deepEqual(mine.map((r) => r.id), [...inserted].sort((a, b) => b - a), "created_at DESC, id");
    const filtered = await listFeedback({ status: "new" });
    const triagedId = mine.find((r) => r.status === "triaged")!.id;
    const filteredIds = (Array.from(filtered.rows) as unknown as Array<{ id: number }>).filter((r) => inserted.includes(r.id)).map((r) => r.id);
    assert.deepEqual(filteredIds, inserted.filter((id) => id !== triagedId).sort((a, b) => b - a));
    assert.ok(Object.values(filtered.counts).every((n) => Number.isInteger(n)));
  } finally {
    await sql`DELETE FROM feedback WHERE id = ANY(${inserted})`;
  }
});
