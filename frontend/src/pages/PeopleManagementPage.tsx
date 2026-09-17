import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/AuthContext'
import { AppLayout } from '../components/templates'
import { Badge, Button, Input } from '../components/atoms'
import { PageHeader, Modal, VisitorPassActions } from '../components/organisms'
import { useLoading } from '../context/LoadingContext'
import { apiRequest } from '../lib/api'
import { FaceThumbnail } from '../components/FaceThumbnail'
import { useModule } from '../context/ModuleContext'

interface EmployeeResponse {
  id: string
  firstName: string
  lastName: string
  /** 'employee' | 'resident' — жильцы лежат в той же таблице, отличаются только этим полем. */
  kind?: string
  apartment?: string | null
  housingBlockId?: string | null
  housingBlockName?: string | null
  employeeNo?: string | null
  gender?: string | null
  validFromUtc?: string | null
  validToUtc?: string | null
  isActive: boolean
  onlyVerify?: boolean
  accessLevelNames: string[]
  department?: { id: string; name: string } | null
  primaryFaceId?: string | null
  cardsCount: number
  facesCount: number
  fingerprintsCount: number
  irisesCount: number
}

interface VisitorResponse {
  id: string
  firstName: string
  lastName: string
  documentNumber?: string | null
  validFromUtc?: string | null
  validToUtc?: string | null
  isActive: boolean
  accessLevelNames: string[]
  department?: { id: string; name: string } | null
  primaryFaceId?: string | null
  cardsCount: number
  facesCount: number
  fingerprintsCount: number
  irisesCount: number
  /** Номер QR-пропуска; без него билет строить не из чего. */
  qrCardNo?: string | null
}

interface DepartmentTreeItem {
  id: string
  name: string
  parentId?: string | null
  companyId?: string | null
}

type TabType = 'employees' | 'residents' | 'visitors'

/** Жильцы приходят с того же эндпоинта, что и работники, — разделяет их параметр kind. */
const TAB_KIND: Record<'employees' | 'residents', string> = { employees: 'employee', residents: 'resident' }

/** Порядок вкладок: в ЖКХ первыми идут жильцы, в остальных модулях их нет вовсе. */
const TAB_ORDER = (isHousing: boolean): TabType[] =>
  isHousing ? ['residents', 'employees', 'visitors'] : ['employees', 'visitors']

export function PeopleManagementPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const { token } = useAuth()
  const { startLoading, stopLoading } = useLoading()
  const { activeModule } = useModule()
  // Жильцы живут только в модуле ЖКХ: в Workforce их вкладки нет вовсе.
  const isHousing = activeModule === 'housing'
  const [selectedTab, setTab] = useState<TabType | null>(null)
  // Модуль могли переключить, пока открыта вкладка «Жильцы».
  // Пока пользователь не выбрал вкладку сам, показываем главную для модуля:
  // в ЖКХ это жильцы, в остальных — работники.
  const defaultTab: TabType = isHousing ? 'residents' : 'employees'
  const tab: TabType = selectedTab === null || (!isHousing && selectedTab === 'residents')
    ? defaultTab
    : selectedTab
  const [statusFilterEmployees, setStatusFilterEmployees] = useState({ active: true, dismissed: false })
  const [statusFilterVisitors, setStatusFilterVisitors] = useState({ active: true, blocked: false })
  const [employees, setEmployees] = useState<EmployeeResponse[]>([])
  const [residents, setResidents] = useState<EmployeeResponse[]>([])
  const [visitors, setVisitors] = useState<VisitorResponse[]>([])
  // Название организации попадает в шапку пропуска-билета. Не критично: если
  // настройка не задана или запрос не прошёл, билет печатается без неё.
  const [companyName, setCompanyName] = useState<string | null>(null)
  const [departments, setDepartments] = useState<DepartmentTreeItem[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [deptFilter, setDeptFilter] = useState<string>('')
  const [currentPage, setCurrentPage] = useState(1)
  const PAGE_SIZE = 20
  const [error, setError] = useState<string | null>(null)
  const [syncWarning, setSyncWarning] = useState<string | null>(null)
  const [companyMode, setCompanyMode] = useState<'None' | 'Single' | 'Multiple'>('None')
  const [importModalOpen, setImportModalOpen] = useState(false)
  const [devices, setDevices] = useState<{ id: string; name: string; ipAddress: string }[]>([])
  const [importSelectedDeviceIds, setImportSelectedDeviceIds] = useState<string[]>([])
  const [importCompanyId, setImportCompanyId] = useState<string | null>(null)
  const [importCompanies, setImportCompanies] = useState<{ id: string; name: string }[]>([])
  const [importCompanyMode, setImportCompanyMode] = useState<'Single' | 'Multiple' | 'None'>('None')
  const [importLoading, setImportLoading] = useState(false)
  const [importResult, setImportResult] = useState<{
    importedCount: number
    skippedCount: number
    errorCount: number
    items: {
      employeeNo: string
      name: string
      deviceName: string
      success: boolean
      message?: string
      cardsImported?: number
      facesImported?: number
      fingerprintsImported?: number
      irisesImported?: number
    }[]
  } | null>(null)

  const loadEmployees = useCallback(async () => {
    if (!token) return
    setError(null)
    try {
      const params = new URLSearchParams()
      if (searchQuery.trim()) params.set('search', searchQuery.trim())
      params.set('kind', TAB_KIND.employees)
      const list = await apiRequest<EmployeeResponse[]>(`/api/employees?${params}`, { token })
      setEmployees(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('people.errors.loadEmployees'))
    }
  }, [token, searchQuery, t])

  /** Жильцы есть только в режиме ЖКХ — в режиме компании запрос не шлём вовсе. */
  const loadResidents = useCallback(async () => {
    if (!token || !isHousing) { setResidents([]); return }
    setError(null)
    try {
      const params = new URLSearchParams()
      if (searchQuery.trim()) params.set('search', searchQuery.trim())
      params.set('kind', TAB_KIND.residents)
      const list = await apiRequest<EmployeeResponse[]>(`/api/employees?${params}`, { token })
      setResidents(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('people.errors.loadResidents'))
    }
  }, [token, searchQuery, isHousing, t])

  const loadVisitors = useCallback(async () => {
    if (!token) return
    setError(null)
    try {
      const params = new URLSearchParams()
      if (searchQuery.trim()) params.set('search', searchQuery.trim())
      const list = await apiRequest<VisitorResponse[]>(`/api/visitors?${params}`, { token })
      setVisitors(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('people.errors.loadVisitors'))
    }
  }, [token, searchQuery, t])

  // Название организации для шапки пропуска. Ошибку глотаем: билет без неё
  // остаётся валидным, а список гостей из-за настройки падать не должен.
  useEffect(() => {
    if (!token) return
    apiRequest<{ key: string; value: string }>('/api/system-settings/CompanyName', { token })
      .then((s) => setCompanyName(s?.value?.trim() || null))
      .catch(() => setCompanyName(null))
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

  // Отделы нужны списку для фильтра; режим компаний — чтобы знать, показывать ли их.
  useEffect(() => {
    loadCompanyMode()
    loadDepartments()
  }, [loadCompanyMode, loadDepartments])

  useEffect(() => {
    if (!token) return
    startLoading()
    // Always load all groups on initial or tab change to keep stats accurate
    Promise.all([
      loadEmployees(),
      loadResidents(),
      loadVisitors()
    ]).finally(stopLoading)
  }, [token, loadEmployees, loadResidents, loadVisitors, startLoading, stopLoading])

  useEffect(() => {
    const state = location.state as { syncWarning?: string; syncError?: string }
    const msg = state?.syncWarning ?? state?.syncError
    if (msg) {
      setSyncWarning(msg)
      navigate(location.pathname, { replace: true, state: {} })
    }
  }, [location.state, location.pathname, navigate])

  const activeCount = useMemo(() => {
    return employees.filter((e) => e.isActive).length
      + residents.filter((r) => r.isActive).length
      + visitors.filter((v) => v.isActive).length
  }, [employees, residents, visitors])

  // Добавление вынесено на отдельную страницу /people/new/:type
  // Вид берём из активной вкладки: с вкладки «Жильцы» заводится жилец.
  function openCreatePage() {
    navigate(`/people/new/${tab === 'employees' ? 'employee' : tab === 'residents' ? 'resident' : 'visitor'}`)
  }

  async function openImportModal() {
    if (!token) return
    setImportModalOpen(true)
    setImportResult(null)
    setImportSelectedDeviceIds([])
    setError(null)
    try {
      const [devicesList, companiesList, modeSetting] = await Promise.all([
        apiRequest<{ id: string; name: string; ipAddress: string }[]>('/api/devices', { token }),
        apiRequest<{ id: string; name: string }[]>('/api/companies', { token }),
        apiRequest<{ key: string; value: string }>('/api/system-settings/CompanyMode', { token }).catch(() => ({ value: 'None' }))
      ])
      setDevices(devicesList)
      setImportCompanies(companiesList)
      const mode = (modeSetting?.value as 'Single' | 'Multiple' | 'None') || 'None'
      setImportCompanyMode(mode)
      if (companiesList.length > 0) {
        setImportCompanyId(companiesList[0].id)
      } else {
        setImportCompanyId(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('people.errors.loadDevices'))
    }
  }

  const closeImportModal = () => {
    setImportModalOpen(false)
    setImportResult(null)
    setImportSelectedDeviceIds([])
    setImportCompanyId(null)
    setImportCompanies([])
    setDevices([])
  }

  const toggleImportDevice = (id: string) => {
    setImportSelectedDeviceIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

  const selectAllImportDevices = () => {
    setImportSelectedDeviceIds(devices.map((d) => d.id))
  }

  async function runImport() {
    if (!token || importSelectedDeviceIds.length === 0) return
    setImportLoading(true)
    setImportResult(null)
    setError(null)
    try {
      const res = await apiRequest<{
        importedCount: number
        skippedCount: number
        errorCount: number
        items: {
          employeeNo: string
          name: string
          deviceName: string
          success: boolean
          message?: string
          cardsImported?: number
          facesImported?: number
          fingerprintsImported?: number
          irisesImported?: number
        }[]
      }>('/api/people/import-from-devices', {
        method: 'POST',
        token,
        body: JSON.stringify({
          deviceIds: importSelectedDeviceIds,
          companyId: importCompanyId || undefined,
        }),
      })
      setImportResult(res)
      await Promise.all([loadEmployees(), loadResidents(), loadVisitors()])
    } catch (e) {
      setError(e instanceof Error ? e.message : t('people.errors.importFailed'))
    } finally {
      setImportLoading(false)
    }
  }

  useEffect(() => { setCurrentPage(1) }, [tab, searchQuery, deptFilter, statusFilterEmployees, statusFilterVisitors])


  const filteredList = useMemo(() => {
    // Жилец в маршрутах — тот же 'employee': карточка, биометрия и запись на
    // устройства у него общие с работником, разделение живёт только в вкладках.
    const raw = tab === 'employees'
      ? employees.map(e => ({ ...e, type: 'employee' as const }))
      : tab === 'residents'
        ? residents.map(r => ({ ...r, type: 'employee' as const }))
        : visitors.map(v => ({ ...v, type: 'visitor' as const }))
    let result = tab === 'visitors'
      ? raw.filter((item) => {
          if (item.isActive && statusFilterVisitors.active) return true
          if (!item.isActive && statusFilterVisitors.blocked) return true
          return false
        })
      : raw.filter((item) => {
          if (item.isActive && statusFilterEmployees.active) return true
          if (!item.isActive && statusFilterEmployees.dismissed) return true
          return false
        })
    if (deptFilter) {
      result = result.filter(item => item.department?.id === deptFilter)
    }
    return result
  }, [tab, employees, residents, visitors, statusFilterEmployees, statusFilterVisitors, deptFilter])

  const totalPages = Math.max(1, Math.ceil(filteredList.length / PAGE_SIZE))

  const list = useMemo(
    () => filteredList.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filteredList, currentPage, PAGE_SIZE]
  )

  return (
    <AppLayout onAction={openCreatePage}>
      <div className="flex-1 overflow-y-auto bg-background-light pb-20 md:pb-0">
        <div className="p-6 md:p-8 space-y-6">
          <PageHeader
            className="hidden md:flex"
            title={t(isHousing ? 'people.titleHousing' : 'people.title')}
            description={t(isHousing ? 'people.descriptionHousing' : 'people.description')}
            actions={
              <div className="flex gap-2">
                <Button variant="outline" icon="upload" size="md" onClick={openImportModal} className="shadow-sm">
                  {t('common.import')}
                </Button>
                <Button icon="person_add" size="md" onClick={openCreatePage} className="shadow-md">
                  {t('people.addPeople')}
                </Button>
              </div>
            }
          />

          {error && (
            <div className="p-4 bg-error-bg text-error-text rounded-xl text-xs font-bold shadow-sm max-h-40 overflow-y-auto whitespace-pre-wrap">
              {error}
            </div>
          )}
          {syncWarning && (
            <div className="p-4 bg-amber-50 text-amber-800 rounded-xl text-xs font-bold shadow-sm max-h-40 overflow-y-auto border border-amber-200 whitespace-pre-wrap flex items-start gap-2">
              <span className="material-symbols-outlined text-base shrink-0">warning</span>
              {syncWarning}
            </div>
          )}

          {/* Top Stats Tier */}
          <div className="grid grid-cols-3 gap-3 md:grid-cols-4 lg:grid-cols-6">
            <div className="bg-surface p-4 rounded-2xl shadow-md flex flex-col items-center md:items-start text-center md:text-left">
              <p className="text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('common.active')}</p>
              <p className="text-2xl font-black text-primary leading-none">{activeCount}</p>
            </div>
            <div className="bg-surface p-4 rounded-2xl shadow-md flex flex-col items-center md:items-start text-center md:text-left">
              <p className="text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('people.employees')}</p>
              <p className="text-2xl font-black text-primary leading-none">{employees.length}</p>
            </div>
            {isHousing && (
              <div className="bg-surface p-4 rounded-2xl shadow-md flex flex-col items-center md:items-start text-center md:text-left">
                <p className="text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('people.residents')}</p>
                <p className="text-2xl font-black text-primary leading-none">{residents.length}</p>
              </div>
            )}
            <div className="bg-surface p-4 rounded-2xl shadow-md flex flex-col items-center md:items-start text-center md:text-left">
              <p className="text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('people.visitors')}</p>
              <p className="text-2xl font-black text-primary leading-none">{visitors.length}</p>
            </div>
          </div>

          <div className="flex flex-col md:flex-row gap-4 md:items-center justify-between">
            <div className="relative flex-1 max-w-md">
              <Input
                placeholder={tab === 'employees' ? t('people.searchEmployees') : tab === 'residents' ? t('people.searchResidents') : t('people.searchVisitors')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                icon="search"
                className="bg-white shadow-sm"
              />
            </div>
            <div className="flex md:hidden gap-2">
              <Button fullWidth variant="outline" icon="upload" size="sm" onClick={openImportModal} className="shadow-sm">{t('common.import')}</Button>
            </div>
          </div>

          {/* Department filter — у жильца отдела нет, фильтр обнулил бы список. */}
          {tab !== 'residents' && departments.length > 0 && (
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-black text-text-light uppercase tracking-widest shrink-0">{t('people.departmentLabel')}</span>
              <select
                value={deptFilter}
                onChange={e => setDeptFilter(e.target.value)}
                className="text-xs font-bold text-text-dark bg-surface border border-border-light rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 shadow-sm min-w-[160px]"
              >
                <option value="">{t('people.allDepartments')}</option>
                {departments.map(d => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Status filter */}
          <div className="flex flex-wrap items-center gap-4">
            <span className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('people.statusLabel')}</span>
            {tab !== 'visitors' ? (
              <>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={statusFilterEmployees.active}
                    onChange={(e) => setStatusFilterEmployees((p) => ({ ...p, active: e.target.checked }))}
                    className="rounded border-border-light text-primary focus:ring-primary"
                  />
                  <span className="text-sm font-bold text-text-dark">{t('common.active')}</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={statusFilterEmployees.dismissed}
                    onChange={(e) => setStatusFilterEmployees((p) => ({ ...p, dismissed: e.target.checked }))}
                    className="rounded border-border-light text-primary focus:ring-primary"
                  />
                  <span className="text-sm font-bold text-text-dark">{t('people.terminated')}</span>
                </label>
              </>
            ) : (
              <>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={statusFilterVisitors.active}
                    onChange={(e) => setStatusFilterVisitors((p) => ({ ...p, active: e.target.checked }))}
                    className="rounded border-border-light text-primary focus:ring-primary"
                  />
                  <span className="text-sm font-bold text-text-dark">{t('common.active')}</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={statusFilterVisitors.blocked}
                    onChange={(e) => setStatusFilterVisitors((p) => ({ ...p, blocked: e.target.checked }))}
                    className="rounded border-border-light text-primary focus:ring-primary"
                  />
                  <span className="text-sm font-bold text-text-dark">{t('people.blocked')}</span>
                </label>
              </>
            )}
          </div>

          {/* Tabs. Вкладка жильцов есть только в модуле ЖКХ и стоит там первой:
              жильцов в доме больше, чем работников МТК. */}
          <div className="flex overflow-x-auto no-scrollbar gap-8 border-b border-border-light">
            {TAB_ORDER(isHousing).map((key) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`pb-2.5 text-xs font-black uppercase tracking-widest border-b-2 transition-colors ${tab === key ? 'border-primary text-primary' : 'border-transparent text-text-light'
                  }`}
              >
                {t(`people.${key}`)}
              </button>
            ))}
          </div>

          {/* List Layout */}
          <div className="space-y-3">
            {filteredList.length === 0 ? (
              <div className="py-20 text-center bg-surface rounded-2xl shadow-md">
                <span className="material-symbols-outlined text-text-light text-5xl mb-3">person_search</span>
                <p className="text-sm font-bold text-text-muted uppercase tracking-widest">{t('people.noPeopleFound')}</p>
              </div>
            ) : (
              list.map((item) => {
                const initials = (item.firstName?.[0] || '') + (item.lastName?.[0] || '')
                const credLine = t('people.credLine', {
                  cards: item.cardsCount,
                  faces: item.facesCount,
                  fingerprints: item.fingerprintsCount,
                  irises: item.irisesCount ?? 0,
                })
                const address = [
                  'housingBlockName' in item && item.housingBlockName ? item.housingBlockName : null,
                  'apartment' in item && item.apartment ? t('people.apartmentShort', { value: item.apartment }) : null,
                ].filter(Boolean).join(' · ')
                const subtitle =
                  tab === 'residents'
                    ? (address ? `${address} · ${credLine}` : credLine)
                    : item.type === 'employee'
                    ? credLine
                    : t('people.validSubtitle', {
                        from: item.validFromUtc?.slice(0, 10) || '—',
                        to: item.validToUtc?.slice(0, 10) || '—',
                        creds: credLine,
                      })

                return (
                  <div
                    key={item.id}
                    onClick={() => navigate(`/people/${item.type}/${item.id}`)}
                    className="flex items-center justify-between p-4 bg-surface rounded-2xl shadow-md hover:shadow-xl active:scale-[0.99] transition-all cursor-pointer group"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 shrink-0 rounded-2xl overflow-hidden bg-primary/10 flex items-center justify-center">
                        {item.primaryFaceId ? (
                          <FaceThumbnail faceId={item.primaryFaceId} token={token} className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-primary font-black text-sm uppercase">{initials || '?'}</span>
                        )}
                      </div>
                      <div>
                        <h4 className="text-base font-black text-text-dark leading-tight">{item.firstName} {item.lastName}</h4>
                        <p className="text-[10px] font-bold text-text-light uppercase tracking-widest mt-1">
                          {subtitle}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {/* Пропуск-билет: скачать или отправить гостю. Показываем
                          только когда у гостя выдан QR-пропуск. */}
                      {item.type === 'visitor' && item.qrCardNo && (
                        <VisitorPassActions
                          cardNo={item.qrCardNo}
                          fullName={`${item.firstName} ${item.lastName}`.trim()}
                          companyName={companyName}
                          department={item.department?.name}
                          accessLevels={item.accessLevelNames}
                          documentNumber={item.documentNumber}
                          validFromUtc={item.validFromUtc}
                          validToUtc={item.validToUtc}
                        />
                      )}
                      <Badge variant={item.isActive ? 'success' : 'neutral'}>
                        {item.type === 'employee' ? (item.isActive ? t('common.active') : t('people.terminated')) : (item.isActive ? t('common.active') : t('people.blocked'))}
                      </Badge>
                      <span className="material-symbols-outlined text-text-light group-hover:text-text-muted transition-colors">chevron_right</span>
                    </div>
                  </div>
                )
              })
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <span className="text-xs text-text-muted font-bold">
                {t('people.pageOf', { page: currentPage, total: totalPages, count: filteredList.length })}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="w-8 h-8 flex items-center justify-center rounded-xl bg-surface shadow text-text-muted hover:text-primary disabled:opacity-30 transition-colors"
                >
                  <span className="material-symbols-outlined text-base">chevron_left</span>
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter(p => p === 1 || p === totalPages || Math.abs(p - currentPage) <= 2)
                  .reduce<(number | '...')[]>((acc, p, idx, arr) => {
                    if (idx > 0 && (arr[idx - 1] as number) < p - 1) acc.push('...')
                    acc.push(p)
                    return acc
                  }, [])
                  .map((p, idx) =>
                    p === '...' ? (
                      <span key={`ellipsis-${idx}`} className="w-8 h-8 flex items-center justify-center text-xs text-text-muted">…</span>
                    ) : (
                      <button
                        key={p}
                        onClick={() => setCurrentPage(p as number)}
                        className={`w-8 h-8 flex items-center justify-center rounded-xl text-xs font-black transition-colors ${currentPage === p ? 'bg-primary text-white shadow' : 'bg-surface text-text-muted hover:text-primary shadow'}`}
                      >
                        {p}
                      </button>
                    )
                  )
                }
                <button
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="w-8 h-8 flex items-center justify-center rounded-xl bg-surface shadow text-text-muted hover:text-primary disabled:opacity-30 transition-colors"
                >
                  <span className="material-symbols-outlined text-base">chevron_right</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      <Modal
        isOpen={importModalOpen}
        title={t('people.importFromDevices')}
        onClose={closeImportModal}
      >
        <div className="space-y-4">
          {!importResult ? (
            <>
              {importCompanies.length > 0 && (
                <div>
                  <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-2">{t('people.company')}</label>
                  {importCompanyMode === 'Single' ? (
                    <div className="px-4 py-3 bg-slate-50 rounded-xl text-sm font-bold text-text-dark border border-divider-light">
                      {importCompanies.find((c) => c.id === importCompanyId)?.name ?? importCompanies[0]?.name}
                    </div>
                  ) : (
                    <select
                      className="w-full bg-surface border border-divider-light rounded-xl h-12 px-4 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                      value={importCompanyId ?? ''}
                      onChange={(e) => setImportCompanyId(e.target.value || null)}
                    >
                      {importCompanies.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  )}
                </div>
              )}
              <p className="text-sm text-text-muted">{t('people.selectDevicesToImport')}</p>
              <div className="max-h-64 overflow-y-auto space-y-2 border border-border-light rounded-xl p-2">
                {devices.map((d) => (
                  <label key={d.id} className="flex items-center gap-3 p-3 rounded-xl hover:bg-slate-50 cursor-pointer border border-transparent transition-all">
                    <input
                      type="checkbox"
                      checked={importSelectedDeviceIds.includes(d.id)}
                      onChange={() => toggleImportDevice(d.id)}
                      className="rounded border-border-light text-primary focus:ring-primary"
                    />
                    <div>
                      <p className="text-sm font-bold text-text-dark">{d.name}</p>
                      <p className="text-xs text-text-light">{d.ipAddress}</p>
                    </div>
                  </label>
                ))}
              </div>
              <div className="flex justify-between items-center pt-2">
                <button type="button" onClick={selectAllImportDevices} className="text-xs font-bold text-primary hover:underline">{t('common.selectAll')}</button>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={closeImportModal}>{t('common.cancel')}</Button>
                  <Button onClick={runImport} disabled={importLoading || importSelectedDeviceIds.length === 0} isLoading={importLoading}>{t('common.import')}</Button>
                </div>
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-2">
                <div className="text-center p-3 bg-slate-50 rounded-xl">
                  <p className="text-[10px] font-black text-text-light uppercase">{t('people.imported')}</p>
                  <p className="text-xl font-black text-success-text">{importResult.importedCount}</p>
                </div>
                <div className="text-center p-3 bg-slate-50 rounded-xl">
                  <p className="text-[10px] font-black text-text-light uppercase">{t('people.skipped')}</p>
                  <p className="text-xl font-black text-text-muted">{importResult.skippedCount}</p>
                </div>
                <div className="text-center p-3 bg-slate-50 rounded-xl">
                  <p className="text-[10px] font-black text-text-light uppercase">{t('people.errors_label')}</p>
                  <p className="text-xl font-black text-error-text">{importResult.errorCount}</p>
                </div>
              </div>
              {(() => {
                const cred = importResult.items.reduce(
                  (a, i) => ({
                    cards: a.cards + (i.cardsImported ?? 0),
                    faces: a.faces + (i.facesImported ?? 0),
                    fps: a.fps + (i.fingerprintsImported ?? 0),
                    ir: a.ir + (i.irisesImported ?? 0),
                  }),
                  { cards: 0, faces: 0, fps: 0, ir: 0 }
                )
                if (cred.cards + cred.faces + cred.fps + cred.ir === 0) return null
                return (
                  <p className="text-xs text-text-muted text-center">
                    {t('people.pulledFromDevices', { cards: cred.cards, faces: cred.faces, fingerprints: cred.fps, irises: cred.ir })}
                  </p>
                )
              })()}
              <Button fullWidth variant="outline" onClick={closeImportModal}>{t('common.close')}</Button>
            </div>
          )}
        </div>
      </Modal>

    </AppLayout>
  )
}
