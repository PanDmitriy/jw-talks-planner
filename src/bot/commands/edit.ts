/**
 * Команда /edit — редактирование публичной речи по ID
 */

import type { Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import type { AuthContext } from '../middlewares/auth';
import { Markup } from 'telegraf';
import { talksRepo, congregationsRepo } from '../../db';
import type { TalkInput } from '../../db/types';

type EditStep = 'field' | 'date' | 'song' | 'talk_number' | 'title' | 'speaker_name' | 'speaker_phone';

interface EditTalkState {
  step: EditStep;
  talkId: number;
}

const editState = new Map<number, EditTalkState>();

function isValidDate(s: string): boolean {
  const d = new Date(s);
  return !isNaN(d.getTime()) && s.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function registerEditCommand(bot: Telegraf<AuthContext>, db: DatabaseInstance): void {
  const talks = talksRepo(db);
  const congRepo = congregationsRepo(db);

  bot.command('edit', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const ids = ctx.congregationIds ?? [];
    if (ids.length === 0) return;

    const text = (ctx.message as { text?: string })?.text?.trim() ?? '';
    const args = text.split(/\s+/).slice(1);
    const idStr = args[0];
    const talkId = idStr ? parseInt(idStr, 10) : NaN;
    if (isNaN(talkId) || talkId < 1) {
      await ctx.reply('Использование: /edit <id>\nПример: /edit 5\n(ID речи можно посмотреть в /list)');
      return;
    }

    const talk = talks.getById(talkId);
    if (!talk) {
      await ctx.reply('Речь с таким ID не найдена.');
      return;
    }
    if (!ids.includes(talk.congregation_id)) {
      await ctx.reply('Нет доступа к этой речи.');
      return;
    }

    editState.set(userId, { step: 'field', talkId });
    const cong = congRepo.getById(talk.congregation_id);
    await ctx.reply(
      `Редактирование речи #${talkId} (${cong?.name ?? ''}):\n` +
        `Дата: ${talk.date}\n` +
        `Песня: ${talk.song_number}, Речь: №${talk.talk_number}\n` +
        `Название: ${talk.title}\n` +
        `Докладчик: ${talk.speaker_name}, ${talk.speaker_phone}\n\n` +
        'Что изменить? (или /cancel)',
      Markup.inlineKeyboard([
        [
          Markup.button.callback('Дата', 'edit:field:date'),
          Markup.button.callback('Песня', 'edit:field:song'),
          Markup.button.callback('№ речи', 'edit:field:talk_number'),
        ],
        [
          Markup.button.callback('Название', 'edit:field:title'),
          Markup.button.callback('Докладчик', 'edit:field:speaker_name'),
          Markup.button.callback('Телефон', 'edit:field:speaker_phone'),
        ],
      ])
    );
  });

  const fieldPrompts: Record<string, string> = {
    date: 'Введите новую дату (ГГГГ-ММ-ДД):',
    song: 'Введите новый номер песни:',
    talk_number: 'Введите новый номер речи:',
    title: 'Введите новое название речи:',
    speaker_name: 'Введите новое имя докладчика:',
    speaker_phone: 'Введите новый номер телефона:',
  };

  bot.action(/^edit:field:(.+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const field = ctx.match[1];
    if (!['date', 'song', 'talk_number', 'title', 'speaker_name', 'speaker_phone'].includes(field)) return;
    const state = editState.get(userId);
    if (!state || state.step !== 'field') return;
    const talk = talks.getById(state.talkId);
    if (!talk || !ctx.congregationIds?.includes(talk.congregation_id)) {
      await ctx.answerCbQuery('Нет доступа.');
      return;
    }
    state.step = field as EditStep;
    editState.set(userId, state);
    await ctx.editMessageText(fieldPrompts[field] ?? 'Введите новое значение:');
  });

  bot.on('message', async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();
    const state = editState.get(userId);
    if (!state) return next();
    const text = (ctx.message as { text?: string })?.text?.trim();
    if (!text) return next();
    if (text === '/cancel') {
      editState.delete(userId);
      await ctx.reply('Редактирование отменено.');
      return;
    }
    if (text.startsWith('/')) {
      editState.delete(userId);
      return next();
    }

    const talk = talks.getById(state.talkId);
    if (!talk) {
      editState.delete(userId);
      await ctx.reply('Речь не найдена.');
      return;
    }

    if (state.step === 'field') {
      const field = text.toLowerCase();
      if (['date', 'song', 'talk_number', 'title', 'speaker_name', 'speaker_phone'].includes(field)) {
        state.step = field as EditStep;
        editState.set(userId, state);
        await ctx.reply(fieldPrompts[field] ?? 'Введите новое значение:');
        return;
      }
      await ctx.reply('Нажмите кнопку выбора поля выше или отправьте /cancel.');
      return;
    }

    let value: string | number = text;
    if (state.step === 'date') {
      if (!isValidDate(text)) {
        await ctx.reply('Неверный формат даты. Введите ГГГГ-ММ-ДД:');
        return;
      }
    } else if (state.step === 'song') {
      const n = parseInt(text, 10);
      if (isNaN(n) || n < 1) {
        await ctx.reply('Введите число (номер песни):');
        return;
      }
      value = n;
    } else if (state.step === 'talk_number') {
      const n = parseInt(text, 10);
      if (isNaN(n) || n < 1) {
        await ctx.reply('Введите номер речи (число):');
        return;
      }
      value = n;
    }

    const update: Partial<TalkInput> = {};
    if (state.step === 'date') update.date = text;
    else if (state.step === 'song') update.song_number = value as number;
    else if (state.step === 'talk_number') update.talk_number = value as number;
    else if (state.step === 'title') update.title = text;
    else if (state.step === 'speaker_name') update.speaker_name = text;
    else if (state.step === 'speaker_phone') update.speaker_phone = text;

    talks.update(state.talkId, update);
    editState.delete(userId);
    await ctx.reply(`✅ Речь #${state.talkId} обновлена.`);
  });
}
