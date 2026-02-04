/**
 * Разбиение длинного текста на части по лимиту Telegram (4096 символов)
 */

const MAX_MESSAGE_LENGTH = 4000;

/**
 * Разбивает текст на части не больше MAX_MESSAGE_LENGTH (по строкам, не режем посередине)
 */
export function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const next = current ? current + '\n' + line : line;
    if (next.length > MAX_MESSAGE_LENGTH && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
