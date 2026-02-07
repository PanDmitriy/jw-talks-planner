/**
 * Команда /edit — редактирование публичной речи (выбор по дате и кнопкам)
 */

import type { Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import type { AuthContext } from '../middlewares/auth';
import { Markup } from 'telegraf';
import { talksRepo, congregationsRepo, getTitleForTalk } from '../../db';
import type { TalkInput } from '../../db/types';

type EditStep =
  | 'congregation'
  | 'date'   // выбор даты из списка или ввод новой даты
  | 'field'
  | 'song'
  | 'talk_number'
  | 'speaker_name'
  | 'speaker_phone';

interface EditTalkState {
  step: EditStep;
  congregationId?: number;
  talkId?: number;
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

    const today = new Date().toISOString().slice(0, 10);

    if (ids.length === 1) {
      const list = talks.listByCongregation(ids[0], { fromDate: today });
      const dates = [...new Set(list.map((t) => t.date))].sort();
      if (dates.length === 0) {
        await ctx.reply('Нет предстоящих речей для редактирования. Добавить: /add');
        return;
      }
      editState.set(userId, { step: 'date', congregationId: ids[0] });
      const dateButtons = dates.map((d) => Markup.button.callback(d, `edit:date:${d}`));
      await ctx.reply(
        'Выберите дату:',
        Markup.inlineKeyboard(dateButtons.map((b) => [b]))
      );
      return;
    }

    editState.set(userId, { step: 'congregation' });
    const buttons = ids.map((id) => {
      const c = congRepo.getById(id);
      return Markup.button.callback(c?.name ?? `Община ${id}`, `edit:cong:${id}`);
    });
    await ctx.reply('Выберите общину:', Markup.inlineKeyboard(buttons.map((b) => [b])));
  });

  bot.action(/^edit:cong:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const congregationId = parseInt(ctx.match[1], 10);
    if (!ctx.congregationIds?.includes(congregationId)) {
      await ctx.answerCbQuery('Нет доступа к этой общине.');
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const list = talks.listByCongregation(congregationId, { fromDate: today });
    const dates = [...new Set(list.map((t) => t.date))].sort();
    if (dates.length === 0) {
      await ctx.editMessageText('В этой общине нет предстоящих речей для редактирования.');
      editState.delete(userId);
      return;
    }
    editState.set(userId, { step: 'date', congregationId });
    const dateButtons = dates.map((d) => Markup.button.callback(d, `edit:date:${d}`));
    await ctx.editMessageText('Выберите дату:', Markup.inlineKeyboard(dateButtons.map((b) => [b])));
  });

  bot.action(/^edit:date:(.+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const date = ctx.match[1];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const state = editState.get(userId);
    if (!state || state.step !== 'date' || state.congregationId === undefined) {
      await ctx.answerCbQuery('Выберите общину и дату заново: /edit');
      return;
    }
    const onDate = talks.listByCongregation(state.congregationId, { fromDate: date, toDate: date });
    if (onDate.length === 0) {
      await ctx.answerCbQuery('На эту дату речей не найдено.');
      return;
    }
    const talkButtons = onDate.map((t, i) =>
      Markup.button.callback(
        `${i + 1}. Песня ${t.song_number === 0 ? '?' : t.song_number}, №${t.talk_number} — ${t.speaker_name}`,
        `edit:talk:${t.id}`
      )
    );
    await ctx.editMessageText(
      `Речи на ${date}. Выберите речь:`,
      Markup.inlineKeyboard(talkButtons.map((b) => [b]))
    );
  });

  bot.action(/^edit:talk:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const talkId = parseInt(ctx.match[1], 10);
    const talk = talks.getById(talkId);
    if (!talk || !ctx.congregationIds?.includes(talk.congregation_id)) {
      await ctx.answerCbQuery('Нет доступа к этой речи.');
      return;
    }
    editState.set(userId, { step: 'field', talkId });
    const cong = congRepo.getById(talk.congregation_id);
    await ctx.editMessageText(
      `Редактирование речи (${cong?.name ?? ''}):\n` +
        `Дата: ${talk.date}\n` +
        `Песня: ${talk.song_number === 0 ? '?' : talk.song_number}, Речь: №${talk.talk_number}\n` +
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
          Markup.button.callback('Докладчик', 'edit:field:speaker_name'),
          Markup.button.callback('Телефон', 'edit:field:speaker_phone'),
        ],
      ])
    );
  });

  const fieldPrompts: Record<string, string> = {
    date: 'Введите новую дату (ГГГГ-ММ-ДД):',
    song: 'Введите новый номер песни (1–200 или ? если ещё не известна):',
    talk_number: 'Введите новый номер речи (название подставится из списка):',
    speaker_name: 'Введите новое имя докладчика:',
    speaker_phone: 'Введите новый номер телефона:',
  };

  bot.action(/^edit:field:(.+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const field = ctx.match[1];
    if (!['date', 'song', 'talk_number', 'speaker_name', 'speaker_phone'].includes(field)) return;
    const state = editState.get(userId);
    if (!state || state.step !== 'field' || state.talkId === undefined) return;
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

    if (state.step !== 'field' || state.talkId === undefined) {
      await ctx.reply('Сначала выберите речь: /edit');
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
      if (['date', 'song', 'talk_number', 'speaker_name', 'speaker_phone'].includes(field)) {
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
      const trimmed = text.trim();
      if (trimmed === '?' || trimmed === '？') {
        value = 0;
      } else {
        const n = parseInt(text, 10);
        if (isNaN(n) || n < 1 || n > 200) {
          await ctx.reply('Введите число от 1 до 200 (номер песни) или ? если ещё не известна:');
          return;
        }
        value = n;
      }
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
    else if (state.step === 'talk_number') {
      update.talk_number = value as number;
      const newTitle = getTitleForTalk(db, value as number);
      if (newTitle) update.title = newTitle;
    } else if (state.step === 'speaker_name') update.speaker_name = text;
    else if (state.step === 'speaker_phone') update.speaker_phone = text;

    talks.update(state.talkId, update);
    editState.delete(userId);
    await ctx.reply(`✅ Речь обновлена.`);
  });
}
