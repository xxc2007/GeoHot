import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFeedbackMail, encodedWord } from "@aihot/backend/notify/email";

const decode = (line: string) => Buffer.from(line, "base64").toString("utf8");

test("邮件载荷：CRLF 行距、base64 正文可还原、含截图部件", () => {
  const mail = buildFeedbackMail({
    from: "xxc200707@qq.com",
    to: "xxc200707@qq.com",
    subject: "GEOHOT 反馈 #12：首页加载很慢",
    text: "首页图片加载失败。\r\n页面：https://xxc2007.me/geohot/\r\n邮箱：reader@example.com",
    attachment: { filename: "abc-123.png", mime: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]) },
    date: new Date("2026-10-31T02:00:00Z"),
  });
  assert.ok(!/(?<!\r)\n/.test(mail), "DATA 载荷只允许 CRLF 行距");
  assert.ok(mail.startsWith("From: =?UTF-8?B?"));
  assert.ok(mail.includes('Content-Type: multipart/mixed; boundary="geohot-'));
  // 正文 base64 部件可还原成原文（跨 76 字符折行的空白被忽略）。
  const cte = mail.indexOf("Content-Transfer-Encoding: base64");
  const textBody = mail.slice(cte, mail.indexOf("--geohot-", cte)).split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
  assert.ok(decode(textBody).includes("首页图片加载失败。"));
  assert.ok(decode(textBody).includes("邮箱：reader@example.com"));
  // 附件部件带文件名且 base64 可还原。
  assert.ok(mail.includes('filename="abc-123.png"'));
  const disp = mail.indexOf("Content-Disposition: attachment");
  const attachBody = mail.slice(disp, mail.indexOf("--geohot-", disp)).split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
  assert.deepEqual(Buffer.from(attachBody, "base64"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]));
  // 首部不出现裸点行（base64 字母表不含点，无需 dot-stuffing）。
  assert.ok(!/^\.|\r\n\./.test(mail));
});

test("同一内容产出稳定边界，主题的编码词可解码回原文", () => {
  const input = {
    from: "a@qq.com", to: "a@qq.com", subject: "GEOHOT 反馈 #3：截图提交失败",
    text: "同一内容", date: new Date("2026-10-31T02:00:00Z"),
  };
  const a = buildFeedbackMail(input);
  const b = buildFeedbackMail(input);
  assert.equal(a, b);
  const subject = a.split("\r\n").find((l) => l.startsWith("Subject: "))!;
  const roundTrip = subject.slice("Subject: ".length)
    .split(/\r\n |\r\n/).join("")
    .replace(/=\?UTF-8\?B\?(.*?)\?=/g, (_, b64: string) => decode(b64));
  assert.equal(roundTrip, "GEOHOT 反馈 #3：截图提交失败");
  assert.ok(encodedWord("长主题").startsWith("=?UTF-8?B?"));
});

test("无截图时不产生附件部件，边界闭合", () => {
  const mail = buildFeedbackMail({ from: "a@qq.com", to: "b@qq.com", subject: "s", text: "t", date: new Date("2026-10-31T02:00:00Z") });
  assert.ok(!mail.includes("Content-Disposition: attachment"));
  assert.equal((mail.match(/--geohot-\w+--/g) ?? []).length, 1, "恰好一个结束边界");
  assert.ok((mail.match(/--geohot-\w+\r\n/g) ?? []).length >= 1, "至少一个部件分隔");
});
