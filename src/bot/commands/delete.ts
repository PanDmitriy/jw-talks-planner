/**
 * Команда /delete — удаление публичной речи по ID
 */

import type { Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import type { AuthContext } from '../middlewares/auth';
import { Markup } from 'telegraf';
import { talksRepo } from '../../db';

export function registerDeleteCommand(bot: Telegraf<AuthContext>, db: DatabaseInstance): void {
  const talks = talksRepo(db);
  const pendingDelete = new Map<number, number>(); // userId -> talkId

  bot.command('delete', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;

    const text = (ctx.message as { text?: string })?.text?.trim() ?? '';
    const args = text.split(/\s+/).slice(1);
    const idStr = args[0];
    const talkId = idStr ? parseInt(idStr, 10) : NaN;
    if (isNaN(talkId) || talkId < 1) {
      await ctx.reply('Использование: /delete <id>\nПример: /delete 5\n(ID речи можно посмотреть в /list)');
      return;
    }

    const talk = talks.getById(talkId);
    if (!talk) {
      await ctx.reply('Речь с таким ID не найдена.');
      return;
    }
    if (!ids.includes(talk.congregation_id)) {
      await ctx.reply('Нет доступа к этой речи.');
      return;
    }

    pendingDelete.set(userId, talkId);
    await ctx.reply(
      `Удалить речь #${talkId}?\n${talk.date} — «${talk.title}» (${talk.speaker_name})`,
      Markup.inlineKeyboard([
        Markup.button.callback('Да, удалить', `delete:confirm:${talkId}`),
        Markup.button.callback('Отмена', 'delete:cancel'),
      ])
    );
  });

  bot.action(/^delete:confirm:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const talkId = parseInt(ctx.match[1], 10);
    if (pendingDelete.get(userId) !== talkId) {
      await ctx.answerCbQuery('Сессия изменилась. Выполните /delete снова.');
      return;
    }
    const talk = talks.getById(talkId);
    if (!talk || !ctx.congregationIds?.includes(talk.congregation_id)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    talks.delete(talkId);
    pendingDelete.delete(userId);
    await ctx.editMessageText(`✅ Речь #${talkId} удалена.`);
  });

  bot.action('delete:cancel', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) pendingDelete.delete(userId);
    await ctx.editMessageText('Удаление отменено.');
  });
}
