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

function formatSong(n: number): string {
  return n === 0 ? '?' : String(n);
}

function formatTalkNumber(n: number): string {
  return n === 0 ? 'произвольная тема' : `№${n}`;
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
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

/** Блок одной даты: заголовок даты, затем песня/речь/название, докладчик. */
function formatScheduleBlock(t: Talk): string {
  const song = formatSong(t.song_number);
  return (
    `🗓 ${formatDateHeader(t.date)}\n` +
    `   🎵 ${song}  ·  ${formatTalkNumber(t.talk_number)} «${t.title}»\n` +
    `   👤 ${t.speaker_name}`
  );
}

function formatExceptionLine(exception: ScheduleException): string {
  if (exception.exception_type === 'memorial') {
    return '   🚫 Вечеря воспоминания';
  }
  if (exception.exception_type === 'district_congress') {
    return '   🚫 Районный конгресс';
  }
  if (exception.exception_type === 'special_talk_before_memorial') {
    return '   ℹ️ Специальная речь перед Вечерей';
  }
  if (exception.exception_type === 'bethel_speaker_visit') {
    return '   ℹ️ Посещение вефильского докладчика';
  }
  return '   ℹ️ С публичной и служебной речью выступает РС';
}

/** Собирает текст расписания с визуальными блоками и разделителями. */
function buildScheduleText(talks: Talk[], exceptions: ScheduleException[]): string {
  if (talks.length === 0 && exceptions.length === 0) return '';
  const byDate = new Map<string, { talk?: Talk; exception?: ScheduleException }>();
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
  const sep = '─────────────────────';
  const blocks = dates.map((date) => {
    const row = byDate.get(date)!;
    const lines: string[] = [`🗓 ${formatDateHeader(date)}`];
    if (row.talk) {
      lines.push(
        `   🎵 ${formatSong(row.talk.song_number)}  ·  ${formatTalkNumber(row.talk.talk_number)} «${row.talk.title}»`
      );
      lines.push(`   👤 ${row.talk.speaker_name}`);
    }
    if (row.exception) {
      lines.push(formatExceptionLine(row.exception));
    }
    return lines.join('\n');
  }).join(`\n\n${sep}\n\n`);
  return `${sep}\n\n${blocks}\n\n${sep}`;
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
      const meetingDay = DAY_NAMES[cong?.meeting_weekday ?? 0];
      const meetingTime = (cong?.meeting_time ?? '10:00').slice(0, 5);
      if (talks.length === 0 && exceptions.length === 0) {
        await ctx.reply(
          `В собрании «${name}» пока ничего нет.\n` +
            `День и время встречи: ${meetingDay}, ${meetingTime}.\n` +
            'Добавить: /add'
        );
        return;
      }
      const scheduleText = buildScheduleText(talks, exceptions);
      const fullText =
        `📅 Расписание — ${name}\n` +
        `🕒 День и время встречи: ${meetingDay}, ${meetingTime}\n\n` +
        `${scheduleText}`;
      const chunks = splitMessage(fullText);
      for (const chunk of chunks) await ctx.reply(chunk);
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
    const meetingDay = DAY_NAMES[cong?.meeting_weekday ?? 0];
    const meetingTime = (cong?.meeting_time ?? '10:00').slice(0, 5);
    if (talks.length === 0 && exceptions.length === 0) {
      await ctx.editMessageText(
        `В собрании «${name}» пока ничего нет.\n` +
          `День и время встречи: ${meetingDay}, ${meetingTime}.\n` +
          'Добавить: /add'
      );
      return;
    }
    const scheduleText = buildScheduleText(talks, exceptions);
    const fullText =
      `📅 Расписание — ${name}\n` +
      `🕒 День и время встречи: ${meetingDay}, ${meetingTime}\n\n` +
      `${scheduleText}`;
    const chunks = splitMessage(fullText);
    await ctx.editMessageText(chunks[0]);
    const chatId = ctx.chat?.id;
    if (chatId && chunks.length > 1) {
      for (const chunk of chunks.slice(1)) await ctx.telegram.sendMessage(chatId, chunk);
    }
  });
}
