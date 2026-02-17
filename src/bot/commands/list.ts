/**
 * Команда /list — расписание публичных речей по общине.
 * На каждую дату одна речь (собрание по воскресеньям или по субботам).
 */

import type { Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import type { AuthContext } from '../middlewares/auth';
import { Markup } from 'telegraf';
import { talksRepo, congregationsRepo } from '../../db';
import type { Talk } from '../../db/types';
import { splitMessage } from '../utils/splitMessage';
import { formatDateRu, toYmdString } from '../../utils/date';

const DAY_NAMES = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

function formatSong(n: number): string {
  return n === 0 ? '?' : String(n);
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
    `   🎵 ${song}  ·  №${t.talk_number} «${t.title}»\n` +
    `   👤 ${t.speaker_name}`
  );
}

/** Собирает текст расписания с визуальными блоками и разделителями. */
function buildScheduleText(talks: Talk[]): string {
  if (talks.length === 0) return '';
  const sep = '─────────────────────';
  const blocks = talks.map(formatScheduleBlock).join(`\n\n${sep}\n\n`);
  return `${sep}\n\n${blocks}\n\n${sep}`;
}

export function registerListCommand(bot: Telegraf<AuthContext>, db: DatabaseInstance): void {
  const talks = talksRepo(db);
  const congRepo = congregationsRepo(db);

  const listHandler = async (ctx: AuthContext) => {
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;

    const today = new Date().toISOString().slice(0, 10);

    if (ids.length === 1) {
      const list = await talks.listByCongregation(ids[0], { fromDate: today });
      const cong = await congRepo.getById(ids[0]);
      const name = cong?.name ?? 'Община';
      if (list.length === 0) {
        await ctx.reply(`В общине «${name}» пока ничего нет. Добавить: /add`);
        return;
      }
      const scheduleText = buildScheduleText(list);
      const fullText = `📅 Расписание — ${name}\n\n${scheduleText}`;
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
    const list = await talks.listByCongregation(congregationId, { fromDate: today });
    const cong = await congRepo.getById(congregationId);
    const name = cong?.name ?? 'Община';
    if (list.length === 0) {
      await ctx.editMessageText(`В общине «${name}» пока ничего нет. Добавить: /add`);
      return;
    }
    const scheduleText = buildScheduleText(list);
    const fullText = `📅 Расписание — ${name}\n\n${scheduleText}`;
    const chunks = splitMessage(fullText);
    await ctx.editMessageText(chunks[0]);
    const chatId = ctx.chat?.id;
    if (chatId && chunks.length > 1) {
      for (const chunk of chunks.slice(1)) await ctx.telegram.sendMessage(chatId, chunk);
    }
  });
}
