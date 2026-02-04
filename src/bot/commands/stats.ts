/**
 * Команда /stats — статистика: сколько раз каждая речь звучала, когда в последний раз, кто выступал чаще всего
 */

import type { Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import type { AuthContext } from '../middlewares/auth';
import { Markup } from 'telegraf';
import { getTalkStats, getSpeakerStats, congregationsRepo } from '../../db';
import { splitMessage } from '../utils/splitMessage';

export function registerStatsCommand(bot: Telegraf<AuthContext>, db: DatabaseInstance): void {
  const congRepo = congregationsRepo(db);

  const statsHandler = async (ctx: AuthContext) => {
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;

    const text = (ctx.message as { text?: string })?.text?.trim() ?? '';
    const args = text.split(/\s+/).slice(1);
    const congregationName = args.join(' ').trim();

    if (ids.length === 1 && !congregationName) {
      await sendStatsForCongregation(ctx, db, ids[0]);
      return;
    }

    if (congregationName) {
      const cong = congRepo.listAll().find((c) => c.name.toLowerCase() === congregationName.toLowerCase());
      if (cong && ids.includes(cong.id)) {
        await sendStatsForCongregation(ctx, db, cong.id);
        return;
      }
    }

    // Несколько общин и не указана — выбор кнопкой
    const buttons = ids.map((id) => {
      const c = congRepo.getById(id);
      return Markup.button.callback(c?.name ?? `Община ${id}`, `stats:cong:${id}`);
    });
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
}

async function sendStatsForCongregation(
  ctx: AuthContext,
  db: DatabaseInstance,
  congregationId: number,
  isEdit = false
): Promise<void> {
  const cong = congregationsRepo(db).getById(congregationId);
  const name = cong?.name ?? `Община ${congregationId}`;

  const talkStats = getTalkStats(db, congregationId);
  const speakerStats = getSpeakerStats(db, congregationId);

  let msg = `📊 Статистика — ${name}\n\n`;
  msg += 'По речам (сколько раз звучала, когда в последний раз):\n';
  if (talkStats.length === 0) {
    msg += 'Нет данных о прошедших речах.\n\n';
  } else {
    for (const t of talkStats) {
      msg += `• Речь №${t.talk_number} «${t.title}» — ${t.total_count} раз`;
      if (t.last_date) msg += `, последний раз: ${t.last_date}`;
      if (t.last_speaker) msg += ` (${t.last_speaker})`;
      msg += '\n';
    }
    msg += '\n';
  }

  msg += 'Кто выступал чаще всего:\n';
  if (speakerStats.length === 0) {
    msg += 'Нет данных.\n';
  } else {
    speakerStats.slice(0, 15).forEach((s, i) => {
      msg += `${i + 1}. ${s.speaker_name} (${s.speaker_phone}) — ${s.total_talks} речей\n`;
    });
  }

  const chunks = splitMessage(msg);
  if (isEdit && 'editMessageText' in ctx && typeof ctx.editMessageText === 'function') {
    await ctx.editMessageText(chunks[0]);
    const chatId = ctx.chat?.id;
    if (chatId && chunks.length > 1) {
      for (const chunk of chunks.slice(1)) await ctx.telegram.sendMessage(chatId, chunk);
    }
  } else {
    for (const chunk of chunks) await ctx.reply(chunk);
  }
}
