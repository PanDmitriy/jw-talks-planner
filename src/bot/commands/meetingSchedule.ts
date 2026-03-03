/**
 * Команда /meeting_schedule — просмотр и изменение дня/времени встречи собрания.
 */

import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import { congregationsRepo } from '../../db';
import type { AuthContext } from '../middlewares/auth';
import { formatMeetingTime, formatWeekdayRu, normalizeMeetingTime, parseWeekdayToken } from '../utils/meetingSchedule';

interface PendingScheduleAction {
  weekday: number;
  time: string;
}

interface ScheduleEditState {
  step: 'time' | 'rename';
  congregationId: number;
  weekday?: number;
}

const pendingAction = new Map<number, PendingScheduleAction>();
const pendingRenameAction = new Map<number, string>();
const editState = new Map<number, ScheduleEditState>();

function getHelpText(): string {
  return [
    'Настройки собрания:',
    '/meeting_schedule — показать день/время и настройки собрания',
    '/meeting_schedule set <день> <HH:MM> — изменить',
    '/meeting_schedule rename <новое название> — переименовать',
    '',
    'Примеры:',
    '/meeting_schedule set воскресенье 10:00',
    '/meeting_schedule set сб 18:30',
    '/meeting_schedule rename Центральное',
  ].join('\n');
}

export function registerMeetingScheduleCommand(bot: Telegraf<AuthContext>, db: DatabaseInstance): void {
  const congRepo = congregationsRepo(db);

  const getWeekdayKeyboard = (congregationId: number) =>
    Markup.inlineKeyboard([
      [Markup.button.callback('Суббота', `meeting_schedule:weekday:${congregationId}:6`)],
      [Markup.button.callback('Воскресенье', `meeting_schedule:weekday:${congregationId}:0`)],
    ]);

  const showSchedule = async (ctx: AuthContext, congregationId: number): Promise<void> => {
    const congregation = await congRepo.getById(congregationId);
    if (!congregation) {
      await ctx.reply('Собрание не найдено.');
      return;
    }
    await ctx.reply(
      `Собрание: ${congregation.name}\n` +
        `День встречи: ${formatWeekdayRu(congregation.meeting_weekday)}\n` +
        `Время встречи: ${formatMeetingTime(congregation.meeting_time)}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('Изменить день/время', `meeting_schedule:change:${congregation.id}`)],
        [Markup.button.callback('Переименовать', `meeting_schedule:rename:${congregation.id}`)],
      ])
    );
  };

  const applySchedule = async (
    ctx: AuthContext,
    congregationId: number,
    action: PendingScheduleAction
  ): Promise<void> => {
    await congRepo.updateSchedule(congregationId, action.weekday, action.time);
    const congregation = await congRepo.getById(congregationId);
    await ctx.reply(
      `✅ Расписание обновлено.\n` +
        `Собрание: ${congregation?.name ?? congregationId}\n` +
        `День: ${formatWeekdayRu(action.weekday)}\n` +
        `Время: ${action.time}`
    );
  };

  const applyRename = async (
    ctx: AuthContext,
    congregationId: number,
    newName: string
  ): Promise<void> => {
    const old = await congRepo.getById(congregationId);
    if (!old) {
      await ctx.reply('Собрание не найдено.');
      return;
    }
    await congRepo.updateName(congregationId, newName);
    await ctx.reply(`✅ Собрание переименовано: «${old.name}» → «${newName}».`);
  };

  bot.command('meeting_schedule', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    editState.delete(userId);
    pendingAction.delete(userId);
    pendingRenameAction.delete(userId);
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;

    const text = (ctx.message as { text?: string })?.text?.trim() ?? '';
    const args = text.split(/\s+/).slice(1);

    if (args.length === 0) {
      if (ids.length === 1) {
        await showSchedule(ctx, ids[0]);
      } else {
        const buttons = await Promise.all(ids.map(async (id) => {
          const c = await congRepo.getById(id);
          return Markup.button.callback(c?.name ?? `Собрание ${id}`, `meeting_schedule:show:${id}`);
        }));
        await ctx.reply('Выберите собрание:', Markup.inlineKeyboard(buttons.map((b) => [b])));
      }
      return;
    }

    if (args[0] === 'rename') {
      if (args.length < 2) {
        await ctx.reply(getHelpText());
        return;
      }
      const newName = args.slice(1).join(' ').trim();
      if (!newName) {
        await ctx.reply('Введите новое название собрания.');
        return;
      }
      if (ids.length === 1) {
        await applyRename(ctx, ids[0], newName);
        return;
      }
      pendingRenameAction.set(userId, newName);
      const buttons = await Promise.all(ids.map(async (id) => {
        const c = await congRepo.getById(id);
        return Markup.button.callback(c?.name ?? `Собрание ${id}`, `meeting_schedule:rename_apply:${id}`);
      }));
      await ctx.reply('Выберите собрание для переименования:', Markup.inlineKeyboard(buttons));
      return;
    }

    if (args[0] !== 'set' || args.length < 3) {
      await ctx.reply(getHelpText());
      return;
    }

    const weekday = parseWeekdayToken(args[1]);
    if (weekday === null) {
      await ctx.reply('Неверный день недели. Пример: воскресенье, сб, sunday.');
      return;
    }
    if (weekday !== 0 && weekday !== 6) {
      await ctx.reply('Для публичных речей допустим только выходной день: суббота или воскресенье.');
      return;
    }

    const time = normalizeMeetingTime(args[2]);
    if (!time) {
      await ctx.reply('Неверный формат времени. Используйте HH:MM, например 10:00.');
      return;
    }

    if (ids.length === 1) {
      await applySchedule(ctx, ids[0], { weekday, time });
      return;
    }

    pendingAction.set(userId, { weekday, time });
    const buttons = await Promise.all(ids.map(async (id) => {
      const c = await congRepo.getById(id);
      return Markup.button.callback(c?.name ?? `Собрание ${id}`, `meeting_schedule:set:${id}`);
    }));
    await ctx.reply('Выберите собрание для обновления расписания:', Markup.inlineKeyboard(buttons));
  });

  bot.action(/^meeting_schedule:show:(\d+)$/, async (ctx) => {
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    await ctx.answerCbQuery();
    await showSchedule(ctx, congregationId);
  });

  bot.action(/^meeting_schedule:change:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    editState.delete(userId);
    await ctx.answerCbQuery();
    await ctx.reply(
      'Выберите новый день встречи (доступны только выходные):',
      getWeekdayKeyboard(congregationId)
    );
  });

  bot.action(/^meeting_schedule:rename:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    editState.set(userId, { step: 'rename', congregationId });
    await ctx.answerCbQuery();
    await ctx.reply('Введите новое название собрания (или /cancel для отмены):');
  });

  bot.action(/^meeting_schedule:weekday:(\d+):(0|6)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const congregationId = parseInt(ctx.match[1], 10);
    const weekday = parseInt(ctx.match[2], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    editState.set(userId, { step: 'time', congregationId, weekday });
    await ctx.answerCbQuery();
    await ctx.reply(
      `Выбран день: ${formatWeekdayRu(weekday)}.\n` +
        'Введите новое время в формате HH:MM (например 10:00), или /cancel для отмены.'
    );
  });

  bot.action(/^meeting_schedule:set:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    const action = pendingAction.get(userId);
    if (!action) {
      await ctx.answerCbQuery('Сначала задайте параметры: /meeting_schedule set ...');
      return;
    }
    pendingAction.delete(userId);
    await ctx.answerCbQuery();
    await applySchedule(ctx, congregationId, action);
  });

  bot.action(/^meeting_schedule:rename_apply:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    const newName = pendingRenameAction.get(userId);
    if (!newName) {
      await ctx.answerCbQuery('Сначала задайте название: /meeting_schedule rename ...');
      return;
    }
    pendingRenameAction.delete(userId);
    await ctx.answerCbQuery();
    await applyRename(ctx, congregationId, newName);
  });

  bot.on('message', async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();
    const state = editState.get(userId);
    if (!state) return next();
    const text = (ctx.message as { text?: string })?.text?.trim();
    if (!text) return next();

    if (text === '/cancel') {
      editState.delete(userId);
      await ctx.reply('Изменение расписания отменено.');
      return;
    }
    if (text.startsWith('/')) {
      editState.delete(userId);
      return next();
    }

    if (!ctx.congregationIds?.includes(state.congregationId)) {
      editState.delete(userId);
      await ctx.reply('Нет доступа к этому собранию.');
      return;
    }

    if (state.step === 'rename') {
      const newName = text.trim();
      if (!newName) {
        await ctx.reply('Введите непустое название собрания.');
        return;
      }
      await applyRename(ctx, state.congregationId, newName);
      editState.delete(userId);
      return;
    }

    const normalizedTime = normalizeMeetingTime(text);
    if (!normalizedTime) {
      await ctx.reply('Неверный формат времени. Используйте HH:MM, например 10:00.');
      return;
    }

    if (state.weekday === undefined) {
      editState.delete(userId);
      await ctx.reply('Не удалось определить выбранный день. Запустите /meeting_schedule заново.');
      return;
    }

    await applySchedule(ctx, state.congregationId, { weekday: state.weekday, time: normalizedTime });
    editState.delete(userId);
  });
}
