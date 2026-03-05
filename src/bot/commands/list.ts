/**
 * Команда /list — расписание публичных речей по общине.
 * На каждую дату одна речь (собрание по воскресеньям или по субботам).
 */

import type { Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import type { AuthContext } from '../middlewares/auth';
import { Markup } from 'telegraf';
import { talksRepo, congregationsRepo, scheduleExceptionsRepo } from '../../db';
import type { Talk, ScheduleException } from '../../db/types';
import { splitMessage } from '../utils/splitMessage';
import { formatDateRu, toYmdString } from '../../utils/date';

const DAY_NAMES = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const MONTH_NAMES = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];

function formatSong(n: number): string {
  return n === 0 ? '?' : String(n);
}

function formatTalkNumber(n: number): string | null {
  return n !== 0 ? `${n}` : null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function addMonths(ymd: string, months: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCMonth(dt.getUTCMonth() + months);
  return dt.toISOString().slice(0, 10);
}

function getNextMeetingDate(fromDate: string, meetingWeekday: number): string {
  let cursor = fromDate;
  for (let i = 0; i < 7; i += 1) {
    if (getUtcDayOfWeek(cursor) === meetingWeekday) return cursor;
    cursor = addDays(cursor, 1);
  }
  return fromDate;
}

function getUpcomingMeetingDates(fromDate: string, meetingWeekday: number, monthsAhead: number): string[] {
  const endDate = addMonths(fromDate, monthsAhead);
  const out: string[] = [];
  let cursor = getNextMeetingDate(fromDate, meetingWeekday);
  while (cursor <= endDate) {
    out.push(cursor);
    cursor = addDays(cursor, 7);
  }
  return out;
}

function getUtcDayOfWeek(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Форматирует дату как "Суббота, 10.02.2025" */
function formatDateHeader(isoDate: string | Date | number): string {
  const ymd = toYmdString(isoDate);
  if (!ymd) return formatDateRu(isoDate);
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dayName = DAY_NAMES[date.getDay()];
  return `${dayName}, ${formatDateRu(isoDate)}`;
}

function getMonthKey(ymd: string): string {
  return ymd.slice(0, 7);
}

function formatMonthHeader(ymd: string): string {
  const [year, month] = ymd.split('-').map(Number);
  return `📆 <b>${MONTH_NAMES[month - 1]} ${year}</b>`;
}

function formatExceptionLine(exception: ScheduleException): string {
  if (exception.exception_type === 'memorial') {
    return 'Вечеря воспоминания';
  }
  if (exception.exception_type === 'district_congress') {
    return 'Районный конгресс';
  }
  if (exception.exception_type === 'special_talk_before_memorial') {
    return 'Специальная речь перед Вечерей';
  }
  if (exception.exception_type === 'bethel_speaker_visit') {
    return 'Посещение вефильского докладчика';
  }
  return 'С публичной и служебной речью выступает РС';
}

/** Собирает текст расписания компактными блоками без визуального шума. */
function buildScheduleText(
  talks: Talk[],
  exceptions: ScheduleException[],
  upcomingMeetingDates: string[]
): string {
  const byDate = new Map<string, { talk?: Talk; exception?: ScheduleException }>();
  for (const date of upcomingMeetingDates) {
    byDate.set(date, byDate.get(date) ?? {});
  }
  for (const t of talks) {
    const row = byDate.get(t.date) ?? {};
    row.talk = t;
    byDate.set(t.date, row);
  }
  for (const e of exceptions) {
    const row = byDate.get(e.date) ?? {};
    row.exception = e;
    byDate.set(e.date, row);
  }
  const dates = [...byDate.keys()].sort();
  const blocks: string[] = [];
  let currentMonth: string | null = null;
  for (const date of dates) {
    const monthKey = getMonthKey(date);
    if (monthKey !== currentMonth) {
      blocks.push(formatMonthHeader(date));
      currentMonth = monthKey;
    }
    const row = byDate.get(date)!;
    const lines: string[] = [`🗓 ${formatDateHeader(date)}`];
    if (row.talk) {
      const talkNumber = formatTalkNumber(row.talk.talk_number);
      const safeTitle = escapeHtml(row.talk.title);
      const safeSpeakerName = escapeHtml(row.talk.speaker_name);
      const talkLabel = talkNumber ? `${safeTitle} (${talkNumber})` : `${safeTitle}`;
      lines.push(`🎵 ${formatSong(row.talk.song_number)}`);
      lines.push(`💬 ${talkLabel}`);
      lines.push(`👤 ${safeSpeakerName}`);
    }
    if (row.exception) {
      lines.push(`ℹ️ ${formatExceptionLine(row.exception)}`);
    }
    if (!row.talk && !row.exception) {
      lines.push('⚠️ Речь не запланирована');
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

async function loadScheduleForCongregation(
  db: DatabaseInstance,
  congregationId: number,
  fromDate: string,
  meetingWeekday: number
): Promise<{ talks: Talk[]; exceptions: ScheduleException[] }> {
  const talksAll = await talksRepo(db).listByCongregation(congregationId, { fromDate });
  const talks = talksAll.filter((t) => getUtcDayOfWeek(t.date) === meetingWeekday);
  const maxTalkDate = talks[talks.length - 1]?.date;
  const fallbackToDate = addDays(fromDate, 120);
  const toDate = maxTalkDate && maxTalkDate > fallbackToDate ? maxTalkDate : fallbackToDate;
  const exceptionsAll = await scheduleExceptionsRepo(db).listByCongregation(congregationId, {
    fromDate,
    toDate,
  });
  const exceptions = exceptionsAll.filter((e) => getUtcDayOfWeek(e.date) === meetingWeekday);
  return { talks, exceptions };
}

export function registerListCommand(bot: Telegraf<AuthContext>, db: DatabaseInstance): void {
  const congRepo = congregationsRepo(db);

  const listHandler = async (ctx: AuthContext) => {
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;

    const today = new Date().toISOString().slice(0, 10);

    if (ids.length === 1) {
      const cong = await congRepo.getById(ids[0]);
      const { talks, exceptions } = await loadScheduleForCongregation(
        db,
        ids[0],
        today,
        cong?.meeting_weekday ?? 0
      );
      const name = cong?.name ?? 'Собрание';
      const safeName = escapeHtml(name);
      const meetingDay = DAY_NAMES[cong?.meeting_weekday ?? 0];
      const meetingTime = (cong?.meeting_time ?? '10:00').slice(0, 5);
      const meetingWeekday = cong?.meeting_weekday ?? 0;
      const nextMeetingDate = getNextMeetingDate(today, meetingWeekday);
      const upcomingMeetingDates = getUpcomingMeetingDates(today, meetingWeekday, 3);
      const scheduleText = buildScheduleText(talks, exceptions, upcomingMeetingDates);
      const fullText =
        `📅 Расписание — ${safeName}\n` +
        `🕒 Встреча: ${meetingDay}, ${meetingTime}\n` +
        `➡️ Ближайшая дата: ${formatDateRu(nextMeetingDate)}\n\n` +
        `${scheduleText}`;
      const chunks = splitMessage(fullText);
      for (const chunk of chunks) await ctx.reply(chunk, { parse_mode: 'HTML' });
      return;
    }

    // Несколько общин — показываем кнопки выбора
    const buttons = await Promise.all(ids.map(async (id) => {
      const c = await congRepo.getById(id);
      return Markup.button.callback(c?.name ?? `Община ${id}`, `list:cong:${id}`);
    }));
    await ctx.reply('Выберите общину:', Markup.inlineKeyboard(buttons));
  };

  bot.command('list', listHandler);
  bot.hears('📅 Расписание', listHandler);

  bot.action(/^list:cong:(\d+)$/, async (ctx) => {
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа к этой общине.');
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const cong = await congRepo.getById(congregationId);
    const { talks, exceptions } = await loadScheduleForCongregation(
      db,
      congregationId,
      today,
      cong?.meeting_weekday ?? 0
    );
    const name = cong?.name ?? 'Собрание';
    const safeName = escapeHtml(name);
    const meetingDay = DAY_NAMES[cong?.meeting_weekday ?? 0];
    const meetingTime = (cong?.meeting_time ?? '10:00').slice(0, 5);
    const meetingWeekday = cong?.meeting_weekday ?? 0;
    const nextMeetingDate = getNextMeetingDate(today, meetingWeekday);
    const upcomingMeetingDates = getUpcomingMeetingDates(today, meetingWeekday, 3);
    const scheduleText = buildScheduleText(talks, exceptions, upcomingMeetingDates);
    const fullText =
      `📅 Расписание — ${safeName}\n` +
      `🕒 Встреча: ${meetingDay}, ${meetingTime}\n` +
      `➡️ Ближайшая дата: ${formatDateRu(nextMeetingDate)}\n\n` +
      `${scheduleText}`;
    const chunks = splitMessage(fullText);
    await ctx.editMessageText(chunks[0], { parse_mode: 'HTML' });
    const chatId = ctx.chat?.id;
    if (chatId && chunks.length > 1) {
      for (const chunk of chunks.slice(1)) {
        await ctx.telegram.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
      }
    }
  });
}
