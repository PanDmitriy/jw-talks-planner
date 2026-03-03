/**
 * Команда /exceptions — отметка особых выходных (конгресс, вечеря, РС).
 */

import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import type { DatabaseInstance, ScheduleExceptionType } from '../../db';
import { congregationsRepo, scheduleExceptionsRepo } from '../../db';
import type { AuthContext } from '../middlewares/auth';
import { formatDateRu, parseUserDateToYmd } from '../../utils/date';
import { splitMessage } from '../utils/splitMessage';

type ExceptionAction = 'add' | 'list' | 'remove';

interface MonthRange {
  fromDate: string;
  toDate: string;
  label: string;
}

interface PendingExceptionAction {
  action: ExceptionAction;
  date?: string;
  exceptionType?: ScheduleExceptionType;
  note?: string;
  month?: MonthRange;
}

const pendingActions = new Map<number, PendingExceptionAction>();

type ExceptionsWizardStep = 'action' | 'type' | 'congregation' | 'date' | 'month';

interface ExceptionsWizardState {
  step: ExceptionsWizardStep;
  action?: ExceptionAction;
  congregationId?: number;
  exceptionType?: ScheduleExceptionType;
}

const wizardState = new Map<number, ExceptionsWizardState>();

const TYPE_ALIASES: Record<string, ScheduleExceptionType> = {
  rs_visit: 'rs_visit',
  rs: 'rs_visit',
  'рс': 'rs_visit',
  district_congress: 'district_congress',
  congress: 'district_congress',
  'конгресс': 'district_congress',
  memorial: 'memorial',
  'вечеря': 'memorial',
};

function getUtcDayOfWeek(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function isWeekend(ymd: string): boolean {
  const day = getUtcDayOfWeek(ymd);
  return day === 0 || day === 6;
}

function toYmdUtc(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function getWeekendPair(ymd: string): { saturday: string; sunday: string } {
  const [year, month, day] = ymd.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const dow = utc.getUTCDay();
  const saturdayShift = dow === 6 ? 0 : dow === 0 ? -1 : -(dow + 1);
  const saturday = new Date(utc);
  saturday.setUTCDate(saturday.getUTCDate() + saturdayShift);
  const sunday = new Date(saturday);
  sunday.setUTCDate(sunday.getUTCDate() + 1);
  return { saturday: toYmdUtc(saturday), sunday: toYmdUtc(sunday) };
}

function getTypeLabel(type: ScheduleExceptionType): string {
  if (type === 'rs_visit') return 'Посещение РС';
  if (type === 'district_congress') return 'Районный конгресс';
  return 'Вечеря воспоминания';
}

function parseExceptionType(raw: string): ScheduleExceptionType | null {
  const normalized = raw.trim().toLowerCase();
  return TYPE_ALIASES[normalized] ?? null;
}

function parseMonthRange(raw: string): MonthRange | null {
  const trimmed = raw.trim();
  let year = 0;
  let month = 0;
  const dotMatch = trimmed.match(/^(\d{2})\.(\d{4})$/);
  const dashMatch = trimmed.match(/^(\d{4})-(\d{2})$/);
  if (dotMatch) {
    month = Number(dotMatch[1]);
    year = Number(dotMatch[2]);
  } else if (dashMatch) {
    year = Number(dashMatch[1]);
    month = Number(dashMatch[2]);
  } else {
    return null;
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return null;
  const fromDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const toDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { fromDate, toDate, label: `${String(month).padStart(2, '0')}.${year}` };
}

function getHelpText(): string {
  return [
    'Исключения отмечают особые выходные для собрания.',
    '',
    'Удобно: просто отправьте /exceptions и следуйте кнопкам.',
    '',
    'Команды:',
    '/exceptions add <дата> <тип> [комментарий]',
    '/exceptions list [ММ.ГГГГ]',
    '/exceptions remove <дата>',
    '',
    'Дата: ДД.ММ.ГГГГ или YYYY-MM-DD (только выходной день)',
    'Типы: rs_visit (РС), district_congress (конгресс), memorial (вечеря)',
    '',
    'Важно:',
    '- district_congress и memorial блокируют планирование речи на весь уикенд (сб+вс)',
    '- rs_visit информационный: публичную речь планировать можно, с произвольным названием',
  ].join('\n');
}

function getActionKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➕ Добавить событие', 'exceptions:wiz:action:add')],
    [Markup.button.callback('📋 Показать список', 'exceptions:wiz:action:list')],
    [Markup.button.callback('🗑 Удалить событие', 'exceptions:wiz:action:remove')],
    [Markup.button.callback('ℹ️ Помощь', 'exceptions:wiz:action:help')],
  ]);
}

function getTypeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Посещение РС', 'exceptions:wiz:type:rs_visit')],
    [Markup.button.callback('Районный конгресс', 'exceptions:wiz:type:district_congress')],
    [Markup.button.callback('Вечеря воспоминания', 'exceptions:wiz:type:memorial')],
  ]);
}

async function askCongregation(
  ctx: AuthContext,
  ids: number[],
  congRepo: ReturnType<typeof congregationsRepo>
): Promise<void> {
  const buttons = await Promise.all(ids.map(async (id) => {
    const c = await congRepo.getById(id);
    return Markup.button.callback(c?.name ?? `Собрание ${id}`, `exceptions:cong:${id}`);
  }));
  await ctx.reply('Выберите собрание для операции с исключениями:', Markup.inlineKeyboard(buttons));
}

export function registerExceptionsCommand(bot: Telegraf<AuthContext>, db: DatabaseInstance): void {
  const exceptionsRepo = scheduleExceptionsRepo(db);
  const congRepo = congregationsRepo(db);

  const runAction = async (
    ctx: AuthContext,
    congregationId: number,
    action: PendingExceptionAction
  ): Promise<void> => {
    const congregation = await congRepo.getById(congregationId);
    const congregationName = congregation?.name ?? `Собрание ${congregationId}`;

    if (action.action === 'add') {
      if (!action.date || !action.exceptionType) {
        await ctx.reply('Не удалось определить параметры команды. Используйте /exceptions help.');
        return;
      }
      const { saturday, sunday } = getWeekendPair(action.date);
      const note = action.note ?? null;
      const weekendDates = [saturday, sunday];
      for (const date of weekendDates) {
        await exceptionsRepo.upsert({
          congregation_id: congregationId,
          date,
          exception_type: action.exceptionType,
          note,
        });
      }
      const behavior =
        action.exceptionType === 'rs_visit'
          ? 'Публичную речь можно планировать, но обычно с названием по плану РС.'
          : 'Публичная речь на этот уикенд блокируется.';
      await ctx.reply(
        `✅ Событие добавлено на уикенд.\n` +
          `Даты: ${formatDateRu(saturday)} и ${formatDateRu(sunday)}\n` +
          `Тип: ${getTypeLabel(action.exceptionType)}\n` +
          `Собрание: ${congregationName}\n` +
          `${behavior}`
      );
      return;
    }

    if (action.action === 'remove') {
      if (!action.date) {
        await ctx.reply('Не удалось определить дату. Используйте /exceptions remove <дата>.');
        return;
      }
      const { saturday, sunday } = getWeekendPair(action.date);
      const removedCount = await exceptionsRepo.removeByDates(congregationId, [saturday, sunday]);
      if (removedCount === 0) {
        await ctx.reply(
          `События на уикенд ${formatDateRu(saturday)} / ${formatDateRu(sunday)} не найдены в «${congregationName}».`
        );
        return;
      }
      await ctx.reply(
        `✅ События уикенда удалены: ${formatDateRu(saturday)} и ${formatDateRu(sunday)} (${congregationName}).`
      );
      return;
    }

    const options = action.month
      ? { fromDate: action.month.fromDate, toDate: action.month.toDate }
      : undefined;
    const list = await exceptionsRepo.listByCongregation(congregationId, options);
    const periodLabel = action.month ? ` за ${action.month.label}` : '';
    if (list.length === 0) {
      await ctx.reply(`В «${congregationName}» нет отмеченных событий${periodLabel}.`);
      return;
    }
    const lines = list.map((item) => {
      const note = item.note ? ` — ${item.note}` : '';
      return `• ${formatDateRu(item.date)} — ${getTypeLabel(item.exception_type)}${note}`;
    });
    const text = `Исключения в расписании${periodLabel} — ${congregationName}\n\n${lines.join('\n')}`;
    for (const chunk of splitMessage(text)) {
      await ctx.reply(chunk);
    }
  };

  const askWizardCongregation = async (ctx: AuthContext, ids: number[]): Promise<void> => {
    const buttons = await Promise.all(ids.map(async (id) => {
      const c = await congRepo.getById(id);
      return Markup.button.callback(c?.name ?? `Собрание ${id}`, `exceptions:wiz:cong:${id}`);
    }));
    await ctx.reply('Выберите собрание:', Markup.inlineKeyboard(buttons));
  };

  const getDatePickerKeyboard = async (
    action: ExceptionAction,
    congregationId: number,
    fromDate?: string
  ) => {
    const congregation = await congRepo.getById(congregationId);
    const meetingWeekday = congregation?.meeting_weekday ?? 0;
    const start = fromDate ?? new Date().toISOString().slice(0, 10);
    const rows: Array<Array<ReturnType<typeof Markup.button.callback>>> = [];
    let nextCursor: string | null = null;

    if (action === 'remove') {
      const toDate = addDays(start, 365);
      const all = await exceptionsRepo.listByCongregation(congregationId, { fromDate: start, toDate });
      const dates = [...new Set(all.map((e) => e.date))]
        .filter((d) => getUtcDayOfWeek(d) === meetingWeekday)
        .sort();
      const page = dates.slice(0, 8);
      nextCursor = dates.length > 8 ? addDays(page[7], 1) : null;
      for (const d of page) {
        const exception = await exceptionsRepo.getByDate(congregationId, d);
        const label = exception ? getTypeLabel(exception.exception_type) : 'Исключение';
        rows.push([
          Markup.button.callback(
            `${formatDateRu(d)} — ${label}`,
            `exceptions:wiz:datepick:${d}`
          ),
        ]);
      }
    } else {
      const found: string[] = [];
      let cursor = start;
      let scanned = 0;
      while (found.length < 9 && scanned < 500) {
        if (getUtcDayOfWeek(cursor) === meetingWeekday) found.push(cursor);
        cursor = addDays(cursor, 1);
        scanned += 1;
      }
      const page = found.slice(0, 8);
      nextCursor = found.length > 8 ? addDays(page[7], 1) : null;
      for (const d of page) {
        const exception = await exceptionsRepo.getByDate(congregationId, d);
        const suffix = exception ? ` (уже: ${getTypeLabel(exception.exception_type)})` : '';
        rows.push([
          Markup.button.callback(
            `${formatDateRu(d)}${suffix}`,
            `exceptions:wiz:datepick:${d}`
          ),
        ]);
      }
    }

    if (nextCursor) {
      rows.push([Markup.button.callback('Показать следующие даты', `exceptions:wiz:dates:more:${nextCursor}`)]);
    }
    rows.push([Markup.button.callback('Ввести дату вручную', 'exceptions:wiz:manual_date')]);
    return Markup.inlineKeyboard(rows);
  };

  bot.command('exceptions', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;

    const text = (ctx.message as { text?: string })?.text?.trim() ?? '';
    const args = text.split(/\s+/).slice(1);
    const sub = (args[0] ?? '').toLowerCase();

    if (!sub) {
      wizardState.set(userId, { step: 'action' });
      await ctx.reply('Что нужно сделать с исключениями в расписании?', getActionKeyboard());
      return;
    }

    if (sub === 'help') {
      await ctx.reply(getHelpText());
      return;
    }

    let action: PendingExceptionAction | null = null;
    if (sub === 'add') {
      if (args.length < 3) {
        await ctx.reply('Формат: /exceptions add <дата> <тип> [комментарий]');
        return;
      }
      const date = parseUserDateToYmd(args[1]);
      if (!date) {
        await ctx.reply('Неверный формат даты. Используйте ДД.ММ.ГГГГ или YYYY-MM-DD.');
        return;
      }
      if (!isWeekend(date)) {
        await ctx.reply('Для /exceptions add укажите выходной день (суббота или воскресенье).');
        return;
      }
      const exceptionType = parseExceptionType(args[2]);
      if (!exceptionType) {
        await ctx.reply('Неизвестный тип. Допустимо: rs_visit, district_congress, memorial.');
        return;
      }
      const note = args.slice(3).join(' ').trim() || undefined;
      action = { action: 'add', date, exceptionType, note };
    } else if (sub === 'remove') {
      if (args.length < 2) {
        await ctx.reply('Формат: /exceptions remove <дата>');
        return;
      }
      const date = parseUserDateToYmd(args[1]);
      if (!date) {
        await ctx.reply('Неверный формат даты. Используйте ДД.ММ.ГГГГ или YYYY-MM-DD.');
        return;
      }
      if (!isWeekend(date)) {
        await ctx.reply('Для /exceptions remove укажите выходной день (суббота или воскресенье).');
        return;
      }
      action = { action: 'remove', date };
    } else if (sub === 'list') {
      if (args[1]) {
        const month = parseMonthRange(args[1]);
        if (!month) {
          await ctx.reply('Формат месяца: ММ.ГГГГ или YYYY-MM (например 04.2026).');
          return;
        }
        action = { action: 'list', month };
      } else {
        action = { action: 'list' };
      }
    } else {
      await ctx.reply(getHelpText());
      return;
    }

    if (ids.length === 1) {
      await runAction(ctx, ids[0], action);
      return;
    }

    pendingActions.set(userId, action);
    await askCongregation(ctx, ids, congRepo);
  });

  bot.action(/^exceptions:wiz:action:(add|list|remove|help)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;
    const action = ctx.match[1] as ExceptionAction | 'help';
    if (action === 'help') {
      wizardState.delete(userId);
      await ctx.answerCbQuery();
      await ctx.editMessageText(getHelpText());
      return;
    }
    if (action === 'add') {
      wizardState.set(userId, { step: 'type', action });
      await ctx.answerCbQuery();
      await ctx.editMessageText('Выберите тип события:', getTypeKeyboard());
      return;
    }
    if (ids.length === 1) {
      if (action === 'list') {
        wizardState.set(userId, { step: 'month', action, congregationId: ids[0] });
        await ctx.answerCbQuery();
        await ctx.editMessageText('Введите месяц в формате ММ.ГГГГ или отправьте "-" для всех событий.');
        return;
      }
      wizardState.set(userId, { step: 'date', action, congregationId: ids[0] });
      await ctx.answerCbQuery();
      const keyboard = await getDatePickerKeyboard(action, ids[0]);
      await ctx.editMessageText(
        'Выберите дату исключения для удаления или введите вручную:',
        keyboard
      );
      return;
    }
    wizardState.set(userId, { step: 'congregation', action });
    await ctx.answerCbQuery();
    await askWizardCongregation(ctx, ids);
  });

  bot.action(/^exceptions:wiz:type:(rs_visit|district_congress|memorial)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;
    const type = ctx.match[1] as ScheduleExceptionType;
    if (ids.length === 1) {
      wizardState.set(userId, {
        step: 'date',
        action: 'add',
        congregationId: ids[0],
        exceptionType: type,
      });
      await ctx.answerCbQuery();
      await ctx.editMessageText(
        `Тип: ${getTypeLabel(type)}.\nВведите выходную дату (ДД.ММ.ГГГГ или YYYY-MM-DD).\n` +
          'Можно добавить комментарий после даты.'
      );
      return;
    }
    wizardState.set(userId, { step: 'congregation', action: 'add', exceptionType: type });
    await ctx.answerCbQuery();
    await askWizardCongregation(ctx, ids);
  });

  bot.action(/^exceptions:wiz:cong:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const state = wizardState.get(userId);
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа к этому собранию.');
      return;
    }
    if (!state || state.step !== 'congregation' || !state.action) {
      await ctx.answerCbQuery('Сессия неактивна. Запустите /exceptions.');
      return;
    }
    if (state.action === 'list') {
      wizardState.set(userId, { ...state, step: 'month', congregationId });
      await ctx.answerCbQuery();
      await ctx.reply('Введите месяц в формате ММ.ГГГГ или отправьте "-" для всех событий.');
      return;
    }
    wizardState.set(userId, { ...state, step: 'date', congregationId });
    await ctx.answerCbQuery();
    if (state.action === 'add') {
      const keyboard = await getDatePickerKeyboard('add', congregationId);
      await ctx.reply(
        `Тип: ${getTypeLabel(state.exceptionType ?? 'rs_visit')}.\n` +
          'Введите выходную дату (ДД.ММ.ГГГГ или YYYY-MM-DD).\n' +
          'Можно добавить комментарий после даты.',
        keyboard
      );
      return;
    }
    const keyboard = await getDatePickerKeyboard('remove', congregationId);
    await ctx.reply('Выберите дату исключения для удаления или введите вручную:', keyboard);
  });

  bot.action(/^exceptions:cong:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа к этому собранию.');
      return;
    }
    const action = pendingActions.get(userId);
    if (!action) {
      await ctx.answerCbQuery('Операция не найдена. Повторите /exceptions.');
      return;
    }
    pendingActions.delete(userId);
    await ctx.answerCbQuery();
    await runAction(ctx, congregationId, action);
  });

  bot.on('message', async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();
    const state = wizardState.get(userId);
    if (!state) return next();
    const text = (ctx.message as { text?: string })?.text?.trim();
    if (!text) return next();

    if (text === '/cancel') {
      wizardState.delete(userId);
      await ctx.reply('Операция /exceptions отменена.');
      return;
    }
    if (text.startsWith('/')) {
      wizardState.delete(userId);
      return next();
    }

    if (!state.action || state.congregationId === undefined) {
      await ctx.reply('Сессия неактивна. Запустите /exceptions заново.');
      wizardState.delete(userId);
      return;
    }

    if (state.step === 'date') {
      if (state.action === 'remove') {
        const date = parseUserDateToYmd(text.split(/\s+/)[0] ?? '');
        if (!date || !isWeekend(date)) {
          await ctx.reply('Введите выходную дату в формате ДД.ММ.ГГГГ или YYYY-MM-DD.');
          return;
        }
        wizardState.delete(userId);
        await runAction(ctx, state.congregationId, { action: 'remove', date });
        return;
      }
      if (state.action === 'add') {
        if (!state.exceptionType) {
          wizardState.delete(userId);
          await ctx.reply('Тип события не выбран. Запустите /exceptions заново.');
          return;
        }
        const [dateToken, ...rest] = text.split(/\s+/);
        const date = parseUserDateToYmd(dateToken ?? '');
        if (!date || !isWeekend(date)) {
          await ctx.reply('Введите выходную дату в формате ДД.ММ.ГГГГ или YYYY-MM-DD.');
          return;
        }
        const note = rest.join(' ').trim() || undefined;
        wizardState.delete(userId);
        await runAction(ctx, state.congregationId, {
          action: 'add',
          date,
          exceptionType: state.exceptionType,
          note,
        });
        return;
      }
    }

    if (state.step === 'month' && state.action === 'list') {
      let month: MonthRange | undefined;
      if (text !== '-') {
        month = parseMonthRange(text) ?? undefined;
        if (!month) {
          await ctx.reply('Формат месяца: ММ.ГГГГ или YYYY-MM. Либо "-" для всех событий.');
          return;
        }
      }
      wizardState.delete(userId);
      await runAction(ctx, state.congregationId, { action: 'list', month });
      return;
    }

    await ctx.reply('Используйте кнопки или /cancel.');
  });

  bot.action('exceptions:wiz:manual_date', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Введите выходную дату в формате ДД.ММ.ГГГГ или YYYY-MM-DD.');
  });

  bot.action(/^exceptions:wiz:dates:more:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const state = wizardState.get(userId);
    if (!state || state.step !== 'date' || !state.action || state.congregationId === undefined) {
      await ctx.answerCbQuery('Сессия неактивна. Запустите /exceptions.');
      return;
    }
    await ctx.answerCbQuery();
    const keyboard = await getDatePickerKeyboard(state.action, state.congregationId, ctx.match[1]);
    await ctx.editMessageText(
      state.action === 'add'
        ? 'Выберите доступную дату для исключения или введите вручную:'
        : 'Выберите дату исключения для удаления или введите вручную:',
      keyboard
    );
  });

  bot.action(/^exceptions:wiz:datepick:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const state = wizardState.get(userId);
    if (!state || state.step !== 'date' || !state.action || state.congregationId === undefined) {
      await ctx.answerCbQuery('Сессия неактивна. Запустите /exceptions.');
      return;
    }
    const saturday = ctx.match[1];
    if (!isWeekend(saturday)) {
      await ctx.answerCbQuery('Неверная дата выходного.');
      return;
    }
    if (state.action === 'remove') {
      wizardState.delete(userId);
      await ctx.answerCbQuery();
      await runAction(ctx, state.congregationId, { action: 'remove', date: saturday });
      return;
    }
    if (state.action === 'add') {
      if (!state.exceptionType) {
        wizardState.delete(userId);
        await ctx.answerCbQuery('Тип события не выбран. Запустите /exceptions.');
        return;
      }
      wizardState.delete(userId);
      await ctx.answerCbQuery();
      await runAction(ctx, state.congregationId, {
        action: 'add',
        date: saturday,
        exceptionType: state.exceptionType,
      });
      return;
    }
    await ctx.answerCbQuery('Это действие доступно только для add/remove.');
  });
}
