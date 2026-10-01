// Telegram notifications (admin ops channel). BEST-EFFORT ONLY:
//   * never throws — returns a boolean,
//   * 4-second timeout on the network call,
//   * ONE console.warn per process when not configured,
//   * text is cut to Telegram's 4096-character limit.
// fetchImpl is injectable so tests run offline.
let warnedMissing = false;

export function telegramConfig() {
  const env = (globalThis.process?.env || {});
  return {
    token: String(env.TELEGRAM_BOT_TOKEN || '').trim(),
    chatId: String(env.TELEGRAM_CHAT_ID || '').trim(),
  };
}

export function telegramConfigured(cfg = telegramConfig()) {
  return Boolean(cfg.token && cfg.chatId);
}

export async function sendTelegramMessage(text, { cfg = telegramConfig(), fetchImpl = globalThis.fetch } = {}) {
  try {
    if (!cfg.token || !cfg.chatId) {
      if (!warnedMissing) {
        warnedMissing = true;
        console.warn('[telegram] skipped: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set in Vercel.');
      }
      return false;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    let response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.chatId, text: String(text ?? '').slice(0, 4096) }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      console.error(`[telegram] sendMessage responded ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    // Network error, timeout, abort — NEVER propagate to the caller.
    console.error('[telegram] sendMessage failed:', error?.message || error);
    return false;
  }
}
