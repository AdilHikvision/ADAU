import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/AuthContext'
import { AppLayout } from '../components/templates'
import { Button } from '../components/atoms'
import { ErrorDialog } from '../components/organisms'
import { apiRequest } from '../lib/api'
import { maxValidityDate } from '../lib/validity'
import { PersonBiometricsStep } from './PersonBiometricsStep'
import { useModule } from '../context/ModuleContext'
import { flattenHousingBlocks, loadHousingBlocks, type HousingBlockItem } from './housingBlocks'
import { PM_INPUT, PmField } from './personFormUi'

/* ═══ Страница добавления сотрудника / посетителя — мастер из двух шагов на одном экране.
   Шаг 1 — данные (вёрстка по референс-дизайну: иллюстрация + сетка полей).
   Шаг 2 — биометрия (PersonBiometricsStep), тоже по референсу: карточка «Фото» с рамкой
   и плавающей кнопкой + карточка «Биометрические данные» со статус-пилюлями.
   Человек к этому моменту уже создан — лицо/карта/отпечаток привязываются к его записи. ═══ */

interface AccessLevel { id: string; name: string }
interface Company { id: string; name: string }
interface DepartmentTreeItem { id: string; name: string }

/** Виды записей на экране добавления. Порядок задаёт порядок кнопок. */
const PERSON_KINDS = [
  { route: 'employee', labelKey: 'people.kindEmployee' },
  { route: 'resident', labelKey: 'people.kindResident' },
  { route: 'visitor', labelKey: 'people.kindVisitor' },
] as const
interface Position { id: string; name: string }

export function PersonCreatePage() {
  const { t } = useTranslation()
  const { token } = useAuth()
  const navigate = useNavigate()
  const { type } = useParams<{ type: string }>()
  const { activeModule } = useModule()
  // Жильца заводят только в модуле ЖКХ — в Workforce этой кнопки нет.
  const isHousingModule = activeModule === 'housing'
  // Три вида на одном экране: работник, жилец, посетитель. Работник и жилец —
  // одна и та же сущность на бэкенде, различает их поле kind.
  const isResident = type === 'resident'
  const isVisitor = type === 'visitor'
  const isEmployee = !isVisitor

  const [accessLevels, setAccessLevels] = useState<AccessLevel[]>([])
  const [companies, setCompanies] = useState<Company[]>([])
  const [companyMode, setCompanyMode] = useState<'None' | 'Single' | 'Multiple'>('None')
  const [departments, setDepartments] = useState<DepartmentTreeItem[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  // Шаг 2 включается после успешного создания: id нужен для привязки биометрии.
  const [createdId, setCreatedId] = useState<string | null>(null)
  const [syncWarning, setSyncWarning] = useState<string | null>(null)

  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    gender: '',
    validFrom: new Date().toISOString().slice(0, 10),
    // Дальше предельного срока пропуск не выдаём — в пикере эти даты недоступны.
    validTo: isEmployee ? maxValidityDate() : new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    onlyVerify: false,
    accessLevelIds: [] as string[],
    departmentId: null as string | null,
    positionId: null as string | null,
    companyId: null as string | null,
    apartment: '',
    housingBlockId: null as string | null,
  })
  const [housingBlocks, setHousingBlocks] = useState<HousingBlockItem[]>([])

  const loadAccessLevels = useCallback(async () => {
    if (!token) return
    try { setAccessLevels(await apiRequest<AccessLevel[]>('/api/access-levels', { token })) } catch { setAccessLevels([]) }
  }, [token])

  const loadPositions = useCallback(async () => {
    if (!token) return
    try { setPositions(await apiRequest<Position[]>('/api/positions', { token })) } catch { setPositions([]) }
  }, [token])

  const loadDepartments = useCallback(async (cId?: string | null) => {
    if (!token) return
    // В режиме группы компаний отделы показываем только после выбора компании
    if (companyMode === 'Multiple' && !cId) { setDepartments([]); return }
    try {
      const params = new URLSearchParams()
      if (cId) params.set('companyId', cId)
      setDepartments(await apiRequest<DepartmentTreeItem[]>(`/api/departments/tree?${params}`, { token }))
    } catch { setDepartments([]) }
  }, [token, companyMode])

  // Компании + режим: в одиночном режиме компания подставляется автоматически.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    const load = async () => {
      let list: Company[] = []
      try { list = await apiRequest<Company[]>('/api/companies', { token }) } catch { list = [] }
      let mode: 'None' | 'Single' | 'Multiple' = 'None'
      try {
        const setting = await apiRequest<{ key: string; value: string }>('/api/system-settings/CompanyMode', { token })
        mode = (setting.value as 'None' | 'Single' | 'Multiple') ?? 'None'
      } catch { mode = 'None' }
      if (cancelled) return
      setCompanies(list)
      setCompanyMode(mode)
      if (mode === 'Single') setFormData((p) => ({ ...p, companyId: list[0]?.id ?? null }))
    }
    void load()
    void loadAccessLevels()
    if (isEmployee) void loadPositions()
    if (isHousingModule) {
      loadHousingBlocks(token)
        .then((list) => { if (!cancelled) setHousingBlocks(list) })
        .catch(() => { if (!cancelled) setHousingBlocks([]) })
    }
    return () => { cancelled = true }
  }, [token, isEmployee, isHousingModule, loadAccessLevels, loadPositions])

  useEffect(() => { void loadDepartments(formData.companyId) }, [loadDepartments, formData.companyId])

  const toggleAccessLevel = (id: string) => {
    setFormData((prev) => ({
      ...prev,
      accessLevelIds: prev.accessLevelIds.includes(id)
        ? prev.accessLevelIds.filter((x) => x !== id)
        : [...prev.accessLevelIds, id],
    }))
  }

  /** Создаёт человека, если он ещё не создан, и возвращает его id.
   *  Нужен биометрии: лицо/карта/отпечаток привязываются к существующей записи,
   *  но пользователь этого не замечает — всё происходит на одном экране. */
  const ensurePerson = async (): Promise<string | null> => {
    if (createdId) return createdId
    if (!token) return null
    if (!formData.firstName.trim()) {
      setError(t('people.errors.firstNameRequired'))
      return null
    }
    setIsSubmitting(true)
    setError(null)
    try {
      const common = {
        firstName: formData.firstName.trim(),
        lastName: formData.lastName.trim(),
        validFromUtc: formData.validFrom ? formData.validFrom + 'T00:00:00Z' : null,
        validToUtc: formData.validTo ? formData.validTo + 'T23:59:59Z' : null,
        accessLevelIds: formData.accessLevelIds,
        departmentId: formData.departmentId || null,
        companyId: formData.companyId || null,
      }
      const body = isEmployee
        ? JSON.stringify({
            ...common,
            gender: formData.gender.trim() || null,
            onlyVerify: formData.onlyVerify,
            // У жильца нет должности: отдела и должности у него в форме тоже нет.
            positionId: isResident ? null : formData.positionId || null,
            kind: isResident ? 'resident' : 'employee',
            apartment: isResident ? formData.apartment.trim() || null : null,
            housingBlockId: isResident ? formData.housingBlockId : null,
          })
        : JSON.stringify({ ...common, documentNumber: null })

      const res = await apiRequest<{ id: string; syncWarnings?: string[] | null }>(
        isEmployee ? '/api/employees' : '/api/visitors',
        { method: 'POST', token, body },
      )
      setSyncWarning(Array.isArray(res?.syncWarnings) && res.syncWarnings.length > 0
        ? t('people.errors.deviceSyncErrors') + '\n' + res.syncWarnings.join('\n')
        : null)
      if (res?.id) { setCreatedId(res.id); return res.id }
      return null
    } catch (e) {
      setError(e instanceof Error ? e.message : t('people.errors.saveFailed'))
      return null
    } finally {
      setIsSubmitting(false)
    }
  }

  /** Кнопка «Сохранить»: если запись уже создана биометрией — просто закрываем экран. */
  const handleSubmit = async () => {
    const id = await ensurePerson()
    if (id) navigate('/people')
  }

  return (
    <AppLayout>
      <div className="p-6 md:p-8 space-y-[18px] max-w-6xl">
        {/* Заголовок + возврат */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-xl font-black text-text-dark tracking-tight">
              {isResident ? t('people.addResident') : isEmployee ? t('people.addEmployee') : t('people.addVisitor')}
            </h1>
            <p className="text-xs text-text-light mt-1">{t('people.createPageHint')}</p>
          </div>
          <Button variant="outline" icon="arrow_back" onClick={() => navigate('/people')}>
            {t('common.back')}
          </Button>
        </div>

        {/* Ошибки и замечания устройств — окном ErrorDialog в конце разметки. */}

        {/* Сетка референса: слева данные, справа колонка 300px с фото и биометрией */}
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-[18px] items-start">
        <div className="flex flex-col gap-[18px] min-w-0">
        {/* Иллюстрация */}
        <div className="rounded-[18px] overflow-hidden bg-[#F1F0FB] h-[218px]">
          <img src="/ana-hero.png" alt="" className="w-full h-full object-cover object-center block" />
        </div>

        {/* Карточка с полями */}
        <div className="rounded-[18px] border border-[#EFEFF5] bg-surface p-6 md:p-7 space-y-5">
          {/* Вид записи. Переключаем маршрутом, а не состоянием: до сохранения на экране
              ещё нечего терять, а адрес страницы остаётся честным. Жилец — только в ЖКХ. */}
          <PmField label={t('people.personKind')}>
            <div className="flex h-12 rounded-xl border border-[#E6E6F0] overflow-hidden max-w-md">
              {PERSON_KINDS.filter((k) => k.route !== 'resident' || isHousingModule).map((k) => (
                <button
                  key={k.route}
                  type="button"
                  disabled={createdId !== null}
                  onClick={() => navigate(`/people/new/${k.route}`, { replace: true })}
                  className={`flex-1 min-w-0 px-2 text-[13px] font-bold truncate transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                    type === k.route ? 'bg-primary/10 text-primary' : 'bg-white text-text-light hover:text-text-dark'
                  }`}
                >
                  {t(k.labelKey)}
                </button>
              ))}
            </div>
          </PmField>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-[18px]">
            <PmField label={t('people.firstName')} required>
              <input
                type="text"
                value={formData.firstName}
                onChange={(e) => setFormData((p) => ({ ...p, firstName: e.target.value }))}
                placeholder={t('common.required')}
                className={PM_INPUT}
                autoFocus
              />
            </PmField>
            <PmField label={t('people.lastName')} required>
              <input
                type="text"
                value={formData.lastName}
                onChange={(e) => setFormData((p) => ({ ...p, lastName: e.target.value }))}
                placeholder={t('common.required')}
                className={PM_INPUT}
              />
            </PmField>

            {isEmployee && (
              <PmField label={t('people.gender')}>
                <div className="flex h-12 rounded-xl border border-[#E6E6F0] overflow-hidden">
                  {([
                    { v: '', label: t('people.genderUnknown') },
                    { v: 'male', label: t('people.male') },
                    { v: 'female', label: t('people.female') },
                  ] as const).map((opt) => (
                    <button
                      key={opt.v || 'unknown'}
                      type="button"
                      onClick={() => setFormData((p) => ({ ...p, gender: opt.v }))}
                      className={`flex-1 min-w-0 px-2 text-[13px] font-bold truncate transition-colors ${formData.gender === opt.v ? 'bg-primary/10 text-primary' : 'bg-white text-text-light hover:text-text-dark'}`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </PmField>
            )}

            <PmField label={t('people.validFrom')}>
              <input
                type="date"
                value={formData.validFrom}
                max={maxValidityDate()}
                onChange={(e) => setFormData((p) => ({ ...p, validFrom: e.target.value }))}
                className={PM_INPUT}
              />
            </PmField>
            <PmField label={t('people.validTo')}>
              <input
                type="date"
                value={formData.validTo}
                max={maxValidityDate()}
                onChange={(e) => setFormData((p) => ({ ...p, validTo: e.target.value }))}
                className={PM_INPUT}
              />
            </PmField>

            {companyMode !== 'None' && (
              <PmField label={t('people.company')}>
                {companyMode === 'Multiple' ? (
                  <select
                    value={formData.companyId ?? ''}
                    onChange={(e) => setFormData((p) => ({ ...p, companyId: e.target.value || null, departmentId: null }))}
                    className={PM_INPUT}
                  >
                    <option value="">{t('people.notSelected')}</option>
                    {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                ) : (
                  <div className="flex items-center h-12 px-4 rounded-xl border border-[#EFEFF5] bg-[#F8F8FC] text-[13.5px] font-bold text-[#7A7B99] truncate">
                    {companies.find((c) => c.id === formData.companyId)?.name || t('people.primaryCompany')}
                  </div>
                )}
              </PmField>
            )}

            {/* Адрес жильца: у работника этих полей нет, у жильца нет отдела и должности. */}
            {isResident && (
              <>
                <PmField label={t('people.block')}>
                  <select
                    value={formData.housingBlockId ?? ''}
                    onChange={(e) => setFormData((p) => ({ ...p, housingBlockId: e.target.value || null }))}
                    className={PM_INPUT}
                  >
                    <option value="">{t('people.notAssigned')}</option>
                    {flattenHousingBlocks(housingBlocks).map((b) => (
                      <option key={b.id} value={b.id}>{b.label}</option>
                    ))}
                  </select>
                  {housingBlocks.length === 0 && (
                    <span className="text-[11px] text-text-light">{t('people.noHousingBlocks')}</span>
                  )}
                </PmField>
                <PmField label={t('people.apartment')}>
                  <input
                    type="text"
                    value={formData.apartment}
                    onChange={(e) => setFormData((p) => ({ ...p, apartment: e.target.value }))}
                    placeholder={t('people.apartmentPlaceholder')}
                    className={PM_INPUT}
                  />
                </PmField>
              </>
            )}

            {!isResident && departments.length > 0 && (
              <PmField label={t('people.department')}>
                <select
                  value={formData.departmentId ?? ''}
                  onChange={(e) => setFormData((p) => ({ ...p, departmentId: e.target.value || null }))}
                  className={PM_INPUT}
                >
                  <option value="">{t('people.notAssigned')}</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </PmField>
            )}

            {isEmployee && !isResident && positions.length > 0 && (
              <PmField label={t('people.position')}>
                <select
                  value={formData.positionId ?? ''}
                  onChange={(e) => setFormData((p) => ({ ...p, positionId: e.target.value || null }))}
                  className={PM_INPUT}
                >
                  <option value="">{t('people.notAssigned')}</option>
                  {positions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </PmField>
            )}
          </div>

          {isEmployee && !isResident && (
            <label className="flex items-start gap-3 p-4 rounded-[14px] border border-[#EEEBFB] bg-[#FAF9FE] cursor-pointer hover:border-[#DDD9F7] transition-colors">
              <input
                type="checkbox"
                checked={formData.onlyVerify}
                onChange={(e) => setFormData((p) => ({ ...p, onlyVerify: e.target.checked }))}
                className="w-5 h-5 mt-0.5 rounded border-border-light accent-primary"
              />
              <div>
                <span className="text-[13px] font-bold text-text-dark block">{t('people.timeAttendanceOnly')}</span>
                <p className="text-[11.5px] text-[#6D6E8E] mt-1 leading-relaxed">{t('people.timeAttendanceOnlyDescription')}</p>
              </div>
            </label>
          )}

          {accessLevels.length > 0 && (
            <div className="flex flex-col gap-[9px]">
              <span className="text-[12.5px] font-semibold text-[#4A4B6B]">{t('people.accessLevels')}</span>
              <div className="max-h-44 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1 rounded-xl border border-[#E6E6F0] p-2">
                {accessLevels.map((level) => (
                  <label key={level.id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[#FAF9FE] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.accessLevelIds.includes(level.id)}
                      onChange={() => toggleAccessLevel(level.id)}
                      className="rounded border-border-light accent-primary"
                    />
                    <span className="text-[13px] font-semibold text-text-dark truncate">{level.name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-1">
            <Button variant="outline" onClick={() => navigate('/people')}>{t('common.cancel')}</Button>
            <Button onClick={handleSubmit} isLoading={isSubmitting} disabled={!formData.firstName || isSubmitting}>
              {t('common.save')}
            </Button>
          </div>
        </div>
        </div>

        {/* Правая колонка: фото и биометрия — работают сразу, запись создаётся автоматически */}
        <PersonBiometricsStep
          personId={createdId}
          personType={isEmployee ? 'employee' : 'visitor'}
          ensurePerson={ensurePerson}
        />
        </div>
      </div>

      <ErrorDialog
        open={error != null}
        onClose={() => setError(null)}
        title={t('errorDialog.saveTitle')}
        message={error ?? ''}
        onRetry={handleSubmit}
        retryLabel={t('common.save')}
      />
      <ErrorDialog
        open={error == null && syncWarning != null}
        onClose={() => setSyncWarning(null)}
        variant="warning"
        title={t('errorDialog.deviceWarningTitle')}
        message={syncWarning ?? ''}
        hint={t('errorDialog.deviceHint')}
      />
    </AppLayout>
  )
}
