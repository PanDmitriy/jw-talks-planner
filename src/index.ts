/**
 * Точка входа: Telegram-бот для ответственных за публичные речи в собрании Свидетелей Иеговы.
 * Telegraf + SQLite, уведомления за 7 дней и за 12 часов (накануне).
 */

import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { initDatabase } from './db';
import type { AuthContext } from './bot/middlewares/auth';
import { requireAuth, registerGrantCommand, loggingMiddleware } from './bot/middlewares';
import { registerAllCommands } from './bot/commands';
import { startScheduler } from './scheduler/notifications';

const BOT_TOKEN = process.env.BOT_TOKEN;
const DB_PATH = process.env.DB_PATH ?? './data/talks.db';
const ADMIN_IDS = process.env.ADMIN_IDS ?? '';

if (!BOT_TOKEN) {
  console.error('Укажите BOT_TOKEN в .env (см. .env.example)');
  process.exit(1);
}

// Инициализация БД
const db = initDatabase(DB_PATH);

// Бот и middleware
const bot = new Telegraf<AuthContext>(BOT_TOKEN);

// Логирование входящих обновлений (для отладки)
bot.use(loggingMiddleware);

// Команда /grant — только для администратора, без проверки общины
registerGrantCommand(db, bot);

// Все остальные команды требуют авторизации (доступ хотя бы к одной общине)
bot.use(requireAuth(db));
registerAllCommands(bot, db);

// Глобальный перехват ошибок — логируем и уведомляем пользователя
bot.catch((err, ctx) => {
  const from = ctx.from ? `user=${ctx.from.id} @${ctx.from.username ?? '?'}` : '?';
  const text = (ctx.message as { text?: string })?.text ?? (ctx.callbackQuery as { data?: string })?.data ?? '';
  console.error('[bot error]', from, text || ctx.updateType, err);
  ctx.reply('Произошла ошибка. Проверьте логи бота.').catch(() => {});
});

// Планировщик уведомлений (каждый час)
const schedulerInterval = 60 * 60 * 1000;
const schedulerTimer = startScheduler(bot, db, schedulerInterval);

// Список команд для меню бота (кнопка «/» в Telegram)
const BOT_COMMANDS = [
  { command: 'start', description: 'Приветствие и справка' },
  { command: 'help', description: 'Справка по командам' },
  { command: 'list', description: 'Расписание публичных речей' },
  { command: 'add', description: 'Добавить речь' },
  { command: 'edit', description: 'Редактировать речь' },
  { command: 'delete', description: 'Удалить речь' },
  { command: 'stats', description: 'Статистика по речам' },
  { command: 'plans', description: 'Список речей (номер + название)' },
  { command: 'rename_congregation', description: 'Переименовать общину' },
  { command: 'grant', description: 'Выдать доступ (админ)' },
];

// Запуск
bot
  .launch()
  .then(async () => {
    try {
      await bot.telegram.setMyCommands(BOT_COMMANDS);
      console.log('\nБот запущен. Команды зарегистрированы в меню. Для остановки: Ctrl+C\n');
    } catch (e) {
      console.warn('Не удалось обновить меню команд в Telegram:', e);
      console.log('\nБот запущен. Для остановки: Ctrl+C\n');
    }
  })
  .catch((err) => {
    console.error('Ошибка запуска бота:', err);
    process.exit(1);
  });

function shutdown(signal: string) {
  clearInterval(schedulerTimer);
  bot.stop(signal);
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
