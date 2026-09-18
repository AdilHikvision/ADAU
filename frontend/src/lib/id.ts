/**
 * Уникальный идентификатор для клиентских сущностей (группы мониторинга, correlation id и т.п.).
 *
 * Почему не просто crypto.randomUUID(): он есть только в защищённом контексте — https или
 * localhost. По локальной сети приложение открывают по http://<ip> через nginx, и там
 * crypto.randomUUID отсутствует: прямой вызов падает с TypeError и обработчик клика молча
 * перестаёт работать. Поэтому вне защищённого контекста берём запасной вариант.
 */
export function newId(prefix = 'id'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
