import { gate, within } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { extractFromUrl } from "@aihot/backend/content/extract";
import { shutdownSignal } from "@aihot/backend/jobs/queue";

after(closeDb);
test("shutdown while the original page is in flight cannot start a paid fallback", async () => {
  const entered = gate(), finish = gate();
  let fallbackHits = 0;
  const server = http.createServer(async (req,res) => {
    if (req.url === "/original") { entered.open(); await finish.promise; res.writeHead(404); res.end(); }
    else { fallbackHits++; res.writeHead(500); res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0,"127.0.0.1",resolve));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  config.allowPrivateNetworkFetch = true;
  process.env.JINA_BASE_URL = base; process.env.JINA_API_KEY = "local-only-test-key";
  try {
    const pending = extractFromUrl(`${base}/original`,{allowJina:true,subject:"shutdown-fallback-test"});
    const outcome = assert.rejects(pending,/shutting down/);
    await within(entered.promise,2000);
    shutdownSignal.abort(); finish.open();
    await outcome;
    assert.equal(fallbackHits,0);
  } finally { finish.open(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
