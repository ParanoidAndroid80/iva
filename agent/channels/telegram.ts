import { telegramChannel, type TelegramMessageBody } from "eve/channels/telegram";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Разметка Telegram — ЕДИНЫЙ источник правды (тот же модуль, что у cron-скриптов).
// toTelegramHtmlChunks: markdown → массив готовых, сбалансированных HTML-чанков ≤limit
// (гарантирует длину ПОСЛЕ конвертации). htmlToPlain: декодирующий plain-фолбэк.
import { toTelegramHtmlChunks, htmlToPlain } from "../../scripts/lib/telegram-format.mjs";

// Токен (TELEGRAM_BOT_TOKEN) и секрет вебхука (TELEGRAM_WEBHOOK_SECRET_TOKEN)
// читаются из окружения автоматически.
//
// БЕЗОПАСНОСТЬ: бот отвечает ТОЛЬКО доверенным Telegram user ID из
// TELEGRAM_ALLOWED_USER_IDS (через запятую). Это личный ассистент с приватными
// данными — без allowlist кто угодно мог бы вытащить их. Fail-closed: если список
// пуст, не пускается никто.
const ALLOWED = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean),
);

// Повторяет дефолтную логику диспатча eve (приваты — всегда; группы — только
// команда/упоминание/ответ боту; боты и каналы игнорируются).
function isBotCommand(text: string, bot?: string): boolean {
  const m = /^\/(?<command>[A-Za-z0-9_]+)(?:@(?<target>[A-Za-z0-9_]+))?(?:\s|$)/u.exec(text);
  if (!m) return false;
  const target = m.groups?.target;
  return target === undefined ? true : bot !== undefined && target.toLowerCase() === bot.toLowerCase();
}
function shouldDispatch(msg: any, bot?: string): boolean {
  if (msg.from?.isBot === true || msg.chat.type === "channel") return false;
  const text: string = msg.text || msg.caption || "";
  if (!(text.trim().length > 0 || msg.attachments.length > 0)) return false;
  return (
    msg.chat.type === "private" ||
    msg.replyToMessage?.from?.isBot === true ||
    isBotCommand(text, bot) ||
    (bot !== undefined && text.toLowerCase().includes(`@${bot.toLowerCase()}`))
  );
}

// Для медиа text/attachments пусты (eve не парсит голос/видео в attachments),
// поэтому обычный shouldDispatch их всегда отбрасывает (строка с проверкой длины).
// Гейтим по чату: личка — всегда; группа/супергруппа — только реплай боту,
// команда или @упоминание в подписи. Иначе в группе чужой голос ушёл бы в Deepgram.
function shouldDispatchMedia(msg: any, bot?: string): boolean {
  if (msg.from?.isBot === true || msg.chat.type === "channel") return false;
  if (msg.chat.type === "private") return true;
  const caption: string = msg.caption || "";
  return (
    msg.replyToMessage?.from?.isBot === true ||
    isBotCommand(caption, bot) ||
    (bot !== undefined && caption.toLowerCase().includes(`@${bot.toLowerCase()}`))
  );
}

// Воспроизводит дефолтный auth-контекст eve для Telegram-актора.
function buildAuth(msg: any) {
  const u = msg.from;
  if (!u) return null;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const attributes: Record<string, string> = {
    chat_id: msg.chat.id,
    chat_type: msg.chat.type,
    message_id: msg.messageId,
    user_id: u.id,
  };
  if (msg.chat.title !== undefined) attributes.chat_title = msg.chat.title;
  if (msg.messageThreadId !== undefined) attributes.message_thread_id = String(msg.messageThreadId);
  if (u.username !== undefined) attributes.username = u.username;
  return {
    attributes,
    authenticator: "telegram-webhook",
    issuer: isGroup ? `telegram:${msg.chat.id}` : "telegram",
    principalId: isGroup ? `telegram:${msg.chat.id}:${u.id}` : `telegram:${u.id}`,
    principalType: u.isBot ? "service" : "user",
  };
}

// --- Сырой транскрипт: дозапись реплики в дневной файл vault ---
//
// Тот же крошечный хелпер продублирован в agent/hooks/transcript.ts — выносить в
// общий модуль не стали из-за тривиальности (это пара fs-вызовов), а НЕ из-за бандла:
// импорт из scripts/lib в бандл работает (см. telegram-format.mjs). Формат d_brain:
// `## HH:MM [type]` + контент.
// Дата/время — в часовом поясе пользователя (ASSISTANT_TIMEZONE, иначе локальный TZ).
function localStamp(): { date: string; hhmm: string; hhmmss: string } {
  const tz = process.env.ASSISTANT_TIMEZONE || undefined;
  const now = new Date();
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const hhmm = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const hhmmss = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(now)
    .replace(/:/g, "");
  return { date, hhmm, hhmmss };
}

function appendDaily(type: string, content: string): void {
  const { date, hhmm } = localStamp();
  const dir = join(process.env.ASSISTANT_VAULT_DIR || "vault", "daily");
  mkdirSync(dir, { recursive: true });
  // Append-only: существующие записи никогда не переписываются.
  appendFileSync(join(dir, `${date}.md`), `\n## ${hhmm} ${type}\n${content}\n`, "utf8");
}

// --- Файловые вложения (фото/документы любого типа, включая docx/pdf) ---
//
// eve парсит фото/документы в message.attachments (kind: photo|document) и по
// uploadPolicy сам отдаёт модели pdf/изображения нативно. Но БЛОБ на диск не пишет
// и ССЫЛКУ в daily не ставит — делаем это сами: сохраняем в vault/attachments/<date>/,
// пишем Obsidian-embed в daily, путь отдаём Iva. docx/прочее Iva читает через host-bash.

// getFile → скачивание байтов. Возвращает байты, либо признак >20MB, либо null.
async function fetchTelegramFile(
  request: (method: string, body?: { file_id: string }) => Promise<{ body: unknown }>,
  fileId: string,
): Promise<{ bytes: ArrayBuffer } | { tooBig: true } | null> {
  const r = await request("getFile", { file_id: fileId });
  const body = r.body as { result?: { file_path?: string }; description?: string } | null;
  const filePath = body?.result?.file_path;
  if (!filePath) {
    if (/too big/i.test(String(body?.description ?? ""))) return { tooBig: true };
    return null;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const dl = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!dl.ok) return null;
  return { bytes: await dl.arrayBuffer() };
}

// Расширение из имени → mediaType → дефолт по виду.
function attExt(name: string | undefined, mediaType: string | undefined, kind: string): string {
  const m = name && /\.([a-z0-9]{1,8})$/i.exec(name);
  if (m) return m[1].toLowerCase();
  const sub = mediaType?.includes("/") ? mediaType.split("/")[1] : "";
  if (/^[a-z0-9.+-]{1,8}$/i.test(sub)) return sub.toLowerCase().replace("+xml", "");
  return kind === "photo" ? "jpg" : "bin";
}

// Сохраняет блоб в vault/attachments/<date>/<name>, возвращает rel-путь для Obsidian-embed.
// Имя берём из присланного (санитизируем), иначе <kind>-<hhmmss>.<ext>; коллизии нумеруем.
function saveBlob(
  bytes: ArrayBuffer,
  name: string | undefined,
  kind: string,
  mediaType: string | undefined,
  stamp: { date: string; hhmmss: string },
): string {
  const ext = attExt(name, mediaType, kind);
  const safe = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/-+$/, "");
  let fname = safe && /\.[a-z0-9]+$/.test(safe) ? safe : `${kind}-${stamp.hhmmss}.${ext}`;
  const dir = join(process.env.ASSISTANT_VAULT_DIR || "vault", "attachments", stamp.date);
  mkdirSync(dir, { recursive: true });
  const dot = fname.lastIndexOf(".");
  const base = dot > 0 ? fname.slice(0, dot) : fname;
  const tail = dot > 0 ? fname.slice(dot) : "";
  let i = 1;
  while (existsSync(join(dir, fname))) fname = `${base}-${i++}${tail}`;
  writeFileSync(join(dir, fname), Buffer.from(bytes));
  return `attachments/${stamp.date}/${fname}`;
}

// --- Deepgram: транскрипция голоса/видео (nova-3, language=multi) ---
//
// Инлайн (НЕ общий модуль — см. выше). Тело — сырые байты, ответ →
// results.channels[0].alternatives[0].transcript.
async function transcribe(audio: ArrayBuffer): Promise<string> {
  const language = process.env.DEEPGRAM_LANGUAGE || "multi";
  const url =
    `https://api.deepgram.com/v1/listen?model=nova-3&language=${language}` +
    `&punctuate=true&smart_format=true`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY ?? ""}`,
      "Content-Type": "application/octet-stream",
    },
    body: audio,
  });
  if (!res.ok) throw new Error(`Deepgram HTTP ${res.status}`);
  const json = (await res.json()) as {
    results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
  };
  return json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
}

// Медиа, которые eve НЕ парсит в attachments (только photo/document) — берём из raw.
// key — поле raw; tag — метка [type] в daily и префикс контекста; transcribe — слать ли в
// Deepgram (анимации/стикеры без речи — нет, только сохраняем оригинал).
const RAW_MEDIA: ReadonlyArray<{ key: string; tag: string; transcribe: boolean }> = [
  { key: "voice", tag: "voice", transcribe: true },
  { key: "audio", tag: "audio", transcribe: true },
  { key: "video", tag: "video", transcribe: true },
  { key: "video_note", tag: "video", transcribe: true },
  { key: "animation", tag: "animation", transcribe: false },
  { key: "sticker", tag: "sticker", transcribe: false },
];

// Telegram file-CDN отдаёт фото/файлы с Content-Type: application/octet-stream. eve берёт
// mediaType вложения из этого заголовка → картинка не распознаётся как image/* и НЕ инлайнится
// в vision-модель (а при узкой uploadPolicy роняла весь ход). Публичного override fetchFile у
// канала нет, но скачивание файла идёт через api.fetch — перехватываем ответ file-эндпоинта и
// выставляем реальный тип по magic-bytes. Прочие вызовы Bot API проходят насквозь.
function sniffMediaType(b: Uint8Array): string | undefined {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
    return "image/webp";
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  return undefined;
}

const telegramFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  if (!/\/file\/bot[^/]+\//.test(url)) return res;
  const ct = res.headers.get("content-type") ?? "";
  if (ct && ct !== "application/octet-stream") return res;
  const ab = await res.arrayBuffer();
  const sniffed = sniffMediaType(new Uint8Array(ab.slice(0, 16)));
  const headers = new Headers(res.headers);
  if (sniffed) headers.set("content-type", sniffed);
  return new Response(ab, { status: res.status, statusText: res.statusText, headers });
};

// Markdown → Telegram HTML и нарезка на чанки — в общем модуле
// scripts/lib/telegram-format.mjs (тот же конвертер использует cron). Импорт выше.

export default telegramChannel({
  botUsername: process.env.TELEGRAM_BOT_USERNAME ?? "my_bot",
  // Исправляем octet-stream от Telegram на реальный тип — иначе картинка не доходит до vision.
  api: { fetch: telegramFetch },
  // "*": не роняем ход ни на каком типе. Картинки/pdf eve инлайнит модели нативно (после
  // починки content-type выше), прочее становится безвредным текст-рефом, а оригинал всё равно
  // кладём в vault сами (ниже). maxBytes = потолок Bot API (>20MB ботам не отдаётся).
  uploadPolicy: {
    allowedMediaTypes: "*",
    maxBytes: 20 * 1024 * 1024,
  },
  events: {
    // Ответ модели → красивый Telegram-HTML. Переопределяет дефолтную plain-доставку
    // eve. Промежуточный текст перед tool-calls не шлём (зеркалим дефолт). Конвертер
    // даёт всегда валидный HTML, поэтому 400 от Telegram практически недостижим — но
    // если случился, НЕ глотаем молча: логируем и шлём один раз plain (теги срезаны,
    // без parse_mode → по сущностям 400 невозможен). Без повторного хода модели — ход
    // уже закрыт, реформат произойдёт на следующем сообщении (ошибка видна в логе/vault).
    async "message.completed"(data, channel) {
      if (data.finishReason === "tool-calls" || !data.message) return;
      // toTelegramHtmlChunks режет на чанки И конвертирует, гарантируя длину каждого
      // чанка ≤4096 ПОСЛЕ конвертации (ручной chunkMarkdown+mdToTelegramHtml мог раздуть
      // чанк тегами за лимит → 400). Пустые чанки не шлём (Telegram отвергает пустой текст).
      for (const html of toTelegramHtmlChunks(data.message, 4096)) {
        if (!html) continue;
        try {
          // eve's TelegramMessageBody type omits parse_mode, но рантайм
          // (normalizeTelegramMessageBody) спредит тело прямо в sendMessage —
          // поле доходит до Telegram, и от него зависит наш HTML-рендер. Расширяем тип локально.
          await channel.telegram.post({
            text: html,
            parse_mode: "HTML",
          } as TelegramMessageBody & { parse_mode: "HTML" });
        } catch (err) {
          console.error("[telegram] HTML отвергнут, шлю plain:", err, "| HTML:", html.slice(0, 300));
          try {
            // htmlToPlain декодирует сущности (&amp;→&), иначе они утекли бы литералами.
            await channel.telegram.post(htmlToPlain(html));
          } catch (e2) {
            console.error("[telegram] plain-фолбэк тоже упал:", e2);
          }
        }
      }
    },
    // Ход упал (в т.ч. переполнение контекста / HookConflict) — даём пользователю escape.
    async "turn.failed"(_data, channel) {
      try {
        await channel.telegram.sendMessage(
          "Ход не удался (возможно, переполнился контекст). Команды: /new — начать заново, /restart — перезапустить.",
        );
      } catch {
        /* молча игнорируем сбой ответа */
      }
    },
  },
  async onMessage(ctx, message) {
    const userId = message.from?.id;

    // 1. Allowlist — главный барьер доступа.
    if (ALLOWED.size === 0 || !userId || !ALLOWED.has(userId)) {
      // Вежливо отвечаем только в личке, чтобы человек мог передать свой ID владельцу.
      if (message.chat.type === "private") {
        const note =
          ALLOWED.size === 0
            ? "Бот ещё не настроен: владельцу нужно добавить Telegram ID в TELEGRAM_ALLOWED_USER_IDS."
            : `Нет доступа. Ваш Telegram ID: ${userId ?? "неизвестен"} — передайте владельцу, чтобы он добавил вас.`;
        try {
          await ctx.telegram.sendMessage(note);
        } catch {
          /* молча игнорируем сбой ответа */
        }
      }
      return null; // дропаем апдейт
    }

    // 1b. Команды, которые роутятся в модель (/help, /restart, /new — обрабатывает поллер-мост
    //     out-of-band и сюда НЕ доставляет; здесь — только те, что нужны модели).
    const cmdText = (message.text || "").trim();
    if (cmdText.startsWith("/")) {
      const cmd = cmdText.split(/\s+/)[0].replace(/@\w+$/, "").toLowerCase();
      const rest = cmdText.slice(cmdText.split(/\s+/)[0].length).trim();
      if (cmd === "/task") {
        appendDaily("[text]", cmdText);
        await ctx.telegram.startTyping();
        return {
          auth: buildAuth(message),
          context: [rest ? `Добавь в список задач: ${rest}` : "Спроси, какую задачу добавить."],
        };
      }
      if (cmd === "/tasks") {
        appendDaily("[text]", cmdText);
        await ctx.telegram.startTyping();
        return { auth: buildAuth(message), context: ["Покажи мой список задач (вызови инструмент tasks)."] };
      }
      if (cmd === "/digest") {
        appendDaily("[text]", cmdText);
        await ctx.telegram.startTyping();
        return { auth: buildAuth(message), context: ["Загрузи скилл morning-digest и собери утренний дайджест."] };
      }
      // прочие команды — пусть отвечает модель обычным ходом (fall through)
    }

    // 2. Сырое медиа (голос/аудио/видео/кружок/анимация/стикер) — eve не парсит их в attachments.
    const raw = message.raw as Record<string, any>;
    let media:
      | { fileId: string; tag: string; transcribe: boolean; mimeType?: string; fileName?: string }
      | null = null;
    for (const m of RAW_MEDIA) {
      const obj = raw[m.key] as { file_id?: string; mime_type?: string; file_name?: string } | undefined;
      if (obj && typeof obj.file_id === "string") {
        media = {
          fileId: obj.file_id,
          tag: m.tag,
          transcribe: m.transcribe,
          mimeType: obj.mime_type,
          fileName: obj.file_name,
        };
        break;
      }
    }

    if (media) {
      // Гейтим медиа как обычный диспатч (в группе — только обращённое к боту).
      if (!shouldDispatchMedia(message, ctx.telegram.botUsername)) return null;
      const tag = `[${media.tag}]`;
      const caption = (message.caption || "").trim();
      const capSuffix = caption ? `\n\n${caption}` : "";
      await ctx.telegram.startTyping();
      try {
        // getFile → скачивание байтов через тот же хелпер, что у вложений (DRY).
        const f = await fetchTelegramFile((m, b) => ctx.telegram.request(m, b), media.fileId);
        if (f && "tooBig" in f) {
          // >20MB Bot API ботам не отдаёт: фиксируем факт + подпись, отвечаем юзеру, дропаем апдейт.
          appendDaily(tag, `(файл >20MB — Telegram не отдаёт его ботам)${capSuffix}`);
          try {
            await ctx.telegram.sendMessage(
              "Файл больше 20 МБ — Telegram не отдаёт такие ботам. " +
                "Подпись сохранил; перешли файл иначе (ссылкой/частями).",
            );
          } catch {
            /* молча игнорируем сбой ответа */
          }
          return null;
        }
        // null = getFile без file_path (не too-big) либо скачивание !ok — общий диагностический фолбэк.
        if (!f) throw new Error("getFile/скачивание не удалось");

        // Сохраняем оригинал ВСЕГДА (буквально всё + оригиналы), потом транскрипт где есть речь.
        const stamp = localStamp();
        const rel = saveBlob(f.bytes, media.fileName, media.tag, media.mimeType, stamp);
        let transcript = "";
        if (media.transcribe) {
          try {
            transcript = (await transcribe(f.bytes)).trim();
          } catch (e) {
            console.error("[telegram] Deepgram упал, оставляю только файл:", e);
          }
        }
        appendDaily(tag, transcript ? `![[${rel}]]\n\n${transcript}${capSuffix}` : `![[${rel}]]${capSuffix}`);

        // Ход модели запускаем только если есть что обсуждать (транскрипт/подпись). Немой
        // стикер/GIF без подписи — сохранили и в лог, без спама ответом.
        if (!transcript && !caption) return null;
        const parts = [`${tag} сохранён: ${rel}`];
        if (transcript) parts.push(`${tag} ${transcript}`);
        if (caption) parts.push(caption);
        return { auth: buildAuth(message), context: parts };
      } catch (err) {
        try {
          await ctx.telegram.sendMessage(
            `Не смог обработать запись: ${String((err as Error).message ?? err).slice(0, 200)}`,
          );
        } catch {
          /* молча игнорируем сбой ответа */
        }
        return null;
      }
    }

    // 2b. Не-файловые типы (локация/контакт/опрос) — буквально всё фиксируем в логе дня.
    // Это чистые данные, файла нет; скачивать нечего, отдельный ход без текста не нужен.
    const nonFile = raw.location
      ? `[location]\t${raw.location.latitude}, ${raw.location.longitude}`
      : raw.contact
        ? `[contact]\t${[raw.contact.first_name, raw.contact.last_name, raw.contact.phone_number]
            .filter(Boolean)
            .join(" ")}`
        : raw.poll
          ? `[poll]\t${raw.poll.question}`
          : null;
    if (nonFile) {
      const [head, body] = nonFile.split("\t");
      appendDaily(head, body);
      if (!(message.text || "").trim()) return null; // нет текста — только лог, без ответа
    }

    // 3. Штатное гейтирование диспатча (текст/фото/документы; в группе — только обращённое к боту).
    if (!shouldDispatch(message, ctx.telegram.botUsername)) return null;

    // 4. Файловые вложения → блоб в vault/attachments + ссылка в daily + путь Iva.
    if (message.attachments.length > 0) {
      await ctx.telegram.startTyping();
      const stamp = localStamp();
      const cap = (message.caption || "").trim();
      const capSuffix = cap ? `\n\n${cap}` : "";
      const saved: string[] = [];
      for (const att of message.attachments) {
        const label = `[${att.kind}]`;
        const named = att.fileName ? ` ${att.fileName}` : "";
        try {
          const f = await fetchTelegramFile(
            (m, b) => ctx.telegram.request(m, b),
            att.fileId,
          );
          if (!f) {
            appendDaily(label, `(не удалось скачать файл${named})${capSuffix}`);
          } else if ("tooBig" in f) {
            appendDaily(label, `(файл >20MB — Telegram не отдаёт ботам${named})${capSuffix}`);
          } else {
            const rel = saveBlob(f.bytes, att.fileName, att.kind, att.mediaType, stamp);
            saved.push(rel);
            // Obsidian-embed: ссылка на сохранённый блоб + подпись.
            appendDaily(label, `![[${rel}]]${capSuffix}`);
          }
        } catch {
          appendDaily(label, `(ошибка обработки файла${named})${capSuffix}`);
        }
      }
      const text = (message.text || "").trim();
      if (text) appendDaily("[text]", text);

      const vaultDir = process.env.ASSISTANT_VAULT_DIR || "vault";
      const note = saved.length
        ? `Пользователь прислал файл(ы): ${saved.join(", ")} (в ${vaultDir}). ` +
          `Изображения и PDF доступны тебе нативно; для docx/прочих форматов извлеки текст через ` +
          `bash (напр. pandoc/pdftotext) по сохранённому пути. Сохрани суть в память по правилам vault.`
        : "";
      return { auth: buildAuth(message), ...(note ? { context: [note] } : {}) };
    }

    // 5. Текстовая реплика юзера → daily.
    const userText = (message.text || "").trim();
    if (userText) appendDaily("[text]", userText);

    await ctx.telegram.startTyping();
    return { auth: buildAuth(message) };
  },
});
