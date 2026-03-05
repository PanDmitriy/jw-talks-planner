/**
 * Команда /edit — редактирование публичной речи (выбор по дате и кнопкам)
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

type EditStep =
  | 'congregation'
  | 'period'
  | 'date'   // выбор даты из списка или ввод новой даты
  | 'field'
  | 'song'
  | 'talk_number'
  | 'speaker_name'
  | 'speaker_phone';

type TalkPeriod = 'past' | 'future';

interface EditTalkState {
  step: EditStep;
  congregationId?: number;
  period?: TalkPeriod;
  talkId?: number;
}

const editState = new Map<number, EditTalkState>();

function getDateStatusLabel(ymd: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return ymd < today ? '🕓 Прошедшая' : '📅 Предстоящая';
}

function isDateInPeriod(ymd: string, period: TalkPeriod): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return period === 'past' ? ymd < today : ymd >= today;
}

function getUtcDayOfWeek(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function getPeriodLabel(period: TalkPeriod): string {
  return period === 'past' ? 'прошедшие' : 'будущие';
}

function getPeriodKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🕓 Прошедшие', 'edit:period:past')],
    [Markup.button.callback('📅 Будущие', 'edit:period:future')],
  ]);
}

function getEditFieldKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Дата', 'edit:field:date'),
      Markup.button.callback('Песня', 'edit:field:song'),
      Markup.button.callback('№ речи', 'edit:field:talk_number'),
    ],
    [
      Markup.button.callback('Докладчик', 'edit:field:speaker_name'),
      Markup.button.callback('Телефон', 'edit:field:speaker_phone'),
    ],
    [Markup.button.callback('✅ Готово', 'edit:done')],
  ]);
}

function formatTalkNumber(n: number): string {
  return n === 0 ? 'произвольная тема' : `№${n}`;
}

function formatEditTalkCard(congregationName: string, talk: { date: string; song_number: number; talk_number: number; title: string; speaker_name: string; speaker_phone: string }): string {
  return (
    `Редактирование речи (${congregationName}):\n` +
    `Дата: ${formatDateRu(talk.date)}\n` +
    `Песня: ${talk.song_number === 0 ? '?' : talk.song_number}, Речь: ${formatTalkNumber(talk.talk_number)}\n` +
    `Название: ${talk.title}\n` +
    `Докладчик: ${talk.speaker_name}, ${talk.speaker_phone}\n\n` +
    'Что изменить?'
  );
}

export function registerEditCommand(bot: Telegraf<AuthContext>, db: DatabaseInstance): void {
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

  bot.command('edit', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;

    if (ids.length === 1) {
      editState.set(userId, { step: 'period', congregationId: ids[0] });
      await ctx.reply('Какие речи хотите редактировать?', getPeriodKeyboard());
      return;
    }

    editState.set(userId, { step: 'congregation' });
    const buttons = await Promise.all(ids.map(async (id) => {
      const c = await congRepo.getById(id);
      return Markup.button.callback(c?.name ?? `Община ${id}`, `edit:cong:${id}`);
    }));
    await ctx.reply('Выберите общину:', Markup.inlineKeyboard(buttons.map((b) => [b])));
  });

  bot.action(/^edit:cong:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа к этой общине.');
      return;
    }
    editState.set(userId, { step: 'period', congregationId });
    await ctx.editMessageText('Какие речи хотите редактировать?', getPeriodKeyboard());
  });

  bot.action(/^edit:period:(past|future)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const period = ctx.match[1] as TalkPeriod;
    const state = editState.get(userId);
    if (!state || state.step !== 'period' || state.congregationId === undefined) {
      await ctx.answerCbQuery('Выберите общину заново: /edit');
      return;
    }

    const list = await talks.listByCongregation(state.congregationId);
    const congregation = await congRepo.getById(state.congregationId);
    const meetingWeekday = congregation?.meeting_weekday ?? 0;
    const dates = [...new Set(
      list
        .map((t) => t.date)
        .filter((d) => isDateInPeriod(d, period) && getUtcDayOfWeek(d) === meetingWeekday)
    )].sort();
    if (dates.length === 0) {
      await ctx.editMessageText(`В этой общине нет речей в категории «${getPeriodLabel(period)}».`);
      editState.delete(userId);
      return;
    }

    editState.set(userId, { step: 'date', congregationId: state.congregationId, period });
    const dateButtons = dates.map((d) =>
      Markup.button.callback(
        `${d < new Date().toISOString().slice(0, 10) ? '🕓' : '📅'} ${formatDateRu(d)}`,
        `edit:date:${d}`
      )
    );
    await ctx.editMessageText(
      `Выберите дату (${getPeriodLabel(period)} речи).\n` +
        'Показываются только даты дня встречи вашего собрания:',
      Markup.inlineKeyboard(dateButtons.map((b) => [b]))
    );
  });

  bot.action(/^edit:date:(.+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const date = ctx.match[1];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const state = editState.get(userId);
    if (!state || state.step !== 'date' || state.congregationId === undefined || !state.period) {
      await ctx.answerCbQuery('Выберите общину и дату заново: /edit');
      return;
    }
    if (!isDateInPeriod(date, state.period)) {
      await ctx.answerCbQuery('Эта дата не входит в выбранную категорию.');
      return;
    }
    const congregation = await congRepo.getById(state.congregationId);
    const meetingWeekday = congregation?.meeting_weekday ?? 0;
    if (getUtcDayOfWeek(date) !== meetingWeekday) {
      await ctx.answerCbQuery('Эта дата не относится к дню встречи собрания.');
      return;
    }
    const onDate = await talks.listByCongregation(state.congregationId, { fromDate: date, toDate: date });
    if (onDate.length === 0) {
      await ctx.answerCbQuery('На эту дату речей не найдено.');
      return;
    }
    const talkButtons = onDate.map((t, i) =>
      Markup.button.callback(
        `${i + 1}. Песня ${t.song_number === 0 ? '?' : t.song_number}, ${formatTalkNumber(t.talk_number)} — ${t.speaker_name}`,
        `edit:talk:${t.id}`
      )
    );
    await ctx.editMessageText(
      `${getDateStatusLabel(date)} речь на ${formatDateRu(date)}. Выберите речь:`,
      Markup.inlineKeyboard(talkButtons.map((b) => [b]))
    );
  });

  bot.action(/^edit:talk:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const talkId = parseInt(ctx.match[1], 10);
    const talk = await talks.getById(talkId);
    if (!talk || !ctx.congregationIds?.includes(talk.congregation_id)) {
      await ctx.answerCbQuery('Нет доступа к этой речи.');
      return;
    }
    const currentState = editState.get(userId);
    editState.set(userId, {
      step: 'field',
      talkId,
      congregationId: talk.congregation_id,
      period: currentState?.period,
    });
    const cong = await congRepo.getById(talk.congregation_id);
    await ctx.editMessageText(
      `${formatEditTalkCard(cong?.name ?? '', talk)} (или /cancel)`,
      getEditFieldKeyboard()
    );
  });

  const fieldPrompts: Record<string, string> = {
    date: 'Введите новую дату (ДД.ММ.ГГГГ):',
    song: 'Введите новый номер песни (1–200 или ? если ещё не известна):',
    talk_number:
      'Введите новый номер речи (название подставится из списка, кроме РС/спецречи перед Вечерей/вефильского докладчика):',
    speaker_name: 'Введите новое имя докладчика:',
    speaker_phone: 'Введите новый номер телефона:',
  };

  bot.action(/^edit:field:(.+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const field = ctx.match[1];
    if (!['date', 'song', 'talk_number', 'speaker_name', 'speaker_phone'].includes(field)) return;
    const state = editState.get(userId);
    if (!state || state.step !== 'field' || state.talkId === undefined) return;
    const talk = await talks.getById(state.talkId);
    if (!talk || !ctx.congregationIds?.includes(talk.congregation_id)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    state.step = field as EditStep;
    editState.set(userId, state);
    await ctx.editMessageText(fieldPrompts[field] ?? 'Введите новое значение:');
  });

  bot.action('edit:done', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const state = editState.get(userId);
    if (!state || state.step !== 'field' || state.talkId === undefined) {
      await ctx.answerCbQuery('Сессия неактивна. Выполните /edit заново.');
      return;
    }
    editState.delete(userId);
    await ctx.editMessageText('✅ Редактирование завершено.');
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
      await ctx.reply('Редактирование отменено.');
      return;
    }
    if (text.startsWith('/')) {
      editState.delete(userId);
      return next();
    }

    if (state.talkId === undefined) {
      await ctx.reply('Сначала выберите речь: /edit');
      return next();
    }

    const talk = await talks.getById(state.talkId);
    if (!talk) {
      editState.delete(userId);
      await ctx.reply('Речь не найдена.');
      return;
    }

    if (state.step === 'field') {
      const field = text.toLowerCase();
      if (field === 'готово') {
        editState.delete(userId);
        await ctx.reply('✅ Редактирование завершено.');
        return;
      }
      if (['date', 'song', 'talk_number', 'speaker_name', 'speaker_phone'].includes(field)) {
        state.step = field as EditStep;
        editState.set(userId, state);
        await ctx.reply(fieldPrompts[field] ?? 'Введите новое значение:');
        return;
      }
      await ctx.reply('Нажмите кнопку выбора поля выше или отправьте /cancel.');
      return;
    }

    let value: string | number = text;
    let normalizedDate: string | null = null;
    let hasManualTitleEventForTalk = false;
    if (state.step === 'date') {
      normalizedDate = parseUserDateToYmd(text);
      if (!normalizedDate) {
        await ctx.reply('Неверный формат даты. Введите ДД.ММ.ГГГГ:');
        return;
      }
    } else if (state.step === 'song') {
      const trimmed = text.trim();
      if (trimmed === '?' || trimmed === '？') {
        value = 0;
      } else {
        const n = parseInt(text, 10);
        if (isNaN(n) || n < 1 || n > 200) {
          await ctx.reply('Введите число от 1 до 200 (номер песни) или ? если ещё не известна:');
          return;
        }
        value = n;
      }
    } else if (state.step === 'talk_number') {
      const events = await exceptionsRepo.getWeekendEvents(talk.congregation_id, talk.date);
      hasManualTitleEventForTalk = events.some((event) => MANUAL_TITLE_TYPES.has(event.exception_type));
      const trimmed = text.trim();
      if (hasManualTitleEventForTalk && (trimmed === '?' || trimmed === '0')) {
        value = 0;
      } else {
        const n = parseInt(text, 10);
        if (isNaN(n) || n < 1) {
          await ctx.reply(
            hasManualTitleEventForTalk
              ? 'Введите номер речи (число) или 0/? для произвольной темы:'
              : 'Введите номер речи (число):'
          );
          return;
        }
        value = n;
      }
    }

    const update: Partial<TalkInput> = {};
    if (state.step === 'date') update.date = normalizedDate!;
    else if (state.step === 'song') update.song_number = value as number;
    else if (state.step === 'talk_number') {
      update.talk_number = value as number;
      if (!hasManualTitleEventForTalk) {
        const newTitle = await getTitleForTalk(db, value as number);
        if (newTitle) update.title = newTitle;
      }
    } else if (state.step === 'speaker_name') update.speaker_name = text;
    else if (state.step === 'speaker_phone') update.speaker_phone = text;

    try {
      await talks.update(state.talkId, update);
    } catch (error) {
      if (error instanceof TalkDateValidationError) {
        await ctx.reply(
          `Эта дата не совпадает с днем встречи собрания. ` +
            `Выберите ${formatWeekdayRu(error.expectedWeekday)}.`
        );
        return;
      }
      if (error instanceof TalkDateBlockedByEventError) {
        await ctx.reply(
          `Этот уикенд занят событием: ${getExceptionTypeLabel(error.exceptionType)}. ` +
            'Публичную речь на такую дату планировать нельзя.'
        );
        return;
      }
      throw error;
    }
    const updatedTalk = await talks.getById(state.talkId);
    if (!updatedTalk || !ctx.congregationIds?.includes(updatedTalk.congregation_id)) {
      editState.delete(userId);
      await ctx.reply('Речь обновлена, но сессия завершена. Запустите /edit при необходимости.');
      return;
    }

    const cong = await congRepo.getById(updatedTalk.congregation_id);
    state.step = 'field';
    editState.set(userId, state);
    await ctx.reply(
      `✅ Поле обновлено.\n\n${formatEditTalkCard(cong?.name ?? '', updatedTalk)} (или /cancel)`,
      getEditFieldKeyboard()
    );
  });
}
