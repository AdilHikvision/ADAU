import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AppLayout } from '../components/templates'
import { Button, Spinner } from '../components/atoms'
import { PageHeader, Modal } from '../components/organisms'
import { Pagination, usePageReset, pageSlice } from '../components/molecules'
import { apiRequest } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { useModule } from '../context/ModuleContext'
import { loadHousingBlocks, type HousingBlockItem } from './housingBlocks'

/* ═══════════════════════════════════════════════════════════════
   Записи аутентификации — сырые проходы с устройств за один день.
   Показываются только люди, заведённые в базе: сервер джоинит
   device_auth_logs с карточками по табельному номеру.
   Модуль ЖКХ добавляет к работникам жильцов (переключатель в окне
   выбора); в Workforce выбираются только работники.
   ═══════════════════════════════════════════════════════════════ */

type PersonKind = 'employee' | 'resident'

interface PersonItem {
  id: string
  firstName: string
  lastName: string
  employeeNo: string | null
  apartment?: string | null
  housingBlockId?: string | null
  housingBlockName?: string | null
  department?: { id: string; name: string } | null
}

/** Отдел или блок ЖКХ: окно выбора работает с ними одинаково. */
interface GroupNode {
  id: string
  name: string
  parentId?: string | null
  sortOrder: number
}

interface AuthRecord {
  id: string
  personId: string
  firstName: string
  lastName: string
  employeeNo: string | null
  eventTimeUtc: string
  deviceId: string | null
  deviceName: string | null
}

/** Сегодня в локальной зоне (не UTC — иначе после 20:00 в Баку открывался бы завтрашний день). */
function todayLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

/** С секундами: за минуту у одного человека бывает несколько аутентификаций. */
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

/** Узел вместе со всеми потомками — выбрав корпус/отдел, видим и вложенные. */
function descendantsOf(nodes: { id: string; parentId?: string | null }[], rootId: string): Set<string> {
  const set = new Set<string>([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const n of nodes) {
      if (n.parentId && set.has(n.parentId) && !set.has(n.id)) {
        set.add(n.id)
        grew = true
      }
    }
  }
  return set
}

/** Список id → стабильная строка для запроса и ключей: порядок выбора на результат не влияет. */
function idsParam(ids: string[]): string {
  return [...ids].sort().join(',')
}

export function AuthenticationRecordsPage() {
  const { t } = useTranslation()
  const { token } = useAuth()
  const { activeModule } = useModule()
  // Жильцы есть только в ЖКХ — в Workforce переключатель не показываем.
  const housingModule = activeModule === 'housing'

  const [kind, setKind] = useState<PersonKind>('employee')
  const [date, setDate] = useState<string>(todayLocal)
  const [personId, setPersonId] = useState('')
  // Отделы и блоки ЖКХ — мультивыбор: фильтр складывается из нескольких групп.
  const [deptIds, setDeptIds] = useState<string[]>([])
  const [blockIds, setBlockIds] = useState<string[]>([])
  const deptParam = useMemo(() => idsParam(deptIds), [deptIds])
  const blockParam = useMemo(() => idsParam(blockIds), [blockIds])

  const [people, setPeople] = useState<PersonItem[]>([])
  const [deptTree, setDeptTree] = useState<GroupNode[]>([])
  const [blocks, setBlocks] = useState<HousingBlockItem[]>([])

  const [records, setRecords] = useState<AuthRecord[]>([])
  // Проходов за день бывают тысячи — режем на страницы; смена фильтров возвращает на первую.
  const [page, setPage] = usePageReset(`${kind}|${date}|${personId}|${deptParam}|${blockParam}`)
  const [error, setError] = useState<string | null>(null)
  // Кнопка «Обновить» перезапрашивает те же фильтры — меняем счётчик, а не состояние загрузки.
  const [reloadTick, setReloadTick] = useState(0)
  const [loadedKey, setLoadedKey] = useState<string | null>(null)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerGroupId, setPickerGroupId] = useState<string | null>(null)
  const [groupSearch, setGroupSearch] = useState('')
  const [personSearch, setPersonSearch] = useState('')

  // Списки людей и структура: справочники для окна выбора.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    void apiRequest<PersonItem[]>(`/api/employees?kind=${kind}`, { token })
      .then((list) => { if (!cancelled) setPeople(list) })
      .catch(() => { if (!cancelled) setPeople([]) })
    return () => { cancelled = true }
  }, [token, kind])

  useEffect(() => {
    if (!token) return
    let cancelled = false
    void apiRequest<GroupNode[]>('/api/departments/tree', { token })
      .then((list) => { if (!cancelled) setDeptTree(list) })
      .catch(() => { if (!cancelled) setDeptTree([]) })
    return () => { cancelled = true }
  }, [token])

  useEffect(() => {
    if (!token || !housingModule) return
    let cancelled = false
    void loadHousingBlocks(token)
      .then((list) => { if (!cancelled) setBlocks(list) })
      .catch(() => { if (!cancelled) setBlocks([]) })
    return () => { cancelled = true }
  }, [token, housingModule])

  // Показанные данные отстают от фильтров ровно пока идёт запрос — отдельный
  // флаг загрузки не нужен (и не заставляет эффект синхронно менять state).
  const requestKey = [date, kind, personId, deptParam, blockParam, reloadTick].join('|')
  const loading = loadedKey !== requestKey

  useEffect(() => {
    if (!token) return
    let cancelled = false
    const params = new URLSearchParams({ date, kind })
    // Человек важнее отделов/блоков: выбрано что-то одно.
    if (personId) params.set('employeeId', personId)
    else if (deptParam) params.set('departmentIds', deptParam)
    else if (blockParam) params.set('housingBlockIds', blockParam)
    void apiRequest<AuthRecord[]>(`/api/authentication-records?${params}`, { token })
      .then((list) => {
        if (cancelled) return
        setRecords(list)
        setError(null)
        setLoadedKey(requestKey)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setRecords([])
        setError(err instanceof Error ? err.message : String(err))
        setLoadedKey(requestKey)
      })
    return () => { cancelled = true }
  }, [token, date, kind, personId, deptParam, blockParam, requestKey])

  const residents = kind === 'resident'
  // Окно выбора одинаково работает с отделами и блоками ЖКХ — отличается только источник.
  const groupNodes: GroupNode[] = residents ? blocks : deptTree
  const selectedGroupIds = residents ? blockIds : deptIds
  /** Имена выбранных групп в порядке дерева — для подписи кнопки фильтра. */
  const selectedGroupNames = (): string[] =>
    groupNodes.filter((n) => selectedGroupIds.includes(n.id)).map((n) => n.name)

  const switchKind = (next: PersonKind) => {
    if (next === kind) return
    setKind(next)
    setPersonId('')
    setDeptIds([])
    setBlockIds([])
    setPickerGroupId(null)
    setGroupSearch('')
    setPersonSearch('')
  }

  const openPicker = () => {
    setPickerGroupId(null)
    setGroupSearch('')
    setPersonSearch('')
    setPickerOpen(true)
  }

  const pickPerson = (id: string) => {
    setPersonId(id)
    setDeptIds([])
    setBlockIds([])
    setPickerOpen(false)
  }

  const clearSelection = () => { setPersonId(''); setDeptIds([]); setBlockIds([]) }

  // Группы накапливаются — окно не закрывается, чтобы можно было отметить несколько.
  const toggleGroup = (id: string) => {
    setPersonId('')
    const applyToggle = (prev: string[]) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    if (residents) setBlockIds(applyToggle)
    else setDeptIds(applyToggle)
  }

  const selectionLabel = (): string => {
    const person = people.find((p) => p.id === personId)
    if (person) return `${person.firstName} ${person.lastName}`
    const names = selectedGroupNames()
    if (names.length === 1) return `${names[0]} · ${t(residents ? 'authRecords.wholeBlock' : 'workHours.wholeDept')}`
    // Много групп — два первых имени и счётчик остальных, иначе кнопка расползается.
    if (names.length > 1) return names.length === 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`
    return residents ? t('authRecords.allResidents') : t('workHours.allEmployees')
  }

  // Список в правой колонке окна выбора: сузили группой слева + строкой поиска.
  const groupScope = pickerGroupId ? descendantsOf(groupNodes, pickerGroupId) : null
  const personQuery = personSearch.trim().toLowerCase()
  const pickerPeople = people.filter((p) => {
    if (groupScope) {
      const groupId = residents ? p.housingBlockId : p.department?.id
      if (!groupId || !groupScope.has(groupId)) return false
    }
    if (!personQuery) return true
    const haystack = [`${p.firstName} ${p.lastName}`, p.employeeNo ?? '', p.apartment ?? ''].join(' ').toLowerCase()
    return haystack.includes(personQuery)
  })

  const groupQuery = groupSearch.trim().toLowerCase()
  const groupBtnCls = (active: boolean) =>
    `w-full text-left px-3 py-2 rounded-lg text-sm font-bold transition-colors ${active ? 'bg-primary text-white' : 'text-text-dark hover:bg-background-light'}`

  // Строка группы: чекбокс — выбор в фильтр, имя — переход к списку её людей.
  const groupRow = (n: GroupNode, depth: number): ReactNode => {
    const checked = selectedGroupIds.includes(n.id)
    const browsing = pickerGroupId === n.id
    return (
      <div
        key={n.id}
        className={`flex items-center gap-2 rounded-lg pr-2 transition-colors ${browsing ? 'bg-primary/10' : 'hover:bg-background-light'}`}
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={() => toggleGroup(n.id)}
          aria-label={n.name}
          className="h-4 w-4 shrink-0 accent-primary cursor-pointer"
        />
        <button
          type="button"
          onClick={() => setPickerGroupId(n.id)}
          className={`flex-1 min-w-0 text-left py-2 text-sm font-bold truncate ${checked || browsing ? 'text-primary' : 'text-text-dark'}`}
        >
          {n.name}
        </button>
      </div>
    )
  }

  const renderGroupTree = (parentId: string | null, depth: number): ReactNode[] =>
    groupNodes
      .filter((n) => (n.parentId ?? null) === parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .flatMap((n) => [groupRow(n, depth), ...renderGroupTree(n.id, depth + 1)])

  return (
    <AppLayout onAction={() => {}}>
      <div className="flex-1 overflow-y-auto bg-background-light pb-20 md:pb-0">
        <div className="p-6 md:p-10 space-y-6">

          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 animate-in slide-in-from-top-4 duration-500">
            <PageHeader
              className="p-0 border-none shadow-none bg-transparent"
              title={t('authRecords.pageTitle')}
              description={t('authRecords.pageDescription')}
            />
          </div>

          {/* Filters */}
          <div className="bg-surface rounded-2xl p-5 shadow-sm flex flex-wrap gap-4 items-end">
            <div className="space-y-1 flex-1 min-w-[160px]">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('authRecords.person')}</label>
              <button
                type="button"
                onClick={openPicker}
                className="w-full rounded-xl bg-background-light border-none px-3 py-2 text-sm font-bold text-text-dark text-left focus:ring-2 focus:ring-primary/20 outline-none flex items-center justify-between gap-2"
              >
                <span className="truncate">{selectionLabel()}</span>
                <span className="material-symbols-outlined text-base text-text-light shrink-0">expand_more</span>
              </button>
              {/* Выбранные группы — чипами: виден весь список и можно снять по одной. */}
              {!personId && selectedGroupIds.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {selectedGroupIds.map((id) => {
                    const node = groupNodes.find((n) => n.id === id)
                    if (!node) return null
                    return (
                      <span key={id} className="inline-flex items-center gap-1 rounded-lg bg-primary/10 pl-2 pr-1 py-0.5 text-[11px] font-bold text-primary">
                        <span className="truncate max-w-[140px]">{node.name}</span>
                        <button
                          type="button"
                          aria-label={t('authRecords.removeFromSelection', { name: node.name })}
                          onClick={() => toggleGroup(id)}
                          className="material-symbols-outlined text-[13px] leading-none hover:text-primary-dark"
                        >
                          close
                        </button>
                      </span>
                    )
                  })}
                  {selectedGroupIds.length > 1 && (
                    <button type="button" onClick={clearSelection} className="px-2 py-0.5 text-[11px] font-black uppercase tracking-wide text-text-light hover:text-primary">
                      {t('authRecords.clearSelection')}
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-1">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('common.date')}</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="rounded-xl bg-background-light border-none px-3 py-2 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
              />
            </div>

            <div className="flex items-end">
              <Button type="button" icon="refresh" variant="outline" disabled={loading} onClick={() => setReloadTick((n) => n + 1)}>
                {t('authRecords.refresh')}
              </Button>
            </div>
          </div>

          {/* Results */}
          <div className="bg-surface rounded-2xl shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-3">
              <p className="text-xs font-black text-text-light uppercase tracking-widest">
                {t('authRecords.recordsCount', { count: records.length })}
              </p>
              {!loading && !error && records.length > 0 && (
                <p className="text-[11px] font-bold text-text-light">{formatDate(`${date}T00:00:00`)}</p>
              )}
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Spinner />
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2 text-error-text">
                <span className="material-symbols-outlined text-4xl">error</span>
                <p className="text-sm font-semibold">{error}</p>
              </div>
            ) : records.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2 text-text-light">
                <span className="material-symbols-outlined text-4xl">fingerprint</span>
                <p className="text-sm">{t('authRecords.empty')}</p>
              </div>
            ) : (() => {
              const paged = pageSlice(records, page)
              return (
              <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] font-black text-text-light uppercase tracking-widest border-b border-border">
                      <th className="px-5 py-3 text-left">{t('authRecords.colName')}</th>
                      <th className="px-5 py-3 text-left">{t('authRecords.colDate')}</th>
                      <th className="px-5 py-3 text-left">{t('authRecords.colDevice')}</th>
                      <th className="px-5 py-3 text-left">{t('authRecords.colTime')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.rows.map((r) => (
                      <tr key={r.id} className="border-b border-border last:border-none hover:bg-background-light transition-colors">
                        <td className="px-5 py-3 font-bold text-text-dark">
                          {r.firstName} {r.lastName}
                          {r.employeeNo && <span className="ml-2 text-[10px] font-bold text-text-light">#{r.employeeNo}</span>}
                        </td>
                        <td className="px-5 py-3 font-mono text-text-dark">{formatDate(r.eventTimeUtc)}</td>
                        <td className="px-5 py-3 text-text-dark">{r.deviceName ?? <span className="text-text-light">—</span>}</td>
                        <td className="px-5 py-3 font-mono text-text-dark">{formatTime(r.eventTimeUtc)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination page={paged.page} totalPages={paged.totalPages} total={records.length} onPage={setPage} />
              </>
              )
            })()}
          </div>

          {/* Person picker: слева отделы (в ЖКХ — блоки), справа поиск и люди */}
          {pickerOpen && (
            <Modal isOpen title={t('authRecords.pickPersonTitle')} onClose={() => setPickerOpen(false)}>
              <div className="space-y-4">
                {housingModule && (
                  <div className="flex rounded-xl bg-background-light p-1 gap-1 w-fit">
                    {(['employee', 'resident'] as PersonKind[]).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => switchKind(k)}
                        className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition-colors ${kind === k ? 'bg-primary text-white' : 'text-text-light hover:text-text-dark'}`}
                      >
                        {t(k === 'resident' ? 'people.residents' : 'people.employees')}
                      </button>
                    ))}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Departments / housing blocks */}
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={groupSearch}
                      onChange={(e) => setGroupSearch(e.target.value)}
                      placeholder={t(residents ? 'authRecords.blockSearchPlaceholder' : 'workHours.deptSearchPlaceholder')}
                      className="w-full rounded-xl bg-background-light border-none px-3 py-2 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                    />
                    <p className="px-1 text-[10px] leading-snug text-text-light">
                      {t(residents ? 'authRecords.multiBlockHint' : 'authRecords.multiDeptHint')}
                    </p>
                    <div className="h-80 overflow-y-auto rounded-xl border border-border-light p-1 space-y-0.5">
                      <button
                        type="button"
                        onClick={() => { setPickerGroupId(null); clearSelection() }}
                        className={groupBtnCls(selectedGroupIds.length === 0 && !personId)}
                      >
                        {t(residents ? 'authRecords.allBlocks' : 'people.allDepartments')}
                      </button>
                      {groupQuery
                        ? groupNodes
                            .filter((n) => n.name.toLowerCase().includes(groupQuery))
                            .sort((a, b) => a.name.localeCompare(b.name))
                            .map((n) => groupRow(n, 0))
                        : renderGroupTree(null, 0)}
                    </div>
                  </div>

                  {/* People of the selected group */}
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={personSearch}
                      onChange={(e) => setPersonSearch(e.target.value)}
                      placeholder={t(residents ? 'authRecords.residentSearchPlaceholder' : 'workHours.empSearchPlaceholder')}
                      className="w-full rounded-xl bg-background-light border-none px-3 py-2 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                    />
                    <div className="h-80 overflow-y-auto rounded-xl border border-border-light p-1 space-y-0.5">
                      <button
                        type="button"
                        onClick={() => pickPerson('')}
                        className={`w-full text-left px-3 py-2 rounded-lg text-sm font-bold transition-colors ${!personId && selectedGroupIds.length === 0 ? 'bg-primary text-white' : 'text-text-dark hover:bg-background-light'}`}
                      >
                        {t(residents ? 'authRecords.allResidents' : 'workHours.allEmployees')}
                      </button>
                      {pickerGroupId && (() => {
                        const groupCount = people.filter((p) => {
                          const groupId = residents ? p.housingBlockId : p.department?.id
                          return groupId != null && groupScope!.has(groupId)
                        }).length
                        const checked = selectedGroupIds.includes(pickerGroupId)
                        const onLabel = residents ? 'authRecords.selectWholeBlock' : 'workHours.selectWholeDept'
                        const offLabel = residents ? 'authRecords.unselectWholeBlock' : 'workHours.unselectWholeDept'
                        return (
                          <button
                            type="button"
                            onClick={() => toggleGroup(pickerGroupId)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm font-bold transition-colors ${checked ? 'bg-primary text-white' : 'text-primary hover:bg-primary/10'}`}
                          >
                            <span className="flex items-center gap-2">
                              <span className="material-symbols-outlined text-base shrink-0">
                                {checked ? 'check_circle' : (residents ? 'school' : 'groups')}
                              </span>
                              <span className="truncate">
                                {checked ? t(offLabel) : t(onLabel, { count: groupCount })}
                              </span>
                            </span>
                          </button>
                        )
                      })()}
                      {pickerPeople.length === 0 ? (
                        <p className="px-3 py-4 text-xs text-text-light">
                          {t(residents ? 'authRecords.noResidentsInBlock' : 'workHours.noEmployeesInDept')}
                        </p>
                      ) : (
                        pickerPeople.map((p) => {
                          const active = personId === p.id
                          const subtitle = residents
                            ? [p.housingBlockName, p.apartment && `${t('authRecords.apartmentShort')} ${p.apartment}`].filter(Boolean).join(' · ')
                            : p.department?.name
                          return (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => pickPerson(p.id)}
                              className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${active ? 'bg-primary text-white' : 'hover:bg-background-light'}`}
                            >
                              <span className={`block text-sm font-bold truncate ${active ? 'text-white' : 'text-text-dark'}`}>{p.firstName} {p.lastName}</span>
                              {subtitle && <span className={`block text-[10px] truncate ${active ? 'text-white/80' : 'text-text-light'}`}>{subtitle}</span>}
                            </button>
                          )
                        })
                      )}
                    </div>
                  </div>
                </div>

                {/* Итог по группам + подтверждение: мультивыбор окно сам не закрывает. */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-light pt-3">
                  <p className="text-xs font-bold text-text-light">
                    {selectedGroupIds.length > 0
                      ? t('authRecords.selectedCount', { count: selectedGroupIds.length })
                      : t(residents ? 'authRecords.noBlocksSelected' : 'authRecords.noDeptsSelected')}
                  </p>
                  <div className="flex items-center gap-2">
                    {selectedGroupIds.length > 0 && (
                      <Button type="button" variant="outline" onClick={clearSelection}>{t('authRecords.clearSelection')}</Button>
                    )}
                    <Button type="button" onClick={() => setPickerOpen(false)}>{t('common.apply')}</Button>
                  </div>
                </div>
              </div>
            </Modal>
          )}

        </div>
      </div>
    </AppLayout>
  )
}
