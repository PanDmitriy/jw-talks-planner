/**
 * Команда /stats — статистика: сколько раз каждая речь звучала и когда в последний раз
 */

import type { Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import type { AuthContext } from '../middlewares/auth';
import { Markup } from 'telegraf';
import { getTalkStats, getTalkStatsByYearMatrix, congregationsRepo } from '../../db';
import { splitMessage } from '../utils/splitMessage';
import { formatDateRu } from '../../utils/date';

export function registerStatsCommand(bot: Telegraf<AuthContext>, db: DatabaseInstance): void {
  const congRepo = congregationsRepo(db);

  const statsHandler = async (ctx: AuthContext) => {
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;

    const text = (ctx.message as { text?: string })?.text?.trim() ?? '';
    const args = text.split(/\s+/).slice(1);
    const congregationName = args.join(' ').trim();

    if (ids.length === 1) {
      await sendStatsForCongregation(ctx, db, ids[0]);
      return;
    }

    if (congregationName) {
      const allCong = await congRepo.listAll();
      const cong = allCong.find((c) => c.name.toLowerCase() === congregationName.toLowerCase());
      if (cong && ids.includes(cong.id)) {
        await sendStatsForCongregation(ctx, db, cong.id);
        return;
      }
    }

    // Несколько общин и не указана — выбор кнопкой
    const buttons = await Promise.all(ids.map(async (id) => {
      const c = await congRepo.getById(id);
      return Markup.button.callback(c?.name ?? `Община ${id}`, `stats:cong:${id}`);
    }));
    await ctx.reply('Выберите общину:', Markup.inlineKeyboard(buttons));
  };

  bot.command('stats', statsHandler);
  bot.hears('📊 Статистика', statsHandler);

  bot.action(/^stats:cong:(\d+)$/, async (ctx) => {
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    await sendStatsForCongregation(ctx, db, congregationId, true);
  });

  bot.action(/^stats:matrix:(\d+)$/, async (ctx) => {
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    await ctx.answerCbQuery();
    const cong = await congregationsRepo(db).getById(congregationId);
    const name = cong?.name ?? `Община ${congregationId}`;
    const matrix = await getTalkStatsByYearMatrix(db, congregationId, { fromYear: 2020, toYear: 2028 });
    const years = [2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027, 2028];
    const header = ['№', 'Название', ...years.map(String)].join(';');
    const escapeCsv = (s: string) => (s.includes(';') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = [header];
    for (const row of matrix) {
      const cells = [
        String(row.talk_number),
        escapeCsv(row.title),
        ...years.map((y) => row.datesByYear[y] ?? ''),
      ];
      lines.push(cells.join(';'));
    }
    const csv = '\uFEFF' + lines.join('\n');
    const fileName = `stats-${name.replace(/\s+/g, '-')}-по-годам.csv`;
    await ctx.telegram.sendDocument(ctx.chat!.id, {
      source: Buffer.from(csv, 'utf8'),
      filename: fileName,
    }, {
      caption: `📅 Учёт по годам — ${name}. Даты в формате ДД.ММ.`,
    });
  });
}

async function sendStatsForCongregation(
  ctx: AuthContext,
  db: DatabaseInstance,
  congregationId: number,
  isEdit = false
): Promise<void> {
  const pluralizeTimes = (count: number): string => {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return `${count} раз`;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} раза`;
    return `${count} раз`;
  };

  const escapeHtml = (value: string): string =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const cong = await congregationsRepo(db).getById(congregationId);
  const name = cong?.name ?? `Община ${congregationId}`;
  const safeName = escapeHtml(name);

  const talkStats = await getTalkStats(db, congregationId);
  let msg = `📊 <b>Статистика речей</b>\n🏛 <b>Община:</b> ${safeName}\n\n`;

  if (talkStats.length === 0) {
    msg += 'Пока нет данных по речам.\n';
  } else {
    msg += `🧾 <b>Всего тем в истории:</b> ${talkStats.length}\n`;
    msg += `🔢 <b>Порядок:</b> по номеру речи\n\n`;

    for (const t of talkStats) {
      const countText = pluralizeTimes(t.total_count);
      const lastDateText = t.last_date ? escapeHtml(formatDateRu(t.last_date)) : 'нет данных';
      msg += `<b>№${t.talk_number}</b> • <b>${countText}</b>\n`;
      msg += `🗓 Последняя дата: <b>${lastDateText}</b>\n`;
      msg += '\n';
    }
  }

  const matrixButton = Markup.button.callback('📅 По годам (матрица CSV)', `stats:matrix:${congregationId}`);

  const chunks = splitMessage(msg);
  const keyboard = Markup.inlineKeyboard([matrixButton]);
  if (isEdit && 'editMessageText' in ctx && typeof ctx.editMessageText === 'function') {
    await ctx.editMessageText(chunks[0], {
      ...keyboard,
      parse_mode: 'HTML',
    });
    const chatId = ctx.chat?.id;
    if (chatId && chunks.length > 1) {
      for (const chunk of chunks.slice(1)) {
        await ctx.telegram.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
      }
    }
  } else {
    await ctx.reply(chunks[0], {
      ...keyboard,
      parse_mode: 'HTML',
    });
    for (const chunk of chunks.slice(1)) {
      await ctx.reply(chunk, { parse_mode: 'HTML' });
    }
  }
}
