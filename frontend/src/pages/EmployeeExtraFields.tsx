import { useTranslation } from 'react-i18next'
import { PM_INPUT, PmField } from './personFormUi'

/** Допустимые ставки (штат) работника. Тот же набор проверяет сервер. */
const STAFF_RATES = [1, 0.75, 0.5] as const

export interface EmployeeExtra {
  middleName: string
  fin: string
  staffRate: number
}

/**
 * Поля работника ADAU: отчество, FIN и штатная ставка. Все необязательные, ставка
 * по умолчанию 1. Общие для экранов создания и карточки работника; студентам не показываются.
 */
export function EmployeeExtraFields({ value, onChange }: {
  value: EmployeeExtra
  onChange: (next: EmployeeExtra) => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <PmField label={t('people.middleName')}>
        <input
          type="text"
          value={value.middleName}
          onChange={(e) => onChange({ ...value, middleName: e.target.value })}
          className={PM_INPUT}
        />
      </PmField>
      <PmField label="FIN">
        <input
          type="text"
          value={value.fin}
          // FIN на удостоверении — 7 латинских букв и цифр, пишется заглавными.
          onChange={(e) => onChange({ ...value, fin: e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 7) })}
          placeholder={t('people.finPlaceholder')}
          className={`${PM_INPUT} font-mono tracking-wider`}
        />
      </PmField>
      <PmField label={t('people.staffRate')}>
        <select
          value={value.staffRate}
          onChange={(e) => onChange({ ...value, staffRate: Number(e.target.value) })}
          className={PM_INPUT}
        >
          {STAFF_RATES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </PmField>
    </>
  )
}
