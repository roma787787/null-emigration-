import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  checkLiquidity,
  checkLiquidityLevels,
  clearLiquidityCache,
  okxRequestsSent,
  signOkxRequest,
  verdictFromQuote,
} from "./okxLiquidity.js";

test("signs requests like OKX expects (reference value from Python hmac)", () => {
  assert.equal(
    signOkxRequest("secret", "2026-01-01T00:00:00.000Z", "GET", "/api/v6/dex/aggregator/quote?chainIndex=1"),
    "EhrxcW1Q+Pb6aemwM5gof2v+JvOq/Kd6GZmXdpSEwqo=",
  );
});

test("a route within the impact cap passes; negative impact is read as its size", () => {
  const body = { code: "0", data: [{ toTokenAmount: "123", priceImpactPercent: "-4.2" }] };
  assert.deepEqual(verdictFromQuote(body, "STRICT"), { status: "pass", impactPercent: 4.2, reason: "impact 4.2%", amountOut: "123" });
});

test("impact over the cap is skipped for Strict but can pass Low-Cap", () => {
  const body = { code: "0", data: [{ toTokenAmount: "123", priceImpactPercent: "7" }] };
  assert.equal(verdictFromQuote(body, "STRICT").status, "skip");
  assert.equal(verdictFromQuote(body, "LOW_CAP").status, "pass");
});

test("v5's priceImpactPercentage is understood too", () => {
  const body = { code: "0", data: [{ toTokenAmount: "1", priceImpactPercentage: "1.5" }] };
  assert.equal(verdictFromQuote(body, "STRICT").impactPercent, 1.5);
});

test("no route, empty output and honeypots are skipped", () => {
  assert.equal(verdictFromQuote({ code: "82000", msg: "Insufficient liquidity" }, "STRICT").status, "skip");
  assert.equal(verdictFromQuote({ code: "0", data: [{ toTokenAmount: "0", priceImpactPercent: "0" }] }, "STRICT").status, "skip");
  assert.equal(verdictFromQuote({ code: "0", data: [] }, "STRICT").status, "skip");
  const honeypot = { code: "0", data: [{ toTokenAmount: "5", priceImpactPercent: "0.1", toToken: { isHoneyPot: true } }] };
  assert.deepEqual(verdictFromQuote(honeypot, "STRICT").reason, "honeypot");
});

test("auth / rate-limit errors say nothing about the token: unchecked", () => {
  assert.equal(verdictFromQuote({ code: "50011", msg: "Too Many Requests" }, "STRICT").status, "unchecked");
  assert.equal(verdictFromQuote({ code: "50113", msg: "Invalid Sign" }, "STRICT").status, "unchecked");
});

// --- against a local stub of the OKX API --------------------------------------------
let server: Server;
let rateLimitedOnce = true;
const seen: Array<{ url: string; headers: Record<string, string | string[] | undefined> }> = [];
before(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    const to = new URL(req.url ?? "/", "http://x").searchParams.get("toTokenAddress");
    const amount = new URL(req.url ?? "/", "http://x").searchParams.get("amount");
    res.setHeader("content-type", "application/json");
    if (to === "0x00000000000000000000000000000000000000cc" && rateLimitedOnce) {
      rateLimitedOnce = false;
      res.end(JSON.stringify({ code: "50011", msg: "Too Many Requests" }));
    } else if (to === "0x00000000000000000000000000000000000000cc") {
      res.end(JSON.stringify({ code: "0", data: [{ toTokenAmount: "1", priceImpactPercent: "1" }] }));
    } else if (to === "0x00000000000000000000000000000000000000aa") {
      res.end(JSON.stringify({ code: "0", data: [{ toTokenAmount: "1000", priceImpactPercent: amount === "1000000000" ? "7" : "2" }] }));
    } else {
      res.end(JSON.stringify({ code: "82000", msg: "Insufficient liquidity" }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  Object.assign(process.env, {
    OKX_API_KEY: "key",
    OKX_SECRET_KEY: "secret",
    OKX_API_PASSPHRASE: "pass",
    OKX_API_BASE_URL: `http://127.0.0.1:${port}`,
    OKX_MIN_INTERVAL_MS: "0",
  });
});
after(() => {
  server.close();
  for (const k of ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_API_PASSPHRASE", "OKX_API_BASE_URL", "OKX_MIN_INTERVAL_MS"]) delete process.env[k];
});

test("sends a signed $1,000 USDT → token quote on the right chain", async () => {
  clearLiquidityCache();
  const check = await checkLiquidity("ethereum", "0x00000000000000000000000000000000000000AA", "STRICT");
  const req = seen.at(-1)!;
  const params = new URL(req.url, "http://x").searchParams;
  assert.equal(params.get("chainIndex"), "1");
  assert.equal(params.get("fromTokenAddress"), "0xdac17f958d2ee523a2206206994597c13d831ec7");
  assert.equal(params.get("amount"), "1000000000"); // 1,000 USDT at 6 decimals
  assert.equal(req.headers["ok-access-key"], "key");
  assert.equal(req.headers["ok-access-passphrase"], "pass");
  const signed = signOkxRequest("secret", String(req.headers["ok-access-timestamp"]), "GET", req.url);
  assert.equal(req.headers["ok-access-sign"], signed);
  assert.equal(check.status, "skip"); // 7% > 5%
});

test("results are cached per token for 5 minutes", async () => {
  clearLiquidityCache();
  const before = okxRequestsSent();
  await checkLiquidity("ethereum", "0x00000000000000000000000000000000000000aa", "LOW_CAP");
  await checkLiquidity("ethereum", "0x00000000000000000000000000000000000000AA", "LOW_CAP");
  assert.equal(okxRequestsSent() - before, 1);
});

test("all levels: a token failing even Low-Cap costs one request, not three", async () => {
  clearLiquidityCache();
  const before = okxRequestsSent();
  const levels = await checkLiquidityLevels("ethereum", "0x00000000000000000000000000000000000000bb");
  assert.equal(levels.LOW_CAP.status, "skip");
  assert.equal(levels.STRICT.status, "skip");
  assert.equal(levels.DEEP.status, "skip");
  assert.equal(okxRequestsSent() - before, 1);
});

test("an API failure is not cached: the next check asks again", async () => {
  clearLiquidityCache();
  const before = okxRequestsSent();
  const port = Number(new URL(process.env.OKX_API_BASE_URL!).port);
  process.env.OKX_API_BASE_URL = "http://127.0.0.1:1"; // nothing listens there
  const failed = await checkLiquidity("ethereum", "0x00000000000000000000000000000000000000aa", "STRICT");
  process.env.OKX_API_BASE_URL = `http://127.0.0.1:${port}`;
  const retried = await checkLiquidity("ethereum", "0x00000000000000000000000000000000000000aa", "STRICT");
  assert.equal(failed.status, "unchecked");
  assert.equal(retried.status, "skip");
  assert.equal(okxRequestsSent() - before, 2);
});

test("Strict and Low-Cap can disagree on the same token", async () => {
  clearLiquidityCache();
  const levels = await checkLiquidityLevels("ethereum", "0x00000000000000000000000000000000000000aa");
  assert.equal(levels.LOW_CAP.status, "pass"); // $300: 2% ≤ 10%
  assert.equal(levels.STRICT.status, "skip"); // $1,000: 7% > 5%
  assert.equal(levels.DEEP.status, "skip"); // failed at $1,000 → not even asked at $10,000
});

test("Deep defaults to $10,000 / 3% and every level is overridable via LIQUIDITY_<LEVEL>", async () => {
  const { liquidityLevel } = await import("./okxLiquidity.js");
  assert.deepEqual(liquidityLevel("DEEP"), { amountUsd: 10000, maxImpactPercent: 3 });
  process.env.LIQUIDITY_DEEP = "25000:2";
  assert.deepEqual(liquidityLevel("DEEP"), { amountUsd: 25000, maxImpactPercent: 2 });
  process.env.LIQUIDITY_DEEP = "garbage";
  assert.deepEqual(liquidityLevel("DEEP"), { amountUsd: 10000, maxImpactPercent: 3 });
  delete process.env.LIQUIDITY_DEEP;
  assert.equal(verdictFromQuote({ code: "0", data: [{ toTokenAmount: "1", priceImpactPercent: "3.5" }] }, "DEEP").status, "skip");
  assert.equal(verdictFromQuote({ code: "0", data: [{ toTokenAmount: "1", priceImpactPercent: "2.9" }] }, "DEEP").status, "pass");
});

test("OKX rate limiting (50011) is waited out and retried, not reported as a verdict", async () => {
  clearLiquidityCache();
  const check = await checkLiquidity("ethereum", "0x00000000000000000000000000000000000000cc", "STRICT");
  assert.equal(check.status, "pass");
});

test("requests are spaced by OKX_MIN_INTERVAL_MS", async () => {
  clearLiquidityCache();
  process.env.OKX_MIN_INTERVAL_MS = "300";
  const started = Date.now();
  await checkLiquidity("ethereum", "0x00000000000000000000000000000000000000d1", "STRICT");
  await checkLiquidity("ethereum", "0x00000000000000000000000000000000000000d2", "STRICT");
  await checkLiquidity("ethereum", "0x00000000000000000000000000000000000000d3", "STRICT");
  process.env.OKX_MIN_INTERVAL_MS = "0";
  assert.ok(Date.now() - started >= 550, `took ${Date.now() - started}ms`);
});
