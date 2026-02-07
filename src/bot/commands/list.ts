/**
 * Команда /list — просмотр списка публичных речей по общине
 */

import type { Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import type { AuthContext } from '../middlewares/auth';
import { Markup } from 'telegraf';
import { talksRepo, congregationsRepo } from '../../db';
import type { Talk } from '../../db/types';
import { splitMessage } from '../utils/splitMessage';

function formatSong(n: number): string {
  return n === 0 ? '?' : String(n);
}

function formatTalk(t: Talk, congregationName: string): string {
  return (
    `🆔 ${t.id}\n` +
    `📅 ${t.date} • Песня ${formatSong(t.song_number)} • Речь №${t.talk_number}\n` +
    `📖 ${t.title}\n` +
    `👤 ${t.speaker_name} • ${t.speaker_phone}\n` +
    `Община: ${congregationName}`
  );
}

export function registerListCommand(bot: Telegraf<AuthContext>, db: DatabaseInstance): void {
  const talks = talksRepo(db);
  const congRepo = congregationsRepo(db);

  const listHandler = async (ctx: AuthContext) => {
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;

    const today = new Date().toISOString().slice(0, 10);

    if (ids.length === 1) {
      const list = talks.listByCongregation(ids[0], { fromDate: today });
      const cong = congRepo.getById(ids[0]);
      const name = cong?.name ?? 'Община';
      if (list.length === 0) {
        await ctx.reply(`В общине «${name}» пока ничего нет. Добавить: /add`);
        return;
      }
      const text = list.map((t) => formatTalk(t, name)).join('\n\n---\n\n');
      const fullText = `📋 Предстоящие речи — ${name}\n\n${text}`;
      const chunks = splitMessage(fullText);
      for (const chunk of chunks) await ctx.reply(chunk);
      return;
    }

    // Несколько общин — показываем кнопки выбора
    const buttons = ids.map((id) => {
      const c = congRepo.getById(id);
      return Markup.button.callback(c?.name ?? `Община ${id}`, `list:cong:${id}`);
    });
    await ctx.reply('Выберите общину:', Markup.inlineKeyboard(buttons));
  };

  bot.command('list', listHandler);
  bot.hears('📋 Список речей', listHandler);

  bot.action(/^list:cong:(\d+)$/, async (ctx) => {
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа к этой общине.');
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const list = talks.listByCongregation(congregationId, { fromDate: today });
    const cong = congRepo.getById(congregationId);
    const name = cong?.name ?? 'Община';
    if (list.length === 0) {
      await ctx.editMessageText(`В общине «${name}» пока ничего нет. Добавить: /add`);
      return;
    }
    const text = list.map((t) => formatTalk(t, name)).join('\n\n---\n\n');
    const fullText = `📋 Предстоящие речи — ${name}\n\n${text}`;
    const chunks = splitMessage(fullText);
    await ctx.editMessageText(chunks[0]);
    const chatId = ctx.chat?.id;
    if (chatId && chunks.length > 1) {
      for (const chunk of chunks.slice(1)) await ctx.telegram.sendMessage(chatId, chunk);
    }
  });
}
