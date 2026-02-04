/**
 * Типы для работы с базой данных
 */

/** Публичная речь */
export interface Talk {
  id: number;
  congregation_id: number;
  date: string; // YYYY-MM-DD
  song_number: number;
  talk_number: number;
  title: string;
  speaker_name: string;
  speaker_phone: string;
  created_at: string;
  updated_at: string;
}

/** Речь для создания/редактирования (без id и дат) */
export interface TalkInput {
  congregation_id: number;
  date: string;
  song_number: number;
  talk_number: number;
  title: string;
  speaker_name: string;
  speaker_phone: string;
}

/** Община */
export interface Congregation {
  id: number;
  name: string;
  created_at: string;
}

/** Пользователь с доступом к общине */
export interface UserCongregation {
  user_id: number;
  username: string | null;
  congregation_id: number;
  granted_at: string;
}

/** Статистика по речи (по номеру и названию) */
export interface TalkStats {
  talk_id: number;
  talk_number: number;
  title: string;
  total_count: number;
  last_date: string | null;
  last_speaker: string | null;
}

/** План речи (номер + название) по общине */
export interface TalkPlan {
  id: number;
  congregation_id: number;
  talk_number: number;
  title: string;
  created_at: string;
}

/** Топ докладчиков */
export interface SpeakerStats {
  speaker_name: string;
  speaker_phone: string;
  total_talks: number;
}
