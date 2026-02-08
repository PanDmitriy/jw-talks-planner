/**
 * Команда /delete — удаление публичной речи (выбор даты из расписания)
 */

import type { Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import type { AuthContext } from '../middlewares/auth';
import { Markup } from 'telegraf';
import { talksRepo, congregationsRepo } from '../../db';

const DAY_NAMES = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const MONTH_NAMES = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** Краткая подпись даты для кнопки: "10 фев (сб)" */
function formatDateShort(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dayName = DAY_NAMES[date.getDay()];
  const month = MONTH_NAMES[m - 1];
  return `${d} ${month} (${dayName})`;
}

export function registerDeleteCommand(bot: Telegraf<AuthContext>, db: DatabaseInstance): void {
  const talks = talksRepo(db);
  const congRepo = congregationsRepo(db);
  const pendingDelete = new Map<number, number>(); // userId -> talkId

  bot.command('delete', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;

    const today = new Date().toISOString().slice(0, 10);

    if (ids.length === 1) {
      const congregationId = ids[0];
      const list = talks.listByCongregation(congregationId, { fromDate: today });
      const dates = [...new Set(list.map((t) => t.date))].sort();
      if (dates.length === 0) {
        await ctx.reply('Нет предстоящих речей для удаления.');
        return;
      }
      const dateButtons = dates.map((d) =>
        Markup.button.callback(formatDateShort(d), `delete:date:${congregationId}:${d}`)
      );
      await ctx.reply(
        'Выберите дату речи для удаления:',
        Markup.inlineKeyboard(dateButtons.map((b) => [b]))
      );
      return;
    }

    const buttons = ids.map((id) => {
      const c = congRepo.getById(id);
      return Markup.button.callback(c?.name ?? `Община ${id}`, `delete:cong:${id}`);
    });
    await ctx.reply('Выберите общину:', Markup.inlineKeyboard(buttons.map((b) => [b])));
  });

  bot.action(/^delete:cong:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа к этой общине.');
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const list = talks.listByCongregation(congregationId, { fromDate: today });
    const dates = [...new Set(list.map((t) => t.date))].sort();
    if (dates.length === 0) {
      await ctx.editMessageText('В этой общине нет предстоящих речей для удаления.');
      return;
    }
    const dateButtons = dates.map((d) =>
      Markup.button.callback(formatDateShort(d), `delete:date:${congregationId}:${d}`)
    );
    await ctx.editMessageText(
      'Выберите дату речи для удаления:',
      Markup.inlineKeyboard(dateButtons.map((b) => [b]))
    );
  });

  bot.action(/^delete:date:(\d+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const congregationId = parseInt(ctx.match[1], 10);
    const date = ctx.match[2];
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    const onDate = talks.listByCongregation(congregationId, { fromDate: date, toDate: date });
    const talk = onDate[0];
    if (!talk) {
      await ctx.answerCbQuery('На эту дату речей не найдено.');
      return;
    }
    pendingDelete.set(userId, talk.id);
    const songDisplay = talk.song_number === 0 ? '?' : talk.song_number;
    await ctx.editMessageText(
      `Удалить речь?\n\n${formatDateShort(date)} — Песня ${songDisplay}, №${talk.talk_number} «${talk.title}»\nДокладчик: ${talk.speaker_name}`,
      Markup.inlineKeyboard([
        Markup.button.callback('Да, удалить', `delete:confirm:${talk.id}`),
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
    await ctx.editMessageText(`✅ Речь удалена (${formatDateShort(talk.date)}).`);
  });

  bot.action('delete:cancel', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) pendingDelete.delete(userId);
    await ctx.editMessageText('Удаление отменено.');
  });
}
