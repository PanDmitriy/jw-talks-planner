/**
 * Команда /stats — статистика: сколько раз каждая речь звучала и когда в последний раз
 */

import type { Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import type { AuthContext } from '../middlewares/auth';
import { Markup } from 'telegraf';
import ExcelJS from 'exceljs';
import { getTalkStats, getTalkStatsByYearMatrix, congregationsRepo } from '../../db';
import { formatDateRu } from '../../utils/date';
import type { TalkStats } from '../../db/types';

const STATS_PAGE_SIZE = 10;
const STATS_TOP_LIMIT = 10;

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

  bot.action(/^stats:page:(\d+):(\d+)$/, async (ctx) => {
    const congregationId = parseInt(ctx.match[1], 10);
    const offset = parseInt(ctx.match[2], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    await ctx.answerCbQuery();
    await sendStatsForCongregation(ctx, db, congregationId, true, offset);
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
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'JW Talks Planner Bot';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Матрица', {
      views: [{ state: 'frozen', ySplit: 4, xSplit: 2 }],
    });

    const lastColumnLetter = String.fromCharCode(65 + years.length + 2);
    sheet.mergeCells(`A1:${lastColumnLetter}1`);
    sheet.getCell('A1').value = `Учёт по годам — ${name}`;
    sheet.getCell('A1').font = { bold: true, size: 14 };
    sheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };

    sheet.mergeCells(`A2:${lastColumnLetter}2`);
    sheet.getCell('A2').value = `Период: ${years[0]}-${years[years.length - 1]} | Тем в матрице: ${matrix.length} | Даты в формате ДД.ММ`;
    sheet.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };

    const headers = ['№', 'Название речи', ...years.map(String), 'Итого дат'];
    const headerRowIndex = 4;
    const headerRow = sheet.getRow(headerRowIndex);
    headerRow.values = headers;
    headerRow.height = 22;
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD9D9D9' } },
        left: { style: 'thin', color: { argb: 'FFD9D9D9' } },
        bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } },
        right: { style: 'thin', color: { argb: 'FFD9D9D9' } },
      };
    });

    for (const [index, row] of matrix.entries()) {
      const datesByYears = years.map((y) => row.datesByYear[y] ?? '');
      const totalDates = datesByYears
        .flatMap((value) => value.split(', ').filter(Boolean))
        .length;
      const excelRow = sheet.addRow([
        row.talk_number,
        row.title,
        ...datesByYears,
        totalDates,
      ]);
      excelRow.height = 34;
      excelRow.eachCell((cell, colNumber) => {
        const isTitleColumn = colNumber === 2;
        cell.alignment = {
          horizontal: isTitleColumn ? 'left' : 'center',
          vertical: 'middle',
          wrapText: true,
        };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE6E6E6' } },
          left: { style: 'thin', color: { argb: 'FFE6E6E6' } },
          bottom: { style: 'thin', color: { argb: 'FFE6E6E6' } },
          right: { style: 'thin', color: { argb: 'FFE6E6E6' } },
        };
        if (index % 2 === 1) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7FBFF' } };
        }
      });
    }

    sheet.columns = [
      { width: 6 },
      { width: 44 },
      ...years.map(() => ({ width: 12 })),
      { width: 12 },
    ];
    sheet.autoFilter = {
      from: { row: headerRowIndex, column: 1 },
      to: { row: headerRowIndex, column: headers.length },
    };

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer() as ArrayBuffer);
    const fileName = `stats-${name.replace(/\s+/g, '-')}-по-годам.xlsx`;
    await ctx.telegram.sendDocument(ctx.chat!.id, {
      source: buffer,
      filename: fileName,
    }, {
      caption: `📅 Учёт по годам (XLSX) — ${name}. Добавлены перенос названий, фильтр и итоги.`,
    });
  });

  bot.action(/^stats:fullxlsx:(\d+)$/, async (ctx) => {
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    await ctx.answerCbQuery();
    await sendFullStatsXlsx(ctx, db, congregationId);
  });
}

async function sendStatsForCongregation(
  ctx: AuthContext,
  db: DatabaseInstance,
  congregationId: number,
  isEdit = false,
  offset = 0
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
  const message = buildStatsMessage({
    talkStats,
    congregationName: safeName,
    offset,
    pageSize: STATS_PAGE_SIZE,
    topLimit: STATS_TOP_LIMIT,
    escapeHtml,
    pluralizeTimes,
  });
  const keyboard = buildStatsKeyboard(congregationId, talkStats.length, offset, STATS_PAGE_SIZE);

  if (isEdit && 'editMessageText' in ctx && typeof ctx.editMessageText === 'function') {
    await ctx.editMessageText(message, {
      ...keyboard,
      parse_mode: 'HTML',
    });
  } else {
    await ctx.reply(message, {
      ...keyboard,
      parse_mode: 'HTML',
    });
  }
}

function buildStatsKeyboard(
  congregationId: number,
  totalItems: number,
  offset: number,
  pageSize: number
) {
  const rows = [
    [
      Markup.button.callback('📅 По годам (матрица XLSX)', `stats:matrix:${congregationId}`),
      Markup.button.callback('📄 Полный список XLSX', `stats:fullxlsx:${congregationId}`),
    ],
  ];

  if (totalItems > pageSize) {
    const safeOffset = Math.max(0, Math.min(offset, totalItems - 1));
    const pageStart = Math.floor(safeOffset / pageSize) * pageSize;
    const prevOffset = Math.max(0, pageStart - pageSize);
    const nextOffset = pageStart + pageSize;
    const paginationRow = [];

    if (pageStart > 0) {
      const from = prevOffset + 1;
      const to = Math.min(prevOffset + pageSize, totalItems);
      paginationRow.push(
        Markup.button.callback(`⬅️ ${from}-${to}`, `stats:page:${congregationId}:${prevOffset}`)
      );
    }
    if (nextOffset < totalItems) {
      const from = nextOffset + 1;
      const to = Math.min(nextOffset + pageSize, totalItems);
      paginationRow.push(
        Markup.button.callback(`${from}-${to} ➡️`, `stats:page:${congregationId}:${nextOffset}`)
      );
    }

    if (paginationRow.length > 0) {
      rows.push(paginationRow);
    }
  }

  return Markup.inlineKeyboard(rows);
}

function buildStatsMessage(params: {
  talkStats: TalkStats[];
  congregationName: string;
  offset: number;
  pageSize: number;
  topLimit: number;
  escapeHtml: (value: string) => string;
  pluralizeTimes: (count: number) => string;
}): string {
  const { talkStats, congregationName, offset, pageSize, topLimit, escapeHtml, pluralizeTimes } = params;
  let msg = `📊 <b>Статистика речей</b>\n🏛 <b>Община:</b> ${congregationName}\n\n`;

  if (talkStats.length === 0) {
    msg += 'Пока нет данных по речам.';
    return msg;
  }

  const totalTopics = talkStats.length;
  const totalOccurrences = talkStats.reduce((sum, item) => sum + item.total_count, 0);
  const latestIsoDate = talkStats
    .map((item) => item.last_date)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const latestDateText = latestIsoDate ? escapeHtml(formatDateRu(latestIsoDate)) : 'нет данных';

  msg += `🧾 <b>Тем в истории:</b> ${totalTopics}\n`;
  msg += `📌 <b>Всего проведений:</b> ${pluralizeTimes(totalOccurrences)}\n`;
  msg += `🗓 <b>Последняя речь:</b> ${latestDateText}\n\n`;

  const top = [...talkStats]
    .sort((a, b) => b.total_count - a.total_count || a.talk_number - b.talk_number)
    .slice(0, topLimit);
  msg += `<b>🔥 ТОП-${top.length} тем</b>\n`;
  for (const item of top) {
    const lastDate = item.last_date ? escapeHtml(formatDateRu(item.last_date)) : '—';
    msg += `• №${item.talk_number} — ${escapeHtml(pluralizeTimes(item.total_count))} · ${lastDate}\n`;
  }

  const safeOffset = Math.max(0, Math.min(offset, talkStats.length - 1));
  const pageStart = Math.floor(safeOffset / pageSize) * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, talkStats.length);
  const pageItems = talkStats.slice(pageStart, pageEnd);

  msg += `\n<b>📚 Полный список (${pageStart + 1}-${pageEnd} из ${talkStats.length})</b>\n`;
  for (const item of pageItems) {
    const safeTitle = escapeHtml(item.title);
    const countText = escapeHtml(pluralizeTimes(item.total_count));
    const lastDate = item.last_date ? escapeHtml(formatDateRu(item.last_date)) : '—';
    msg += `• №${item.talk_number} «${safeTitle}» — ${countText} · ${lastDate}\n`;
  }

  return msg;
}

async function sendFullStatsXlsx(
  ctx: AuthContext,
  db: DatabaseInstance,
  congregationId: number
): Promise<void> {
  const cong = await congregationsRepo(db).getById(congregationId);
  const name = cong?.name ?? `Община ${congregationId}`;
  const talkStats = await getTalkStats(db, congregationId);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'JW Talks Planner Bot';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Полная статистика');
  sheet.columns = [
    { header: '№', key: 'talkNumber', width: 8 },
    { header: 'Название', key: 'title', width: 46 },
    { header: 'Сколько раз', key: 'count', width: 12 },
    { header: 'Последняя дата', key: 'lastDate', width: 16 },
    { header: 'Последний докладчик', key: 'lastSpeaker', width: 28 },
  ];

  for (const item of talkStats) {
    sheet.addRow({
      talkNumber: item.talk_number,
      title: item.title,
      count: item.total_count,
      lastDate: item.last_date ? formatDateRu(item.last_date) : '',
      lastSpeaker: item.last_speaker ?? '',
    });
  }

  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer() as ArrayBuffer);
  const fileName = `stats-${name.replace(/\s+/g, '-')}-полный-список.xlsx`;
  await ctx.telegram.sendDocument(ctx.chat!.id, {
    source: buffer,
    filename: fileName,
  }, {
    caption: `📄 Полная статистика (XLSX) — ${name}.`,
  });
}
