#!/usr/bin/env node
// Интерактивная настройка ассистента: ключ Ollama Cloud, выбор актуальной модели,
// (опц.) Telegram. Пишет .env. Без внешних зависимостей.
import { createInterface } from "node:readline/promises";
import { createReadStream } from "node:fs";
import { readFile, writeFile, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const OLLAMA_BASE = "https://ollama.com/v1";

// читаем prompt'ы из tty даже при запуске через `curl | bash`
const input = process.stdin.isTTY ? process.stdin : createReadStream("/dev/tty");
const rl = createInterface({ input, output: process.stdout });
const ask = async (q, def = "") => {
  const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
  return a || def;
};
const askYesNo = async (q, def = false) => {
  const a = (await ask(`${q} (${def ? "Y/n" : "y/N"})`)).toLowerCase();
  return a ? a.startsWith("y") : def;
};

function parseEnv(text) {
  const env = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

async function loadExistingEnv() {
  try {
    await access(ENV_PATH);
    return parseEnv(await readFile(ENV_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function fetchModels(key) {
  const res = await fetch(`${OLLAMA_BASE}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Ollama API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return (json.data || []).map((m) => m.id).sort();
}

async function main() {
  console.log("\n  Настройка ассистента (Ева)\n  ──────────────────────────\n");
  const existing = await loadExistingEnv();
  const out = { ...existing };

  // 1. Ключ Ollama Cloud
  const keyDef = process.env.OLLAMA_API_KEY || existing.OLLAMA_API_KEY || "";
  let key = await ask(
    "Ключ Ollama Cloud (https://ollama.com/settings/keys)",
    keyDef ? keyDef.slice(0, 6) + "…(оставить)" : "",
  );
  if (!key || key.endsWith("…(оставить)")) key = keyDef;
  if (!key) {
    console.error("Ключ обязателен. Прерываю.");
    process.exit(1);
  }
  out.OLLAMA_API_KEY = key;

  // 2. Актуальные модели
  console.log("\n  Запрашиваю актуальные модели у Ollama Cloud…");
  let models;
  try {
    models = await fetchModels(key);
  } catch (e) {
    console.error("  Не удалось получить список моделей:", e.message);
    process.exit(1);
  }
  const RECOMMENDED = "deepseek-v4-pro";
  console.log(`\n  Доступно моделей: ${models.length}\n`);
  models.forEach((id, i) => {
    const mark = id === RECOMMENDED ? "  ★ рекомендуется" : "";
    console.log(`   ${String(i + 1).padStart(2)}. ${id}${mark}`);
  });
  const defIdx = models.indexOf(out.OLLAMA_MODEL || RECOMMENDED);
  const defNum = (defIdx >= 0 ? defIdx : models.indexOf(RECOMMENDED)) + 1 || 1;
  let choice = await ask(`\n  Выбери модель (номер)`, String(defNum));
  let idx = parseInt(choice, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= models.length) idx = defNum - 1;
  out.OLLAMA_MODEL = models[idx];
  console.log(`  → ${out.OLLAMA_MODEL}`);

  out.OLLAMA_CONTEXT_WINDOW = await ask(
    "\n  Размер контекстного окна (токены)",
    out.OLLAMA_CONTEXT_WINDOW || "131072",
  );

  // 3. Telegram (опционально)
  if (await askYesNo("\n  Настроить Telegram-бота сейчас?", Boolean(existing.TELEGRAM_BOT_TOKEN))) {
    out.TELEGRAM_BOT_TOKEN = await ask("  Bot token (@BotFather)", existing.TELEGRAM_BOT_TOKEN || "");
    out.TELEGRAM_BOT_USERNAME = await ask("  Bot username (без @)", existing.TELEGRAM_BOT_USERNAME || "");
    out.TELEGRAM_WEBHOOK_SECRET_TOKEN =
      existing.TELEGRAM_WEBHOOK_SECRET_TOKEN || randomBytes(24).toString("hex");
    console.log(`  webhook secret: ${out.TELEGRAM_WEBHOOK_SECRET_TOKEN} (сгенерирован)`);
    out.TELEGRAM_DIGEST_CHAT_ID = await ask(
      "  Chat ID для дайджеста (можно позже)",
      existing.TELEGRAM_DIGEST_CHAT_ID || "",
    );
  }

  // 4. Прочее
  out.ASSISTANT_DATA_DIR = out.ASSISTANT_DATA_DIR || "data";
  out.ASSISTANT_HOST = out.ASSISTANT_HOST || "http://127.0.0.1:3000";

  // Запись .env
  const order = [
    "OLLAMA_API_KEY", "OLLAMA_MODEL", "OLLAMA_CONTEXT_WINDOW",
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME", "TELEGRAM_WEBHOOK_SECRET_TOKEN",
    "TELEGRAM_DIGEST_CHAT_ID", "ASSISTANT_DATA_DIR", "ASSISTANT_HOST", "ASSISTANT_BEARER",
  ];
  const keys = [...order.filter((k) => out[k] != null), ...Object.keys(out).filter((k) => !order.includes(k))];
  const body = keys.map((k) => `${k}=${out[k]}`).join("\n") + "\n";
  await writeFile(ENV_PATH, body, "utf8");

  console.log(`\n  ✓ Записан ${ENV_PATH}`);
  console.log(`  ✓ Модель: ${out.OLLAMA_MODEL}`);
  console.log(out.TELEGRAM_BOT_TOKEN ? "  ✓ Telegram настроен" : "  • Telegram пропущен");
  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
