/**
 * Предельный срок действия пропуска при регистрации человека.
 * Раньше по умолчанию ставили далёкую дату и в пикере можно было выбрать что угодно;
 * теперь дальше «сегодня + MAX_VALIDITY_YEARS» дата недоступна для выбора.
 */
export const MAX_VALIDITY_YEARS = 6

/** Дата в формате yyyy-MM-dd по локальному календарю (его же показывает input type="date"). */
function toInputDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Предельная дата для полей «действителен с/до» — атрибут max у input type="date".
 * 29 февраля браузер сам перенесёт на 1 марта, если через 6 лет год невисокосный.
 */
export function maxValidityDate(from: Date = new Date()): string {
  return toInputDate(new Date(from.getFullYear() + MAX_VALIDITY_YEARS, from.getMonth(), from.getDate()))
}
