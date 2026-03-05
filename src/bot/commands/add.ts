/**
 * Команда /add — пошаговое добавление публичной речи
 */

import type { Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import type { AuthContext } from '../middlewares/auth';
import { Markup } from 'telegraf';
import {
  talksRepo,
  congregationsRepo,
  getTitleForTalk,
  scheduleExceptionsRepo,
  TalkDateValidationError,
  TalkDateBlockedByEventError,
} from '../../db';
import type { TalkInput, ScheduleExceptionType } from '../../db/types';
import { formatDateRu, parseUserDateToYmd } from '../../utils/date';
import { formatWeekdayRu } from '../utils/meetingSchedule';

type AddStep =
  | 'congregation'
  | 'date'
  | 'song'
  | 'talk_number'
  | 'title'
  | 'speaker_name'
  | 'speaker_phone';

interface AddTalkState {
  step: AddStep;
  congregationId?: number;
  date?: string;
  song_number?: number;
  talk_number?: number;
  title?: string;
  speaker_name?: string;
  speaker_phone?: string;
  manualTitleExceptionType?: ScheduleExceptionType;
  dateCursorFrom?: string;
}

const wizardState = new Map<number, AddTalkState>();

export function registerAddCommand(bot: Telegraf<AuthContext>, db: DatabaseInstance): void {
  const talks = talksRepo(db);
  const congRepo = congregationsRepo(db);
  const exceptionsRepo = scheduleExceptionsRepo(db);

  const BLOCKING_TYPES = new Set(['district_congress', 'memorial']);
  const MANUAL_TITLE_TYPES = new Set<ScheduleExceptionType>([
    'rs_visit',
    'special_talk_before_memorial',
    'bethel_speaker_visit',
  ]);

  function getExceptionTypeLabel(type: string): string {
    if (type === 'district_congress') return 'Районный конгресс';
    if (type === 'memorial') return 'Вечеря воспоминания';
    if (type === 'special_talk_before_memorial') return 'Специальная речь перед Вечерей';
    if (type === 'bethel_speaker_visit') return 'Посещение вефильского докладчика';
    return 'Посещение РС';
  }

  function getUtcDayOfWeek(ymd: string): number {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }

  function addDays(ymd: string, days: number): string {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }

  async function validateSelectedDate(
    congregationId: number,
    ymd: string
  ): Promise<{ ok: true; manualTitleExceptionType?: ScheduleExceptionType } | { ok: false; reason: string }> {
    const congregation = await congRepo.getById(congregationId);
    if (!congregation) return { ok: false, reason: 'Собрание не найдено.' };
    const weekday = getUtcDayOfWeek(ymd);
    if (weekday !== congregation.meeting_weekday) {
      return {
        ok: false,
        reason: `Для этого собрания встреча проходит по ${formatWeekdayRu(congregation.meeting_weekday)}.`,
      };
    }
    const events = await exceptionsRepo.getWeekendEvents(congregationId, ymd);
    const blocking = events.find((e) => BLOCKING_TYPES.has(e.exception_type));
    if (blocking) {
      return {
        ok: false,
        reason: `Этот уикенд отмечен как «${getExceptionTypeLabel(blocking.exception_type)}», публичную речь планировать нельзя.`,
      };
    }
    const existing = await talks.listByCongregation(congregationId, { fromDate: ymd, toDate: ymd });
    if (existing.length > 0) {
      return { ok: false, reason: `На ${formatDateRu(ymd)} уже запланирована публичная речь.` };
    }
    const manualTitleException = events.find((e) => MANUAL_TITLE_TYPES.has(e.exception_type))?.exception_type;
    return { ok: true, manualTitleExceptionType: manualTitleException };
  }

  async function getNextAvailableDates(
    congregationId: number,
    fromDate: string,
    limit = 8
  ): Promise<{ dates: string[]; nextCursorFrom: string | null }> {
    const congregation = await congRepo.getById(congregationId);
    if (!congregation) return { dates: [], nextCursorFrom: null };
    const out: string[] = [];
    let cursor = fromDate;
    let scannedDays = 0;
    while (scannedDays < 730 && out.length < limit + 1) {
      if (getUtcDayOfWeek(cursor) === congregation.meeting_weekday) {
        const validated = await validateSelectedDate(congregationId, cursor);
        if (validated.ok) out.push(cursor);
      }
      cursor = addDays(cursor, 1);
      scannedDays += 1;
    }
    if (out.length <= limit) return { dates: out, nextCursorFrom: null };
    return { dates: out.slice(0, limit), nextCursorFrom: addDays(out[limit - 1], 1) };
  }

  async function askDateSelection(
    ctx: AuthContext,
    userId: number,
    congregationId: number,
    options?: { fromDate?: string; replaceMessage?: boolean }
  ): Promise<void> {
    const congregation = await congRepo.getById(congregationId);
    const fromDate = options?.fromDate ?? new Date().toISOString().slice(0, 10);
    const { dates: freeDates, nextCursorFrom } = await getNextAvailableDates(congregationId, fromDate, 8);
    if (freeDates.length === 0) {
      const emptyText =
        `Не найдено свободных дат на ближайший период для собрания ${congregation?.name ?? congregationId}. ` +
        'Проверьте /exceptions или измените день встречи через /meeting_schedule.';
      if (options?.replaceMessage) await ctx.editMessageText(emptyText);
      else await ctx.reply(emptyText);
      wizardState.delete(userId);
      return;
    }
    const buttons = freeDates.map((d) => [Markup.button.callback(formatDateRu(d), `add:date:${d}`)]);
    if (nextCursorFrom) {
      buttons.push([Markup.button.callback('Показать еще даты', `add:dates:more:${nextCursorFrom}`)]);
    }
    wizardState.set(userId, {
      step: 'date',
      congregationId,
      dateCursorFrom: nextCursorFrom ?? undefined,
    });
    const text =
      `Шаг 1 из 7. Собрание: ${congregation?.name ?? congregationId}.\n` +
      `Выберите свободную дату встречи (${formatWeekdayRu(congregation?.meeting_weekday ?? 0)}):`;
    if (options?.replaceMessage) {
      await ctx.editMessageText(text, Markup.inlineKeyboard(buttons));
    } else {
      await ctx.reply(text, Markup.inlineKeyboard(buttons));
    }
  }

  const addHandler = async (ctx: AuthContext) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;

    if (ids.length === 1) {
      await askDateSelection(ctx, userId, ids[0]);
      return;
    }
    wizardState.set(userId, { step: 'congregation' });
    const buttons = await Promise.all(ids.map(async (id) => {
      const c = await congRepo.getById(id);
      return Markup.button.callback(c?.name ?? `Община ${id}`, `add:cong:${id}`);
    }));
    await ctx.reply('Шаг 1 из 7. Выберите общину (отмена: /cancel):', Markup.inlineKeyboard(buttons));
  };

  bot.command('add', addHandler);
  bot.hears('➕ Добавить', addHandler);

  bot.action(/^add:cong:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    await ctx.answerCbQuery();
    await askDateSelection(ctx, userId, congregationId);
  });

  bot.action(/^add:date:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const state = wizardState.get(userId);
    if (!state || state.step !== 'date' || state.congregationId === undefined) {
      await ctx.answerCbQuery('Начните заново: /add');
      return;
    }
    const ymd = ctx.match[1];
    const validated = await validateSelectedDate(state.congregationId, ymd);
    if (!validated.ok) {
      await ctx.answerCbQuery('Дата недоступна');
      await ctx.reply(validated.reason);
      await askDateSelection(ctx, userId, state.congregationId);
      return;
    }
    state.date = ymd;
    state.manualTitleExceptionType = validated.manualTitleExceptionType;
    state.step = 'song';
    wizardState.set(userId, state);
    await ctx.answerCbQuery();
    await ctx.reply('Шаг 2 из 7. Введите номер песни (1–200) или ? если песня ещё не известна:');
  });

  bot.action(/^add:dates:more:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const state = wizardState.get(userId);
    if (!state || state.step !== 'date' || state.congregationId === undefined) {
      await ctx.answerCbQuery('Начните заново: /add');
      return;
    }
    await ctx.answerCbQuery();
    await askDateSelection(ctx, userId, state.congregationId, {
      fromDate: ctx.match[1],
      replaceMessage: true,
    });
  });

  bot.on('message', async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();
    const state = wizardState.get(userId);
    if (!state) return next();
    const text = (ctx.message as { text?: string })?.text?.trim();
    if (!text) {
      await ctx.reply('Пожалуйста, введите текст.');
      return;
    }
    // /cancel — отмена; любая команда (/) — выход из мастера, чтобы команда обработалась
    if (text === '/cancel') {
      wizardState.delete(userId);
      await ctx.reply('Добавление речи отменено.');
      return;
    }
    if (text.startsWith('/')) {
      wizardState.delete(userId);
      return next();
    }

    if (state.step === 'date') {
      const ymd = parseUserDateToYmd(text);
      if (!ymd) {
        await ctx.reply('Выберите дату кнопкой выше или введите ДД.ММ.ГГГГ (например 10.02.2025), /cancel.');
        return;
      }
      if (state.congregationId === undefined) {
        await ctx.reply('Собрание не выбрано. Начните заново: /add');
        wizardState.delete(userId);
        return;
      }
      const validated = await validateSelectedDate(state.congregationId, ymd);
      if (!validated.ok) {
        await ctx.reply(validated.reason);
        return;
      }
      state.step = 'song';
      state.date = ymd;
      state.manualTitleExceptionType = validated.manualTitleExceptionType;
      wizardState.set(userId, state);
      await ctx.reply('Шаг 2 из 7. Введите номер песни (1–200) или ? если песня ещё не известна:');
      return;
    }

    if (state.step === 'song') {
      const trimmed = text.trim();
      if (trimmed === '?' || trimmed === '？') {
        state.song_number = 0;
      } else {
        const n = parseInt(text, 10);
        if (isNaN(n) || n < 1 || n > 200) {
          await ctx.reply('Введите число от 1 до 200 (номер песни) или ? если ещё не известна:');
          return;
        }
        state.song_number = n;
      }
      if (state.manualTitleExceptionType) {
        state.step = 'talk_number';
        wizardState.set(userId, state);
        await ctx.reply(
          `Шаг 3 из 7. Для события «${getExceptionTypeLabel(state.manualTitleExceptionType)}» ` +
            'номер речи можно не указывать.\n' +
            'Введите номер речи или ? (либо 0), если используете произвольную тему:'
        );
      } else {
        state.step = 'talk_number';
        wizardState.set(userId, state);
        await ctx.reply('Шаг 3 из 7. Введите номер речи из списка (/plans):');
      }
      return;
    }

    if (state.step === 'talk_number') {
      if (state.manualTitleExceptionType) {
        const trimmed = text.trim();
        if (trimmed === '?' || trimmed === '？' || trimmed === '0') {
          state.talk_number = 0;
        } else {
          const n = parseInt(text, 10);
          if (isNaN(n) || n < 1) {
            await ctx.reply('Введите номер речи (положительное число) или ?/0 для произвольной темы:');
            return;
          }
          state.talk_number = n;
        }
        const suggested =
          state.talk_number > 0 ? await getTitleForTalk(db, state.talk_number) : undefined;
        state.step = 'title';
        wizardState.set(userId, state);
        if (suggested) {
          await ctx.reply(
            `Шаг 4 из 7. Для события «${getExceptionTypeLabel(state.manualTitleExceptionType)}» ` +
              'название вводится вручную.\n' +
              `Подсказка из списка: «${suggested}».\n` +
              'Введите фактическое название речи:'
          );
        } else {
          await ctx.reply(
            `Шаг 4 из 7. Для события «${getExceptionTypeLabel(state.manualTitleExceptionType)}» ` +
              'введите название речи вручную:'
          );
        }
        return;
      }
      const n = parseInt(text, 10);
      if (isNaN(n) || n < 1) {
        await ctx.reply('Введите номер речи из списка (положительное число):');
        return;
      }
      state.talk_number = n;
      const title = await getTitleForTalk(db, n);
      if (title) {
        state.title = title;
        state.step = 'speaker_name';
        wizardState.set(userId, state);
        await ctx.reply(`Шаг 4 из 7. Название из списка: «${title}».\nШаг 5 из 7. Введите имя докладчика:`);
        return;
      }
      state.step = 'title';
      wizardState.set(userId, state);
      await ctx.reply('Шаг 4 из 7. В списке речей нет такого номера. Введите название речи вручную:');
      return;
    }

    if (state.step === 'title') {
      state.step = 'speaker_name';
      state.title = text;
      wizardState.set(userId, state);
      await ctx.reply('Шаг 5 из 7. Введите имя докладчика:');
      return;
    }

    if (state.step === 'speaker_name') {
      state.step = 'speaker_phone';
      state.speaker_name = text;
      wizardState.set(userId, state);
      await ctx.reply('Шаг 6 из 7. Введите номер телефона докладчика:');
      return;
    }

    if (state.step === 'speaker_phone') {
      state.speaker_phone = text;
      wizardState.delete(userId);
      if (
        state.congregationId === undefined ||
        state.date === undefined ||
        state.song_number === undefined ||
        state.talk_number === undefined ||
        state.title === undefined ||
        state.speaker_name === undefined
      ) {
        await ctx.reply('Ошибка: не все данные сохранены. Начните заново с /add');
        return;
      }
      const input: TalkInput = {
        congregation_id: state.congregationId,
        date: state.date,
        song_number: state.song_number,
        talk_number: state.talk_number,
        title: state.title,
        speaker_name: state.speaker_name,
        speaker_phone: state.speaker_phone,
      };
      let id: number;
      try {
        id = await talks.create(input);
      } catch (error) {
        if (error instanceof TalkDateValidationError) {
          await ctx.reply(
            `Эта дата не совпадает с днем встречи собрания. ` +
              `Выберите ${formatWeekdayRu(error.expectedWeekday)} через /add.`
          );
          return;
        }
        if (error instanceof TalkDateBlockedByEventError) {
          await ctx.reply(
            `Этот уикенд занят событием: ${getExceptionTypeLabel(error.exceptionType)}. ` +
              'На такую дату публичную речь не планируют.'
          );
          return;
        }
        throw error;
      }
      const cong = await congRepo.getById(state.congregationId);
      const songDisplay = state.song_number === 0 ? '?' : state.song_number;
      const talkNumberDisplay = state.talk_number === 0 ? 'произвольная тема' : `№${state.talk_number}`;
      await ctx.reply(
        `✅ Речь добавлена (ID: ${id}).\n` +
          `${formatDateRu(state.date)}, песня ${songDisplay}, речь ${talkNumberDisplay}\n` +
          `«${state.title}» — ${state.speaker_name}, ${state.speaker_phone}\n` +
          `Собрание: ${cong?.name ?? state.congregationId}\n\nПосмотреть расписание: /list`
      );
      return;
    }

    return next();
  });
}
