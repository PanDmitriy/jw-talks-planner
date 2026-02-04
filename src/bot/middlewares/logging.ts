/**
 * Логирование входящих обновлений и ошибок для отладки
 */

import type { Context } from 'telegraf';

function formatUpdate(ctx: Context): string {
  const u = ctx.update;
  const from = ctx.from;
  const user = from ? `user=${from.id} @${from.username ?? '?'}` : 'user=?';
  const parts: string[] = [`[${u.update_id}]`, user];

  if ('message' in u && u.message) {
    const msg = u.message as { text?: string; caption?: string };
    if (msg.text) parts.push(`text="${msg.text.slice(0, 80)}${msg.text.length > 80 ? '…' : ''}"`);
    else if (msg.caption) parts.push(`caption="${msg.caption.slice(0, 50)}…"`);
    else parts.push('message');
  } else if ('callback_query' in u && u.callback_query) {
    const data = (u.callback_query as { data?: string }).data ?? '';
    parts.push(`callback="${data.slice(0, 60)}"`);
  } else {
    parts.push(JSON.stringify(Object.keys(u)).slice(0, 40));
  }

  return parts.join(' ');
}

/** Логирует каждое входящее обновление (команда/сообщение/кнопка) */
export async function loggingMiddleware(ctx: Context, next: () => Promise<void>) {
  const line = formatUpdate(ctx);
  console.log('[in]', line);
  const start = Date.now();
  try {
    await next();
    const ms = Date.now() - start;
    if (ms > 500) console.log('[slow]', ms + 'ms', line);
  } catch (err) {
    console.error('[error]', line, err);
    throw err;
  }
}
