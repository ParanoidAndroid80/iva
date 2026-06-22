// VPS cron-runner: спрашивает у агента утренний дайджест и шлёт его в Telegram.
// Запускается из system cron (см. README/implementation-notes).
//
//   0 5 * * *  cd /srv/assistant && node --env-file=.env scripts/daily-digest.ts >> /var/log/assistant-cron.log 2>&1
//
// Требует: запущенный агент (eve start) и переменные TELEGRAM_BOT_TOKEN, TELEGRAM_DIGEST_CHAT_ID.
import { Client } from "eve/client";
import { sendTelegramHtml } from "./lib/telegram-send.mjs";

const PORT = process.env.IVA_PORT ?? "8723";
const HOST = process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${PORT}`;
const BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_DIGEST_CHAT_ID;
const BEARER = process.env.ASSISTANT_BEARER; // нужен, если eve-канал в проде требует auth

if (!BOT || !CHAT) {
  console.error("Нужны TELEGRAM_BOT_TOKEN и TELEGRAM_DIGEST_CHAT_ID");
  process.exit(1);
}

const client = new Client({
  host: HOST,
  ...(BEARER ? { auth: { bearer: async () => BEARER } } : {}),
});

const session = client.session();
const response = await session.send(
  "Загрузи скилл morning-digest и собери утренний дайджест по моим задачам. " +
    "Верни только готовый текст дайджеста, без вступлений.",
);
const result = await response.result();

// Интерактивный ход завершается статусом "waiting" (сессия готова к следующему сообщению),
// поэтому ориентируемся на наличие текста, а не на статус "completed".
if (result.status === "failed" || !result.message) {
  console.error("Агент не вернул дайджест:", result.status);
  process.exit(1);
}

// Конвертация markdown → Telegram-HTML + self-heal живут в общем хелпере.
const r = await sendTelegramHtml(BOT, CHAT, result.message);
if (r.fellBack) {
  await session.send(
    `Прошлый дайджест не прошёл Telegram parse_mode=HTML (${r.error}), ушёл плоским текстом — ` +
      "форматируй проще в следующий раз: **жирный**, `код`, списки, без сырого HTML.",
  );
}
if (!r.ok) {
  console.error("digest: Telegram send failed:", r.error);
  process.exit(1);
}
console.log("Дайджест отправлен в Telegram.");
