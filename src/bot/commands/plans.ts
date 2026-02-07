/**
 * Команды списка речей: просмотр общего списка, редактирование — только для админа
 */

import type { Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import type { AuthContext } from '../middlewares/auth';
import { Markup } from 'telegraf';
import { congregationsRepo, defaultTalkTitlesRepo } from '../../db';
import { requireAdmin } from '../middlewares/auth';
import { splitMessage } from '../utils/splitMessage';

export function registerPlansCommand(bot: Telegraf<AuthContext>, db: DatabaseInstance): void {
  const congRepo = congregationsRepo(db);
  const defaultRepo = defaultTalkTitlesRepo(db);

  // --- /plans — общий список речей (один для всех общин) ---
  bot.command('plans', async (ctx) => {
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;

    const text = (ctx.message as { text?: string })?.text?.trim() ?? '';
    const args = text.split(/\s+/).slice(1);
    const congregationName = args.join(' ').trim();

    const showList = (congregationId: number) => {
      const list = defaultRepo.listAll();
      const cong = congRepo.getById(congregationId);
      const name = cong?.name ?? `Община ${congregationId}`;
      if (list.length === 0) {
        return `📋 Список речей — ${name}\n\nПока пусто.`;
      }
      const lines = list.map((p) => `• №${p.talk_number} — ${p.title}`).join('\n');
      return `📋 Список речей — ${name}\n\n${lines}`;
    };

    if (ids.length === 1 && !congregationName) {
      const out = showList(ids[0]);
      const chunks = splitMessage(out);
      for (const chunk of chunks) await ctx.reply(chunk);
      return;
    }
    if (congregationName) {
      const cong = congRepo.listAll().find((c) => c.name.toLowerCase() === congregationName.toLowerCase());
      if (cong && ids.includes(cong.id)) {
        const out = showList(cong.id);
        const chunks = splitMessage(out);
        for (const chunk of chunks) await ctx.reply(chunk);
        return;
      }
    }
    const buttons = ids.map((id) => {
      const c = congRepo.getById(id);
      return Markup.button.callback(c?.name ?? `Община ${id}`, `plans:cong:${id}`);
    });
    await ctx.reply('Выберите общину:', Markup.inlineKeyboard(buttons));
  });

  bot.action(/^plans:cong:(\d+)$/, async (ctx) => {
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    const list = defaultRepo.listAll();
    const cong = congRepo.getById(congregationId);
    const name = cong?.name ?? `Община ${congregationId}`;
    if (list.length === 0) {
      await ctx.editMessageText(`📋 Список речей — ${name}\n\nПока пусто.`);
      return;
    }
    const lines = list.map((p) => `• №${p.talk_number} — ${p.title}`).join('\n');
    const fullText = `📋 Список речей — ${name}\n\n${lines}`;
    const chunks = splitMessage(fullText);
    await ctx.editMessageText(chunks[0]);
    const chatId = ctx.chat?.id;
    if (chatId && chunks.length > 1) {
      for (const chunk of chunks.slice(1)) {
        await ctx.telegram.sendMessage(chatId, chunk);
      }
    }
  });

  // --- /edit_default_plan — редактировать общий список (только админ) ---
  bot.command('edit_default_plan', requireAdmin, async (ctx) => {
    const text = (ctx.message as { text?: string })?.text?.trim() ?? '';
    const args = text.split(/\s+/).slice(1);
    if (args.length >= 2) {
      const numStr = args[0];
      const newTitle = args.slice(1).join(' ').trim();
      const talkNumber = parseInt(numStr, 10);
      if (isNaN(talkNumber) || talkNumber < 1 || !newTitle) {
        await ctx.reply(
          'Использование: /edit_default_plan <номер> <новое название>\nПример: /edit_default_plan 5 У семейных проблем есть решение'
        );
        return;
      }
      const existing = defaultRepo.getByNumber(talkNumber);
      if (!existing) {
        await ctx.reply(`В общем списке нет речи №${talkNumber}. Номера: 1–194.`);
        return;
      }
      defaultRepo.updateTitle(talkNumber, newTitle);
      await ctx.reply(`✅ Общий список: речь №${talkNumber} обновлена на «${newTitle}».`);
      return;
    }

    await ctx.reply(
      'Редактирование общего списка речей (видят все общины). Только для администратора.\n\n' +
        'Использование: /edit_default_plan <номер> <новое название>\n' +
        'Пример: /edit_default_plan 59 (Не используется)'
    );
  });
}
