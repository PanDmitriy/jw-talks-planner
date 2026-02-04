/**
 * Команды списка речей: просмотр, добавление списком (1 Название. 2 Название! …), редактирование, удаление
 */

import type { Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import type { AuthContext } from '../middlewares/auth';
import { Markup } from 'telegraf';
import { talkPlansRepo, congregationsRepo } from '../../db';
import { splitMessage } from '../utils/splitMessage';

type PlanWizardStep = 'congregation' | 'list' | 'number' | 'title';
type PlanWizardType = 'add' | 'edit' | 'delete';

interface PlanWizardState {
  type: PlanWizardType;
  step: PlanWizardStep;
  congregationId?: number;
  talkNumber?: number;
  planId?: number;
  title?: string;
}

const planWizardState = new Map<number, PlanWizardState>();

/** Парсит список речей: каждая строка — "1 Название." или "2 Название!" (номер, пробел, название до конца строки) */
function parseTalkList(text: string): { number: number; title: string }[] {
  const lines = text.split(/\n/).map((s) => s.trim()).filter(Boolean);
  const result: { number: number; title: string }[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num >= 1) {
        const title = match[2].trim() || `Речь ${num}`;
        result.push({ number: num, title });
      }
    }
  }
  return result;
}

export function registerPlansCommand(bot: Telegraf<AuthContext>, db: DatabaseInstance): void {
  const plansRepo = talkPlansRepo(db);
  const congRepo = congregationsRepo(db);

  // --- /plans — список речей ---
  bot.command('plans', async (ctx) => {
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;

    const text = (ctx.message as { text?: string })?.text?.trim() ?? '';
    const args = text.split(/\s+/).slice(1);
    const congregationName = args.join(' ').trim();

    const showList = (congregationId: number) => {
      const list = plansRepo.listByCongregation(congregationId);
      const cong = congRepo.getById(congregationId);
      const name = cong?.name ?? `Община ${congregationId}`;
      if (list.length === 0) {
        return `📋 Список речей — ${name}\n\nПока ничего нет. Добавить: /add_plan`;
      }
      const lines = list.map((p) => `• №${p.talk_number} — ${p.title}`).join('\n');
      return `📋 Список речей — ${name}\n\n${lines}\n\nДобавить: /add_plan\nРедактировать: /edit_plan\nУдалить: /delete_plan`;
    };

    if (ids.length === 1 && !congregationName) {
      const text = showList(ids[0]);
      const chunks = splitMessage(text);
      for (const chunk of chunks) await ctx.reply(chunk);
      return;
    }
    if (congregationName) {
      const cong = congRepo.listAll().find((c) => c.name.toLowerCase() === congregationName.toLowerCase());
      if (cong && ids.includes(cong.id)) {
        const text = showList(cong.id);
        const chunks = splitMessage(text);
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
    const list = plansRepo.listByCongregation(congregationId);
    const cong = congRepo.getById(congregationId);
    const name = cong?.name ?? `Община ${congregationId}`;
    if (list.length === 0) {
      await ctx.editMessageText(
        `📋 Список речей — ${name}\n\nПока ничего нет. Добавить: /add_plan`
      );
      return;
    }
    const lines = list.map((p) => `• №${p.talk_number} — ${p.title}`).join('\n');
    const fullText = `📋 Список речей — ${name}\n\n${lines}\n\nДобавить: /add_plan\nРедактировать: /edit_plan\nУдалить: /delete_plan`;
    const chunks = splitMessage(fullText);
    await ctx.editMessageText(chunks[0]);
    const chatId = ctx.chat?.id;
    if (chatId && chunks.length > 1) {
      for (const chunk of chunks.slice(1)) {
        await ctx.telegram.sendMessage(chatId, chunk);
      }
    }
  });

  // --- /add_plan — добавить пункты списка речей (одним сообщением или по одному) ---
  const LIST_PROMPT =
    'Введите пункты списка речей (каждый с новой строки): номер и название.\n\nПример:\n1 Первая речь.\n2 Вторая речь!\n3 Третья речь?';

  bot.command('add_plan', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;

    if (ids.length === 1) {
      planWizardState.set(userId, { type: 'add', step: 'list', congregationId: ids[0] });
      await ctx.reply(`${LIST_PROMPT}\n\nИли /cancel для отмены.`);
      return;
    }
    planWizardState.set(userId, { type: 'add', step: 'congregation' });
    const buttons = ids.map((id) => {
      const c = congRepo.getById(id);
      return Markup.button.callback(c?.name ?? `Община ${id}`, `add_plan:cong:${id}`);
    });
    await ctx.reply('Выберите общину:', Markup.inlineKeyboard(buttons));
  });

  bot.action(/^add_plan:cong:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    planWizardState.set(userId, { type: 'add', step: 'list', congregationId });
    await ctx.editMessageText(`${LIST_PROMPT}\n\nИли /cancel для отмены.`);
  });

  // --- Обработка списка при add_plan (step 'list') ---
  // (обрабатывается в общем message handler ниже)

  // --- /edit_plan — редактировать название по номеру ---
  bot.command('edit_plan', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;

    const text = (ctx.message as { text?: string })?.text?.trim() ?? '';
    const args = text.split(/\s+/).slice(1);
    if (args.length >= 2) {
      const numStr = args[0];
      const newTitle = args.slice(1).join(' ').trim();
      const talkNumber = parseInt(numStr, 10);
      if (isNaN(talkNumber) || talkNumber < 1 || !newTitle) {
        await ctx.reply('Использование: /edit_plan <номер> <новое название>\nПример: /edit_plan 5 Любовь в действии');
        return;
      }
      if (ids.length === 1) {
        const plan = plansRepo.getByNumber(ids[0], talkNumber);
        if (!plan) {
          await ctx.reply(`В списке речей нет №${talkNumber}. Добавьте: /add_plan`);
          return;
        }
        plansRepo.updateTitle(plan.id, newTitle);
        await ctx.reply(`✅ Речь №${talkNumber} в списке обновлена: «${newTitle}».`);
        return;
      }
    }

    if (ids.length === 1) {
      planWizardState.set(userId, { type: 'edit', step: 'number', congregationId: ids[0] });
      await ctx.reply('Введите номер речи в списке для переименования (или /cancel):');
      return;
    }
    planWizardState.set(userId, { type: 'edit', step: 'congregation' });
    const buttons = ids.map((id) => {
      const c = congRepo.getById(id);
      return Markup.button.callback(c?.name ?? `Община ${id}`, `edit_plan:cong:${id}`);
    });
    await ctx.reply('Выберите общину:', Markup.inlineKeyboard(buttons));
  });

  bot.action(/^edit_plan:cong:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    planWizardState.set(userId, { type: 'edit', step: 'number', congregationId });
    await ctx.editMessageText('Введите номер речи в списке для редактирования (или /cancel):');
  });

  // --- /delete_plan — удалить пункт из списка по номеру ---
  bot.command('delete_plan', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;

    const text = (ctx.message as { text?: string })?.text?.trim() ?? '';
    const args = text.split(/\s+/).slice(1);
    if (args.length >= 1) {
      const talkNumber = parseInt(args[0], 10);
      if (isNaN(talkNumber) || talkNumber < 1) {
        await ctx.reply('Использование: /delete_plan <номер>\nПример: /delete_plan 5');
        return;
      }
      if (ids.length === 1) {
        const plan = plansRepo.getByNumber(ids[0], talkNumber);
        if (!plan) {
          await ctx.reply(`В списке речей нет №${talkNumber}.`);
          return;
        }
        plansRepo.delete(plan.id);
        await ctx.reply(`✅ Речь №${talkNumber} удалена из списка.`);
        return;
      }
    }

    if (ids.length === 1) {
      planWizardState.set(userId, { type: 'delete', step: 'number', congregationId: ids[0] });
      await ctx.reply('Введите номер речи в списке для удаления (или /cancel):');
      return;
    }
    planWizardState.set(userId, { type: 'delete', step: 'congregation' });
    const buttons = ids.map((id) => {
      const c = congRepo.getById(id);
      return Markup.button.callback(c?.name ?? `Община ${id}`, `delete_plan:cong:${id}`);
    });
    await ctx.reply('Выберите общину:', Markup.inlineKeyboard(buttons));
  });

  bot.action(/^delete_plan:cong:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    planWizardState.set(userId, { type: 'delete', step: 'number', congregationId });
    await ctx.editMessageText('Введите номер речи в списке для удаления (или /cancel):');
  });

  // --- Обработка ввода: список речей (add) или пошагово (edit / delete) ---
  bot.on('message', async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();
    const state = planWizardState.get(userId);
    if (!state) return next();
    const text = (ctx.message as { text?: string })?.text?.trim();
    if (!text) return next();
    if (text === '/cancel') {
      planWizardState.delete(userId);
      await ctx.reply('Отменено.');
      return;
    }
    if (text.startsWith('/')) return next();

    // Добавление списком: парсим "1 Название. 2 Название! 3 Название?"
    if (state.type === 'add' && state.step === 'list' && state.congregationId !== undefined) {
      const items = parseTalkList(text);
      if (items.length === 0) {
        await ctx.reply('Не удалось разобрать список. Формат: номер и название на каждой строке.\nПример:\n1 Первая речь.\n2 Вторая речь!');
        return;
      }
      let added = 0;
      let updated = 0;
      for (const { number: num, title: titleText } of items) {
        const existing = plansRepo.getByNumber(state.congregationId, num);
        if (existing) {
          plansRepo.updateTitle(existing.id, titleText);
          updated++;
        } else {
          plansRepo.create(state.congregationId, num, titleText);
          added++;
        }
      }
      planWizardState.delete(userId);
      const cong = congRepo.getById(state.congregationId);
      const parts: string[] = [];
      if (added) parts.push(`добавлено ${added}`);
      if (updated) parts.push(`обновлено ${updated}`);
      await ctx.reply(
        `✅ Список речей: ${parts.join(', ')}.\nОбщина: ${cong?.name ?? state.congregationId}\n\nПосмотреть: /plans`
      );
      return;
    }

    if (state.step === 'number') {
      const n = parseInt(text, 10);
      if (isNaN(n) || n < 1) {
        await ctx.reply('Введите положительное число (номер речи):');
        return;
      }
      if (state.type === 'edit') {
        const plan = plansRepo.getByNumber(state.congregationId!, n);
        if (!plan) {
          await ctx.reply(`В списке речей нет №${n}. Добавьте: /add_plan`);
          return;
        }
        state.planId = plan.id;
        state.talkNumber = n;
        state.step = 'title';
        planWizardState.set(userId, state);
        await ctx.reply(`Текущее название: «${plan.title}». Введите новое название:`);
        return;
      }
      if (state.type === 'delete') {
        const plan = plansRepo.getByNumber(state.congregationId!, n);
        if (!plan) {
          await ctx.reply(`В списке речей нет №${n}.`);
          return;
        }
        plansRepo.delete(plan.id);
        planWizardState.delete(userId);
        await ctx.reply(`✅ Речь №${n} удалена из списка.`);
        return;
      }
    }

    if (state.step === 'title' && state.type === 'edit' && state.planId !== undefined) {
      plansRepo.updateTitle(state.planId, text);
      planWizardState.delete(userId);
      await ctx.reply(`✅ Речь №${state.talkNumber} в списке обновлена: «${text}».`);
      return;
    }

    return next();
  });
}
