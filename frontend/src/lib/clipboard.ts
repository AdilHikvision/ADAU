/**
 * Копирование в буфер обмена.
 *
 * navigator.clipboard существует только в защищённом контексте — https или localhost.
 * По локальной сети приложение открывают по http://<ip> через nginx, и там его нет:
 * прямой вызов падает с TypeError, а вызов через ?. молча ничего не делает — кнопка
 * «копировать» выглядит рабочей, но буфер пуст. Поэтому вне защищённого контекста
 * используем старый execCommand('copy') через скрытое поле.
 *
 * @returns удалось ли скопировать — вызывающий код решает, показывать ли «Скопировано».
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Отказ в доступе или не защищённый контекст — пробуем запасной путь ниже.
    }
  }

  try {
    const area = document.createElement('textarea')
    area.value = text
    // Вне экрана, но в документе: иначе выделение и execCommand не сработают.
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    area.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}
