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

const pendingAction = new Map<number, PendingScheduleAction>();

function getHelpText(): string {
  return [
    'Управление расписанием встречи собрания:',
    '/meeting_schedule — показать текущие день и время',
    '/meeting_schedule set <день> <HH:MM> — изменить',
    '',
    'Примеры:',
    '/meeting_schedule set воскресенье 10:00',
    '/meeting_schedule set сб 18:30',
  ].join('\n');
}

export function registerMeetingScheduleCommand(bot: Telegraf<AuthContext>, db: DatabaseInstance): void {
  const congRepo = congregationsRepo(db);

  const showSchedule = async (ctx: AuthContext, congregationId: number): Promise<void> => {
    const congregation = await congRepo.getById(congregationId);
    if (!congregation) {
      await ctx.reply('Собрание не найдено.');
      return;
    }
    await ctx.reply(
      `Собрание: ${congregation.name}\n` +
        `День встречи: ${formatWeekdayRu(congregation.meeting_weekday)}\n` +
        `Время встречи: ${formatMeetingTime(congregation.meeting_time)}`
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

  bot.command('meeting_schedule', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
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
}
