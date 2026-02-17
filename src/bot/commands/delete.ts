/**
 * Команда /delete — удаление публичной речи (выбор даты из расписания)
 */

import type { Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import type { AuthContext } from '../middlewares/auth';
import { Markup } from 'telegraf';
import { talksRepo, congregationsRepo } from '../../db';
import { formatDateRu, toYmdString } from '../../utils/date';

/** Краткая подпись даты для кнопки: "10.02.2025" */
function formatDateShort(isoDate: string | Date | number): string {
  return formatDateRu(isoDate);
}

function getDateStatusLabel(ymd: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return ymd < today ? '🕓 Прошедшая' : '📅 Предстоящая';
}

type TalkPeriod = 'past' | 'future';

interface DeleteState {
  step: 'period';
  congregationId: number;
  period?: TalkPeriod;
}

function isDateInPeriod(ymd: string, period: TalkPeriod): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return period === 'past' ? ymd < today : ymd >= today;
}

function getPeriodLabel(period: TalkPeriod): string {
  return period === 'past' ? 'прошедшие' : 'будущие';
}

function getPeriodKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🕓 Прошедшие', 'delete:period:past')],
    [Markup.button.callback('📅 Будущие', 'delete:period:future')],
  ]);
}

export function registerDeleteCommand(bot: Telegraf<AuthContext>, db: DatabaseInstance): void {
  const talks = talksRepo(db);
  const congRepo = congregationsRepo(db);
  const pendingDelete = new Map<number, number>(); // userId -> talkId
  const deleteState = new Map<number, DeleteState>();

  bot.command('delete', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;

    if (ids.length === 1) {
      const congregationId = ids[0];
      deleteState.set(userId, { step: 'period', congregationId });
      await ctx.reply('Какие речи хотите удалить?', getPeriodKeyboard());
      return;
    }

    const buttons = await Promise.all(ids.map(async (id) => {
      const c = await congRepo.getById(id);
      return Markup.button.callback(c?.name ?? `Община ${id}`, `delete:cong:${id}`);
    }));
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
    deleteState.set(userId, { step: 'period', congregationId });
    await ctx.editMessageText('Какие речи хотите удалить?', getPeriodKeyboard());
  });

  bot.action(/^delete:period:(past|future)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const period = ctx.match[1] as TalkPeriod;
    const state = deleteState.get(userId);
    if (!state || state.step !== 'period') {
      await ctx.answerCbQuery('Выберите общину заново: /delete');
      return;
    }
    if (!ctx.congregationIds?.includes(state.congregationId)) {
      await ctx.answerCbQuery('Нет доступа к этой общине.');
      return;
    }

    const list = await talks.listByCongregation(state.congregationId);
    const dates = [...new Set(list.map((t) => toYmdString(t.date)).filter((d) => isDateInPeriod(d, period)))].sort();
    if (dates.length === 0) {
      await ctx.editMessageText(`В этой общине нет речей в категории «${getPeriodLabel(period)}».`);
      deleteState.delete(userId);
      return;
    }

    deleteState.set(userId, { ...state, period });
    const today = new Date().toISOString().slice(0, 10);
    const dateButtons = dates.map((d) =>
      Markup.button.callback(
        `${d < today ? '🕓' : '📅'} ${formatDateShort(d)}`,
        `delete:date:${state.congregationId}:${d}`
      )
    );
    await ctx.editMessageText(
      `Выберите дату (${getPeriodLabel(period)} речи):`,
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
    const state = deleteState.get(userId);
    if (!state || state.congregationId !== congregationId || !state.period) {
      await ctx.answerCbQuery('Сначала выберите категорию: /delete');
      return;
    }
    if (!isDateInPeriod(date, state.period)) {
      await ctx.answerCbQuery('Эта дата не входит в выбранную категорию.');
      return;
    }
    const onDate = await talks.listByCongregation(congregationId, { fromDate: date, toDate: date });
    const talk = onDate[0];
    if (!talk) {
      await ctx.answerCbQuery('На эту дату речей не найдено.');
      return;
    }
    pendingDelete.set(userId, talk.id);
    const songDisplay = talk.song_number === 0 ? '?' : talk.song_number;
    await ctx.editMessageText(
      `Удалить речь?\n\n${getDateStatusLabel(date)}: ${formatDateShort(date)} — Песня ${songDisplay}, №${talk.talk_number} «${talk.title}»\nДокладчик: ${talk.speaker_name}`,
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
    const talk = await talks.getById(talkId);
    if (!talk || !ctx.congregationIds?.includes(talk.congregation_id)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    await talks.delete(talkId);
    pendingDelete.delete(userId);
    deleteState.delete(userId);
    await ctx.editMessageText(`✅ Речь удалена (${formatDateShort(talk.date)}).`);
  });

  bot.action('delete:cancel', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) {
      pendingDelete.delete(userId);
      deleteState.delete(userId);
    }
    await ctx.editMessageText('Удаление отменено.');
  });
}
