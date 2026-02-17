/**
 * Команда /plans — просмотр списка речей (номера и названия).
 * Список создаётся при инициализации БД (default_talk_titles), редактирование отключено.
 */

import type { Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import type { AuthContext } from '../middlewares/auth';
import { Markup } from 'telegraf';
import { congregationsRepo, defaultTalkTitlesRepo } from '../../db';
import { splitMessage } from '../utils/splitMessage';

export function registerPlansCommand(bot: Telegraf<AuthContext>, db: DatabaseInstance): void {
  const congRepo = congregationsRepo(db);
  const defaultRepo = defaultTalkTitlesRepo(db);

  const showList = async (congregationId: number): Promise<string> => {
    const list = await defaultRepo.listAll();
    const cong = await congRepo.getById(congregationId);
    const name = cong?.name ?? `Община ${congregationId}`;
    if (list.length === 0) return `📋 Список речей — ${name}\n\nПока пусто.`;
    const lines = list.map((p) => `• №${p.talk_number} — ${p.title}`).join('\n');
    return `📋 Список речей — ${name}\n\n${lines}`;
  };

  bot.command('plans', async (ctx) => {
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;

    const text = (ctx.message as { text?: string })?.text?.trim() ?? '';
    const args = text.split(/\s+/).slice(1);
    const congregationName = args.join(' ').trim();

    if (ids.length === 1 && !congregationName) {
      const out = await showList(ids[0]);
      const chunks = splitMessage(out);
      for (const chunk of chunks) await ctx.reply(chunk);
      return;
    }
    if (congregationName) {
      const allCong = await congRepo.listAll();
      const cong = allCong.find((c) => c.name.toLowerCase() === congregationName.toLowerCase());
      if (cong && ids.includes(cong.id)) {
        const out = await showList(cong.id);
        const chunks = splitMessage(out);
        for (const chunk of chunks) await ctx.reply(chunk);
        return;
      }
    }
    const buttons = await Promise.all(ids.map(async (id) => {
      const c = await congRepo.getById(id);
      return Markup.button.callback(c?.name ?? `Община ${id}`, `plans:cong:${id}`);
    }));
    await ctx.reply('Выберите общину:', Markup.inlineKeyboard(buttons));
  });

  bot.action(/^plans:cong:(\d+)$/, async (ctx) => {
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    const out = await showList(congregationId);
    const chunks = splitMessage(out);
    await ctx.editMessageText(chunks[0]);
    const chatId = ctx.chat?.id;
    if (chatId && chunks.length > 1) {
      for (const chunk of chunks.slice(1)) await ctx.telegram.sendMessage(chatId, chunk);
    }
  });
}
