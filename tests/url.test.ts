// The fetch guard: internal addresses stay unreachable in every spelling, and a name that resolves
// to one is refused at connect time too (DNS rebinding after the URL check).
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { Agent, fetch as undiciFetch } from "undici";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { assertPublicUrl, guardedLookup, isBlockedAddress, isInternalAddress, preferIPv4 } from "@aihot/backend/lib/url";

const server = http.createServer((_req, res) => res.end("internal"));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const { port } = server.address() as { port: number };
const agent = new Agent({ connect: { lookup: guardedLookup as never } });
after(async () => {
  server.close();
  await agent.close();
});

test("internal and reserved addresses are blocked in every spelling", () => {
  const blocked = [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "255.255.255.255",
    "::1", "::", "fd00::1", "fe80::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a00:1", "::ffff:a9fe:a9fe", "::7f00:1", // IPv4-mapped and -compatible
    "64:ff9b::7f00:1", "64:ff9b:1::1", "2002:7f00:1::1", "2001:0:4136:e378::1", // NAT64, 6to4, Teredo
    "not-an-ip",
  ];
  const allowed = ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"];
  assert.deepEqual(blocked.filter((a) => !isBlockedAddress(a)), [], "not blocked");
  assert.deepEqual(allowed.filter((a) => isBlockedAddress(a)), [], "wrongly blocked");
});

test("URL literals that embed a loopback address are refused before any request", async () => {
  for (const url of ["http://[::ffff:127.0.0.1]/", "http://[::127.0.0.1]/", "http://[64:ff9b::127.0.0.1]/", "http://localhost/"]) {
    await assert.rejects(assertPublicUrl(url), Error, url);
  }
  await assert.rejects(guardedFetch(`http://[::ffff:127.0.0.1]:${port}/`));
});

test("a name resolving to an internal address is refused at connect time", async () => {
  await assert.rejects(undiciFetch(`http://localhost:${port}/`, { dispatcher: agent }));
});

test("through the egress proxy only internal answers refuse a name; literals keep the full check", async () => {
  // The proxy resolves and connects abroad: a poisoned local answer (Teredo, documentation, reserved)
  // must not refuse a blocked site, while anything that reaches this host or its network still does.
  const internal = ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:a00:1", "64:ff9b::7f00:1", "64:ff9b:1::1", "2002:a9fe:a9fe::1"];
  const unroutable = ["2001::58bf:f9b6", "2001:db8::1", "255.255.255.255", "224.0.0.1", "192.0.2.1", "8.8.8.8", "2606:4700:4700::1111"];
  assert.deepEqual(internal.filter((a) => !isInternalAddress(a)), [], "internal not recognised");
  assert.deepEqual(unroutable.filter((a) => isInternalAddress(a)), [], "wrongly internal");
  for (const url of ["http://localhost/", "http://[::ffff:127.0.0.1]/", "http://[2001:db8::1]/", "http://10.0.0.1/"]) {
    await assert.rejects(assertPublicUrl(url, false, true), Error, url);
  }
});

test("a dual-stack host is dialled over IPv4 first, and an IPv6-only host still resolves to its v6", () => {
  // 2026-10-09：这台采集器没有 IPv6 出口（对 egu.eu 的 AAAA 直连 `ENETUNREACH`，同一时刻 `curl -4` 200、
  // `curl -6` 连不上，Node 的 fetch 与 curl 默认行为一样超时）。`guardedLookup` 原本拨解析列表的第一个，
  // 于是两条健康的 EGU feed 上线即 "fetch failed"。排序抽成 `preferIPv4`，就是为了这条用例能真跑而不是扫源码。
  const dual = [{ address: "2a01:4f8:c01e:4e5::1", family: 6 }, { address: "185.12.40.163", family: 4 }];
  assert.deepEqual(preferIPv4(dual).map((a) => a.family), [4, 6], "双栈：先 IPv4");
  assert.deepEqual(preferIPv4([...dual].reverse()).map((a) => a.family), [4, 6], "与解析器给的顺序无关");
  assert.deepEqual(preferIPv4([dual[0]!]).map((a) => a.family), [6], "纯 IPv6 主机不许被排空——那样就谁都连不上了");
  // SSRF 侧的不变量：排序只是换拨号顺序，检查仍然覆盖列表里的每一个地址。
  assert.equal(dual.some((a) => isBlockedAddress(a.address)), false, "夹具本身是公网地址（这条用例不测拦截）");
  assert.equal(isBlockedAddress("2a01:4f8:c01e:4e5::1"), false, "公网 v6 不被拦：拦的是私有段，不是地址族");
  assert.equal(isBlockedAddress("fe80::1"), true, "链路本地 v6 仍然被拦（排序不会把它顶到前面去绕开检查）");
});
