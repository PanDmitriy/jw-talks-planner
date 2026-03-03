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
📋 Команды бота

Расписание и речи
/list — расписание предстоящих речей
/check — проверить по номеру, была ли речь и когда
/add — добавить речь
/edit — изменить речь (выбор по дате)
/delete — удалить речь (выбор по дате)
/exceptions — исключения в расписании (конгресс/вечеря/РС)
/meeting_schedule — просмотр и изменение дня/времени встречи

Список речей (номера и названия для подстановки при добавлении речи)
/plans — просмотр

Собрание
/stats — статистика по речам и докладчикам
/rename_congregation — переименовать собрание

Админ
/grant @username (община) — выдать доступ

/cancel — отмена пошаговой операции
/help — эта справка
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
    await applyPendingGrants(db, userId, username);

    const userRepo = userCongregationsRepo(db);
    const congRepo = congregationsRepo(db);
    const ids = await userRepo.getCongregationIdsForUser(userId);

    if (ids.length === 0) {
      await ctx.reply(
        'Добро пожаловать! У вас пока нет доступа к общинам. Обратитесь к ответственному за публичные речи или администратору бота — он выдаст доступ командой /grant @ваш_username.'
      );
      return;
    }

    const names = (await Promise.all(ids.map((id) => congRepo.getById(id)))).map((c) => c?.name).filter(Boolean).join(', ');
    await ctx.reply(
      `Добро пожаловать! У вас есть доступ к общинам: ${names}.\n\n${HELP_TEXT}`,
      Markup.keyboard(QUICK_ACTIONS_KEYBOARD as unknown as string[][]).resize()
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });
}
