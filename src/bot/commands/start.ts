/**
 * Команда /start — приветствие и выдача доступа по ожидающему /grant
 */

import type { Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import type { AuthContext } from '../middlewares/auth';
import { Markup } from 'telegraf';
import { applyPendingGrants } from '../middlewares/auth';
import { userCongregationsRepo, congregationsRepo } from '../../db';

const HELP_TEXT = `
📋 *Команды бота*

*Речи:* /list — расписание, /add — добавить, /edit, /delete
*Список речей:* /plans — просмотр, /add_plan, /edit_plan, /delete_plan
*Общины:* /stats — статистика, /rename_congregation — переименовать общину
*Админ:* /grant @username [община] — выдать доступ

В любой пошаговой операции: /cancel — отмена. /help — эта справка.
`.trim();

/** Reply-клавиатура быстрых действий (показывается после /start) */
export const QUICK_ACTIONS_KEYBOARD = [
  ['📅 Расписание', '➕ Добавить'],
  ['📊 Статистика'],
] as const;

export function registerStartCommand(bot: Telegraf<AuthContext>, db: DatabaseInstance): void {
  bot.start(async (ctx) => {
    const userId = ctx.from?.id;
    const username = ctx.from?.username ?? null;
    if (!userId) {
      await ctx.reply('Не удалось определить пользователя.');
      return;
    }

    // Если администратор выдал доступ по username — привязываем к user_id
    applyPendingGrants(db, userId, username);

    const userRepo = userCongregationsRepo(db);
    const congRepo = congregationsRepo(db);
    const ids = userRepo.getCongregationIdsForUser(userId);

    if (ids.length === 0) {
      await ctx.reply(
        'Добро пожаловать! У вас пока нет доступа к общинам. Обратитесь к ответственному за публичные речи или администратору бота — он выдаст доступ командой /grant @ваш_username.'
      );
      return;
    }

    const names = ids.map((id) => congRepo.getById(id)?.name).filter(Boolean).join(', ');
    await ctx.reply(
      `Добро пожаловать! У вас есть доступ к общинам: ${names}.\n\n${HELP_TEXT}`,
      {
        parse_mode: 'Markdown',
        ...Markup.keyboard(QUICK_ACTIONS_KEYBOARD as unknown as string[][]).resize(),
      }
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(HELP_TEXT, { parse_mode: 'Markdown' });
  });
}
