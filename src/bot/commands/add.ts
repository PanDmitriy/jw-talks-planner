/**
 * Команда /add — пошаговое добавление публичной речи
 */

import type { Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import type { AuthContext } from '../middlewares/auth';
import { Markup } from 'telegraf';
import { talksRepo, congregationsRepo, getTitleForTalk } from '../../db';
import type { TalkInput } from '../../db/types';

type AddStep =
  | 'congregation'
  | 'date'
  | 'song'
  | 'talk_number'
  | 'title'
  | 'speaker_name'
  | 'speaker_phone';

interface AddTalkState {
  step: AddStep;
  congregationId?: number;
  date?: string;
  song_number?: number;
  talk_number?: number;
  title?: string;
  speaker_name?: string;
  speaker_phone?: string;
}

const wizardState = new Map<number, AddTalkState>();

/** Проверка даты ГГГГ-ММ-ДД */
function isValidDate(s: string): boolean {
  const d = new Date(s);
  return !isNaN(d.getTime()) && s.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function registerAddCommand(bot: Telegraf<AuthContext>, db: DatabaseInstance): void {
  const talks = talksRepo(db);
  const congRepo = congregationsRepo(db);

  const addHandler = async (ctx: AuthContext) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;

    if (ids.length === 1) {
      wizardState.set(userId, { step: 'date', congregationId: ids[0] });
      const cong = congRepo.getById(ids[0]);
      await ctx.reply(
        `Шаг 1 из 7. Община: ${cong?.name ?? ids[0]}.\n\nВведите дату речи (ГГГГ-ММ-ДД), например 2025-02-10.\nОтмена: /cancel`
      );
      return;
    }
    wizardState.set(userId, { step: 'congregation' });
    const buttons = ids.map((id) => {
      const c = congRepo.getById(id);
      return Markup.button.callback(c?.name ?? `Община ${id}`, `add:cong:${id}`);
    });
    await ctx.reply('Шаг 1 из 7. Выберите общину (отмена: /cancel):', Markup.inlineKeyboard(buttons));
  };

  bot.command('add', addHandler);
  bot.hears('➕ Добавить', addHandler);

  bot.action(/^add:cong:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    wizardState.set(userId, { step: 'date', congregationId });
    const cong = congRepo.getById(congregationId);
    await ctx.editMessageText(
      `Шаг 1 из 7. Община: ${cong?.name ?? congregationId}.\n\nВведите дату речи (ГГГГ-ММ-ДД), например 2025-02-10.\nОтмена: /cancel`
    );
  });

  bot.on('message', async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();
    const state = wizardState.get(userId);
    if (!state) return next();
    const text = (ctx.message as { text?: string })?.text?.trim();
    if (!text) {
      await ctx.reply('Пожалуйста, введите текст.');
      return;
    }
    // /cancel — отмена; любая команда (/) — выход из мастера, чтобы команда обработалась
    if (text === '/cancel') {
      wizardState.delete(userId);
      await ctx.reply('Добавление речи отменено.');
      return;
    }
    if (text.startsWith('/')) {
      wizardState.delete(userId);
      return next();
    }

    if (state.step === 'date') {
      if (!isValidDate(text)) {
        await ctx.reply('Неверный формат даты. Введите ГГГГ-ММ-ДД (например 2025-02-10) или /cancel.');
        return;
      }
      state.step = 'song';
      state.date = text;
      wizardState.set(userId, state);
      await ctx.reply('Шаг 2 из 7. Введите номер песни (1–200) или ? если песня ещё не известна:');
      return;
    }

    if (state.step === 'song') {
      const trimmed = text.trim();
      if (trimmed === '?' || trimmed === '？') {
        state.song_number = 0;
      } else {
        const n = parseInt(text, 10);
        if (isNaN(n) || n < 1 || n > 200) {
          await ctx.reply('Введите число от 1 до 200 (номер песни) или ? если ещё не известна:');
          return;
        }
        state.song_number = n;
      }
      state.step = 'talk_number';
      wizardState.set(userId, state);
      await ctx.reply('Шаг 3 из 7. Введите номер речи из списка (/plans):');
      return;
    }

    if (state.step === 'talk_number') {
      const n = parseInt(text, 10);
      if (isNaN(n) || n < 1) {
        await ctx.reply('Введите номер речи (положительное число):');
        return;
      }
      state.talk_number = n;
      const congregationId = state.congregationId!;
      const title = getTitleForTalk(db, n);
      if (title) {
        state.title = title;
        state.step = 'speaker_name';
        wizardState.set(userId, state);
        await ctx.reply(`Шаг 4 из 7. Название из списка: «${title}».\nШаг 5 из 7. Введите имя докладчика:`);
        return;
      }
      state.step = 'title';
      wizardState.set(userId, state);
      await ctx.reply('Шаг 4 из 7. В списке речей нет такого номера. Введите название речи вручную:');
      return;
    }

    if (state.step === 'title') {
      state.step = 'speaker_name';
      state.title = text;
      wizardState.set(userId, state);
      await ctx.reply('Шаг 5 из 7. Введите имя докладчика:');
      return;
    }

    if (state.step === 'speaker_name') {
      state.step = 'speaker_phone';
      state.speaker_name = text;
      wizardState.set(userId, state);
      await ctx.reply('Шаг 6 из 7. Введите номер телефона докладчика:');
      return;
    }

    if (state.step === 'speaker_phone') {
      state.speaker_phone = text;
      wizardState.delete(userId);
      if (
        state.congregationId === undefined ||
        state.date === undefined ||
        state.song_number === undefined ||
        state.talk_number === undefined ||
        state.title === undefined ||
        state.speaker_name === undefined
      ) {
        await ctx.reply('Ошибка: не все данные сохранены. Начните заново с /add');
        return;
      }
      const input: TalkInput = {
        congregation_id: state.congregationId,
        date: state.date,
        song_number: state.song_number,
        talk_number: state.talk_number,
        title: state.title,
        speaker_name: state.speaker_name,
        speaker_phone: state.speaker_phone,
      };
      const id = talks.create(input);
      const cong = congRepo.getById(state.congregationId);
      const songDisplay = state.song_number === 0 ? '?' : state.song_number;
      await ctx.reply(
        `✅ Речь добавлена (ID: ${id}).\n` +
          `${state.date}, песня ${songDisplay}, речь №${state.talk_number}\n` +
          `«${state.title}» — ${state.speaker_name}, ${state.speaker_phone}\n` +
          `Община: ${cong?.name ?? state.congregationId}\n\nПосмотреть список: /list`
      );
      return;
    }

    return next();
  });
}
