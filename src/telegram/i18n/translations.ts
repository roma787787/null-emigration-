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
    "Watches token owners/admins across EVM networks for new contract deployments, and flags the ones that look like a migration into a new token.\n" +
    "\n" +
    "Commands:\n" +
    "/add_token <network> <address> — track a token, auto-discover its owners\n" +
    "/list — tracked tokens and their owners (paginated)\n" +
    "/remove_token <address> — stop tracking a token (asks to confirm)\n" +
    "/add_owner <network> <token> <owner> — manually link an extra wallet (dev, multisig) to a tracked token\n" +
    "/remove_owner <network> <token> <owner> — unlink a manually-added wallet\n" +
    "/settings — toggle which confidence level / networks alert this chat\n" +
    "/language — change the bot's language\n" +
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

  "card.title": "MIGRATION CONTRACT DETECTED",
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
  "card.eventWord": "Event",
  "card.variableWord": "variable",
  "card.noSignals": "no explicit signals found",
  "card.links": "Links:",
};

const uk: Dict = {
  "lang.prompt": "Будь ласка, оберіть мову.",
  "lang.chosen": "Мову встановлено: українська.",

  welcome:
    "🛰 Multi-EVM Migration Tracker\n" +
    "\n" +
    "Стежить за власниками/адмінами токенів у EVM-мережах, шукає нові задеплоєні контракти та позначає ті, що схожі на механізм міграції в новий токен.\n" +
    "\n" +
    "Команди:\n" +
    "/add_token <мережа> <адреса> — почати відстежувати токен, авто-пошук власників\n" +
    "/list — список відстежуваних токенів та їх власників (з пагінацією)\n" +
    "/remove_token <адреса> — прибрати токен з відстеження (з підтвердженням)\n" +
    "/add_owner <мережа> <токен> <власник> — вручну прив'язати гаманець (розробник, мультисиг) до токена\n" +
    "/remove_owner <мережа> <токен> <власник> — відв'язати вручну доданий гаманець\n" +
    "/settings — перемкнути рівень впевненості / мережі для алертів у цьому чаті\n" +
    "/language — змінити мову бота\n" +
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

  "card.title": "ВИЯВЛЕНО КОНТРАКТ МІГРАЦІЇ",
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
  "card.eventWord": "Подія",
  "card.variableWord": "змінна",
  "card.noSignals": "явних ознак не знайдено",
  "card.links": "Посилання:",
};

const ru: Dict = {
  "lang.prompt": "Пожалуйста, выберите язык.",
  "lang.chosen": "Язык установлен: русский.",

  welcome:
    "🛰 Multi-EVM Migration Tracker\n" +
    "\n" +
    "Отслеживает владельцев/админов токенов в EVM-сетях, следит за новыми задеплоенными контрактами и помечает те, что похожи на механизм миграции в новый токен.\n" +
    "\n" +
    "Команды:\n" +
    "/add_token <сеть> <адрес> — начать отслеживать токен, авто-поиск владельцев\n" +
    "/list — список отслеживаемых токенов и их владельцев (с пагинацией)\n" +
    "/remove_token <адрес> — убрать токен из отслеживания (с подтверждением)\n" +
    "/add_owner <сеть> <токен> <владелец> — вручную привязать кошелёк (разработчик, мультисиг) к токену\n" +
    "/remove_owner <сеть> <токен> <владелец> — отвязать вручную добавленный кошелёк\n" +
    "/settings — переключить уровень уверенности / сети для алертов в этом чате\n" +
    "/language — сменить язык бота\n" +
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

  "card.title": "ОБНАРУЖЕН КОНТРАКТ МИГРАЦИИ",
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
  "card.eventWord": "Событие",
  "card.variableWord": "переменная",
  "card.noSignals": "явных признаков не найдено",
  "card.links": "Ссылки:",
};

export const translations: Record<Language, Dict> = { en, uk, ru };
