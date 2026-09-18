import { useCallback, useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { HubConnectionBuilder, HttpTransportType, LogLevel } from '@microsoft/signalr'
import { useAuth } from '../auth/AuthContext'
import { AppLayout } from '../components/templates'
import { Badge, Button } from '../components/atoms'
import { ConfirmDialog } from '../components/molecules'
import { ErrorDialog } from '../components/organisms'
import { PersonBiometricsStep } from './PersonBiometricsStep'
import { useModule } from '../context/ModuleContext'
import { flattenHousingBlocks, loadHousingBlocks, type HousingBlockItem } from './housingBlocks'
import { maxValidityDate } from '../lib/validity'
import { PM_CARD, PM_INPUT, PM_TITLE, PmField } from './personFormUi'

import { apiRequest, getHubUrl } from '../lib/api'
import { newId } from '../lib/id'
import { copyToClipboard } from '../lib/clipboard'

interface PersonSyncProgressEvent {
  syncId: string
  stage: 'syncing' | 'skipped' | 'done' | 'error' | 'complete'
  current: number
  total: number
  deviceId: string
  deviceName: string
  message?: string | null
}

interface SyncProgressState {
  syncId: string
  current: number
  total: number
  deviceName: string
  stage: PersonSyncProgressEvent['stage']
  message: string
  skipped: number
  errors: number
}

interface DepartmentRef {
  id: string
  name: string
}

interface PersonDetail {
  id: string
  firstName: string
  lastName: string
  documentNumber?: string | null
  externalId?: string | null
  gender?: string | null
  validFromUtc?: string | null
  validToUtc?: string | null
  isActive: boolean
  onlyVerify?: boolean
  department?: DepartmentRef | null
  position?: DepartmentRef | null
  companyId?: string | null
  accessLevels: { id: string; name: string }[]
  cards: { id: string; cardNo: string; cardNumber?: string | null; cardType?: string | null }[]
  faces: { id: string; fdid: number }[]
  fingerprints: { id: string; fingerIndex: number }[]
  irises: { id: string; irisIndex: number }[]
  selfServiceEnabled?: boolean
  selfServiceEmail?: string | null
  /** Приходит ТОЛЬКО в ответе на сохранение, когда аккаунт был создан именно сейчас (в GET его нет). */
  selfServiceTempPassword?: string | null
  /** null — аккаунт не создавался; false — письмо с доступом не ушло, пароль нужно передать вручную. */
  selfServiceEmailSent?: boolean | null
  /** Ответ SMTP, когда письмо не ушло: без него причина видна только в консольном логе сервиса. */
  selfServiceEmailError?: string | null
  workScheduleId?: string | null
  workScheduleName?: string | null
  /** 'employee' | 'resident' — жилец хранится в той же таблице, что и работник. */
  kind?: string
  apartment?: string | null
  housingBlockId?: string | null
  housingBlockName?: string | null
}

interface WorkSchedule {
  id: string
  name: string
  type: string
}

interface DepartmentTreeItem {
  id: string
  name: string
  description?: string | null
  sortOrder: number
  parentId?: string | null
  employeesCount: number
  visitorsCount: number
  companyId?: string | null
}

interface AccessLevelDoor {
  deviceId: string
  deviceName: string
  doorIndex: number
  isElevator?: boolean
}

interface Company {
  id: string
  name: string
  description?: string | null
}

interface AccessLevel {
  id: string
  name: string
  description?: string | null
  doors?: AccessLevelDoor[]
}



export function PersonDetailPage() {
  const { t } = useTranslation()
  const { type, id } = useParams<{ type: 'employee' | 'visitor'; id: string }>()
  const { activeModule } = useModule()
  // Переключать работника в жильца можно только в модуле ЖКХ.
  const isHousingModule = activeModule === 'housing'
  const navigate = useNavigate()
  const { token } = useAuth()

  const [detail, setDetail] = useState<PersonDetail | null>(null)
  const [accessLevels, setAccessLevels] = useState<AccessLevel[]>([])
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    externalId: '',
    gender: '',
    validFrom: '',
    validTo: '',
    isActive: true,
    onlyVerify: false,
    accessLevelIds: [] as string[],
    departmentId: null as string | null,
    positionId: null as string | null,
    companyId: null as string | null,
    selfServiceEnabled: false,
    selfServiceEmail: '',
    workScheduleId: null as string | null,
    kind: 'employee',
    apartment: '',
    housingBlockId: null as string | null,
  })
  const [housingBlocks, setHousingBlocks] = useState<HousingBlockItem[]>([])
  // Жилец лежит в тех же записях, что и работник (type === 'employee'),
  // отличает его поле kind — оно же прячет отдел, должность, табель и смены.
  const isResident = formData.kind === 'resident'
  const [workSchedules, setWorkSchedules] = useState<WorkSchedule[]>([])
  // Одноразовый показ выданного пароля: живёт только в состоянии страницы — после ухода
  // или перезагрузки его уже не увидеть, сервер отдаёт пароль лишь в ответе на создание.
  const [newSelfService, setNewSelfService] = useState<{ password: string; email: string; emailSent: boolean | null; emailError: string | null } | null>(null)
  const [passwordCopied, setPasswordCopied] = useState(false)
  const [selfServiceLoading, setSelfServiceLoading] = useState(false)
  const [companies, setCompanies] = useState<Company[]>([])
  const [companyMode, setCompanyMode] = useState<'None' | 'Single' | 'Multiple'>('None')
  const [departments, setDepartments] = useState<DepartmentTreeItem[]>([])
  const [positions, setPositions] = useState<{ id: string; name: string }[]>([])
  const [saveLoading, setSaveLoading] = useState(false)
  const [syncProgress, setSyncProgress] = useState<SyncProgressState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [syncWarning, setSyncWarning] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)

  const apiPath = type === 'employee' ? '/api/employees' : '/api/visitors'

  const loadDetail = useCallback(async () => {
    if (!token || !id) return
    setError(null)
    try {
      const data = await apiRequest<PersonDetail>(`${apiPath}/${id}`, { token })
      setDetail(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('personDetail.errors.loadFailed'))
    }
  }, [token, id, apiPath, t])

  const loadCompanies = useCallback(async (): Promise<Company[]> => {
    if (!token) return []
    try {
      const list = await apiRequest<Company[]>(`/api/companies`, { token })
      setCompanies(list)
      return list
    } catch {
      setCompanies([])
      return []
    }
  }, [token])

  const loadCompanyMode = useCallback(async (): Promise<string> => {
    if (!token) return 'None'
    try {
      const setting = await apiRequest<{ key: string; value: string }>(`/api/system-settings/CompanyMode`, { token })
      setCompanyMode(setting.value as any)
      return setting.value
    } catch {
      setCompanyMode('None')
      return 'None'
    }
  }, [token])

  const loadAccessLevels = useCallback(async () => {
    if (!token) return
    try {
      const list = await apiRequest<AccessLevel[]>(`/api/access-levels`, { token })
      setAccessLevels(list)
    } catch {
      setAccessLevels([])
    }
  }, [token])

  const loadWorkSchedules = useCallback(async () => {
    if (!token) return
    try {
      const list = await apiRequest<WorkSchedule[]>(`/api/work-schedules`, { token })
      setWorkSchedules(list)
    } catch {
      setWorkSchedules([])
    }
  }, [token])

  const loadDepartments = useCallback(async (cId?: string | null) => {
    if (!token) return
    
    // In group-of-companies mode, hide departments until a company is selected
    if (companyMode === 'Multiple' && !cId) {
      setDepartments([])
      return
    }

    try {
      const params = new URLSearchParams()
      if (cId) params.set('companyId', cId)
      const list = await apiRequest<DepartmentTreeItem[]>(`/api/departments/tree?${params}`, { token })
      setDepartments(list)
    } catch {
      setDepartments([])
    }
  }, [token, companyMode])

  const loadPositions = useCallback(async () => {
    if (!token) return
    try {
      const list = await apiRequest<{ id: string; name: string }[]>(`/api/positions`, { token })
      setPositions(list)
    } catch {
      setPositions([])
    }
  }, [token])

  useEffect(() => {
    loadDetail()
    loadAccessLevels()
    loadCompanies()
    loadCompanyMode()
    if (type === 'employee') { loadWorkSchedules(); loadPositions() }
    // Структура ЖКХ нужна только там, где блок вообще можно выбрать.
    if (type === 'employee' && isHousingModule) {
      loadHousingBlocks(token).then(setHousingBlocks).catch(() => setHousingBlocks([]))
    }
  }, [loadDetail, loadAccessLevels, loadCompanies, loadCompanyMode, loadWorkSchedules, loadPositions, type, isHousingModule, token])

  useEffect(() => {
    loadDepartments(formData.companyId)
  }, [loadDepartments, formData.companyId])

  useEffect(() => {
    if (!detail) return
    const validFrom = detail.validFromUtc ? detail.validFromUtc.slice(0, 10) : new Date().toISOString().slice(0, 10)
    const validTo = detail.validToUtc ? detail.validToUtc.slice(0, 10) : maxValidityDate()
    
    let cId = detail.companyId ?? null;
    if (!cId && companyMode === 'Single' && companies.length > 0) {
      cId = companies[0].id;
    }

    setFormData({
      firstName: detail.firstName,
      lastName: detail.lastName,
      externalId: (detail as PersonDetail & { externalId?: string | null }).externalId ?? '',
      gender: (detail as PersonDetail & { gender?: string }).gender ?? '',
      validFrom,
      validTo,
      isActive: detail.isActive,
      onlyVerify: (detail as PersonDetail & { onlyVerify?: boolean }).onlyVerify ?? false,
      accessLevelIds: detail.accessLevels?.map((a) => a.id) ?? [],
      departmentId: detail.department?.id ?? null,
      positionId: detail.position?.id ?? null,
      companyId: cId,
      selfServiceEnabled: detail.selfServiceEnabled ?? false,
      selfServiceEmail: detail.selfServiceEmail ?? '',
      workScheduleId: detail.workScheduleId ?? null,
      kind: detail.kind ?? 'employee',
      apartment: detail.apartment ?? '',
      housingBlockId: detail.housingBlockId ?? null,
    })
    // Пароль намеренно НЕ восстанавливаем из detail: в GET его нет и быть не должно —
    // он показывается один раз, сразу после создания аккаунта (см. handleSave).
  }, [detail, companies, companyMode])

  function showSyncWarnings(res: { syncWarnings?: string[] | null }) {
    const w = res?.syncWarnings
    setSyncWarning(Array.isArray(w) && w.length > 0
      ? t('personDetail.errors.deviceSyncErrors') + '\n' + w.join('\n')
      : null)
  }

  async function handleSave() {
    if (!token || !id || !detail) return
    if (!formData.firstName.trim() || !formData.lastName.trim()) {
      setError(t('personDetail.errors.namesRequired'))
      return
    }

    // Generate a unique sync correlation ID. The backend echoes it back in every
    // PersonSyncProgress SignalR event so we know which messages belong to THIS save
    // (and ignore syncs from other tabs / users).
    const syncId = newId('sync')

    setSyncWarning(null)
    setSaveLoading(true)
    setError(null)
    // Пароль от прошлого создания убираем, чтобы его не приняли за новый.
    setNewSelfService(null)
    setPasswordCopied(false)
    setSyncProgress({
      syncId,
      current: 0,
      total: 0,
      deviceName: '',
      stage: 'syncing',
      message: t('personDetail.sync.savingProfile'),
      skipped: 0,
      errors: 0,
    })

    // Open a dedicated hub connection for the duration of this save. We deliberately
    // do NOT reuse a long-lived connection — this keeps the cleanup trivial and the
    // listener scoped to a single save operation.
    const hub = new HubConnectionBuilder()
      .withUrl(`${getHubUrl()}/hubs/devices`, {
        accessTokenFactory: () => token!,
        skipNegotiation: true,
        transport: HttpTransportType.WebSockets,
      })
      .configureLogging(LogLevel.Error)
      .build()

    hub.on('PersonSyncProgress', (evt: PersonSyncProgressEvent) => {
      if (!evt || evt.syncId !== syncId) return
      setSyncProgress((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          current: evt.current,
          total: evt.total,
          deviceName: evt.deviceName || prev.deviceName,
          stage: evt.stage,
          message: evt.message ?? prev.message,
          skipped: evt.stage === 'skipped' ? prev.skipped + 1 : prev.skipped,
          errors: evt.stage === 'error' ? prev.errors + 1 : prev.errors,
        }
      })
    })

    try {
      try {
        await hub.start()
      } catch {
        // SignalR failed to connect — proceed without progress UI rather than block save.
      }

      const commonHeaders = { 'X-Sync-Id': syncId }
      if (type === 'employee') {
        const res = await apiRequest<PersonDetail & { syncWarnings?: string[] }>(`${apiPath}/${id}`, {
          method: 'PUT',
          token,
          headers: commonHeaders,
          body: JSON.stringify({
            firstName: formData.firstName.trim(),
            lastName: formData.lastName.trim(),
            externalId: formData.externalId.trim(),
            gender: formData.gender.trim() || null,
            validFromUtc: formData.validFrom ? formData.validFrom + 'T00:00:00Z' : null,
            validToUtc: formData.validTo ? formData.validTo + 'T23:59:59Z' : null,
            isActive: formData.isActive,
            onlyVerify: formData.onlyVerify,
            accessLevelIds: formData.accessLevelIds,
            departmentId: formData.departmentId || null,
            positionId: formData.positionId || null,
            companyId: formData.companyId || null,
            selfServiceEnabled: formData.selfServiceEnabled,
            selfServiceEmail: formData.selfServiceEnabled && formData.selfServiceEmail ? formData.selfServiceEmail.trim() : null,
            workScheduleId: isResident ? null : formData.workScheduleId || null,
            kind: formData.kind,
            apartment: isResident ? formData.apartment.trim() : null,
            housingBlockId: isResident ? formData.housingBlockId : null,
          }),
        })
        showSyncWarnings(res)
        setDetail(res)
        // Аккаунт самообслуживания создан именно этим сохранением — показываем пароль один раз.
        if (res.selfServiceTempPassword) {
          setNewSelfService({
            password: res.selfServiceTempPassword,
            email: res.selfServiceEmail ?? formData.selfServiceEmail.trim(),
            emailSent: res.selfServiceEmailSent ?? null,
            emailError: res.selfServiceEmailError ?? null,
          })
        }
      } else {
        const res = await apiRequest<PersonDetail & { syncWarnings?: string[] }>(`${apiPath}/${id}`, {
          method: 'PUT',
          token,
          headers: commonHeaders,
          body: JSON.stringify({
            firstName: formData.firstName.trim(),
            lastName: formData.lastName.trim(),
            documentNumber: detail.documentNumber ?? null,
            validFromUtc: formData.validFrom ? formData.validFrom + 'T00:00:00Z' : null,
            validToUtc: formData.validTo ? formData.validTo + 'T23:59:59Z' : null,
            isActive: formData.isActive,
            accessLevelIds: formData.accessLevelIds,
            departmentId: formData.departmentId || null,
            companyId: formData.companyId || null,
          }),
        })
        showSyncWarnings(res)
        setDetail(res)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('personDetail.errors.saveFailed'))
    } finally {
      setSaveLoading(false)
      setSyncProgress(null)
      try {
        await hub.stop()
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Выдать доступ к самообслуживанию: сервер создаёт аккаунт (или перевыпускает пароль
   * существующему), шлёт письмо и возвращает новый пароль — показываем его один раз.
   * Адрес берём из формы, поэтому сохранять карточку заранее не нужно.
   */
  async function handleSelfServiceAccess() {
    if (!token || !id) return
    const email = formData.selfServiceEmail.trim()
    if (!email) return
    setSelfServiceLoading(true)
    setError(null)
    setNewSelfService(null)
    setPasswordCopied(false)
    try {
      const res = await apiRequest<{ selfServiceEmail: string; selfServiceTempPassword: string; selfServiceEmailSent: boolean; selfServiceEmailError?: string | null }>(
        `/api/employees/${id}/self-service`,
        { method: 'POST', token, body: JSON.stringify({ email }) },
      )
      setNewSelfService({
        password: res.selfServiceTempPassword,
        email: res.selfServiceEmail,
        emailSent: res.selfServiceEmailSent,
        emailError: res.selfServiceEmailError ?? null,
      })
      // Сервер включил самообслуживание и зафиксировал адрес — отражаем это в карточке,
      // чтобы кнопка сразу стала «перевыпустить», а повторное сохранение ничего не сбросило.
      setFormData((p) => ({ ...p, selfServiceEnabled: true, selfServiceEmail: res.selfServiceEmail }))
      setDetail((d) => (d ? { ...d, selfServiceEnabled: true, selfServiceEmail: res.selfServiceEmail } : d))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('personDetail.errors.saveFailed'))
    } finally {
      setSelfServiceLoading(false)
    }
  }

  function toggleAccessLevel(levelId: string) {
    setFormData((prev) => ({
      ...prev,
      accessLevelIds: prev.accessLevelIds.includes(levelId)
        ? prev.accessLevelIds.filter((x) => x !== levelId)
        : [...prev.accessLevelIds, levelId],
    }))
  }

  async function handleRetireProfile() {
    if (!token || !id || !type) return
    setError(null)
    setIsSubmitting(true)
    try {
      const res = await apiRequest<{ syncWarnings?: string[] } | void>(`${apiPath}/${id}`, { method: 'DELETE', token })
      const warnings = res && typeof res === 'object' && Array.isArray((res as { syncWarnings?: string[] }).syncWarnings)
        ? (res as { syncWarnings: string[] }).syncWarnings
        : null
      setDeleteConfirmOpen(false)
      navigate('/people', { state: warnings?.length ? { syncWarning: t('personDetail.errors.deviceSyncErrors') + '\n' + warnings.join('\n') } : undefined })
    } catch (e) {
      setError(e instanceof Error ? e.message : t('personDetail.errors.deleteProfileFailed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!detail) {
    return (
      <AppLayout onAction={() => navigate('/people')}>
        <div className="flex-1 flex flex-col bg-background-light">
          <div className="p-6 md:p-10">
            <button
              onClick={() => navigate('/people')}
              className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-text-light hover:text-primary transition-colors"
            >
              <span className="material-symbols-outlined text-base">arrow_back</span>
              {type === 'employee' ? t('personDetail.backToEmployees') : t('personDetail.backToVisitors')}
            </button>
          </div>
          <div className="flex-1 flex items-center justify-center">
            {error ? (
              <div className="text-error-text font-black uppercase tracking-widest text-[10px] animate-pulse">
                {t('personDetail.errorProtocol', { error })}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4">
                <div className="w-12 h-12 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
                <p className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('personDetail.initializingProfile')}</p>
              </div>
            )}
          </div>
        </div>
      </AppLayout>
    )
  }

  const name = `${formData.firstName || detail.firstName} ${formData.lastName || detail.lastName}`.trim() || t('personDetail.profile')

  return (
    <AppLayout onAction={() => navigate('/people')}>
      <div className="flex-1 overflow-y-auto bg-background-light pb-20 md:pb-0">
        <div className="p-6 md:p-8 space-y-[18px] max-w-6xl">
          {/* Шапка: имя + возврат (тот же вид, что на странице добавления) */}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <h1 className="text-xl font-black text-text-dark tracking-tight truncate">{name}</h1>
                <Badge variant="primary" className="px-3 py-1 shrink-0">
                  {type === 'employee' ? t('personDetail.employee') : t('personDetail.visitor')}
                </Badge>
              </div>
              <p className="text-xs text-text-light mt-1">
                {type === 'employee' ? t('personDetail.employeeProfileHint') : t('personDetail.visitorProfileHint')}
              </p>
            </div>
            <Button variant="outline" icon="arrow_back" onClick={() => navigate('/people')}>
              {t('common.back')}
            </Button>
          </div>

          {/* Ошибки и замечания устройств показываем окном ErrorDialog (ниже), а не полосами в потоке страницы. */}
          {/* Сетка референса: слева данные, справа колонка 300px с фото и биометрией */}
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-[18px] items-start">
            <div className="flex flex-col gap-[18px] min-w-0">

              {/* Иллюстрация */}
              <div className="rounded-[18px] overflow-hidden bg-[#F1F0FB] h-[218px]">
                <img src="/ana-hero.png" alt="" className="w-full h-full object-cover object-center block" />
              </div>

              {/* Данные человека */}
              <div className={`${PM_CARD} p-6 md:p-7 space-y-5`}>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-[18px]">
                  <PmField label={t('personDetail.firstName')} required>
                    <input
                      type="text"
                      value={formData.firstName}
                      onChange={(e) => setFormData((p) => ({ ...p, firstName: e.target.value }))}
                      placeholder={t('common.required')}
                      className={PM_INPUT}
                    />
                  </PmField>
                  <PmField label={t('personDetail.lastName')} required>
                    <input
                      type="text"
                      value={formData.lastName}
                      onChange={(e) => setFormData((p) => ({ ...p, lastName: e.target.value }))}
                      placeholder={t('common.required')}
                      className={PM_INPUT}
                    />
                  </PmField>

                  {/* Работника и жильца можно переключать: на устройствах это ничего не меняет,
                      меняется только вкладка и набор доступных полей. */}
                  {type === 'employee' && isHousingModule && (
                    <PmField label={t('people.personKind')}>
                      <div className="flex h-12 rounded-xl border border-[#E6E6F0] overflow-hidden">
                        {([
                          { v: 'employee', label: t('people.kindEmployee') },
                          { v: 'resident', label: t('people.kindResident') },
                        ] as const).map((opt) => (
                          <button
                            key={opt.v}
                            type="button"
                            onClick={() => setFormData((p) => ({ ...p, kind: opt.v }))}
                            className={`flex-1 min-w-0 px-2 text-[13px] font-bold truncate transition-colors ${formData.kind === opt.v ? 'bg-primary/10 text-primary' : 'bg-white text-text-light hover:text-text-dark'}`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </PmField>
                  )}

                  {type === 'employee' && isResident && (
                    <>
                      <PmField label={t('people.block')}>
                        <select
                          value={formData.housingBlockId ?? ''}
                          onChange={(e) => setFormData((p) => ({ ...p, housingBlockId: e.target.value || null }))}
                          className={PM_INPUT}
                        >
                          <option value="">{t('personDetail.notAssigned')}</option>
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

                  {type === 'employee' && (
                    <>
                      <PmField label="ID">
                        <input
                          type="text"
                          value={formData.externalId}
                          onChange={(e) => setFormData((p) => ({ ...p, externalId: e.target.value }))}
                          placeholder="ID / таб. №"
                          className={PM_INPUT}
                        />
                      </PmField>
                      <PmField label={t('personDetail.gender')}>
                        <div className="flex h-12 rounded-xl border border-[#E6E6F0] overflow-hidden">
                          {([
                            { v: '', label: t('personDetail.notSpecified') },
                            { v: 'male', label: t('personDetail.male') },
                            { v: 'female', label: t('personDetail.female') },
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
                    </>
                  )}

                  <PmField label={t('personDetail.validFrom')}>
                    <input
                      type="date"
                      value={formData.validFrom}
                      max={maxValidityDate()}
                      onChange={(e) => setFormData((p) => ({ ...p, validFrom: e.target.value }))}
                      className={PM_INPUT}
                    />
                  </PmField>
                  <PmField label={t('personDetail.validTo')}>
                    <input
                      type="date"
                      value={formData.validTo}
                      max={maxValidityDate()}
                      onChange={(e) => setFormData((p) => ({ ...p, validTo: e.target.value }))}
                      className={PM_INPUT}
                    />
                  </PmField>

                  {companyMode !== 'None' && (
                    <PmField label={t('personDetail.company')}>
                      {companyMode === 'Multiple' ? (
                        <select
                          value={formData.companyId ?? ''}
                          onChange={(e) => setFormData((p) => ({ ...p, companyId: e.target.value || null, departmentId: null }))}
                          className={PM_INPUT}
                        >
                          <option value="">{t('personDetail.notSelected')}</option>
                          {companies.map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </select>
                      ) : (
                        <div className="flex items-center h-12 px-4 rounded-xl border border-[#EFEFF5] bg-[#F8F8FC] text-[13.5px] font-bold text-[#7A7B99] truncate">
                          {companies.find((c) => c.id === formData.companyId)?.name || t('personDetail.primaryCompany')}
                        </div>
                      )}
                    </PmField>
                  )}

                  {!isResident && (
                  <PmField label={t('personDetail.department')}>
                    <select
                      value={formData.departmentId ?? ''}
                      onChange={(e) => setFormData((p) => ({ ...p, departmentId: e.target.value || null }))}
                      className={PM_INPUT}
                    >
                      <option value="">{t('personDetail.notAssigned')}</option>
                      {departments.map((d) => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                  </PmField>
                  )}

                  {type === 'employee' && !isResident && (
                    <PmField label={t('personDetail.position')}>
                      <select
                        value={formData.positionId ?? ''}
                        onChange={(e) => setFormData((p) => ({ ...p, positionId: e.target.value || null }))}
                        className={PM_INPUT}
                      >
                        <option value="">{t('personDetail.notAssigned')}</option>
                        {positions.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </PmField>
                  )}
                </div>

                {/* Уровни доступа */}
                <div className="flex flex-col gap-[9px]">
                  <span className="text-[12.5px] font-semibold text-[#4A4B6B]">{t('personDetail.accessLevels')}</span>
                  {accessLevels.length > 0 ? (
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
                  ) : (
                    <p className="text-[11.5px] text-[#8B8CA7]">{t('personDetail.noAccessLevels')}</p>
                  )}
                </div>
              </div>

              {/* Статус — остаётся в левой колонке под данными */}
              <div className={`${PM_CARD} p-[22px] space-y-4`}>
                <span className={PM_TITLE}>{t('common.status')}</span>
                <label className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl cursor-pointer hover:bg-slate-100 transition-colors">
                  <span className="text-xs font-black text-text-dark uppercase tracking-widest">
                    {type === 'employee' ? (formData.isActive ? t('common.active') : t('personDetail.terminated')) : (formData.isActive ? t('common.active') : t('personDetail.blocked'))}
                  </span>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={formData.isActive}
                      onChange={(e) => setFormData((p) => ({ ...p, isActive: e.target.checked }))}
                      className="w-5 h-5 rounded border-divider-light text-primary focus:ring-primary"
                    />
                    <Badge variant={formData.isActive ? 'success' : 'error'} dot>
                      {type === 'employee' ? (formData.isActive ? t('common.active') : t('personDetail.terminated')) : (formData.isActive ? t('common.active') : t('personDetail.blocked'))}
                    </Badge>
                  </div>
                </label>
                {type === 'employee' && !isResident && (
                  <label className="flex items-start gap-3 p-4 bg-slate-50 rounded-2xl cursor-pointer hover:bg-slate-100 transition-colors">
                    <input
                      type="checkbox"
                      checked={formData.onlyVerify}
                      onChange={(e) => setFormData((p) => ({ ...p, onlyVerify: e.target.checked }))}
                      className="w-5 h-5 mt-0.5 rounded border-divider-light text-primary focus:ring-primary"
                    />
                    <div>
                      <span className="text-xs font-black text-text-dark uppercase tracking-widest block">{t('personDetail.timeAttendanceOnly')}</span>
                      <p className="text-[10px] text-text-light mt-1 leading-relaxed">{t('personDetail.timeAttendanceOnlyHint')}</p>
                    </div>
                  </label>
                )}
              </div>

              {/* Work Schedule & Self-Service — жилец не работает, ни того ни другого ему не нужно. */}
              {type === 'employee' && !isResident && (
                <div className={`${PM_CARD} p-[22px] space-y-4`}>
                  <span className={PM_TITLE}>{t('personDetail.scheduleAndSelfService')}</span>

                  {/* Self-Service Toggle */}
                  <label className="flex items-start gap-3 p-4 bg-white rounded-2xl cursor-pointer hover:bg-indigo-50 transition-colors border border-indigo-100">
                    <input
                      type="checkbox"
                      checked={formData.selfServiceEnabled}
                      onChange={(e) => setFormData((p) => ({ ...p, selfServiceEnabled: e.target.checked }))}
                      className="w-5 h-5 mt-0.5 rounded border-divider-light text-indigo-500 focus:ring-indigo-400"
                    />
                    <div>
                      <span className="text-xs font-black text-text-dark uppercase tracking-widest block">{t('personDetail.selfServicePortal')}</span>
                      <p className="text-[10px] text-text-light mt-1 leading-relaxed">{t('personDetail.selfServicePortalHint')}</p>
                    </div>
                  </label>

                  {formData.selfServiceEnabled && (
                    <div className="space-y-1.5">
                      <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('personDetail.signInEmail')}</label>
                      <div className="relative">
                        <input
                          type="email"
                          placeholder={t('personDetail.signInEmailPlaceholder')}
                          value={formData.selfServiceEmail}
                          onChange={(e) => setFormData((p) => ({ ...p, selfServiceEmail: e.target.value }))}
                          className="w-full rounded-xl bg-white border-none px-4 pl-10 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none shadow-sm"
                        />
                        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-light text-base">alternate_email</span>
                      </div>

                      {/* Выдача доступа отдельной кнопкой: каждое нажатие выпускает НОВЫЙ пароль
                          (старый перестаёт работать) и показывает его здесь же. */}
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={handleSelfServiceAccess}
                          disabled={selfServiceLoading || !formData.selfServiceEmail.trim()}
                          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-500 text-white text-[11px] font-black uppercase tracking-widest hover:bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          {selfServiceLoading
                            ? <span className="spinner-ring text-base" aria-hidden="true" />
                            : <span className="material-symbols-outlined text-base">{detail.selfServiceEnabled ? 'lock_reset' : 'person_add'}</span>}
                          {detail.selfServiceEnabled
                            ? t('personDetail.resetSelfServicePassword')
                            : t('personDetail.createSelfService')}
                        </button>
                        <p className="text-[10px] text-text-light leading-relaxed flex-1 min-w-[180px]">
                          {detail.selfServiceEnabled
                            ? t('personDetail.resetSelfServiceHint')
                            : t('personDetail.createSelfServiceHint')}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Одноразовый показ: пароль есть только в ответе на создание, после ухода со страницы его не вернуть. */}
                  {newSelfService && (
                    <div className="p-4 bg-green-50 rounded-2xl border border-green-200 space-y-2.5">
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-green-600 text-lg">check_circle</span>
                        <p className="text-[10px] font-black text-green-700 uppercase tracking-widest">{t('personDetail.accountCreated')}</p>
                      </div>

                      <div className="space-y-1">
                        <p className="text-[10px] font-black text-green-700 uppercase tracking-widest">{t('personDetail.temporaryPassword')}</p>
                        <div className="flex items-center gap-2">
                          <code className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-white border border-green-200 font-mono text-sm font-bold text-text-dark break-all select-all">
                            {newSelfService.password}
                          </code>
                          <button
                            type="button"
                            onClick={() => {
                              void copyToClipboard(newSelfService.password)
                                .then((ok) => { if (ok) setPasswordCopied(true) })
                            }}
                            className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-xl bg-green-600 text-white text-[10px] font-black uppercase tracking-widest hover:bg-green-700 transition-colors"
                          >
                            <span className="material-symbols-outlined text-sm">{passwordCopied ? 'check' : 'content_copy'}</span>
                            {passwordCopied ? t('personDetail.passwordCopied') : t('personDetail.copyPassword')}
                          </button>
                        </div>
                      </div>

                      {newSelfService.emailSent === false ? (
                        <div className="space-y-1">
                          <p className="text-[11px] font-bold text-amber-700">{t('personDetail.credentialsEmailFailed')}</p>
                          {/* Точный ответ SMTP: логи сервиса идут только в консоль, поэтому без этой
                              строки администратор не узнает, почему письмо не ушло. */}
                          {newSelfService.emailError && (
                            <p className="px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 font-mono text-[10px] text-amber-800 break-words">
                              {newSelfService.emailError}
                            </p>
                          )}
                        </div>
                      ) : (
                        <p className="text-[11px] font-bold text-green-700">
                          {t('personDetail.credentialsEmailSent', { email: newSelfService.email })}
                        </p>
                      )}
                      <p className="text-[10px] text-green-600">{t('personDetail.savePasswordHint')}</p>
                      <button
                        type="button"
                        onClick={() => { setNewSelfService(null); setPasswordCopied(false) }}
                        className="text-[10px] text-green-500 underline"
                      >{t('common.close')}</button>
                    </div>
                  )}

                  {/* Work Schedule Assignment */}
                  <div className="space-y-1.5">
                    <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('personDetail.defaultWorkSchedule')}</label>
                    <div className="relative">
                      <select
                        value={formData.workScheduleId ?? ''}
                        onChange={(e) => setFormData((p) => ({ ...p, workScheduleId: e.target.value || null }))}
                        className="w-full rounded-xl bg-white border-none px-4 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none shadow-sm appearance-none pr-8"
                      >
                        <option value="">{t('personDetail.noSchedule')}</option>
                        {workSchedules.map((ws) => (
                          <option key={ws.id} value={ws.id}>
                            {ws.name} ({ws.type})
                          </option>
                        ))}
                      </select>
                      <span className="material-symbols-outlined absolute right-2.5 top-1/2 -translate-y-1/2 text-text-light text-base pointer-events-none">expand_more</span>
                    </div>
                    <p className="text-[10px] text-text-light leading-relaxed">
                      {t('personDetail.defaultWorkScheduleHint')}
                    </p>
                  </div>
                </div>
              )}

              {/* Действия */}
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <Button variant="danger" icon="delete" onClick={() => setDeleteConfirmOpen(true)}>{t('personDetail.deleteProfile')}</Button>
                  <p className="text-[10px] text-text-light mt-1.5 leading-relaxed">{t('personDetail.deleteProfileHint')}</p>
                </div>
                <Button icon="save" onClick={handleSave} isLoading={saveLoading}>{t('common.save')}</Button>
              </div>
            </div>

            {/* Правая колонка: фото и биометрия — тот же блок, что на странице добавления */}
            {/* Перемонтируем при смене набора уровней доступа, чтобы подсказка
                «на устройства не пишем» сразу отражала сохранённое состояние. */}
            <PersonBiometricsStep
              key={detail.accessLevels?.length ?? 0}
              personId={id ?? null}
              personType={type === 'visitor' ? 'visitor' : 'employee'}
              ensurePerson={async () => id ?? null}
            />
          </div>
        </div>
      </div>

      {/* Sync progress overlay — shown while handleSave streams device-by-device progress
          via SignalR PersonSyncProgress events. Devices that are offline show as "skipped"
          almost instantly because the backend filters them out before attempting any HTTP
          call (no more 30-second-per-device hangs). */}
      {syncProgress && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-surface w-full max-w-md rounded-3xl shadow-2xl p-6 space-y-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center text-primary">
                <span className="material-symbols-outlined text-xl animate-spin">sync</span>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-black text-text-dark">{t('personDetail.sync.savingProfileTitle')}</h3>
                <p className="text-[10px] font-bold text-text-light uppercase tracking-widest">
                  {syncProgress.total > 0
                    ? t('personDetail.sync.deviceProgress', { current: syncProgress.current, total: syncProgress.total })
                    : t('personDetail.sync.preparing')}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-text-dark truncate pr-3">
                  {syncProgress.deviceName || '—'}
                </span>
                <span
                  className={`text-[9px] font-black uppercase tracking-widest shrink-0 px-2 py-0.5 rounded-full ${
                    syncProgress.stage === 'done'
                      ? 'bg-emerald-50 text-emerald-600'
                      : syncProgress.stage === 'skipped'
                        ? 'bg-amber-50 text-amber-700'
                        : syncProgress.stage === 'error'
                          ? 'bg-error-bg text-error-text'
                          : syncProgress.stage === 'complete'
                            ? 'bg-emerald-50 text-emerald-600'
                            : 'bg-primary/10 text-primary'
                  }`}
                >
                  {syncProgress.stage}
                </span>
              </div>
              <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-200"
                  style={{
                    width: `${
                      syncProgress.total > 0
                        ? Math.min(100, Math.round((syncProgress.current / syncProgress.total) * 100))
                        : syncProgress.stage === 'complete'
                          ? 100
                          : 5
                    }%`,
                  }}
                />
              </div>
              {syncProgress.message && (
                <p className="text-[10px] text-text-light leading-snug">{syncProgress.message}</p>
              )}
            </div>

            {(syncProgress.skipped > 0 || syncProgress.errors > 0) && (
              <div className="flex gap-3 text-[10px] font-bold text-text-light pt-2 border-t border-divider-light">
                {syncProgress.skipped > 0 && (
                  <span className="text-amber-700">{t('personDetail.sync.skipped', { count: syncProgress.skipped })}</span>
                )}
                {syncProgress.errors > 0 && (
                  <span className="text-error-text">{t('personDetail.sync.errors', { count: syncProgress.errors })}</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}


      <ConfirmDialog
        isOpen={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        onConfirm={handleRetireProfile}
        title={t('personDetail.retireProfile')}
        message={t('personDetail.retireProfileMessage', { name })}
        confirmText={t('common.delete')}
        variant="danger"
        isLoading={isSubmitting}
      />

      {/* Ошибка перекрывает замечания: сначала показываем то, что помешало действию. */}
      <ErrorDialog
        open={error != null}
        onClose={() => setError(null)}
        title={t('errorDialog.saveTitle')}
        message={error ?? ''}
        onRetry={handleSave}
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
