/**
 * Глобальный fallback для /cancel:
 * если активного пошагового сценария нет, даём понятный ответ.
 */

import type { Telegraf } from 'telegraf';
import type { AuthContext } from '../middlewares/auth';

export function registerCancelCommand(bot: Telegraf<AuthContext>): void {
  bot.on('message', async (ctx, next) => {
    const text = (ctx.message as { text?: string })?.text?.trim();
    if (text !== '/cancel') return next();
    await ctx.reply('Сейчас нет активной операции для отмены.');
  });
}
