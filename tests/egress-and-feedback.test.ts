// Two surfaces where a value from outside reaches a privileged reader: an anonymous visitor's
// 「意见反馈」 page URL, which the operator is shown as a link, and a redirect chain that could carry a
// paid API's token to a host nobody asked for.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { httpPageUrl } from "@aihot/backend/operations/feedback";

const T = tag();
config.allowPrivateNetworkFetch = true;

interface Seen {
  method?: string;
  authorization?: string;
  body: string;
}
const seen: Record<string, Seen> = {};

// One server answering on two names: 127.0.0.1 and localhost are the same socket but different hosts,
// which is exactly the change of hand these tests are about.
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const key = req.url?.split("/")[1] ?? "";
    seen[key] = { method: req.method, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") };
    const port = (server.address() as { port: number }).port;
    if (key === "see-other" || key === "moved") {
      res.writeHead(key === "see-other" ? 303 : 301, { location: `http://localhost:${port}/target` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("a 303 answer is read as a GET and the submission does not follow it", async () => {
  const res = await guardedFetch(`${base}/see-other`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer paid-${T}` },
    body: `marker=${T}`,
  });
  assert.equal(res.status, 200);
  assert.match(seen["see-other"]!.body, new RegExp(T), "the posted-to host did receive the body");
  assert.equal(seen["target"]!.method, "GET", "the follow-up request is a GET");
  assert.equal(seen["target"]!.body, "", "the body stays with the host that was posted to");
});

test("credentials do not travel to a host the caller did not choose", async () => {
  seen["target"] = { body: "" };
  await guardedFetch(`${base}/moved`, { headers: { authorization: `Bearer paid-${T}` } });
  assert.equal(seen["moved"]!.authorization, `Bearer paid-${T}`, "the first hop is the one we asked for");
  assert.equal(seen["target"]!.authorization, undefined, "the second host sees no Authorization");
});

test("an anonymous page URL is kept only in a form that is safe to link", () => {
  assert.ok(httpPageUrl(`https://xxc2007.me/geohot/items/abc${T}`)?.startsWith("https://"));
  assert.equal(httpPageUrl("/daily"), "/daily", "the form sends a path on this site, and that is legitimate");
  for (const attempt of [`javascript:alert(${T})`, `data:text/html,<script>${T}</script>`, "//example.invalid/x", `${T}`, "ftp://example.invalid/x"]) {
    assert.equal(httpPageUrl(attempt), null, `${attempt.slice(0, 28)} must not be stored`);
  }
  assert.equal(httpPageUrl(undefined), null);
});
