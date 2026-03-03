/**
 * Middleware авторизации: проверка прав доступа к общине и команда /grant для администратора
 */

import { Context, Markup, Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import { userCongregationsRepo, congregationsRepo } from '../../db';
import { normalizeMeetingTime, parseWeekdayToken, formatWeekdayRu } from '../utils/meetingSchedule';

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
        const ids = await userRepo.getCongregationIdsForUser(userId);
        ctx.congregationIds = ids;
      }
      return next();
    }
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('Не удалось определить пользователя.');
      return;
    }
    const ids = await userRepo.getCongregationIdsForUser(userId);
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
  const adminIds = new Set(getAdminIds());
  const congRepo = congregationsRepo(db);
  type GrantWizardStep =
    | 'username'
    | 'congregation_select'
    | 'new_congregation_name'
    | 'new_congregation_weekday'
    | 'new_congregation_time';

  interface GrantWizardState {
    step: GrantWizardStep;
    username?: string;
    newCongregationName?: string;
    meetingWeekday?: number;
  }

  const grantWizardState = new Map<number, GrantWizardState>();

  const buildCongregationButtons = (congregations: Array<{ id: number; name: string }>) => {
    const rows = congregations.map((c) => [Markup.button.callback(c.name, `grant:wiz:cong:${c.id}`)]);
    rows.push([Markup.button.callback('➕ Новое собрание', 'grant:wiz:new')]);
    return Markup.inlineKeyboard(rows);
  };

  const weekdayKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('Суббота', 'grant:wiz:weekday:6')],
    [Markup.button.callback('Воскресенье', 'grant:wiz:weekday:0')],
  ]);

  const parseUsername = (raw: string): string | null => {
    const normalized = raw.trim().replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{5,32}$/.test(normalized)) return null;
    return normalized;
  };

  const finalizeGrant = async (
    ctx: AuthContext,
    username: string,
    congregationId: number,
    options?: { scheduleHint?: boolean }
  ): Promise<void> => {
    getPendingGrants().add(username, congregationId);
    const cong = await congRepo.getById(congregationId);
    const scheduleInfo = cong
      ? ` (${formatWeekdayRu(cong.meeting_weekday)}, ${cong.meeting_time.slice(0, 5)})`
      : '';
    const scheduleHint = options?.scheduleHint
      ? '\nДля нового собрания обязательно указывайте день и время: /grant @username Название воскресенье 10:00'
      : '';
    await ctx.reply(
      `Доступ для @${username} к собранию «${cong?.name ?? congregationId}»${scheduleInfo} будет выдан, когда пользователь напишет боту /start.${scheduleHint}`
    );
  };

  bot.command('grant', requireAdmin, async (ctx: AuthContext) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    grantWizardState.delete(userId);

    const text = (ctx.message as { text?: string })?.text || '';
    const parts = text.trim().split(/\s+/).slice(1); // убираем /grant
    if (parts.length < 1) {
      await ctx.reply(
        'Пошаговая выдача доступа:\n' +
          '1) Отправьте username пользователя (например @ivan)\n' +
          '2) Выберите существующее собрание или создайте новое\n' +
          '3) Для нового собрания укажите день и время\n\n' +
          'Запустите: /grant\n' +
          'Быстрый формат также работает: /grant @ivan Центральное воскресенье 10:00'
      );
      grantWizardState.set(userId, { step: 'username' });
      await ctx.reply('Шаг 1/3. Введите username пользователя (например @ivan), или /cancel.');
      return;
    }

    const username = parseUsername(parts[0]);
    if (!username) {
      await ctx.reply('Неверный username. Используйте формат @username (латиница/цифры/_, 5-32 символа).');
      return;
    }

    const tail = parts.slice(1);
    let meetingWeekday: number | null = null;
    let meetingTime: string | null = null;
    if (tail.length >= 2) {
      const maybeWeekday = parseWeekdayToken(tail[tail.length - 2]);
      const maybeTime = normalizeMeetingTime(tail[tail.length - 1]);
      if (maybeWeekday !== null && maybeTime !== null) {
        if (maybeWeekday !== 0 && maybeWeekday !== 6) {
          await ctx.reply('Для публичных речей укажите выходной день: суббота или воскресенье.');
          return;
        }
        meetingWeekday = maybeWeekday;
        meetingTime = maybeTime;
        tail.splice(tail.length - 2, 2);
      }
    }
    const congregationName = tail.join(' ').trim();

    const congregations = await congRepo.listAll();
    let congregationId: number;
    if (congregationName) {
      let cong = congregations.find((c) => c.name.toLowerCase() === congregationName.toLowerCase());
      if (!cong) {
        if (meetingWeekday === null || meetingTime === null) {
          await ctx.reply(
            'Для нового собрания укажите день и время встречи.\n' +
              `Пример: /grant @${username} ${congregationName} воскресенье 10:00`
          );
          return;
        }
        congregationId = await congRepo.create(congregationName, {
          meeting_weekday: meetingWeekday,
          meeting_time: meetingTime,
        });
        cong = await congRepo.getById(congregationId);
      } else {
        congregationId = cong.id;
      }
    } else {
      if (congregations.length === 0) {
        // Первый grant без названия — создаём собрание по умолчанию
        if (meetingWeekday === null || meetingTime === null) {
          await ctx.reply(
            'Первое собрание нужно создать с днем и временем встречи.\n' +
              `Пример: /grant @${username} "Собрание 1" воскресенье 10:00`
          );
          return;
        }
        const defaultName = process.env.DEFAULT_CONGREGATION_NAME || 'Собрание 1';
        congregationId = await congRepo.create(defaultName, {
          meeting_weekday: meetingWeekday,
          meeting_time: meetingTime,
        });
        const cong = await congRepo.getById(congregationId);
        getPendingGrants().add(username, congregationId);
        const scheduleInfo = ` (${formatWeekdayRu(cong?.meeting_weekday ?? 0)}, ${(cong?.meeting_time ?? '10:00').slice(0, 5)})`;
        await ctx.reply(
          `Собрание «${cong?.name ?? defaultName}» создано автоматически${scheduleInfo}. ` +
            `Доступ для @${username} будет выдан, когда пользователь напишет боту /start.`
        );
        return;
      }
      if (congregations.length > 1) {
        await ctx.reply(
          `Укажите собрание: /grant @${username} НазваниеСобрания\nДоступные: ${congregations.map((c) => c.name).join(', ')}`
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
    await finalizeGrant(ctx, username, congregationId, {
      scheduleHint: meetingWeekday === null || meetingTime === null,
    });
  });

  bot.action('grant:wiz:new', requireAdmin, async (ctx: AuthContext) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const state = grantWizardState.get(userId);
    if (!state || !state.username) {
      await ctx.answerCbQuery('Сессия неактивна. Выполните /grant.');
      return;
    }
    grantWizardState.set(userId, { ...state, step: 'new_congregation_name' });
    await ctx.answerCbQuery();
    await ctx.reply('Шаг 2/3. Введите название нового собрания, или /cancel.');
  });

  bot.action(/^grant:wiz:cong:(\d+)$/, requireAdmin, async (ctx: AuthContext) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const state = grantWizardState.get(userId);
    if (!state || state.step !== 'congregation_select' || !state.username) {
      await ctx.answerCbQuery('Сессия неактивна. Выполните /grant.');
      return;
    }
    const match = (ctx as AuthContext & { match: RegExpExecArray }).match;
    const congregationId = parseInt(match[1], 10);
    const congregation = await congRepo.getById(congregationId);
    if (!congregation) {
      await ctx.answerCbQuery('Собрание не найдено.');
      return;
    }
    grantWizardState.delete(userId);
    await ctx.answerCbQuery();
    await finalizeGrant(ctx, state.username, congregationId);
  });

  bot.action(/^grant:wiz:weekday:(0|6)$/, requireAdmin, async (ctx: AuthContext) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const state = grantWizardState.get(userId);
    if (!state || state.step !== 'new_congregation_weekday') {
      await ctx.answerCbQuery('Сначала укажите название нового собрания.');
      return;
    }
    const match = (ctx as AuthContext & { match: RegExpExecArray }).match;
    const weekday = parseInt(match[1], 10);
    grantWizardState.set(userId, { ...state, step: 'new_congregation_time', meetingWeekday: weekday });
    await ctx.answerCbQuery();
    await ctx.reply(
      `Шаг 3/3. Выбран день: ${formatWeekdayRu(weekday)}.\nВведите время в формате HH:MM (например 10:00), или /cancel.`
    );
  });

  bot.on('message', async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();
    const state = grantWizardState.get(userId);
    if (!state) return next();

    if (!adminIds.has(userId)) {
      grantWizardState.delete(userId);
      return next();
    }

    const text = (ctx.message as { text?: string })?.text?.trim();
    if (!text) return next();

    if (text === '/cancel') {
      grantWizardState.delete(userId);
      await ctx.reply('Выдача доступа (/grant) отменена.');
      return;
    }

    if (text.startsWith('/')) {
      grantWizardState.delete(userId);
      return next();
    }

    if (state.step === 'username') {
      const username = parseUsername(text);
      if (!username) {
        await ctx.reply('Неверный username. Пример: @ivan');
        return;
      }

      const congregations = await congRepo.listAll();
      if (congregations.length === 0) {
        grantWizardState.set(userId, { step: 'new_congregation_name', username });
        await ctx.reply(
          `Собраний пока нет.\nШаг 2/3. Введите название нового собрания для @${username}, или /cancel.`
        );
        return;
      }

      grantWizardState.set(userId, { step: 'congregation_select', username });
      await ctx.reply(
        `Шаг 2/3. Выберите собрание для @${username} или создайте новое:`,
        buildCongregationButtons(congregations)
      );
      return;
    }

    if (state.step === 'congregation_select') {
      const congregationName = text.trim();
      const congregations = await congRepo.listAll();
      const existing = congregations.find((c) => c.name.toLowerCase() === congregationName.toLowerCase());
      if (!existing) {
        await ctx.reply('Выберите собрание кнопкой ниже или нажмите «Новое собрание».');
        return;
      }
      if (!state.username) {
        grantWizardState.delete(userId);
        await ctx.reply('Сессия неактивна. Выполните /grant заново.');
        return;
      }
      grantWizardState.delete(userId);
      await finalizeGrant(ctx, state.username, existing.id);
      return;
    }

    if (state.step === 'new_congregation_name') {
      const name = text.trim();
      if (!name) {
        await ctx.reply('Название не может быть пустым. Введите название нового собрания.');
        return;
      }
      grantWizardState.set(userId, {
        ...state,
        step: 'new_congregation_weekday',
        newCongregationName: name,
      });
      await ctx.reply('Выберите день встречи нового собрания:', weekdayKeyboard);
      return;
    }

    if (state.step === 'new_congregation_weekday') {
      const weekday = parseWeekdayToken(text);
      if (weekday !== 0 && weekday !== 6) {
        await ctx.reply('Укажите выходной день: суббота или воскресенье.');
        return;
      }
      grantWizardState.set(userId, { ...state, step: 'new_congregation_time', meetingWeekday: weekday });
      await ctx.reply(
        `Шаг 3/3. Выбран день: ${formatWeekdayRu(weekday)}.\nВведите время в формате HH:MM (например 10:00), или /cancel.`
      );
      return;
    }

    if (state.step === 'new_congregation_time') {
      const meetingTime = normalizeMeetingTime(text);
      if (!meetingTime) {
        await ctx.reply('Неверный формат времени. Используйте HH:MM, например 10:00.');
        return;
      }
      if (!state.username || !state.newCongregationName || state.meetingWeekday === undefined) {
        grantWizardState.delete(userId);
        await ctx.reply('Сессия неактивна. Выполните /grant заново.');
        return;
      }

      const all = await congRepo.listAll();
      let congregation = all.find((c) => c.name.toLowerCase() === state.newCongregationName!.toLowerCase());
      if (!congregation) {
        const id = await congRepo.create(state.newCongregationName, {
          meeting_weekday: state.meetingWeekday,
          meeting_time: meetingTime,
        });
        congregation = await congRepo.getById(id);
      }
      if (!congregation) {
        grantWizardState.delete(userId);
        await ctx.reply('Не удалось создать собрание. Повторите /grant.');
        return;
      }
      grantWizardState.delete(userId);
      await finalizeGrant(ctx, state.username, congregation.id);
      return;
    }

    return next();
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
export async function applyPendingGrants(db: DatabaseInstance, userId: number, username: string | null): Promise<void> {
  if (!username) return;
  const list = getPendingGrants().consume(username);
  const userRepo = userCongregationsRepo(db);
  for (const congregationId of list) {
    await userRepo.grant(userId, username, congregationId);
  }
}
