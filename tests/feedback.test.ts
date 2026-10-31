// Feedback reaches the operator's mailbox with its screenshot even when the send fails at first: a
// failed SMTP send is retried by the sweep with the same image, a screenshot whose file is gone for
// a day is dropped (the text still goes), imported feedback is never forwarded again, and only one
// send is in flight at a time. The SMTP transport is stubbed, so nothing leaves the process.
import { tag, gate } from "./setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { forwardFeedbackToEmail, smtpTransport, type SmtpOptions } from "@aihot/backend/notify/email";
import { forwardPendingFeedback, submitFeedback } from "@aihot/backend/operations/feedback";

const T = tag();
config.dataDir = mkdtempSync(path.join(tmpdir(), "aihot-feedback-"));
process.env.FEEDBACK_EMAIL_ENABLED = "true";
process.env.FEEDBACK_SMTP_USER = "feedback@test.local";
process.env.FEEDBACK_SMTP_PASS = "test-auth-code";
process.env.FEEDBACK_EMAIL_TO = "operator@test.local";

// The SMTP wire, answered here: sends fail while the switch says so, and every payload is recorded.
const mailbox = { fails: 0, sent: [] as Array<{ to: string; subject: string; text: string; data: string }> };
const realSubmit = smtpTransport.submit;
let sendHold: ReturnType<typeof gate<void>> | undefined;
let sendEntered: ReturnType<typeof gate<void>> | undefined;
smtpTransport.submit = (o: SmtpOptions) => {
  if (sendHold) {
    sendEntered?.open();
    return sendHold.promise.then(() => record(o));
  }
  return record(o);
  function record(o: SmtpOptions) {
    if (mailbox.fails > 0) { mailbox.fails -= 1; return Promise.reject(new Error("smtp send broken")); }
    // 主题是单个 RFC2047 编码词（PR #61 起为 QQ 兼容），正文 base64 且 76 字符折行——都解码成
    // 原文再记录，断言才不必和折叠对齐较劲。
    const encoded = o.data.match(/^Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/m);
    const subject = encoded ? Buffer.from(encoded[1]!, "base64").toString("utf8")
      : (o.data.match(/^Subject: (.*)$/m)?.[1] ?? "");
    const textPart = o.data.match(/Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/m);
    const text = textPart ? Buffer.from(textPart[1]!.replace(/\r\n/g, ""), "base64").toString("utf8") : "";
    mailbox.sent.push({ to: o.to, subject, text, data: o.data });
    return Promise.resolve();
  }
};
before(async () => {
  // feedback 表由多个测试文件共享（security-capacity 也写入），而 sweep 的候选是
  // `ORDER BY id LIMIT 20`：上一个测试进程留下的陈旧行（指向已清理的 tmpdir 截图）会把
  // 本轮刚提交的记录挤出候选批次，让 sweep 断言空转。开跑前清表。
  await sql`DELETE FROM feedback`;
});
after(async () => {
  await sql`DELETE FROM feedback`;
  smtpTransport.submit = realSubmit;
  await closeDb();
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
let n = 0;
// Submitted with the channel off, so each test drives every attempt itself.
async function submit(): Promise<{ id: number; file: string }> {
  n += 1;
  delete process.env.FEEDBACK_EMAIL_ENABLED;
  const { id } = await submitFeedback({ content: `反馈 ${T}-${n}`, screenshot: { mime: "image/png", data: Buffer.concat([PNG, Buffer.from(`${T}-${n}`)]) }, ip: `203.0.113.${n}`, userAgent: "test" });
  process.env.FEEDBACK_EMAIL_ENABLED = "true";
  const [row] = await sql<{ screenshot_key: string }[]>`SELECT screenshot_key FROM feedback WHERE id = ${id}`;
  return { id, file: path.join(config.dataDir, "feedback-screenshots", row!.screenshot_key.slice("local:".length)) };
}
const state = async (id: number) =>
  (await sql<{ forwarded: boolean; forward_error: string | null; screenshot_key: string | null }[]>`
    SELECT forwarded_at IS NOT NULL AS forwarded, forward_error, screenshot_key FROM feedback WHERE id = ${id}`)[0]!;
const sentFor = (id: number) => mailbox.sent.find((m) => m.subject.includes(`反馈 #${id}`));
const olderBy = (id: number, interval: string) => sql`UPDATE feedback SET created_at = now() - ${interval}::interval WHERE id = ${id}`;

test("a failed send keeps the feedback waiting, and the sweep delivers it with the image", async () => {
  const { id, file } = await submit();
  assert.equal((await state(id)).forward_error, "pending");
  mailbox.fails = 1;
  await assert.rejects(forwardFeedbackToEmail(id));
  const waiting = await state(id);
  assert.deepEqual([waiting.forwarded, waiting.forward_error], [false, "smtp send broken"], "the reason is kept for the admin");
  assert.ok(existsSync(file) && !sentFor(id), "nothing is sent while the transport is down");

  await olderBy(id, "10 minutes");
  await forwardPendingFeedback();
  assert.deepEqual({ ...(await state(id)) }, { forwarded: true, forward_error: null, screenshot_key: "emailed" });
  const marker = Buffer.concat([PNG, Buffer.from(`${T}-1`)]).toString("base64").slice(0, 40);
  assert.ok(sentFor(id)!.data.includes(marker), "the message carries the image");
  assert.ok(!existsSync(file), "the local file is gone once emailed");
});

test("a send that fails goes out with the same image next time", async () => {
  const { id, file } = await submit();
  mailbox.fails = 1;
  await assert.rejects(forwardFeedbackToEmail(id));
  assert.match((await state(id)).screenshot_key ?? "", /^local:/, "the screenshot stays until the send lands");
  assert.ok(existsSync(file));
  mailbox.fails = 0;
  assert.equal(await forwardFeedbackToEmail(id), "sent");
  const marker = Buffer.concat([PNG, Buffer.from(`${T}-2`)]).toString("base64").slice(0, 40);
  assert.ok(sentFor(id)!.data.includes(marker), "the image is not lost between attempts");
  assert.ok(!existsSync(file));
});

test("a screenshot whose file is gone for a day is dropped, and the text still goes", async () => {
  const { id, file } = await submit();
  mailbox.fails = 1;
  await assert.rejects(forwardFeedbackToEmail(id));
  mailbox.fails = 0;
  const { unlink } = await import("node:fs/promises");
  await unlink(file);
  await olderBy(id, "25 hours");
  assert.equal(await forwardFeedbackToEmail(id), "sent");
  assert.deepEqual({ ...(await state(id)) }, { forwarded: true, forward_error: null, screenshot_key: "gone:missing" });
  assert.ok(!existsSync(file), "no copy of the screenshot is kept");
  assert.ok(sentFor(id)!.text.includes("（截图文件已不存在）"), "the mail is told the screenshot is missing");
});

test("imported feedback that was never forwarded is not sent now", async () => {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO feedback (content, source_hash, created_at) VALUES (${`旧反馈 ${T}`}, ${`legacy:${T}`}, now() - interval '10 minutes') RETURNING id`;
  await forwardPendingFeedback();
  assert.equal((await state(row!.id)).forwarded, false);
  assert.equal(sentFor(row!.id), undefined);
});

// The HTTP admission ends before background forwarding; this boundary must limit actual image reads.
test("slow sends keep only one mail in flight and leave other records retryable", async () => {
  process.env.FEEDBACK_EMAIL_ENABLED = "false";
  const ids: number[] = [];
  for (let n = 60; n < 72; n++) {
    const { id } = await submitFeedback({ content: `bounded ${T}`, screenshot: { mime: "image/png", data: PNG }, ip: `203.0.113.${n}`, userAgent: "test" });
    ids.push(id);
  }
  process.env.FEEDBACK_EMAIL_ENABLED = "true";
  sendHold = gate(); sendEntered = gate();
  const before = mailbox.sent.length;
  const first = forwardFeedbackToEmail(ids[0]!);
  await sendEntered.promise;
  try {
    const rest = await Promise.all(ids.slice(1).map(forwardFeedbackToEmail));
    assert.ok(rest.every((result) => result === "busy"));
    assert.equal(mailbox.sent.length - before, 0);
    for (const id of ids.slice(1)) {
      const waiting = await state(id);
      assert.equal(waiting.forwarded, false);
      assert.equal(waiting.forward_error, "pending");
      assert.match(waiting.screenshot_key!, /^local:/);
    }
  } finally { sendHold.open(); await first; sendHold = undefined; sendEntered = undefined; }
  assert.equal(await forwardFeedbackToEmail(ids[1]!), "sent", "capacity recovers after the slow send");
});
