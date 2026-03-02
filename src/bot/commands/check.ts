/**
 * Команда /check — проверка, была ли речь по номеру и когда.
 */

import type { Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import type { AuthContext } from '../middlewares/auth';
import { Markup } from 'telegraf';
import { talksRepo, congregationsRepo, getTitleForTalk } from '../../db';
import { splitMessage } from '../utils/splitMessage';
import { formatDateRu } from '../../utils/date';

const checkState = new Map<number, { step: 'talk_number' }>();

export function registerCheckCommand(bot: Telegraf<AuthContext>, db: DatabaseInstance): void {
  const talks = talksRepo(db);
  const congRepo = congregationsRepo(db);

  const sendCheckResult = async (
    ctx: AuthContext,
    congregationId: number,
    talkNumber: number,
    isEdit = false
  ): Promise<void> => {
    const rows = await talks.listPastByNumber(congregationId, talkNumber);
    const cong = await congRepo.getById(congregationId);
    const name = cong?.name ?? `Община ${congregationId}`;
    const title = await getTitleForTalk(db, talkNumber);

    let msg = `🔎 Проверка речи №${talkNumber}\n🏛 Община: ${name}\n`;
    if (title) {
      msg += `🧾 Название: «${title}»\n`;
    }
    msg += '\n';

    if (rows.length === 0) {
      msg += 'Пока такой речи у вас не было.';
    } else {
      const dates = rows.map((r) => `• ${formatDateRu(r.date)}`).join('\n');
      msg += `✅ Такая речь уже была ${rows.length} раз.\n\nКогда:\n${dates}`;
    }

    const chunks = splitMessage(msg);
    if (isEdit && 'editMessageText' in ctx && typeof ctx.editMessageText === 'function') {
      await ctx.editMessageText(chunks[0]);
      const chatId = ctx.chat?.id;
      if (chatId && chunks.length > 1) {
        for (const chunk of chunks.slice(1)) {
          await ctx.telegram.sendMessage(chatId, chunk);
        }
      }
      return;
    }
    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }
  };

  bot.command('check', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;

    checkState.set(userId, { step: 'talk_number' });
    await ctx.reply('Введите номер речи для проверки (или /cancel для отмены):');
  });

  bot.action(/^check:cong:(\d+):(\d+)$/, async (ctx) => {
    const congregationId = parseInt(ctx.match[1], 10);
    const talkNumber = parseInt(ctx.match[2], 10);

    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    await sendCheckResult(ctx, congregationId, talkNumber, true);
  });

  bot.on('message', async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();
    const state = checkState.get(userId);
    if (!state) return next();

    const text = (ctx.message as { text?: string })?.text?.trim();
    if (!text) {
      await ctx.reply('Введите номер речи (положительное число) или /cancel.');
      return;
    }
    if (text === '/cancel') {
      checkState.delete(userId);
      await ctx.reply('Проверка речи отменена.');
      return;
    }
    if (text.startsWith('/')) {
      checkState.delete(userId);
      return next();
    }

    if (state.step === 'talk_number') {
      const talkNumber = parseInt(text, 10);
      if (isNaN(talkNumber) || talkNumber < 1) {
        await ctx.reply('Введите корректный номер речи (положительное число) или /cancel.');
        return;
      }

      checkState.delete(userId);
      const ids = ctx.congregationIds ?? [];
      if (ids.length === 0) return;

      if (ids.length === 1) {
        await sendCheckResult(ctx, ids[0], talkNumber);
        return;
      }

      const buttons = await Promise.all(ids.map(async (id) => {
        const c = await congRepo.getById(id);
        return Markup.button.callback(c?.name ?? `Община ${id}`, `check:cong:${id}:${talkNumber}`);
      }));
      await ctx.reply(`Выберите общину для проверки речи №${talkNumber}:`, Markup.inlineKeyboard(buttons));
      return;
    }

    return next();
  });
}
