/**
 * Команда /rename_congregation — переименование собрания
 */

import type { Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import type { AuthContext } from '../middlewares/auth';
import { Markup } from 'telegraf';
import { congregationsRepo } from '../../db';

/** Состояние пошагового переименования: выбор собрания → ввод нового названия */
const renameState = new Map<number, { congregationId: number }>();

export function registerCongregationCommand(bot: Telegraf<AuthContext>, db: DatabaseInstance): void {
  const congRepo = congregationsRepo(db);

  bot.command('rename_congregation', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;

    const text = (ctx.message as { text?: string })?.text?.trim() ?? '';
    const args = text.split(/\s+/).slice(1);
      // Вариант: /rename_congregation "Старое" "Новое" или /rename_congregation Старое Новое (без пробелов в названиях)
    if (args.length >= 2) {
      const oldName = args[0].replace(/^"|"$/g, '');
      const newName = args.slice(1).join(' ').replace(/^"|"$/g, '');
      const allCong = await congRepo.listAll();
      const cong = allCong.find(
        (c) => ids.includes(c.id) && c.name.toLowerCase() === oldName.toLowerCase()
      );
      if (!cong) {
        const names = (await Promise.all(ids.map((id) => congRepo.getById(id)))).map((c) => c?.name).join(', ');
        await ctx.reply(
          `Собрание «${oldName}» не найдено или у вас нет к нему доступа. Ваши собрания: ${names}`
        );
        return;
      }
      if (!newName.trim()) {
        await ctx.reply('Введите новое название собрания.');
        return;
      }
      await congRepo.updateName(cong.id, newName.trim());
      renameState.delete(userId);
      await ctx.reply(`✅ Собрание переименовано: «${cong.name}» → «${newName.trim()}».`);
      return;
    }

    if (ids.length === 1) {
      renameState.set(userId, { congregationId: ids[0] });
      const cong = await congRepo.getById(ids[0]);
      await ctx.reply(
        `Текущее название: «${cong?.name ?? 'Собрание'}». Введите новое название собрания (или /cancel для отмены):`
      );
      return;
    }

    // Несколько собраний — выбор кнопкой
    const buttons = await Promise.all(ids.map(async (id) => {
      const c = await congRepo.getById(id);
      return Markup.button.callback(c?.name ?? `Община ${id}`, `rename_cong:${id}`);
    }));
    await ctx.reply('Выберите собрание:', Markup.inlineKeyboard(buttons));
  });

  bot.action(/^rename_cong:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    renameState.set(userId, { congregationId });
    const cong = await congRepo.getById(congregationId);
    await ctx.editMessageText(
      `Община: «${cong?.name ?? congregationId}». Введите новое название (или /cancel для отмены):`
    );
  });

  bot.on('message', async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();
    const state = renameState.get(userId);
    if (!state) return next();
    const text = (ctx.message as { text?: string })?.text?.trim();
    if (!text) return next();
    if (text === '/cancel') {
      renameState.delete(userId);
      await ctx.reply('Переименование отменено.');
      return;
    }
    if (text.startsWith('/')) return next();
    const cong = await congRepo.getById(state.congregationId);
    if (!cong) {
      renameState.delete(userId);
      await ctx.reply('Община не найдена.');
      return;
    }
    await congRepo.updateName(state.congregationId, text);
    renameState.delete(userId);
    await ctx.reply(`✅ Собрание переименовано: «${cong.name}» → «${text}».`);
  });
}
