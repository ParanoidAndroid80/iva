// Типы для telegram-send.mjs — чтобы tsgo-потребители (rollup.ts, daily-digest.ts) не ловили TS7016.
export function sendTelegramHtml(
  bot: string,
  chat: string,
  md: unknown,
  opts?: { caption?: boolean },
): Promise<{ ok: boolean; fellBack: boolean; error: string }>;
