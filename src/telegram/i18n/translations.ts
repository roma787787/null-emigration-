import type { Language } from "../../types/index.js";

export const languages: Language[] = ["en", "uk", "ru"];

export const languageLabels: Record<Language, string> = {
  en: "🇬🇧 English",
  uk: "🇺🇦 Українська",
  ru: "🇷🇺 Русский",
};

type Dict = Record<string, string>;

const en: Dict = {
  "lang.prompt": "Please choose your language.",
  "lang.chosen": "Language set to English.",

  welcome:
    "🛰 Multi-EVM Migration Tracker\n" +
    "\n" +
    "Scans every new contract on 12 EVM networks for token-migration mechanisms (auto-discovery), keeps only those whose old token has a real DEX market (OKX executable-route test), and alerts here. Tracked projects' wallets get priority alerts.\n" +
    "\n" +
    "Commands:\n" +
    "/add_token <network> <address> — priority tracking: watch this token's owner/dev wallets\n" +
    "/list — tracked tokens and their owners (paginated)\n" +
    "/remove_token <address> — stop tracking a token (asks to confirm)\n" +
    "/add_owner <network> <token> <owner> — manually link an extra wallet (dev, multisig) to a tracked token\n" +
    "/remove_owner <network> <token> <owner> — unlink a manually-added wallet\n" +
    "/analyze <network> <deploy_tx_hash> — check any already-deployed contract for migration signs\n" +
    "/settings — toggle which confidence level / networks alert this chat\n" +
    "/language — change the bot's language\n" +
    "/status — bot health per network (admins only)\n" +
    "/custodians, /add_custodian, /remove_custodian — RWA deployer registry (admins only)\n" +
    "/help — show this message again",

  "approval.pending": "🔒 Your access request has been sent to the administrator. You'll get a message here once it's approved.",
  "approval.stillPending": "🔒 Still waiting for administrator approval.",
  "approval.granted": "✅ You've been approved! Send /help to see what you can do.",
  "approval.deniedNotice": "🚫 Access denied by an administrator.",
  "approval.blocked": "🔒 This bot requires administrator approval before use. Send /start to request access.",
  "approval.adminRequest":
    "🆕 New access request\nChat: {title}\nChat ID: {chatId}\nUsername: {username}\nLanguage: {language}",
  "approval.approveButton": "✅ Approve",
  "approval.rejectButton": "🚫 Reject",
  "approval.approvedByAdmin": "✅ Approved {chatId}.",
  "approval.rejectedByAdmin": "🚫 Rejected {chatId}.",

  "addToken.usage": "Usage: /add_token <network> <token_a_address>\nSupported networks: {networks}",
  "addToken.unknownNetwork": 'Unknown network "{network}". Supported: {networks}',
  "addToken.invalidAddress": '"{address}" is not a valid EVM address.',
  "addToken.lookingUp": "Looking up {address} on {network}...",
  "addToken.success": "✅ Now tracking {symbol} ({address}) on {network}.\n\nDiscovered owners/admins:\n{owners}",
  "addToken.refreshed": "ℹ️ {symbol} ({address}) on {network} is already tracked — owners re-checked.\n\nDiscovered owners/admins:\n{owners}",
  "analyze.usage": "Usage: /analyze <network> <deploy_tx_hash> [token_a_address]\nTake the hash of the transaction that created the contract — on the explorer's contract page it's linked in the \"Contract Creator\" field.\nSupported networks: {networks}",
  "analyze.invalidHash": "\"{hash}\" is not a transaction hash (0x followed by 64 hex characters).",
  "analyze.working": "🔎 Analyzing {hash} on {network}...",
  "analyze.notFound": "Transaction {hash} was not found on {network} — check the network and the hash.",
  "analyze.reverted": "That transaction failed (reverted), so it didn't create a contract.",
  "analyze.noContract": "That transaction didn't create a contract. If it deployed one through a factory, the {network} RPC must support debug_traceTransaction for the bot to see it.",
  "analyze.failed": "Analysis failed: {error}",
  "addToken.ownersNone": "  • None found automatically — you can link wallets manually later.",
  "addToken.defaultSymbol": "token",

  "list.empty": "No tokens are being tracked yet. Add one with /add_token <network> <address>.",
  "list.header": "Tracked tokens (page {page}/{pageCount}):",
  "list.ownersLabel": "  Owners/admins:",
  "list.ownersNone": "    • none found",
  "list.prevButton": "◀️ Prev",
  "list.nextButton": "Next ▶️",

  "removeToken.usage": "Usage: /remove_token <token_a_address>",
  "removeToken.notTracked": "{address} was not being tracked.",
  "removeToken.confirmPrompt":
    "Remove {address} from tracking? This also drops its discovered owners and any migration contracts found for it.",
  "removeToken.confirmButton": "✅ Confirm",
  "removeToken.cancelButton": "✖️ Cancel",
  "removeToken.removed": "🗑 Removed {address} ({count} network {entries}).",
  "removeToken.entriesWord": "entries",
  "removeToken.alreadyRemoved": "{address} was not being tracked (already removed?).",
  "removeToken.cancelled": "Cancelled — token is still tracked.",

  "addOwner.usage": "Usage: /add_owner <network> <token_a_address> <owner_address>\nSupported networks: {networks}",
  "ownerAddress.invalid": "Both the token and owner addresses must be valid EVM addresses.",
  "addOwner.tokenNotTracked": "{address} on {network} isn't tracked yet — add it first with /add_token.",
  "addOwner.linked": "✅ Linked {owner} to {symbol} as a manually-added owner.",

  "removeOwner.usage":
    "Usage: /remove_owner <network> <token_a_address> <owner_address>\nSupported networks: {networks}",
  "removeOwner.tokenNotTracked": "{address} on {network} isn't tracked.",
  "removeOwner.unlinked": "🗑 Unlinked {owner} from {symbol}.",
  "removeOwner.notLinked": "{owner} wasn't linked to {symbol}.",

  "settings.title": "⚙️ Settings",
  "settings.confidenceLabel": "Confidence filter: {filter}",
  "settings.networksLabel": "Networks: {networks}",
  "settings.networksAll": "all",
  "settings.buttonAllConfidence": "All confidence",
  "settings.buttonHighOnly": "HIGH only",
  "settings.buttonAllNetworks": "All networks",
  "settings.cbConfidenceSet": "Confidence: {filter}",
  "settings.cbUnknownNetwork": "Unknown network",
  "settings.autoLabel": "Auto-discovery alerts (all new contracts): {state}",
  "settings.liquidityLabel": "Liquidity test for auto alerts: {level}",
  "settings.on": "on",
  "settings.off": "off",
  "settings.buttonAutoOn": "Auto-discovery on",
  "settings.buttonAutoOff": "Tracked tokens only",
  "settings.levelStrict": "Strict",
  "settings.levelLowCap": "Low-Cap",
  "settings.levelDeep": "Deep",

  "card.title": "MIGRATION CONTRACT DETECTED",
  "card.titleManual": "CONTRACT ANALYSIS",
  "card.titleUpdate": "MIGRATION CONTRACT UPDATE",
  "card.updateNote": "Re-checked after deploy: the contract has been configured since the first alert.",
  "card.tokenAUnknown": "not specified",
  "card.contract": "Contract:",
  "card.network": "Network",
  "card.tokenA": "Token A",
  "card.creator": "Creator",
  "card.deployerOwner": "Deployer / Owner",
  "card.newContract": "New migration contract:",
  "card.targetToken": "Target token (Token B):",
  "card.notSetYet": "not set yet",
  "card.tokenARefNote": "the constructor references Token A",
  "card.foundIn": "Found in",
  "card.sourceStaticCall": "variable {getter}",
  "card.sourceConstructor": "the constructor",
  "card.analysisStatus": "Analysis status",
  "card.confidenceWord": "CONFIDENCE",
  "card.foundSignals": "Found",
  "card.functionWord": "Function",
  "card.moreFunctions": "+{count} more",
  "card.eventWord": "Event",
  "card.variableWord": "variable",
  "card.noSignals": "no explicit signals found",
  "card.sourceAuto": "Auto-discovery: found in a scan of all new contracts",
  "card.sourceCustodian": "Deployed by RWA custodian {label}",
  "card.sourceSelf": "the contract itself (it is the new token)",
  "card.sourceBytecode": "the contract code (hard-coded address)",
  "card.unverifiedNote": "ticker only, no contract address — not matched to any token",
  "card.liquidity": "Liquidity (OKX)",
  "card.liquidityUnchecked": "not checked: {reason}",
  "custodians.header": "RWA custodians (their deployments skip the DEX liquidity filter):",
  "custodians.empty": "No RWA custodians registered. Add one: /add_custodian <network> <deployer_address> <label>",
  "custodians.addUsage": "Usage: /add_custodian <network> <deployer_address> <label>\nNetworks: {networks}",
  "custodians.removeUsage": "Usage: /remove_custodian <network> <deployer_address>",
  "custodians.added": "✅ {label} ({network}, {address}) registered as an RWA custodian.",
  "custodians.removed": "🗑 {address} removed from RWA custodians.",
  "custodians.notFound": "{address} is not a registered custodian on that network.",
  "status.auto": "🛰 Auto-discovery: new contracts {creations} · migration candidates {candidates} · dropped by liquidity {liquidity} · found {alerts} · queued {waiting}",
  "status.autoOff": "🛰 Auto-discovery: off (AUTO_DISCOVERY=false)",
  "status.autoPaused": "🛰 Auto-discovery: PAUSED — set OKX_API_KEY / OKX_SECRET_KEY / OKX_API_PASSPHRASE to start it (without the liquidity filter its alerts couldn't be sent, so it doesn't spend RPC meanwhile)",
  "status.okxOn": "💧 OKX liquidity API: configured",
  "status.okxOff": "💧 OKX liquidity API: NOT configured — auto-discovered alerts are held back until OKX_API_KEY / OKX_SECRET_KEY / OKX_API_PASSPHRASE are set",
  "status.blockTrace": "block trace: {state}",
  "status.traceUntested": "not tried yet",
  "card.links": "Links:",

  "owners.more": "… and {count} more",
  "owners.refreshedNew": "🔄 {symbol} on {network}: new owner/admin wallets found and now watched:\n{owners}",

  "status.adminOnly": "This command is available to administrators only.",
  "status.title": "📡 Bot status",
  "status.uptime": "⏱ Uptime: {uptime}",
  "status.counts": "🪙 Tokens: {tokens} · wallets: {owners} · contracts found: {contracts}",
  "status.queue": "📬 Analysis queue: waiting {waiting} · running {active} · re-checks scheduled {delayed} · failed {failed}",
  "status.networks": "Networks:",
  "status.none": "no networks enabled",
  "status.notStarted": "listener not running",
  "status.noBlocks": "no blocks processed yet",
  "status.block": "block {block}",
  "status.lag": "lag {lag}",
  "status.headUnknown": "head unavailable",
  "status.ago": "{ago} ago",
  "status.trace": "factory trace: {state}",
  "status.traceOn": "on",
  "status.traceUnavailable": "unavailable on this RPC",
  "status.traceOff": "off",
  "status.skipped": "skipped after downtime: {count}",
  "status.failedBlocks": "failed blocks: {count}",
  "status.restarts": "block feed restarted after a stall: {count}",
  "status.lastError": "last error {ago} ago: {error}",
};

const uk: Dict = {
  "lang.prompt": "Будь ласка, оберіть мову.",
  "lang.chosen": "Мову встановлено: українська.",

  welcome:
    "🛰 Multi-EVM Migration Tracker\n" +
    "\n" +
    "Сканує всі нові контракти в 12 EVM-мережах у пошуках механізмів міграції токенів (автопошук), залишає лише ті, де старий токен має реальний DEX-ринок (перевірка маршруту через OKX), і надсилає алерти сюди. Гаманці відстежуваних проєктів — пріоритетні алерти.\n" +
    "\n" +
    "Команди:\n" +
    "/add_token <мережа> <адреса> — пріоритетне стеження за гаманцями власника/розробників токена\n" +
    "/list — список відстежуваних токенів та їх власників (з пагінацією)\n" +
    "/remove_token <адреса> — прибрати токен з відстеження (з підтвердженням)\n" +
    "/add_owner <мережа> <токен> <власник> — вручну прив'язати гаманець (розробник, мультисиг) до токена\n" +
    "/remove_owner <мережа> <токен> <власник> — відв'язати вручну доданий гаманець\n" +
    "/analyze <мережа> <хеш_деплою> — перевірити будь-який уже задеплоєний контракт на ознаки міграції\n" +
    "/settings — перемкнути рівень впевненості / мережі для алертів у цьому чаті\n" +
    "/language — змінити мову бота\n" +
    "/status — стан бота по мережах (лише для адмінів)\n" +
    "/custodians, /add_custodian, /remove_custodian — реєстр RWA-деплоєрів (лише для адмінів)\n" +
    "/help — показати це повідомлення знову",

  "approval.pending": "🔒 Запит на доступ надіслано адміністратору. Ви отримаєте повідомлення тут, коли його схвалять.",
  "approval.stillPending": "🔒 Все ще очікує на схвалення адміністратора.",
  "approval.granted": "✅ Вас схвалено! Надішліть /help, щоб побачити, що можна робити.",
  "approval.deniedNotice": "🚫 У доступі відмовлено адміністратором.",
  "approval.blocked": "🔒 Цей бот вимагає схвалення адміністратора перед використанням. Надішліть /start, щоб надіслати запит.",
  "approval.adminRequest":
    "🆕 Новий запит на доступ\nЧат: {title}\nID чату: {chatId}\nЮзернейм: {username}\nМова: {language}",
  "approval.approveButton": "✅ Схвалити",
  "approval.rejectButton": "🚫 Відхилити",
  "approval.approvedByAdmin": "✅ Схвалено {chatId}.",
  "approval.rejectedByAdmin": "🚫 Відхилено {chatId}.",

  "addToken.usage": "Використання: /add_token <мережа> <адреса_токена_A>\nПідтримувані мережі: {networks}",
  "addToken.unknownNetwork": 'Невідома мережа "{network}". Підтримувані: {networks}',
  "addToken.invalidAddress": '"{address}" не є коректною EVM-адресою.',
  "addToken.lookingUp": "Шукаю {address} у мережі {network}...",
  "addToken.success": "✅ Тепер відстежую {symbol} ({address}) у мережі {network}.\n\nЗнайдені власники/адміни:\n{owners}",
  "addToken.refreshed": "ℹ️ {symbol} ({address}) у мережі {network} вже відстежується — власників перевірено заново.\n\nЗнайдені власники/адміни:\n{owners}",
  "analyze.usage": "Використання: /analyze <мережа> <хеш_транзакції_деплою> [адреса_токена_A]\nВізьміть хеш транзакції, яка створила контракт — на сторінці контракту в експлорері він у полі \"Contract Creator\".\nПідтримувані мережі: {networks}",
  "analyze.invalidHash": "\"{hash}\" не є хешем транзакції (0x і 64 шістнадцяткові символи).",
  "analyze.working": "🔎 Аналізую {hash} у мережі {network}...",
  "analyze.notFound": "Транзакцію {hash} не знайдено в мережі {network} — перевірте мережу та хеш.",
  "analyze.reverted": "Ця транзакція завершилася з помилкою (reverted), тож контракт не створила.",
  "analyze.noContract": "Ця транзакція не створила контракт. Якщо контракт створено через фабрику, RPC мережі {network} має підтримувати debug_traceTransaction, щоб бот його побачив.",
  "analyze.failed": "Аналіз не вдався: {error}",
  "addToken.ownersNone": "  • Автоматично нікого не знайдено — гаманці можна прив'язати вручну пізніше.",
  "addToken.defaultSymbol": "токен",

  "list.empty": "Поки що немає відстежуваних токенів. Додайте один через /add_token <мережа> <адреса>.",
  "list.header": "Відстежувані токени (сторінка {page}/{pageCount}):",
  "list.ownersLabel": "  Власники/адміни:",
  "list.ownersNone": "    • нікого не знайдено",
  "list.prevButton": "◀️ Назад",
  "list.nextButton": "Далі ▶️",

  "removeToken.usage": "Використання: /remove_token <адреса_токена_A>",
  "removeToken.notTracked": "{address} не відстежувався.",
  "removeToken.confirmPrompt":
    "Прибрати {address} з відстеження? Це також видалить знайдених власників і будь-які знайдені контракти міграції для нього.",
  "removeToken.confirmButton": "✅ Підтвердити",
  "removeToken.cancelButton": "✖️ Скасувати",
  "removeToken.removed": "🗑 Видалено {address} ({count} записів по мережах).",
  "removeToken.entriesWord": "записів",
  "removeToken.alreadyRemoved": "{address} не відстежувався (вже видалено?).",
  "removeToken.cancelled": "Скасовано — токен усе ще відстежується.",

  "addOwner.usage":
    "Використання: /add_owner <мережа> <адреса_токена_A> <адреса_власника>\nПідтримувані мережі: {networks}",
  "ownerAddress.invalid": "І адреса токена, і адреса власника мають бути коректними EVM-адресами.",
  "addOwner.tokenNotTracked": "{address} у мережі {network} ще не відстежується — спочатку додайте через /add_token.",
  "addOwner.linked": "✅ Прив'язано {owner} до {symbol} як вручну доданого власника.",

  "removeOwner.usage":
    "Використання: /remove_owner <мережа> <адреса_токена_A> <адреса_власника>\nПідтримувані мережі: {networks}",
  "removeOwner.tokenNotTracked": "{address} у мережі {network} не відстежується.",
  "removeOwner.unlinked": "🗑 Відв'язано {owner} від {symbol}.",
  "removeOwner.notLinked": "{owner} не був прив'язаний до {symbol}.",

  "settings.title": "⚙️ Налаштування",
  "settings.confidenceLabel": "Фільтр впевненості: {filter}",
  "settings.networksLabel": "Мережі: {networks}",
  "settings.networksAll": "усі",
  "settings.buttonAllConfidence": "Всі рівні",
  "settings.buttonHighOnly": "Лише HIGH",
  "settings.buttonAllNetworks": "Усі мережі",
  "settings.cbConfidenceSet": "Впевненість: {filter}",
  "settings.cbUnknownNetwork": "Невідома мережа",
  "settings.autoLabel": "Алерти автопошуку (усі нові контракти): {state}",
  "settings.liquidityLabel": "Тест ліквідності для автоалертів: {level}",
  "settings.on": "увімк.",
  "settings.off": "вимк.",
  "settings.buttonAutoOn": "Автопошук увімк.",
  "settings.buttonAutoOff": "Лише мої токени",
  "settings.levelStrict": "Strict",
  "settings.levelLowCap": "Low-Cap",
  "settings.levelDeep": "Deep",

  "card.title": "ВИЯВЛЕНО КОНТРАКТ МІГРАЦІЇ",
  "card.titleManual": "АНАЛІЗ КОНТРАКТУ",
  "card.titleUpdate": "ОНОВЛЕННЯ КОНТРАКТУ МІГРАЦІЇ",
  "card.updateNote": "Повторна перевірка після деплою: контракт налаштували після першого сповіщення.",
  "card.tokenAUnknown": "не вказано",
  "card.contract": "Контракт:",
  "card.network": "Мережа",
  "card.tokenA": "Токен A",
  "card.creator": "Створювач",
  "card.deployerOwner": "Deployer / Owner",
  "card.newContract": "Новий контракт міграції:",
  "card.targetToken": "Цільовий токен (Token B):",
  "card.notSetYet": "ще не задано",
  "card.tokenARefNote": "конструктор посилається на Token A",
  "card.foundIn": "Знайдено в",
  "card.sourceStaticCall": "змінній {getter}",
  "card.sourceConstructor": "конструкторі",
  "card.analysisStatus": "Статус аналізу",
  "card.confidenceWord": "CONFIDENCE",
  "card.foundSignals": "Знайдено",
  "card.functionWord": "Функція",
  "card.moreFunctions": "ще {count}",
  "card.eventWord": "Подія",
  "card.variableWord": "змінна",
  "card.noSignals": "явних ознак не знайдено",
  "card.sourceAuto": "Автопошук: знайдено при скануванні всіх нових контрактів",
  "card.sourceCustodian": "Задеплоєно RWA-кастодіаном {label}",
  "card.sourceSelf": "самому контракті (це і є новий токен)",
  "card.sourceBytecode": "коді контракту (зашита адреса)",
  "card.unverifiedNote": "лише тикер, без адреси контракту — ні з яким токеном не зіставлено",
  "card.liquidity": "Ліквідність (OKX)",
  "card.liquidityUnchecked": "не перевірено: {reason}",
  "custodians.header": "RWA-кастодіани (їхні деплої не проходять DEX-фільтр ліквідності):",
  "custodians.empty": "RWA-кастодіанів ще немає. Додати: /add_custodian <мережа> <адреса_деплоєра> <назва>",
  "custodians.addUsage": "Використання: /add_custodian <мережа> <адреса_деплоєра> <назва>\nМережі: {networks}",
  "custodians.removeUsage": "Використання: /remove_custodian <мережа> <адреса_деплоєра>",
  "custodians.added": "✅ {label} ({network}, {address}) додано як RWA-кастодіана.",
  "custodians.removed": "🗑 {address} прибрано з RWA-кастодіанів.",
  "custodians.notFound": "{address} не зареєстрований як кастодіан у цій мережі.",
  "status.auto": "🛰 Автопошук: нових контрактів {creations} · кандидатів у міграції {candidates} · відсіяно за ліквідністю {liquidity} · знайдено {alerts} · у черзі {waiting}",
  "status.autoOff": "🛰 Автопошук: вимк. (AUTO_DISCOVERY=false)",
  "status.autoPaused": "🛰 Автопошук: НА ПАУЗІ — задайте OKX_API_KEY / OKX_SECRET_KEY / OKX_API_PASSPHRASE, щоб запустити (без фільтра ліквідності його алерти не можна надіслати, тож він не витрачає RPC)",
  "status.okxOn": "💧 OKX API ліквідності: налаштовано",
  "status.okxOff": "💧 OKX API ліквідності: НЕ налаштовано — алерти автопошуку затримуються, доки не задано OKX_API_KEY / OKX_SECRET_KEY / OKX_API_PASSPHRASE",
  "status.blockTrace": "трасування блоків: {state}",
  "status.traceUntested": "ще не перевірялось",
  "card.links": "Посилання:",

  "owners.more": "… і ще {count}",
  "owners.refreshedNew": "🔄 {symbol} у мережі {network}: знайдено нові гаманці власників/адмінів, тепер вони відстежуються:\n{owners}",

  "status.adminOnly": "Ця команда доступна лише адміністраторам.",
  "status.title": "📡 Стан бота",
  "status.uptime": "⏱ Працює: {uptime}",
  "status.counts": "🪙 Токенів: {tokens} · гаманців: {owners} · знайдено контрактів: {contracts}",
  "status.queue": "📬 Черга аналізу: очікують {waiting} · в роботі {active} · заплановано перевірок {delayed} · з помилкою {failed}",
  "status.networks": "Мережі:",
  "status.none": "жодної мережі не ввімкнено",
  "status.notStarted": "слухач не запущений",
  "status.noBlocks": "ще не оброблено жодного блоку",
  "status.block": "блок {block}",
  "status.lag": "відставання {lag}",
  "status.headUnknown": "поточний блок недоступний",
  "status.ago": "{ago} тому",
  "status.trace": "трасування фабрик: {state}",
  "status.traceOn": "увімк.",
  "status.traceUnavailable": "недоступне на цьому RPC",
  "status.traceOff": "вимк.",
  "status.skipped": "пропущено після простою: {count}",
  "status.failedBlocks": "блоків з помилкою: {count}",
  "status.restarts": "потік блоків перезапущено після зависання: {count}",
  "status.lastError": "остання помилка {ago} тому: {error}",
};

const ru: Dict = {
  "lang.prompt": "Пожалуйста, выберите язык.",
  "lang.chosen": "Язык установлен: русский.",

  welcome:
    "🛰 Multi-EVM Migration Tracker\n" +
    "\n" +
    "Сканирует все новые контракты в 12 EVM-сетях в поисках механизмов миграции токенов (автопоиск), оставляет только те, где у старого токена есть реальный DEX-рынок (проверка маршрута через OKX), и присылает алерты сюда. Кошельки отслеживаемых проектов — приоритетные алерты.\n" +
    "\n" +
    "Команды:\n" +
    "/add_token <сеть> <адрес> — приоритетное слежение за кошельками владельца/разработчиков токена\n" +
    "/list — список отслеживаемых токенов и их владельцев (с пагинацией)\n" +
    "/remove_token <адрес> — убрать токен из отслеживания (с подтверждением)\n" +
    "/add_owner <сеть> <токен> <владелец> — вручную привязать кошелёк (разработчик, мультисиг) к токену\n" +
    "/remove_owner <сеть> <токен> <владелец> — отвязать вручную добавленный кошелёк\n" +
    "/analyze <сеть> <хеш_деплоя> — проверить любой уже задеплоенный контракт на признаки миграции\n" +
    "/settings — переключить уровень уверенности / сети для алертов в этом чате\n" +
    "/language — сменить язык бота\n" +
    "/status — состояние бота по сетям (только для админов)\n" +
    "/custodians, /add_custodian, /remove_custodian — реестр RWA-деплоеров (только для админов)\n" +
    "/help — показать это сообщение снова",

  "approval.pending": "🔒 Запрос на доступ отправлен администратору. Вы получите сообщение здесь, когда его одобрят.",
  "approval.stillPending": "🔒 Всё ещё ожидает одобрения администратора.",
  "approval.granted": "✅ Вы одобрены! Отправьте /help, чтобы увидеть, что можно делать.",
  "approval.deniedNotice": "🚫 В доступе отказано администратором.",
  "approval.blocked": "🔒 Этот бот требует одобрения администратора перед использованием. Отправьте /start, чтобы запросить доступ.",
  "approval.adminRequest":
    "🆕 Новый запрос на доступ\nЧат: {title}\nID чата: {chatId}\nЮзернейм: {username}\nЯзык: {language}",
  "approval.approveButton": "✅ Одобрить",
  "approval.rejectButton": "🚫 Отклонить",
  "approval.approvedByAdmin": "✅ Одобрено {chatId}.",
  "approval.rejectedByAdmin": "🚫 Отклонено {chatId}.",

  "addToken.usage": "Использование: /add_token <сеть> <адрес_токена_A>\nПоддерживаемые сети: {networks}",
  "addToken.unknownNetwork": 'Неизвестная сеть "{network}". Поддерживаются: {networks}',
  "addToken.invalidAddress": '"{address}" не является корректным EVM-адресом.',
  "addToken.lookingUp": "Ищу {address} в сети {network}...",
  "addToken.success": "✅ Теперь отслеживаю {symbol} ({address}) в сети {network}.\n\nНайденные владельцы/админы:\n{owners}",
  "addToken.refreshed": "ℹ️ {symbol} ({address}) в сети {network} уже отслеживается — владельцы перепроверены.\n\nНайденные владельцы/админы:\n{owners}",
  "analyze.usage": "Использование: /analyze <сеть> <хеш_транзакции_деплоя> [адрес_токена_A]\nВозьмите хеш транзакции, которая создала контракт — на странице контракта в обозревателе он в поле \"Contract Creator\".\nПоддерживаемые сети: {networks}",
  "analyze.invalidHash": "\"{hash}\" не является хешем транзакции (0x и 64 шестнадцатеричных символа).",
  "analyze.working": "🔎 Анализирую {hash} в сети {network}...",
  "analyze.notFound": "Транзакция {hash} не найдена в сети {network} — проверьте сеть и хеш.",
  "analyze.reverted": "Эта транзакция завершилась с ошибкой (reverted), поэтому контракт не создала.",
  "analyze.noContract": "Эта транзакция не создала контракт. Если контракт создан через фабрику, RPC сети {network} должен поддерживать debug_traceTransaction, чтобы бот его увидел.",
  "analyze.failed": "Анализ не удался: {error}",
  "addToken.ownersNone": "  • Автоматически никого не найдено — кошельки можно привязать вручную позже.",
  "addToken.defaultSymbol": "токен",

  "list.empty": "Пока нет отслеживаемых токенов. Добавьте один через /add_token <сеть> <адрес>.",
  "list.header": "Отслеживаемые токены (страница {page}/{pageCount}):",
  "list.ownersLabel": "  Владельцы/админы:",
  "list.ownersNone": "    • никого не найдено",
  "list.prevButton": "◀️ Назад",
  "list.nextButton": "Далее ▶️",

  "removeToken.usage": "Использование: /remove_token <адрес_токена_A>",
  "removeToken.notTracked": "{address} не отслеживался.",
  "removeToken.confirmPrompt":
    "Убрать {address} из отслеживания? Это также удалит найденных владельцев и любые найденные контракты миграции для него.",
  "removeToken.confirmButton": "✅ Подтвердить",
  "removeToken.cancelButton": "✖️ Отмена",
  "removeToken.removed": "🗑 Удалено {address} ({count} записей по сетям).",
  "removeToken.entriesWord": "записей",
  "removeToken.alreadyRemoved": "{address} не отслеживался (уже удалён?).",
  "removeToken.cancelled": "Отменено — токен всё ещё отслеживается.",

  "addOwner.usage":
    "Использование: /add_owner <сеть> <адрес_токена_A> <адрес_владельца>\nПоддерживаемые сети: {networks}",
  "ownerAddress.invalid": "И адрес токена, и адрес владельца должны быть корректными EVM-адресами.",
  "addOwner.tokenNotTracked": "{address} в сети {network} ещё не отслеживается — сначала добавьте через /add_token.",
  "addOwner.linked": "✅ Привязан {owner} к {symbol} как вручную добавленный владелец.",

  "removeOwner.usage":
    "Использование: /remove_owner <сеть> <адрес_токена_A> <адрес_владельца>\nПоддерживаемые сети: {networks}",
  "removeOwner.tokenNotTracked": "{address} в сети {network} не отслеживается.",
  "removeOwner.unlinked": "🗑 Отвязан {owner} от {symbol}.",
  "removeOwner.notLinked": "{owner} не был привязан к {symbol}.",

  "settings.title": "⚙️ Настройки",
  "settings.confidenceLabel": "Фильтр уверенности: {filter}",
  "settings.networksLabel": "Сети: {networks}",
  "settings.networksAll": "все",
  "settings.buttonAllConfidence": "Все уровни",
  "settings.buttonHighOnly": "Только HIGH",
  "settings.buttonAllNetworks": "Все сети",
  "settings.cbConfidenceSet": "Уверенность: {filter}",
  "settings.cbUnknownNetwork": "Неизвестная сеть",
  "settings.autoLabel": "Алерты автопоиска (все новые контракты): {state}",
  "settings.liquidityLabel": "Тест ликвидности для автоалертов: {level}",
  "settings.on": "вкл.",
  "settings.off": "выкл.",
  "settings.buttonAutoOn": "Автопоиск вкл.",
  "settings.buttonAutoOff": "Только мои токены",
  "settings.levelStrict": "Strict",
  "settings.levelLowCap": "Low-Cap",
  "settings.levelDeep": "Deep",

  "card.title": "ОБНАРУЖЕН КОНТРАКТ МИГРАЦИИ",
  "card.titleManual": "АНАЛИЗ КОНТРАКТА",
  "card.titleUpdate": "ОБНОВЛЕНИЕ КОНТРАКТА МИГРАЦИИ",
  "card.updateNote": "Повторная проверка после деплоя: контракт настроили после первого уведомления.",
  "card.tokenAUnknown": "не указан",
  "card.contract": "Контракт:",
  "card.network": "Сеть",
  "card.tokenA": "Токен A",
  "card.creator": "Создатель",
  "card.deployerOwner": "Deployer / Owner",
  "card.newContract": "Новый контракт миграции:",
  "card.targetToken": "Целевой токен (Token B):",
  "card.notSetYet": "ещё не задан",
  "card.tokenARefNote": "конструктор ссылается на Token A",
  "card.foundIn": "Найден в",
  "card.sourceStaticCall": "переменной {getter}",
  "card.sourceConstructor": "конструкторе",
  "card.analysisStatus": "Статус анализа",
  "card.confidenceWord": "CONFIDENCE",
  "card.foundSignals": "Найдено",
  "card.functionWord": "Функция",
  "card.moreFunctions": "ещё {count}",
  "card.eventWord": "Событие",
  "card.variableWord": "переменная",
  "card.noSignals": "явных признаков не найдено",
  "card.sourceAuto": "Автопоиск: найдено при сканировании всех новых контрактов",
  "card.sourceCustodian": "Задеплоено RWA-кастодианом {label}",
  "card.sourceSelf": "самом контракте (это и есть новый токен)",
  "card.sourceBytecode": "коде контракта (зашитый адрес)",
  "card.unverifiedNote": "только тикер, без адреса контракта — ни с каким токеном не сопоставлен",
  "card.liquidity": "Ликвидность (OKX)",
  "card.liquidityUnchecked": "не проверена: {reason}",
  "custodians.header": "RWA-кастодианы (их деплои не проходят DEX-фильтр ликвидности):",
  "custodians.empty": "RWA-кастодианов пока нет. Добавить: /add_custodian <сеть> <адрес_деплоера> <название>",
  "custodians.addUsage": "Использование: /add_custodian <сеть> <адрес_деплоера> <название>\nСети: {networks}",
  "custodians.removeUsage": "Использование: /remove_custodian <сеть> <адрес_деплоера>",
  "custodians.added": "✅ {label} ({network}, {address}) добавлен как RWA-кастодиан.",
  "custodians.removed": "🗑 {address} убран из RWA-кастодианов.",
  "custodians.notFound": "{address} не зарегистрирован как кастодиан в этой сети.",
  "status.auto": "🛰 Автопоиск: новых контрактов {creations} · кандидатов в миграции {candidates} · отсеяно по ликвидности {liquidity} · найдено {alerts} · в очереди {waiting}",
  "status.autoOff": "🛰 Автопоиск: выкл. (AUTO_DISCOVERY=false)",
  "status.autoPaused": "🛰 Автопоиск: НА ПАУЗЕ — задайте OKX_API_KEY / OKX_SECRET_KEY / OKX_API_PASSPHRASE, чтобы запустить (без фильтра ликвидности его алерты нельзя отправить, поэтому он не тратит RPC)",
  "status.okxOn": "💧 OKX API ликвидности: настроен",
  "status.okxOff": "💧 OKX API ликвидности: НЕ настроен — алерты автопоиска придерживаются, пока не заданы OKX_API_KEY / OKX_SECRET_KEY / OKX_API_PASSPHRASE",
  "status.blockTrace": "трассировка блоков: {state}",
  "status.traceUntested": "ещё не проверялась",
  "card.links": "Ссылки:",

  "owners.more": "… и ещё {count}",
  "owners.refreshedNew": "🔄 {symbol} в сети {network}: найдены новые кошельки владельцев/админов, теперь они отслеживаются:\n{owners}",

  "status.adminOnly": "Эта команда доступна только администраторам.",
  "status.title": "📡 Состояние бота",
  "status.uptime": "⏱ Работает: {uptime}",
  "status.counts": "🪙 Токенов: {tokens} · кошельков: {owners} · найдено контрактов: {contracts}",
  "status.queue": "📬 Очередь анализа: ждут {waiting} · в работе {active} · запланировано перепроверок {delayed} · с ошибкой {failed}",
  "status.networks": "Сети:",
  "status.none": "ни одна сеть не включена",
  "status.notStarted": "слушатель не запущен",
  "status.noBlocks": "ещё не обработано ни одного блока",
  "status.block": "блок {block}",
  "status.lag": "отставание {lag}",
  "status.headUnknown": "текущий блок недоступен",
  "status.ago": "{ago} назад",
  "status.trace": "трассировка фабрик: {state}",
  "status.traceOn": "вкл.",
  "status.traceUnavailable": "недоступна на этом RPC",
  "status.traceOff": "выкл.",
  "status.skipped": "пропущено после простоя: {count}",
  "status.failedBlocks": "блоков с ошибкой: {count}",
  "status.restarts": "поток блоков перезапущен после зависания: {count}",
  "status.lastError": "последняя ошибка {ago} назад: {error}",
};

export const translations: Record<Language, Dict> = { en, uk, ru };
