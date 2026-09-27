// Full bot acceptance run: the real Telegraf bot (every command, button,
// access flow and language) plus live alert delivery, against a local anvil
// chain and a fake Telegram Bot API that rejects what the real one would
// (broken MarkdownV2, >4096-char texts, >64-byte button data). Needs anvil on
// :8545 plus Postgres and Redis — see README "End-to-end test".
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { markdownV2Problem } from "./markdownV2.js";

process.env.DATABASE_URL ??= "postgres://tracker:tracker@localhost:5432/migration_tracker";
process.env.REDIS_URL ??= "redis://localhost:6379";
const NETWORK = "anvil";
process.env.EXTRA_NETWORKS = NETWORK;
process.env.NETWORK_ANVIL_CHAIN_ID = "31337";
process.env.NETWORK_ANVIL_NAME = "Anvil (local)";
process.env.RPC_ANVIL ??= "ws://127.0.0.1:8545,http://127.0.0.1:8545";
process.env.ENABLED_NETWORKS = NETWORK;
process.env.LOG_LEVEL ??= "error";
process.env.NODE_ENV = "production";
process.env.SIGNATURE_DB_URL = "off";
process.env.RECHECK_DELAYS_SEC = "3,6,9,12";

const ADMIN = 1001; // admin, English
const ALICE = 2002; // approved, Ukrainian, all alerts
const BOB = 3003; // rejected by the admin, Russian
const CAROL = 4004; // approved, English, only watches "ethereum"
const DAN = 5005; // never picks a language
const GROUP = -100500; // a group chat, set up by member 6006
const MEMBER = 6006;
process.env.ADMIN_CHAT_IDS = String(ADMIN);

// --- fake Telegram Bot API ------------------------------------------------------
type Call = { method: string; body: Record<string, unknown>; at: number; rejected?: string };
const calls: Call[] = [];
// Errors the fake API answers the next sendMessage(s) to a chat with, in order.
type InjectedError = { error_code: number; description: string; parameters?: { retry_after: number } };
const injected = new Map<number, InjectedError[]>();
let nextMessageId = 1;

function rejectionReason(method: string, body: Record<string, unknown>): string | null {
  const text = typeof body.text === "string" ? body.text : undefined;
  if (method === "sendMessage" || method === "editMessageText") {
    if (!text || text.trim() === "") return "message text is empty";
    if (text.length > 4096) return `message is too long (${text.length})`;
    if (body.parse_mode === "MarkdownV2") {
      const problem = markdownV2Problem(text);
      if (problem) return `can't parse entities: ${problem}`;
    }
  }
  if (method === "answerCallbackQuery" && typeof body.text === "string" && body.text.length > 200) {
    return "callback answer text is too long";
  }
  const markup = body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string; text?: string }>> } | undefined;
  for (const row of markup?.inline_keyboard ?? []) {
    for (const button of row) {
      if (!button.text) return "button without text";
      if (button.callback_data && Buffer.byteLength(button.callback_data) > 64) {
        return `BUTTON_DATA_INVALID (${button.callback_data})`;
      }
    }
  }
  return null;
}

const telegramApi = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const method = (req.url ?? "").split("/").pop() ?? "";
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const call: Call = { method, body, at: Date.now() };
    const reason = rejectionReason(method, body);
    res.setHeader("content-type", "application/json");
    const queued = method === "sendMessage" ? injected.get(Number(body.chat_id)) : undefined;
    const failure = queued?.shift();
    if (failure) {
      call.rejected = `injected ${failure.error_code}`;
      calls.push(call);
      res.statusCode = failure.error_code;
      res.end(JSON.stringify({ ok: false, ...failure }));
      return;
    }
    if (reason) {
      call.rejected = reason;
      calls.push(call);
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error_code: 400, description: `Bad Request: ${reason}` }));
      return;
    }
    calls.push(call);
    const result =
      method === "sendMessage" || method === "editMessageText"
        ? { message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: body.chat_id, type: "private" }, text: body.text }
        : true;
    res.end(JSON.stringify({ ok: true, result }));
  });
});
await new Promise<void>((r) => telegramApi.listen(8548, "127.0.0.1", r));

// --- app modules (after env is set) ------------------------------------------------
const { runMigrations } = await import("../src/db/migrate.js");
const { pool } = await import("../src/db/client.js");
const { chatSettingsRepository } = await import("../src/db/repositories/chatSettingsRepository.js");
const { startBlockListener } = await import("../src/chain/blockListener.js");
const { refreshAllOwners } = await import("../src/chain/ownerRefresh.js");
const { enqueueContractCreation, startContractCreationWorker, getContractCreationQueue } = await import(
  "../src/queue/notificationQueue.js"
);
const { createBot, broadcastMigrationAlert, notifyNewOwners } = await import("../src/telegram/bot.js");

type Artifact = { abi: Abi; bytecode: Hex };
const ARTIFACTS = process.env.E2E_ARTIFACTS ?? fileURLToPath(new URL("./artifacts.json", import.meta.url));
const artifacts = JSON.parse(readFileSync(ARTIFACTS, "utf8")) as Record<string, Artifact>;

const rpc = http("http://127.0.0.1:8545");
const chainClient = createPublicClient({ chain: foundry, transport: rpc });
const wallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain: foundry, transport: rpc });
const owner = wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const multisig = wallet("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");

async function deploy(from: typeof owner, name: string, args: unknown[] = []) {
  const { abi, bytecode } = artifacts[name]!;
  const hash = await from.deployContract({ abi, bytecode, args } as never);
  const receipt = await chainClient.waitForTransactionReceipt({ hash });
  return { address: receipt.contractAddress!, hash };
}
async function write(from: typeof owner, address: Address, name: string, functionName: string, args: unknown[]) {
  const hash = await from.writeContract({ address, abi: artifacts[name]!.abi, functionName, args } as never);
  await chainClient.waitForTransactionReceipt({ hash });
}

await runMigrations();
await pool.query("TRUNCATE tokens, chat_settings, network_cursors RESTART IDENTITY CASCADE");
await getContractCreationQueue().obliterate({ force: true });

const bot = createBot("123456:TEST");
// Point the bot at the fake API (dropping the default https agent, which a
// plain-http apiRoot can't use).
const telegramOptions = (bot.telegram as unknown as { options: { apiRoot: string; agent?: unknown } }).options;
telegramOptions.apiRoot = "http://127.0.0.1:8548";
telegramOptions.agent = undefined;
bot.botInfo = { id: 999, is_bot: true, first_name: "Tracker", username: "tracker_test_bot" } as typeof bot.botInfo;

// --- update helpers -----------------------------------------------------------------
let updateId = 1;
function user(id: number) {
  return { id, is_bot: false, first_name: `User${id}`, username: `user${id}` };
}
const chatOf = (chatId: number) =>
  chatId < 0 ? { id: chatId, type: "group", title: "Team chat" } : { id: chatId, type: "private", first_name: `User${chatId}` };
async function send(chatId: number, text: string, fromId = chatId): Promise<Call[]> {
  const from = calls.length;
  const command = text.split(/\s+/)[0]!;
  await bot.handleUpdate({
    update_id: updateId++,
    message: {
      message_id: nextMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat: chatOf(chatId),
      from: user(fromId),
      text,
      entities: command.startsWith("/") ? [{ type: "bot_command", offset: 0, length: command.length }] : [],
    },
  } as never);
  return calls.slice(from);
}
async function click(chatId: number, data: string, fromId = chatId): Promise<Call[]> {
  const from = calls.length;
  await bot.handleUpdate({
    update_id: updateId++,
    callback_query: {
      id: String(updateId),
      from: user(fromId),
      chat_instance: "ci",
      data,
      message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: chatOf(chatId), text: "…" },
    },
  } as never);
  return calls.slice(from);
}
const textsTo = (cs: Call[], chatId: number) =>
  cs
    .filter((c) => !c.rejected && (c.method === "sendMessage" || c.method === "editMessageText") && Number(c.body.chat_id) === chatId)
    .map((c) => String(c.body.text));
const buttons = (cs: Call[]) =>
  cs.flatMap((c) =>
    ((c.body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined)?.inline_keyboard ?? [])
      .flat()
      .map((b) => b.callback_data ?? ""),
  );
const cbAnswer = (cs: Call[]) => String(cs.find((c) => c.method === "answerCallbackQuery")?.body.text ?? "");

// --- checks -----------------------------------------------------------------------
let failures = 0;
let section = "";
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${section ? `[${section}] ` : ""}${label}${ok ? "" : `  <- ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
const has = (texts: string[], pattern: RegExp) => texts.some((t) => pattern.test(t));

// --- chain fixtures -------------------------------------------------------------------
const oldToken = await deploy(owner, "SimpleToken", ["Old Token", "OLD", 10n ** 24n]);
const newToken = await deploy(owner, "SimpleToken", ["New Token", "NEW", 10n ** 24n]);
const extraTokens = [];
for (let i = 1; i <= 5; i++) extraTokens.push(await deploy(owner, "SimpleToken", [`Extra ${i}`, `EX${i}`, 10n ** 24n]));

// =====================================================================================
section = "access";
let r = await send(ALICE, "/start");
check("/start on first contact shows the language picker (3 languages)", buttons(r).join() === "lang:en,lang:uk,lang:ru", buttons(r));
r = await send(DAN, "/list");
check("commands are blocked before a language is picked", has(textsTo(r, DAN), /administrator approval/), textsTo(r, DAN));
r = await click(ALICE, "lang:uk");
check("picking Ukrainian confirms in Ukrainian", /українська/.test(cbAnswer(r)), cbAnswer(r));
check("…and says the request is waiting for approval", has(textsTo(r, ALICE), /схвалення адміністратора/), textsTo(r, ALICE));
check("admin receives the access request with Approve/Reject", buttons(r).join() === `admin:approve:${ALICE},admin:reject:${ALICE}`, buttons(r));
check("…showing the chat id and username", has(textsTo(r, ADMIN), new RegExp(`${ALICE}[\\s\\S]*@user${ALICE}`)), textsTo(r, ADMIN));
r = await send(ALICE, "/list");
check("an unapproved chat is blocked (in its language)", has(textsTo(r, ALICE), /вимагає схвалення/), textsTo(r, ALICE));
r = await send(ALICE, "/start");
check("repeating /start doesn't spam the admin again", textsTo(r, ADMIN).length === 0, textsTo(r, ADMIN));
r = await click(ALICE, `admin:approve:${ALICE}`);
check("a non-admin can't press Approve", cbAnswer(r) === "Not authorized" && textsTo(r, ALICE).every((t) => !/схвалено/i.test(t)), cbAnswer(r));

r = await send(ADMIN, "/start");
check("the admin also picks a language first", buttons(r).includes("lang:en"), buttons(r));
r = await click(ADMIN, "lang:en");
check("the admin is approved automatically and sees the command list", has(textsTo(r, ADMIN), /\/add_token[\s\S]*\/status/), textsTo(r, ADMIN));
r = await click(ADMIN, `admin:approve:${ALICE}`);
check("admin approves: the user is told (in Ukrainian)", has(textsTo(r, ALICE), /Вас схвалено/), textsTo(r, ALICE));
check("…and the admin sees the confirmation in English", /Approved 2002/.test(cbAnswer(r)), cbAnswer(r));
r = await send(ALICE, "/help");
check("an approved user gets the full Ukrainian command list", has(textsTo(r, ALICE), /Команди:[\s\S]*\/analyze/), textsTo(r, ALICE));

await send(BOB, "/start");
await click(BOB, "lang:ru");
r = await click(ADMIN, `admin:reject:${BOB}`);
check("admin rejects: the user is told (in Russian)", has(textsTo(r, BOB), /отказано/), textsTo(r, BOB));
r = await send(BOB, "/list");
check("a rejected user stays blocked", has(textsTo(r, BOB), /требует одобрения/), textsTo(r, BOB));

await send(CAROL, "/start");
await click(CAROL, "lang:en");
await click(ADMIN, `admin:approve:${CAROL}`);
r = await send(ALICE, "/language");
check("/language shows the picker again", buttons(r).join() === "lang:en,lang:uk,lang:ru", buttons(r));

// =====================================================================================
section = "tokens";
r = await send(ALICE, "/add_token");
check("/add_token without args shows usage and networks", has(textsTo(r, ALICE), /\/add_token[\s\S]*anvil/), textsTo(r, ALICE));
r = await send(ALICE, "/add_token solana 0x0000000000000000000000000000000000000001");
check("unknown network is refused", has(textsTo(r, ALICE), /solana/), textsTo(r, ALICE));
r = await send(ALICE, "/add_token anvil 0x123");
check("invalid address is refused", has(textsTo(r, ALICE), /0x123/), textsTo(r, ALICE));
r = await send(ALICE, `/add_token anvil ${oldToken.address}`);
check(
  "adding a token reads its symbol and discovers the owner wallet",
  has(textsTo(r, ALICE), new RegExp(`OLD[\\s\\S]*${owner.account.address}[\\s\\S]*owner`, "i")),
  textsTo(r, ALICE),
);
r = await send(ALICE, `/add_token anvil ${oldToken.address}`);
check("adding it again re-checks owners instead of duplicating", has(textsTo(r, ALICE), /вже відстежується/), textsTo(r, ALICE));
for (const t of extraTokens) await send(ADMIN, `/add_token anvil ${t.address}`);

r = await send(ALICE, "/list");
check("/list shows 5 tokens per page with a Next button", buttons(r).join() === "list:page:1" && has(textsTo(r, ALICE), /1\/2/), { b: buttons(r), t: textsTo(r, ALICE) });
r = await click(ALICE, "list:page:1");
check("Next opens page 2 with a Prev button", buttons(r).join() === "list:page:0" && has(textsTo(r, ALICE), /2\/2[\s\S]*OLD/), { b: buttons(r), t: textsTo(r, ALICE) });

r = await send(ALICE, `/add_owner anvil ${oldToken.address} ${multisig.account.address}`);
check("/add_owner links an extra wallet", has(textsTo(r, ALICE), new RegExp(multisig.account.address)), textsTo(r, ALICE));
r = await send(ALICE, `/add_owner anvil ${newToken.address} ${multisig.account.address}`);
check("/add_owner for an untracked token is refused", has(textsTo(r, ALICE), /не відстежується|not tracked/i), textsTo(r, ALICE));
r = await click(ALICE, "list:page:1");
check("/list shows the manual wallet", has(textsTo(r, ALICE), /\(manual\)/), textsTo(r, ALICE));

const lastExtra = extraTokens.at(-1)!.address;
r = await send(ALICE, `/remove_token ${lastExtra}`);
check("/remove_token asks for confirmation", buttons(r).join().toLowerCase() === `remove:confirm:${lastExtra},remove:cancel`.toLowerCase(), buttons(r));
r = await click(ALICE, "remove:cancel");
check("Cancel keeps the token", has(textsTo(r, ALICE), /Скасовано|скасовано/), textsTo(r, ALICE));
r = await click(ALICE, `remove:confirm:${lastExtra}`);
check("Confirm removes it", has(textsTo(r, ALICE), /Видалено/), textsTo(r, ALICE));
r = await send(ALICE, `/remove_token ${lastExtra}`);
check("removing it again says it isn't tracked", buttons(r).length === 0 && has(textsTo(r, ALICE), /не відстежувався/), textsTo(r, ALICE));

// =====================================================================================
section = "settings";
r = await send(ALICE, "/settings");
check("/settings shows confidence and per-network buttons", buttons(r).includes("settings:confidence:HIGH_ONLY") && buttons(r).includes("settings:net:anvil"), buttons(r));
r = await click(ADMIN, "settings:confidence:HIGH_ONLY");
check("switching to HIGH only is confirmed", /HIGH_ONLY/.test(cbAnswer(r)), cbAnswer(r));
await chatSettingsRepository.ensure(String(CAROL));
await click(CAROL, "settings:net:ALL");
for (const n of ["anvil"]) await click(CAROL, `settings:net:${n}`);
const carol = await chatSettingsRepository.get(String(CAROL));
check("toggling a network off excludes it for that chat", Boolean(carol?.networksFilter && !carol.networksFilter.includes(NETWORK)), carol?.networksFilter);

const settingsButtons = buttons(await send(ALICE, "/settings"));
check("/settings has auto-discovery and liquidity-level buttons", ["settings:auto:on", "settings:auto:off", "settings:liq:STRICT", "settings:liq:LOW_CAP"].every((x) => settingsButtons.includes(x)), settingsButtons);
await click(ALICE, "settings:liq:LOW_CAP");
await click(ALICE, "settings:auto:off");
let alice = await chatSettingsRepository.get(String(ALICE));
check("Low-Cap and auto-off are saved for the chat", alice?.liquidityLevel === "LOW_CAP" && alice.autoAlerts === false, alice);
await click(ALICE, "settings:auto:on");
alice = await chatSettingsRepository.get(String(ALICE));
check("auto alerts can be switched back on", alice?.autoAlerts === true, alice);

section = "custodians";
r = await send(ALICE, "/custodians");
check("the custodian registry is admin-only", has(textsTo(r, ALICE), /лише адміністраторам/), textsTo(r, ALICE));
r = await send(ADMIN, `/add_custodian anvil ${multisig.account.address} Backed Finance`);
check("admin registers a custodian with a label", has(textsTo(r, ADMIN), /Backed Finance/), textsTo(r, ADMIN));
r = await send(ADMIN, "/custodians");
check("/custodians lists it", has(textsTo(r, ADMIN), new RegExp(`Backed Finance — anvil — ${multisig.account.address.toLowerCase()}`)), textsTo(r, ADMIN));
r = await send(ADMIN, `/remove_custodian anvil ${multisig.account.address}`);
check("/remove_custodian removes it", has(textsTo(r, ADMIN), /removed/), textsTo(r, ADMIN));

// =====================================================================================
section = "analyze/status";
const analyzed = await deploy(owner, "MigratorWithGetters", [oldToken.address, newToken.address]);
r = await send(ALICE, "/analyze");
check("/analyze without args explains where to get the hash", has(textsTo(r, ALICE), /Contract Creator/), textsTo(r, ALICE));
r = await send(ALICE, `/analyze anvil 0x${"ab".repeat(32)}`);
check("/analyze with an unknown hash says it wasn't found", has(textsTo(r, ALICE), /не знайдено|not found/i), textsTo(r, ALICE));
r = await send(ALICE, `/analyze anvil ${analyzed.hash}`);
check(
  "/analyze on a real deploy returns a HIGH card with Token B (valid MarkdownV2)",
  has(textsTo(r, ALICE), new RegExp(`АНАЛІЗ КОНТРАКТУ[\\s\\S]*${newToken.address}[\\s\\S]*HIGH`, "i")),
  textsTo(r, ALICE),
);
r = await send(ALICE, "/status");
check("/status is refused for a non-admin", has(textsTo(r, ALICE), /лише адміністраторам/), textsTo(r, ALICE));

// =====================================================================================
section = "alerts";
await pool.query("DELETE FROM migration_contracts");
const worker = startContractCreationWorker((a) => broadcastMigrationAlert(bot, a));
const stopListener = startBlockListener(NETWORK, (event) => enqueueContractCreation(event));
await new Promise((res) => setTimeout(res, 1500));

r = await send(ADMIN, "/status");
check("/status for the admin shows the network healthy and the token count", has(textsTo(r, ADMIN), /Tokens: 5[\s\S]*🟢 anvil · websocket/), textsTo(r, ADMIN));

async function alertsFor(address: Address, waitMs: number, update = false) {
  const until = Date.now() + waitMs;
  const match = (c: Call) =>
    !c.rejected && c.method === "sendMessage" && String(c.body.text).toLowerCase().includes(address.toLowerCase()) && (!update || /🔄/.test(String(c.body.text)));
  while (Date.now() < until && !calls.some(match)) await new Promise((res) => setTimeout(res, 200));
  await new Promise((res) => setTimeout(res, 1500)); // let the broadcast reach every chat
  return calls.filter(match);
}
const recipients = (cs: Call[]) => cs.map((c) => Number(c.body.chat_id)).sort();

let t0 = Date.now();
const high = await deploy(owner, "MigratorWithGetters", [oldToken.address, newToken.address]);
let sent = await alertsFor(high.address, 20_000);
check("HIGH migrator: alert reaches the admin and Alice, not Bob (rejected), Carol (network off) or Dan", recipients(sent).join() === `${ADMIN},${ALICE}`, recipients(sent));
check("…Alice's card is in Ukrainian, the admin's in English", has(textsTo(sent, ALICE), /ВИЯВЛЕНО КОНТРАКТ МІГРАЦІЇ/) && has(textsTo(sent, ADMIN), /MIGRATION CONTRACT DETECTED/), sent.map((c) => c.body.text));
check("…card has Token A, Token B, confidence and links", has(textsTo(sent, ADMIN), new RegExp(`OLD[\\s\\S]*${newToken.address}[\\s\\S]*HIGH CONFIDENCE[\\s\\S]*DexScreener`)), textsTo(sent, ADMIN));
const latency = sent.length ? (Math.min(...sent.map((c) => c.at)) - t0) / 1000 : NaN;
check(`…delivered ${latency.toFixed(1)}s after the deploy tx was sent (target 5-10s)`, latency <= 10, latency);

const medium = await deploy(owner, "MigratorUnconfigured");
sent = await alertsFor(medium.address, 20_000);
check("MEDIUM contract: only Alice gets it (the admin chose HIGH only)", recipients(sent).join() === `${ALICE}`, recipients(sent));

const fromMultisig = await deploy(multisig, "MigratorWithGetters", [oldToken.address, newToken.address]);
sent = await alertsFor(fromMultisig.address, 20_000);
check("deploy from the manually linked wallet is caught", recipients(sent).join() === `${ADMIN},${ALICE}`, recipients(sent));

const polImpl = await deploy(owner, "PolStyleMigration");
sent = await alertsFor(polImpl.address, 20_000);
check("uninitialized logic contract: first alert (no Token B) to Alice", recipients(sent).join() === `${ALICE}`, recipients(sent));
await write(owner, polImpl.address, "PolStyleMigration", "initialize", [oldToken.address, newToken.address]);
sent = await alertsFor(polImpl.address, 30_000, true);
check("after initialize(): update card with Token B to the admin and Alice", recipients(sent).join() === `${ADMIN},${ALICE}` && has(textsTo(sent, ALICE), new RegExp(`ОНОВЛЕННЯ[\\s\\S]*${newToken.address}`)), sent.map((c) => [c.body.chat_id, c.body.text]));

// Ownership moves to a new wallet -> refresh tells the chat that added the token.
const successor = wallet("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");
await write(owner, oldToken.address, "SimpleToken", "transferOwnership", [successor.account.address]);
let from = calls.length;
await refreshAllOwners((res) => notifyNewOwners(bot, res));
const notices = textsTo(calls.slice(from), ALICE);
check("owner refresh tells Alice (who added OLD) about the new owner", has(notices, new RegExp(`OLD[\\s\\S]*${successor.account.address}`)), notices);
t0 = Date.now();
const fromSuccessor = await deploy(successor, "MigratorWithGetters", [oldToken.address, newToken.address]);
sent = await alertsFor(fromSuccessor.address, 20_000);
check("the new owner's deploy is caught", recipients(sent).join() === `${ADMIN},${ALICE}`, recipients(sent));

r = await send(ALICE, "/language");
await click(ALICE, "lang:ru");
from = calls.length;
const ruCase = await deploy(owner, "MigratorWithGetters", [oldToken.address, newToken.address]);
sent = await alertsFor(ruCase.address, 20_000);
check("after switching to Russian, Alice's next card is in Russian", has(textsTo(sent, ALICE), /ОБНАРУЖЕН КОНТРАКТ МИГРАЦИИ/), textsTo(sent, ALICE));

// =====================================================================================
section = "group chat";
r = await send(GROUP, "/start@tracker_test_bot", MEMBER);
check("/start@botname in a group shows the language picker", buttons(r).join() === "lang:en,lang:uk,lang:ru", buttons(r));
r = await click(GROUP, "lang:en", MEMBER);
check("the admin's request names the group and its (negative) chat id", has(textsTo(r, ADMIN), new RegExp(`Team chat[\\s\\S]*${GROUP}`)), textsTo(r, ADMIN));
check("…with working Approve/Reject buttons for a negative id", buttons(r).join() === `admin:approve:${GROUP},admin:reject:${GROUP}`, buttons(r));
r = await send(GROUP, "/list@tracker_test_bot", MEMBER);
check("the group is blocked until approved", has(textsTo(r, GROUP), /administrator approval/), textsTo(r, GROUP));
r = await click(ADMIN, `admin:approve:${GROUP}`);
check("approving the group notifies it", has(textsTo(r, GROUP), /approved/), textsTo(r, GROUP));
r = await send(GROUP, "/list@tracker_test_bot", MEMBER);
check("after approval /list@botname works in the group", has(textsTo(r, GROUP), /Tracked tokens/), textsTo(r, GROUP));

// =====================================================================================
section = "telegram errors";
// Alice blocked the bot (403); the admin hits flood control once (429, retry after 1s).
injected.set(ALICE, [{ error_code: 403, description: "Forbidden: bot was blocked by the user" }]);
injected.set(ADMIN, [{ error_code: 429, description: "Too Many Requests: retry after 1", parameters: { retry_after: 1 } }]);
const floodCase = await deploy(owner, "MigratorWithGetters", [oldToken.address, newToken.address]);
sent = await alertsFor(floodCase.address, 20_000);
await new Promise((res) => setTimeout(res, 1500)); // the 429 retry lands ~1s later
sent = calls.filter((c) => !c.rejected && c.method === "sendMessage" && String(c.body.text).toLowerCase().includes(floodCase.address.toLowerCase()));
check("a chat that blocked the bot (403) doesn't stop delivery to the others", recipients(sent).includes(GROUP), recipients(sent));
check("flood control (429) is waited out and the admin still gets the alert", recipients(sent).includes(ADMIN), recipients(sent));
check("the blocked chat is not retried", calls.filter((c) => Number(c.body.chat_id) === ALICE && String(c.body.text).toLowerCase().includes(floodCase.address.toLowerCase())).length === 1);

// =====================================================================================
section = "long lists";
for (let i = 1; i <= 60; i++) {
  await send(ADMIN, `/add_owner anvil ${oldToken.address} 0x${i.toString(16).padStart(40, "0")}`);
}
r = await send(ALICE, "/list");
const listText = textsTo(r, ALICE).join("\n");
check("/list for a token with 60+ wallets stays under Telegram's limit and is accepted", listText.length > 0 && listText.length <= 4096 && r.every((c) => !c.rejected), { len: listText.length, rejected: r.map((c) => c.rejected) });
check("…and says how many wallets are hidden", /и ещё \d+/.test(listText), listText.slice(-300));

// =====================================================================================
section = "hygiene";
const outgoing = calls.filter((c) => c.method === "sendMessage" || c.method === "editMessageText");
const rejected = calls.filter((c) => c.rejected);
const unexpectedRejections = rejected.filter((c) => !c.rejected!.startsWith("injected"));
check(`all ${calls.length} Bot API calls were accepted (MarkdownV2, lengths, button data)`, unexpectedRejections.length === 0, unexpectedRejections.map((c) => `${c.method}: ${c.rejected}`));
const leaks = outgoing.filter((c) => /\{[a-zA-Z]+\}|undefined|NaN|\[object /.test(String(c.body.text)) || /^[a-z]+\.[a-zA-Z]+$/m.test(String(c.body.text)));
check("no message has unfilled placeholders, 'undefined' or raw translation keys", leaks.length === 0, leaks.map((c) => c.body.text));

await stopListener();
await worker.close();
telegramApi.close();
console.log(`\n${calls.length} Bot API calls, ${outgoing.length} messages checked`);
console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
