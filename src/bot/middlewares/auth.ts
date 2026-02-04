/**
 * Middleware авторизации: проверка прав доступа к общине и команда /grant для администратора
 */

import { Context, Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import { userCongregationsRepo, congregationsRepo } from '../../db';

/** Расширяем контекст: список ID общин, к которым есть доступ у пользователя */
export interface AuthContext extends Context {
  congregationIds?: number[];
  isAdmin?: boolean;
}

/** ID администраторов из переменной окружения (через запятую) */
function getAdminIds(): number[] {
  const raw = process.env.ADMIN_IDS || '';
  return raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));
}

/**
 * Middleware: загружает список общин пользователя в ctx.congregationIds.
 * Если у пользователя нет доступа — отвечает и прерывает цепочку.
 * Команды /start и /help пропускаются без проверки (для новых пользователей и справки).
 */
export function requireAuth(db: DatabaseInstance) {
  const userRepo = userCongregationsRepo(db);
  return async (ctx: AuthContext, next: () => Promise<void>) => {
    const text = (ctx.message as { text?: string })?.text ?? (ctx.update as { message?: { text?: string } })?.message?.text ?? '';
    if (text === '/start' || text.startsWith('/start ') || text === '/help' || text.startsWith('/grant')) {
      const userId = ctx.from?.id;
      if (userId && !text.startsWith('/grant')) {
        const ids = userRepo.getCongregationIdsForUser(userId);
        ctx.congregationIds = ids;
      }
      return next();
    }
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('Не удалось определить пользователя.');
      return;
    }
    const ids = userRepo.getCongregationIdsForUser(userId);
    ctx.congregationIds = ids;
    if (ids.length === 0) {
      await ctx.reply(
        'У вас нет доступа к общинам. Обратитесь к ответственному за публичные речи или администратору бота.'
      );
      return;
    }
    return next();
  };
}

/**
 * Middleware: проверяет, что пользователь — администратор (для /grant).
 */
export function requireAdmin(ctx: AuthContext, next: () => Promise<void>) {
  const adminIds = getAdminIds();
  const userId = ctx.from?.id;
  if (!userId || !adminIds.includes(userId)) {
    return ctx.reply('Эта команда доступна только администратору.');
  }
  ctx.isAdmin = true;
  return next();
}

/**
 * Регистрирует команду /grant: администратор выдаёт доступ пользователю к общине.
 * Использование: /grant @username НазваниеОбщины  или  /grant @username  (если община одна)
 */
export function registerGrantCommand(db: DatabaseInstance, bot: Telegraf<AuthContext>) {
  const adminIds = getAdminIds();
  const userRepo = userCongregationsRepo(db);
  const congRepo = congregationsRepo(db);

  bot.command('grant', requireAdmin, async (ctx: AuthContext) => {
    const text = (ctx.message as { text?: string })?.text || '';
    const parts = text.trim().split(/\s+/).slice(1); // убираем /grant
    if (parts.length < 1) {
      await ctx.reply(
        'Использование: /grant @username [Название общины]\nПример: /grant @ivan Община Центральная'
      );
      return;
    }
    const usernameRaw = parts[0];
    const username = usernameRaw.startsWith('@') ? usernameRaw.slice(1) : usernameRaw;
    const congregationName = parts.slice(1).join(' ').trim();

    const congregations = congRepo.listAll();
    let congregationId: number;
    if (congregationName) {
      let cong = congregations.find((c) => c.name.toLowerCase() === congregationName.toLowerCase());
      if (!cong) {
        congregationId = congRepo.create(congregationName);
        cong = congRepo.getById(congregationId);
      } else {
        congregationId = cong.id;
      }
    } else {
      if (congregations.length === 0) {
        // Первый grant без названия — создаём общину по умолчанию
        const defaultName = process.env.DEFAULT_CONGREGATION_NAME || 'Община 1';
        congregationId = congRepo.create(defaultName);
        const cong = congRepo.getById(congregationId);
        getPendingGrants().add(username, congregationId);
        await ctx.reply(
          `Община «${cong?.name ?? defaultName}» создана автоматически. Доступ для @${username} будет выдан, когда пользователь напишет боту /start. Попросите его написать боту.`
        );
        return;
      }
      if (congregations.length > 1) {
        await ctx.reply(
          `Укажите общину: /grant @${username} НазваниеОбщины\nДоступные: ${congregations.map((c) => c.name).join(', ')}`
        );
        return;
      }
      congregationId = congregations[0].id;
    }

    // Telegram user_id мы не знаем по username — нужно попросить пользователя написать боту /start
    // и сохранять username -> user_id. Упростим: при /grant сохраняем по username, а при первом
    // обращении пользователя обновим user_id. Или: требуем, чтобы пользователь уже писал боту.
    // Для простоты: сохраняем username, user_id = 0 (или отдельная таблица ожидающих доступа).
    // Лучше: бот отвечает "Попросите @username написать боту /start, затем повторите /grant @username Община".
    // Или храним user_id только после того как пользователь напишет /start — тогда в user_congregations
    // мы храним user_id. Значит при /grant мы не можем добавить по username — нужен user_id.
    // Вариант: команда /grant только после того как пользователь написал боту. Тогда админ пересылает
    // сообщение от пользователя или мы просим /grant с указанием user_id. Неудобно.
    // Стандартный подход: храним pending_grants (username, congregation_id), при /start пользователь
    // с таким username получает доступ (user_id подставляется).
    // Реализую: при /grant сохраняем в user_congregations с user_id = 0 и username = @username.
    // При следующем /start от любого пользователя с username = X проверяем pending и выдаём доступ.
    // Но тогда user_id в user_congregations должен быть уникален... Нет, PRIMARY KEY (user_id, congregation_id).
    // Если user_id = 0, то один раз можно. Или отдельная таблица pending_grants (username, congregation_id).
    // Сделаю проще: при /grant пишем "Попросите пользователя @username написать боту команду /start. После этого повторите /grant @username Община — тогда доступ будет привязан к аккаунту." И храним pending: username -> congregation_id. При /start смотрим username, если есть pending — добавляем user_congregations(user_id, username, congregation_id) и удаляем pending.
    getPendingGrants().add(username, congregationId);
    await ctx.reply(
      `Доступ для @${username} к общине «${congRepo.getById(congregationId)?.name}» будет выдан, когда пользователь напишет боту /start. Попросите его написать боту.`
    );
  });
}

/** Ожидающие выдачи доступа по username (в памяти; при перезапуске бота нужно повторить /grant) */
const pendingByUsername = new Map<string, number[]>();

export function getPendingGrants() {
  return {
    add(username: string, congregationId: number) {
      const list = pendingByUsername.get(username) || [];
      if (!list.includes(congregationId)) list.push(congregationId);
      pendingByUsername.set(username, list);
    },
    consume(username: string): number[] {
      const list = pendingByUsername.get(username) || [];
      pendingByUsername.delete(username);
      return list;
    },
  };
}

/**
 * При /start проверяем, есть ли для этого username ожидающий grant — если да, выдаём доступ.
 */
export function applyPendingGrants(db: DatabaseInstance, userId: number, username: string | null): void {
  if (!username) return;
  const list = getPendingGrants().consume(username);
  const userRepo = userCongregationsRepo(db);
  for (const congregationId of list) {
    userRepo.grant(userId, username, congregationId);
  }
}
