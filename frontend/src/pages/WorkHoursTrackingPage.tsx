import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AppLayout } from '../components/templates'
import { Button, Input } from '../components/atoms'
import { PageHeader, Modal, PeoplePicker } from '../components/organisms'
import { Pagination, usePageReset, pageSlice, PAGE_SIZE } from '../components/molecules'
import { apiRequest } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { useModule } from '../context/ModuleContext'
import { useExportReport } from '../hooks/useExportReport'
import { loadHousingBlocks } from './housingBlocks'
import './monthly-hours.css'

/* ═══════════════════════════════════════════════════════════════
   MONTHLY HOURS tab — "Aylıq Tabel" (arkoz.html dizaynı birebir)
   SCOPED stil: monthly-hours.css (.wf-mh-root, wf-mh- prefiks).
   YALNIZ real backend datası (/api/reports/work-hours/monthly, projectx_dev).
   Mok/demo YOXDUR. "Tab. №" sütunu işçinin ExternalId-ni göstərir.
   ═══════════════════════════════════════════════════════════════ */
interface MhDayCell { hours: number; criterionKey: string }
interface MhEmp { no: string; externalId: string; fullname: string; position: string; department: string; days: Record<string, MhDayCell>; totalDays: string; totalHours: string; extraDays: string; extraHours: string }
// Cari ay (YYYY-MM) — tabel həmişə bu ayla açılır.
const MH_DEFAULT_MONTH = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') })()
interface MhApiResponse { month: string; employees: MhEmp[] }

/* ─── Davamiyyət kriteriyaları (attendance criteria, GET /api/attendance-criteria) ─── */
interface AttCriterion { key: string; label: string; letter: string; color: string; enabled: boolean; sortOrder: number; displayMode: string }
const MH_CRIT_DEFAULTS: AttCriterion[] = [
  { key: 'normal', label: 'Tam iş günü', letter: '', color: '#2E7D32', enabled: true, sortOrder: 0, displayMode: 'hours' },
  { key: 'undertime', label: 'Natamam iş günü', letter: 'N', color: '#E8A33D', enabled: true, sortOrder: 1, displayMode: 'hours' },
  { key: 'overtime', label: 'Əlavə iş', letter: '', color: '#2563EB', enabled: true, sortOrder: 2, displayMode: 'hours' },
  { key: 'late', label: 'Gecikmə', letter: '', color: '#EA6A47', enabled: true, sortOrder: 3, displayMode: 'hours' },
  { key: 'early_leave', label: 'Erkən çıxış', letter: '', color: '#8B5CF6', enabled: true, sortOrder: 4, displayMode: 'hours' },
  { key: 'dayoff', label: 'İstirahət günü', letter: 'İ', color: '#94A3B8', enabled: true, sortOrder: 5, displayMode: 'letter' },
  { key: 'onleave', label: 'Məzuniyyət', letter: 'M', color: '#6366F1', enabled: true, sortOrder: 6, displayMode: 'letter' },
  { key: 'absent', label: 'İşə çıxmayıb', letter: 'X', color: '#DC2626', enabled: true, sortOrder: 7, displayMode: 'letter' },
]
// Subtle tinted background from a #rrggbb hex (append alpha).
function mhTint(hex: string): string { return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex + '22' : 'transparent' }
// Hours without trailing .0 → 8, 7.5
function mhFmtHours(h: number): string { const n = Math.round(h * 100) / 100; return String(n) }

function mhDaysInMonth(ym: string): number { const p = ym.split('-'); return new Date(+p[0], +p[1], 0).getDate() }
function mhWeekend(ym: string, day: number): boolean { const p = ym.split('-'); const dow = new Date(+p[0], +p[1] - 1, day).getDay(); return dow === 0 || dow === 6 }
// Ay adı cari interfeys dilində (az/en/ru) — Intl vasitəsilə.
function mhMonthLabel(ym: string, lang: string): string {
  const p = ym.split('-')
  try {
    const s = new Date(+p[0], +p[1] - 1, 1).toLocaleDateString(lang, { month: 'long', year: 'numeric' })
    return s.charAt(0).toUpperCase() + s.slice(1)
  } catch { return ym }
}

// filterQuery — готовый фильтр людей страницы: kind плюс employeeId либо
// departmentIds (сотрудники) / housingBlockIds (студенты).
function MonthlyHoursTable({ month, filterQuery }: { month: string; filterQuery: string }) {
  const { t, i18n } = useTranslation()
  const { token } = useAuth()
  const mhMonth = month
  const [mhData, setMhData] = useState<MhEmp[]>([])
  const [mhLoading, setMhLoading] = useState(true)
  const [mhError, setMhError] = useState('')
  // Ay və ya filtr dəyişəndə səhifə birinciyə qayıdır.
  const [mhPage, setMhPage] = usePageReset(`${month}|${filterQuery}`)
  const [mhCrit, setMhCrit] = useState<AttCriterion[]>(() => {
    try { const c = localStorage.getItem('projectx.attCriteria'); if (c) { const p = JSON.parse(c); if (Array.isArray(p) && p.length) return p } } catch { /* noop */ }
    return MH_CRIT_DEFAULTS
  })

  // Davamiyyət kriteriyaları — bir dəfə çək, localStorage-a keşlə (grid rəng/hərf mənbəyi).
  useEffect(() => {
    let cancelled = false
    apiRequest<AttCriterion[]>('/api/attendance-criteria', { token })
      .then((res) => {
        if (cancelled || !Array.isArray(res) || !res.length) return
        setMhCrit(res)
        try { localStorage.setItem('projectx.attCriteria', JSON.stringify(res)) } catch { /* noop */ }
      })
      .catch(() => { /* defaults qalır */ })
    return () => { cancelled = true }
  }, [token])

  // Yalnız real backend datası (/api/reports/work-hours/monthly). Mok/demo YOXDUR —
  // backend əlçatmazsa xəta mesajı, data yoxdursa boş-hal göstərilir (saxta sətir yox).
  useEffect(() => {
    let cancelled = false
    setMhLoading(true)
    setMhError('')
    // Фильтр уходит на сервер: каждая группа разворачивается в поддерево, как в других отчётах.
    const params = new URLSearchParams(filterQuery)
    params.set('month', mhMonth)
    apiRequest<MhApiResponse>(`/api/reports/work-hours/monthly?${params}`, { token })
      .then((res) => {
        if (cancelled) return
        setMhData(Array.isArray(res?.employees) ? res.employees : [])
      })
      .catch(() => {
        if (cancelled) return
        setMhData([])
        setMhError(t('workHours.tabel.loadError'))
      })
      .finally(() => { if (!cancelled) setMhLoading(false) })
    return () => { cancelled = true }
  }, [mhMonth, token, t, filterQuery])

  const nDays = mhDaysInMonth(mhMonth)
  const rows = mhData
  // Səhifədə 50 işçi; başlıqdakı sayğaclar bütün siyahıya görə qalır.
  const paged = pageSlice(rows, mhPage)
  const sumHours = rows.reduce((s, e) => s + (parseInt(e.totalHours, 10) || 0), 0)
  const dayNums = Array.from({ length: nDays }, (_, k) => k + 1)
  // Defaults + server siyahısı: serverdə çatışmayan açar (məs. absent) default-dan gəlir, boş xana qalmır.
  const critMap = new Map<string, AttCriterion>()
  MH_CRIT_DEFAULTS.forEach((c) => critMap.set(c.key, c))
  mhCrit.forEach((c) => critMap.set(c.key, c))
  const critLegend = Array.from(critMap.values()).filter((c) => c.enabled).sort((a, b) => a.sortOrder - b.sortOrder)
  // Ad interfeys dilində — tanınmayan açar üçün DB-dəki label göstərilir.
  const critLabel = (c: AttCriterion) => t(`workHours.tabel.crit.${c.key}`, { defaultValue: c.label })

  return (
    <div className="wf-mh-root">
      <div className="wf-mh-panel">
        <div className="wf-mh-caption">
          <div>
            <div className="t1">{t('workHours.tabel.title')}</div>
            <div className="t2">{mhMonthLabel(mhMonth, i18n.language)} · {t('workHours.tabel.colorsNote')}</div>
          </div>
          <div className="wf-mh-summary">
            <div><div className="lbl">{t('workHours.tabel.employeeCount')}</div><div className="val">{rows.length}</div></div>
            <div><div className="lbl">{t('workHours.tabel.totalHours')}</div><div className="val acc">{sumHours}</div></div>
          </div>
        </div>

        <div className="wf-mh-scroll">
          {mhLoading ? (
            <div className="wf-mh-empty">{t('workHours.tabel.loading')}</div>
          ) : mhError ? (
            <div className="wf-mh-empty">{mhError}</div>
          ) : rows.length === 0 ? (
            <div className="wf-mh-empty">{t('workHours.tabel.noData')}</div>
          ) : (
            <table className="wf-mh-table">
              <thead>
                <tr>
                  <th className="stick wf-mh-c-ss" rowSpan={2}>{t('workHours.tabel.colSS')}</th>
                  <th className="stick wf-mh-c-no" rowSpan={2}>{t('workHours.tabel.colTabNo')}</th>
                  <th className="stick wf-mh-c-name" rowSpan={2}>{t('workHours.tabel.colFullName')}</th>
                  <th className="wf-mh-c-pos" rowSpan={2}>{t('workHours.tabel.colPosition')}</th>
                  <th className="wf-mh-c-dept" rowSpan={2}>{t('workHours.tabel.colDept')}</th>
                  <th colSpan={nDays}>{t('workHours.tabel.colDays')}</th>
                  <th className="wf-mh-total" rowSpan={2}>{t('workHours.tabel.colTotalDays')}</th>
                  <th className="wf-mh-total" rowSpan={2}>{t('workHours.tabel.colTotalHours')}</th>
                  <th className="wf-mh-total" rowSpan={2}>{t('workHours.tabel.colExtraDays')}</th>
                  <th className="wf-mh-total" rowSpan={2}>{t('workHours.tabel.colExtraHours')}</th>
                </tr>
                <tr>
                  {dayNums.map((d) => <th key={d} className={'wf-mh-day' + (mhWeekend(mhMonth, d) ? ' we' : '')}>{d}</th>)}
                </tr>
              </thead>
              <tbody>
                {paged.rows.map((e, i) => (
                  <tr key={e.no || e.externalId || i}>
                    <td className="stick wf-mh-c-ss">{(paged.page - 1) * PAGE_SIZE + i + 1}</td>
                    <td className="stick wf-mh-c-no">{e.externalId || '—'}</td>
                    <td className="stick wf-mh-c-name">{e.fullname}</td>
                    <td className="wf-mh-c-pos">{e.position}</td>
                    <td className="wf-mh-c-dept">{e.department}</td>
                    {dayNums.map((dd) => {
                      const cell = e.days[String(dd)]
                      const we = mhWeekend(mhMonth, dd) ? ' we' : ''
                      // Gün map-də yoxdursa → boş xana (bugünkü davranış).
                      if (cell == null) return <td key={dd} className={'wf-mh-day' + we} />
                      const crit = critMap.get(cell.criterionKey)
                      const hrs = typeof cell.hours === 'number' ? cell.hours : 0
                      // Kriteriyanın göstərilmə rejiminə görə: 'hours' → işlənmiş saat (rəqəm), 'letter' → kriteriya hərfi. Hər iki halda kriteriya rəngi.
                      const mode = crit?.displayMode === 'hours' ? 'hours' : 'letter'
                      const content = mode === 'hours'
                        ? (hrs > 0 ? mhFmtHours(hrs) : (crit ? crit.letter : ''))
                        : (crit ? crit.letter : (hrs > 0 ? mhFmtHours(hrs) : ''))
                      const title = crit ? critLabel(crit) : cell.criterionKey
                      const style = crit ? { color: crit.color, background: mhTint(crit.color), fontWeight: 700 as const } : undefined
                      return (
                        <td key={dd} className={'wf-mh-day' + we}>
                          <span className="pill" style={style} title={title}>{content}</span>
                        </td>
                      )
                    })}
                    <td className="wf-mh-total">{e.totalDays}</td>
                    <td className="wf-mh-total">{e.totalHours}</td>
                    <td className="wf-mh-total">{e.extraDays}</td>
                    <td className="wf-mh-total">{e.extraHours}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {!mhLoading && !mhError && rows.length > 0 && (
          <Pagination page={paged.page} totalPages={paged.totalPages} total={rows.length} onPage={setMhPage} />
        )}

        <div className="wf-mh-legend">
          <span className="lg-lbl">{t('workHours.tabel.legendTitle')}</span>
          {critLegend.map((c) => (
            <span key={c.key} className="wf-mh-chip">
              <span className="sw" style={{ background: mhTint(c.color), color: c.color, fontWeight: 700 }}>{c.letter || t('workHours.tabel.legendHoursChip')}</span>
              {critLabel(c)}{c.displayMode === 'hours' ? ` (${t('workHours.tabel.legendHours')})` : ''}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}


interface Employee {
  id: string
  firstName: string
  lastName: string
  employeeNo: string | null
  department?: { id: string; name: string } | null
  // У студентов ADAU вместо отдела — блок ЖКХ.
  housingBlockId?: string | null
  housingBlockName?: string | null
}

/** Кого показывает отчёт: сотрудников или студентов (жильцов модуля ADAU). */
type PersonKind = 'employee' | 'resident'

interface WhDept {
  id: string
  name: string
  parentId?: string | null
  sortOrder: number
}



type PageTab = 'daily' | 'weekly' | 'monthly' | 'monthlyHours' | 'schedules' | 'leaves'

interface LeaveRow {
  id: string
  employeeId: string
  employeeName: string
  department: string | null
  leaveType: string
  isPaid: boolean
  startDate: string
  endDate: string
  reason: string | null
  status: string
  notes: string | null
  approvedAt: string | null
}

interface LeaveForm {
  employeeId: string
  leaveType: 'Vacation' | 'DayOff'
  isPaid: boolean
  startDate: string
  endDate: string
  reason: string
}

interface SelfServiceRequestRow {
  id: string
  employeeId: string
  employeeName: string
  type: string
  requestedTimeUtc: string
  requestedEndTimeUtc: string | null
  comment: string | null
  status: string
  reviewedAtUtc: string | null
  reviewComment: string | null
  createdUtc: string
}
type SubTab = 'all' | 'present' | 'absent' | 'late' | 'early' | 'overtime' | 'permission'

interface PeriodRow {
  employeeId: string
  employeeName: string | null
  date: string
  scheduleName: string | null
  shiftStart: string | null
  shiftEnd: string | null
  checkInUtc: string | null
  checkOutUtc: string | null
  totalHours: number
  normHours: number
  overtimeHours: number
  isDayOff: boolean
  isAbsent: boolean
  onLeave?: boolean
  leaveType?: string | null
  leaveIsPaid?: boolean | null
  lateMinutes: number | null
  earlyLeaveMinutes: number | null
  corrected: boolean
  permissionHours?: number | null
  permissionShowInReport?: boolean | null
}

interface DailySummary {
  employeeId: string
  employeeName: string | null
  date: string
  scheduleName: string | null
  shiftStart: string | null
  shiftEnd: string | null
  checkInUtc: string | null
  checkOutUtc: string | null
  totalHours: number
  normHours: number
  overtimeHours: number
  isDayOff: boolean
  isAbsent: boolean
  onLeave?: boolean
  leaveType?: string | null
  leaveIsPaid?: boolean | null
  eventCount: number
  lateMinutes: number | null
  earlyLeaveMinutes: number | null
  corrected: boolean
  correctionComment: string | null
  permissionFrom?: string | null
  permissionTo?: string | null
  permissionHours?: number | null
  permissionShowInReport?: boolean | null
  permissionReason?: string | null
}

function formatDateOnly(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
}
function formatTimeOnly(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** Минуты → "Hh Mm": опоздание и ранний уход приходят с сервера в минутах,
 *  а показываются так же, как остальные длительности в таблице. */
function formatMinutesHM(minutes: number): string {
  return formatHM(minutes / 60)
}

/** Десятичные часы → "Hh Mm" (9.5 → "9h 30m", 0.5 → "30m", 9 → "9h"). */
function formatHM(hours: number): string {
  const totalMin = Math.round(hours * 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h === 0 && m === 0) return '0m'
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

interface WorkScheduleShiftRow {
  id?: string
  name: string
  shiftStart: string // "HH:MM"
  shiftEnd: string
  validEntryFrom: string // "HH:MM"
  validEntryTo: string
  requiredHoursPerDay: number
  sortOrder: number
}

interface WorkScheduleRow {
  id: string
  name: string
  type: string
  shiftStart: string | null
  shiftEnd: string | null
  requiredHoursPerDay: number
  color: string
  createdUtc: string
  shifts?: WorkScheduleShiftRow[]
  countEarlyArrival?: boolean
  overtimeDailyThresholdMinutes?: number
  lunchBreakDeductionEnabled?: boolean
  lunchBreakMinutes?: number
  lateToleranceMinutes?: number
}


function timeToInput(isoOrSpan: string | null): string {
  if (!isoOrSpan) return ''
  const t = isoOrSpan.length >= 5 ? isoOrSpan.slice(0, 5) : isoOrSpan
  return /^\d{2}:\d{2}$/.test(t) ? t : ''
}

function inputTimeToApi(value: string): string | null {
  if (!value.trim()) return null
  return value.length === 5 ? `${value}:00` : value
}

/** Понедельник недели, содержащей дату (YYYY-MM-DD → YYYY-MM-DD). */
function weekRange(anchor: string): { from: string; to: string } {
  const d = new Date(anchor + 'T00:00:00')
  const dow = d.getDay() // 0=Sun..6=Sat
  const diffToMon = (dow + 6) % 7 // Mon=0
  const mon = new Date(d); mon.setDate(d.getDate() - diffToMon)
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
  const fmt = (x: Date) => x.toISOString().slice(0, 10)
  return { from: fmt(mon), to: fmt(sun) }
}

/** Первый и последний день месяца YYYY-MM. */
function monthRange(yyyymm: string): { from: string; to: string } {
  const [y, m] = yyyymm.split('-').map(Number)
  const first = new Date(y, m - 1, 1)
  const last = new Date(y, m, 0)
  const fmt = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
  return { from: fmt(first), to: fmt(last) }
}

/**
 * Маска "HH:MM": при вводе цифр — двоеточие подставляется после первых двух.
 * Лишние символы и более 4 цифр отбрасываются.
 */
function maskHHMM(input: string): string {
  const digits = input.replace(/\D/g, '').slice(0, 4)
  if (digits.length <= 2) return digits
  return `${digits.slice(0, 2)}:${digits.slice(2)}`
}


function rowMatchesSubTab(r: PeriodRow, st: SubTab): boolean {
  if (r.isDayOff) return st === 'all'
  switch (st) {
    case 'present': return !r.isAbsent && r.checkInUtc != null
    case 'absent': return r.isAbsent
    case 'late': return (r.lateMinutes ?? 0) > 0
    case 'early': return (r.earlyLeaveMinutes ?? 0) > 0
    case 'overtime': return r.overtimeHours > 0
    case 'permission': return (r.permissionHours ?? 0) > 0
    default: return true
  }
}

/** Ключи i18n для окна выбора человека. */
interface PickerText { pickTitle: string; groupSearch: string; allGroups: string; personSearch: string; noneInGroup: string }
const PICKER_TEXT_EMPLOYEE: PickerText = {
  pickTitle: 'workHours.pickEmployeeTitle',
  groupSearch: 'workHours.deptSearchPlaceholder',
  allGroups: 'people.allDepartments',
  personSearch: 'workHours.empSearchPlaceholder',
  noneInGroup: 'workHours.noEmployeesInDept',
}

/** Одиночный выбор человека: слева дерево групп (с фильтром), справа поиск + список. */
function EmployeeSinglePickerModal({ isOpen, onClose, employees, deptTree, selectedId, onPick, groupOf = (e) => e.department?.id ?? null, text = PICKER_TEXT_EMPLOYEE }: {
  isOpen: boolean
  onClose: () => void
  employees: Employee[]
  /** Дерево групп: отделы у сотрудников, блоки ЖКХ у студентов ADAU. */
  deptTree: WhDept[]
  selectedId: string
  onPick: (id: string) => void
  /** Группа человека в этом дереве. По умолчанию — отдел. */
  groupOf?: (e: Employee) => string | null
  /** Ключи подписей: у студентов вместо отделов — блоки. По умолчанию — для сотрудников. */
  text?: PickerText
}) {
  const { t } = useTranslation()
  const [deptId, setDeptId] = useState<string | null>(null)
  const [deptSearch, setDeptSearch] = useState('')
  const [empSearch, setEmpSearch] = useState('')
  useEffect(() => {
    if (isOpen) { setDeptId(null); setDeptSearch(''); setEmpSearch('') }
  }, [isOpen])
  if (!isOpen) return null

  const descendants = (rootId: string): Set<string> => {
    const set = new Set<string>([rootId])
    let grew = true
    while (grew) {
      grew = false
      for (const d of deptTree) {
        if (d.parentId && set.has(d.parentId) && !set.has(d.id)) { set.add(d.id); grew = true }
      }
    }
    return set
  }
  const deptScope = deptId ? descendants(deptId) : null
  const empQ = empSearch.trim().toLowerCase()
  const list = employees.filter((e) => {
    if (deptScope) {
      const g = groupOf(e)
      if (!g || !deptScope.has(g)) return false
    }
    if (empQ && !(`${e.firstName} ${e.lastName}`.toLowerCase().includes(empQ) || (e.employeeNo ?? '').toLowerCase().includes(empQ))) return false
    return true
  })
  const deptQ = deptSearch.trim().toLowerCase()
  const deptBtnCls = (active: boolean) =>
    `w-full text-left px-3 py-2 rounded-lg text-sm font-bold transition-colors ${active ? 'bg-primary text-white' : 'text-text-dark hover:bg-background-light'}`
  const renderDept = (parentId: string | null, depth: number): ReactNode[] =>
    deptTree
      .filter((d) => (d.parentId ?? null) === parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .flatMap((d) => [
        <button key={d.id} type="button" onClick={() => setDeptId(d.id)} className={deptBtnCls(deptId === d.id)} style={{ paddingLeft: 12 + depth * 16 }}>
          {d.name}
        </button>,
        ...renderDept(d.id, depth + 1),
      ])

  return (
    <Modal isOpen title={t(text.pickTitle)} onClose={onClose}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <input
            type="text"
            value={deptSearch}
            onChange={(e) => setDeptSearch(e.target.value)}
            placeholder={t(text.groupSearch)}
            className="w-full rounded-xl bg-background-light border-none px-3 py-2 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
          />
          <div className="h-80 overflow-y-auto rounded-xl border border-border-light p-1 space-y-0.5">
            <button type="button" onClick={() => setDeptId(null)} className={deptBtnCls(deptId === null)}>
              {t(text.allGroups)}
            </button>
            {deptQ
              ? deptTree
                  .filter((d) => d.name.toLowerCase().includes(deptQ))
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((d) => (
                    <button key={d.id} type="button" onClick={() => setDeptId(d.id)} className={deptBtnCls(deptId === d.id)}>
                      {d.name}
                    </button>
                  ))
              : renderDept(null, 0)}
          </div>
        </div>
        <div className="space-y-2">
          <input
            type="text"
            value={empSearch}
            onChange={(e) => setEmpSearch(e.target.value)}
            placeholder={t(text.personSearch)}
            className="w-full rounded-xl bg-background-light border-none px-3 py-2 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
          />
          <div className="h-80 overflow-y-auto rounded-xl border border-border-light p-1 space-y-0.5">
            {list.length === 0 ? (
              <p className="px-3 py-4 text-xs text-text-light">{t(text.noneInGroup)}</p>
            ) : (
              list.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => onPick(e.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${selectedId === e.id ? 'bg-primary text-white' : 'hover:bg-background-light'}`}
                >
                  <span className={`block text-sm font-bold truncate ${selectedId === e.id ? 'text-white' : 'text-text-dark'}`}>{e.firstName} {e.lastName}</span>
                  {(e.department?.name ?? e.housingBlockName) && <span className={`block text-[10px] truncate ${selectedId === e.id ? 'text-white/80' : 'text-text-light'}`}>{e.department?.name ?? e.housingBlockName}</span>}
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}

function computeShiftHours(start: string, end: string): number | null {
  const re = /^([01][0-9]|2[0-3]):([0-5][0-9])$/
  const ms = start.match(re); const me = end.match(re)
  if (!ms || !me) return null
  const startMin = parseInt(ms[1], 10) * 60 + parseInt(ms[2], 10)
  let endMin = parseInt(me[1], 10) * 60 + parseInt(me[2], 10)
  if (endMin <= startMin) endMin += 24 * 60
  return (endMin - startMin) / 60
}

/**
 * Колонки отчёта по посещаемости. Ключи те же, что у бэкенда (AttendanceColumns):
 * скрытая здесь колонка не попадает ни в таблицу, ни в Excel/PDF, ни в письмо.
 * Часть ключей в таблице не показывается — их набор шире, потому что в выгрузках
 * колонок больше, чем на экране.
 */
const ATTENDANCE_COLUMNS = [
  'employee', 'department', 'date', 'schedule', 'shift', 'checkIn', 'checkOut',
  'hours', 'norm', 'overtime', 'late', 'early', 'status', 'corrected',
] as const
type AttendanceColumn = typeof ATTENDANCE_COLUMNS[number]
const COLUMNS_STORAGE_KEY = 'workHours.visibleColumns'

/** Пусто, битое значение или ни одного известного ключа — показываем всё. */
function loadVisibleColumns(): Set<AttendanceColumn> {
  try {
    const raw = localStorage.getItem(COLUMNS_STORAGE_KEY)
    if (!raw) return new Set(ATTENDANCE_COLUMNS)
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set(ATTENDANCE_COLUMNS)
    const known = parsed.filter((k): k is AttendanceColumn =>
      (ATTENDANCE_COLUMNS as readonly string[]).includes(k as string))
    return known.length > 0 ? new Set(known) : new Set(ATTENDANCE_COLUMNS)
  } catch {
    return new Set(ATTENDANCE_COLUMNS)
  }
}

export function WorkHoursTrackingPage() {
  const { t } = useTranslation()
  const { token } = useAuth()
  const { exporting, downloadReport } = useExportReport(token)
  const [visibleColumns, setVisibleColumns] = useState<Set<AttendanceColumn>>(loadVisibleColumns)
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false)
  const showCol = (key: AttendanceColumn) => visibleColumns.has(key)
  // То, что уходит в Excel/PDF/письмо: порядок как в ATTENDANCE_COLUMNS.
  const columnsParam = ATTENDANCE_COLUMNS.filter(showCol).join(',')
  function toggleColumn(key: AttendanceColumn) {
    setVisibleColumns((prev) => {
      const next = new Set(prev)
      // Последнюю колонку снять нельзя — отчёт стал бы пустым.
      if (next.has(key)) { if (next.size === 1) return prev; next.delete(key) }
      else next.add(key)
      try { localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify([...next])) } catch { /* приватный режим */ }
      return next
    })
  }
  function resetColumns() {
    setVisibleColumns(new Set(ATTENDANCE_COLUMNS))
    try { localStorage.removeItem(COLUMNS_STORAGE_KEY) } catch { /* приватный режим */ }
  }
  // Стартовые таб/суб-таб можно задать через URL: /work-hours?tab=daily&sub=late
  // (карточки на главной ведут сюда с нужным фильтром).
  const [tab, setTab] = useState<PageTab>(() => {
    const p = new URLSearchParams(window.location.search).get('tab')
    return p === 'daily' || p === 'weekly' || p === 'monthly' || p === 'monthlyHours' || p === 'schedules' || p === 'leaves' ? p : 'daily'
  })
  const [subTab, setSubTab] = useState<SubTab>(() => {
    const p = new URLSearchParams(window.location.search).get('sub')
    return p === 'all' || p === 'present' || p === 'absent' || p === 'late' || p === 'early' || p === 'overtime' || p === 'permission' ? p : 'all'
  })

  // Сотрудники или студенты. Студенты есть только в модуле ADAU — в остальных
  // модулях переключателя нет и отчёт всегда по сотрудникам.
  const { activeModule } = useModule()
  const adauModule = activeModule === 'housing'
  const [kindChoice, setKindChoice] = useState<PersonKind>('employee')
  const kind: PersonKind = adauModule ? kindChoice : 'employee'
  const students = kind === 'resident'

  // Filters
  const [employees, setEmployees] = useState<Employee[]>([])
  // Выбор хранится отдельно для каждого типа. Смена модуля страницу не перезагружает,
  // и общий фильтр отправил бы id блоков студентов как отделы сотрудников.
  const [employeesByKind, setEmployeesByKind] = useState<Record<PersonKind, string[]>>({ employee: [], resident: [] })
  const [groupsByKind, setGroupsByKind] = useState<Record<PersonKind, string[]>>({ employee: [], resident: [] })
  const filterEmployees = employeesByKind[kind]
  // Группы и люди складываются: сервер объединяет списки, поэтому можно взять группу
  // целиком и вдобавок отдельных людей. У сотрудников группа — отдел, у студентов — блок.
  const filterGroups = groupsByKind[kind]
  const setFilterEmployees = (ids: string[]) => setEmployeesByKind((prev) => ({ ...prev, [kind]: ids }))
  const setFilterGroups = (ids: string[]) => setGroupsByKind((prev) => ({ ...prev, [kind]: ids }))
  // Стабильные строки для запросов и ключей: порядок выбора на результат не влияет.
  const groupsParam = useMemo(() => [...filterGroups].sort().join(','), [filterGroups])
  const employeesParam = useMemo(() => [...filterEmployees].sort().join(','), [filterEmployees])
  const toggleFilterGroup = (groupId: string) => {
    setGroupsByKind((prev) => {
      const cur = prev[kind]
      return { ...prev, [kind]: cur.includes(groupId) ? cur.filter((id) => id !== groupId) : [...cur, groupId] }
    })
  }
  const clearFilters = () => { setFilterEmployees([]); setFilterGroups([]) }
  // Employee picker popup: слева дерево групп, справа люди выбранной группы.
  const [deptTree, setDeptTree] = useState<WhDept[]>([])
  const [blockTree, setBlockTree] = useState<WhDept[]>([])
  const groupTree = students ? blockTree : deptTree
  /** Имена выбранных групп в порядке дерева — для подписи кнопки фильтра. */
  const selectedGroupNames = () =>
    groupTree.filter((d) => filterGroups.includes(d.id)).map((d) => d.name)
  /** Группа человека в дереве окна выбора: блок у студента, отдел у сотрудника. */
  const groupIdOf = (e: Employee) => (students ? e.housingBlockId : e.department?.id) ?? null
  /** Фильтр людей для всех запросов отчёта: тип плюс выбранные люди и группы. */
  const peopleFilterQuery = (() => {
    const p = new URLSearchParams({ kind })
    if (employeesParam) p.set('employeeIds', employeesParam)
    if (groupsParam) p.set(students ? 'housingBlockIds' : 'departmentIds', groupsParam)
    return p.toString()
  })()
  const [mhMonth, setMhMonth] = useState(MH_DEFAULT_MONTH)
  /** Параметры выгрузок табеля: месяц плюс тот же фильтр, что и на экране. */
  const tabelParams = () => {
    const params = new URLSearchParams(peopleFilterQuery)
    params.set('month', mhMonth)
    return params.toString()
  }

  const [empPickerOpen, setEmpPickerOpen] = useState(false)
  const switchKind = (next: PersonKind) => {
    if (next === kindChoice) return
    setKindChoice(next)
  }
  // Ключи подписей, зависящих от типа: у студентов группа — блок ЖКХ, у сотрудников — отдел.
  // Для студентов берём готовые ключи страницы «Autentifikasiya qeydləri» — там то же окно выбора.
  const kindText = students
    ? {
        person: 'people.kindResident', all: 'authRecords.allResidents', whole: 'authRecords.wholeBlock',
        selectWhole: 'authRecords.selectWholeBlock', unselectWhole: 'authRecords.unselectWholeBlock',
        allGroups: 'authRecords.allBlocks', groupSearch: 'authRecords.blockSearchPlaceholder',
        personSearch: 'authRecords.residentSearchPlaceholder', noneInGroup: 'authRecords.noResidentsInBlock',
        hint: 'authRecords.multiBlockHint', selected: 'authRecords.selectedCount', noGroups: 'authRecords.noBlocksSelected',
        clear: 'authRecords.clearSelection', remove: 'authRecords.removeFromSelection', pickTitle: 'authRecords.pickPersonTitle',
      }
    : {
        person: 'workHours.employee', all: 'workHours.allEmployees', whole: 'workHours.wholeDept',
        selectWhole: 'workHours.selectWholeDept', unselectWhole: 'workHours.unselectWholeDept',
        allGroups: 'people.allDepartments', groupSearch: 'workHours.deptSearchPlaceholder',
        personSearch: 'workHours.empSearchPlaceholder', noneInGroup: 'workHours.noEmployeesInDept',
        hint: 'workHours.multiDeptHint', selected: 'workHours.deptsSelected', noGroups: 'workHours.noDeptsSelected',
        clear: 'workHours.clearDepts', remove: 'workHours.removeDept', pickTitle: 'workHours.pickEmployeeTitle',
      }
  const [filterFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10)
  })
  const [filterTo] = useState(() => new Date().toISOString().slice(0, 10))
  // Daily-вкладка работает с одной датой (день, за который смотрим отчёт).
  const [filterDailyDate, setFilterDailyDate] = useState(() => new Date().toISOString().slice(0, 10))
  // Weekly/Monthly — anchor-даты, диапазон вычисляется автоматически.
  const [weeklyAnchor, setWeeklyAnchor] = useState(() => new Date().toISOString().slice(0, 10))
  const [monthlyAnchor, setMonthlyAnchor] = useState(() => new Date().toISOString().slice(0, 7)) // YYYY-MM

  // Модалка коррекции check-in/check-out для конкретного сотрудника на конкретный день.
  const [correctionModal, setCorrectionModal] = useState<DailySummary | null>(null)
  // Разрешение на отлучку (почасовое).
  const [permissionModal, setPermissionModal] = useState<DailySummary | null>(null)
  const [permissionForm, setPermissionForm] = useState({ from: '13:00', to: '15:00', reason: '', showInReport: true })
  const [permissionSaving, setPermissionSaving] = useState(false)
  const [correctionForm, setCorrectionForm] = useState({ checkIn: '', checkOut: '', comment: '' })
  const [correctionSaving, setCorrectionSaving] = useState(false)

  // Data
  const [daily, setDaily] = useState<DailySummary[]>([])
  const [period, setPeriod] = useState<PeriodRow[]>([])
  const [loading, setLoading] = useState(false)

  // Səhifələmə (50 sətir/səhifə) — hesabat cədvəllərinin hər birinin öz səhifəsi var;
  // açar dəyişəndə (tab, alt-tab, filtr, tarix) səhifə birinciyə qayıdır.
  const reportPageKey = `${tab}|${subTab}|${peopleFilterQuery}|${filterDailyDate}|${weeklyAnchor}|${monthlyAnchor}`
  const [dailyPage, setDailyPage] = usePageReset(reportPageKey)
  const [periodPage, setPeriodPage] = usePageReset(reportPageKey)
  const [schedulesPage, setSchedulesPage] = usePageReset(tab)

  const [schedules, setSchedules] = useState<WorkScheduleRow[]>([])
  const [scheduleModal, setScheduleModal] = useState<'create' | 'edit' | 'delete' | null>(null)
  const [editingSchedule, setEditingSchedule] = useState<WorkScheduleRow | null>(null)
  const [scheduleForm, setScheduleForm] = useState({
    name: '',
    type: 'Standard' as 'Standard' | 'Flexible' | 'Multi' | 'Off',
    shiftStart: '09:00',
    shiftEnd: '18:00',
    requiredHoursPerDay: '8',
    color: '#6366f1',
    countEarlyArrival: true,
    overtimeDailyThresholdMinutes: '0',
    lunchBreakDeductionEnabled: false,
    lunchBreakMinutes: '30',
    lateToleranceMinutes: '0',
  })
  const [scheduleShifts, setScheduleShifts] = useState<WorkScheduleShiftRow[]>([])
  const [scheduleSaving, setScheduleSaving] = useState(false)

  // ── Leaves ────────────────────────────────────────────────────────────────
  const [leaves, setLeaves] = useState<LeaveRow[]>([])
  const [leavesLoading, setLeavesLoading] = useState(false)
  const [selfServiceReqs, setSelfServiceReqs] = useState<SelfServiceRequestRow[]>([])
  const [selfServiceLoading, setSelfServiceLoading] = useState(false)
  // Статусные табы секции "Заявки самообслуживания": Pending | Approved | Rejected.
  const [ssTab, setSsTab] = useState<'Pending' | 'Approved' | 'Rejected'>('Pending')
  const [leaveModal, setLeaveModal] = useState<'create' | 'edit' | null>(null)
  const [editingLeaveId, setEditingLeaveId] = useState<string | null>(null)
  const [leaveEmpPickerOpen, setLeaveEmpPickerOpen] = useState(false)
  const [leaveSaving, setLeaveSaving] = useState(false)
  // Фильтры таблицы отпусков: поиск по сотруднику + отдел.
  const [leaveSearch, setLeaveSearch] = useState('')
  const [leaveDept, setLeaveDept] = useState('')
  // Səhifələmə: axtarış/şöbə (məzuniyyətlər) və status tabı (self-service) dəyişəndə səhifə sıfırlanır.
  const [leavesPage, setLeavesPage] = usePageReset(`${leaveSearch}|${leaveDept}`)
  const [ssPage, setSsPage] = usePageReset(ssTab)
  const [leaveForm, setLeaveForm] = useState<LeaveForm>({
    employeeId: '',
    leaveType: 'Vacation',
    isPaid: true,
    startDate: new Date().toISOString().slice(0, 10),
    endDate: new Date().toISOString().slice(0, 10),
    reason: '',
  })

  // ── Email Report ──────────────────────────────────────────────────────────
  const [emailReportModal, setEmailReportModal] = useState(false)
  const [emailReportTo, setEmailReportTo] = useState('')
  const [emailReportSending, setEmailReportSending] = useState(false)

  const sendAttendanceReport = async () => {
    if (!token || !emailReportTo.trim()) return
    setEmailReportSending(true)
    try {
      if (tab === 'monthlyHours') {
        // Табель — отдельный эндпоинт: месяц + получатель.
        await apiRequest('/api/reports/work-hours/monthly/send-email', {
          method: 'POST', token,
          body: JSON.stringify({
            to: emailReportTo.trim(), month: mhMonth,
            employeeIds: employeesParam || null,
            departmentIds: students ? null : (groupsParam || null),
            housingBlockIds: students ? (groupsParam || null) : null,
            kind,
          }),
        })
        alert(t('workHours.reportSentTo', { email: emailReportTo.trim() }))
        setEmailReportModal(false)
        setEmailReportTo('')
        return
      }
      let from = filterDailyDate
      let to = filterDailyDate
      if (tab === 'weekly') { const r = weekRange(weeklyAnchor); from = r.from; to = r.to }
      else if (tab === 'monthly') { const r = monthRange(monthlyAnchor); from = r.from; to = r.to }
      await apiRequest('/api/reports/attendance/send-email', {
        method: 'POST', token,
        body: JSON.stringify({ to: emailReportTo.trim(), from, to2: to, columns: ATTENDANCE_COLUMNS.filter(showCol), kind }),
      })
      alert(t('workHours.reportSentTo', { email: emailReportTo.trim() }))
      setEmailReportModal(false)
      setEmailReportTo('')
    } catch (e) {
      alert(e instanceof Error ? e.message : t('workHours.failedToSend'))
    } finally { setEmailReportSending(false) }
  }

  // ── Quick Assign ──────────────────────────────────────────────────────────
  const [assignSchedule, setAssignSchedule] = useState<WorkScheduleRow | null>(null)
  const [assignEmps, setAssignEmps] = useState<{ id: string; name: string; dept: string }[]>([])
  const [assignSelEmps, setAssignSelEmps] = useState<Set<string>>(new Set())
  const [assignSelDows, setAssignSelDows] = useState<Set<number>>(new Set([1, 2, 3, 4, 5]))
  const [assignFrom, setAssignFrom] = useState('')
  const [assignTo, setAssignTo] = useState('')
  const [assignSearch, setAssignSearch] = useState('')
  const [assignSaving, setAssignSaving] = useState(false)
  const [assignSuccessCount, setAssignSuccessCount] = useState(0)
  const [assignLastDows, setAssignLastDows] = useState<Set<number>>(new Set([1, 2, 3, 4, 5]))
  const [assignError, setAssignError] = useState<string | null>(null)
  const [assignRemoveMode, setAssignRemoveMode] = useState(false)
  useEffect(() => {
    if (assignSuccessCount > 0) { const t = setTimeout(() => setAssignSuccessCount(0), 3000); return () => clearTimeout(t) }
  }, [assignSuccessCount])

useEffect(() => {
    loadMeta()
  }, [])

  useEffect(() => {
    if (tab === 'daily') loadDaily()
    else if (tab === 'weekly' || tab === 'monthly') loadPeriod()
  }, [tab, peopleFilterQuery, filterFrom, filterTo, filterDailyDate, weeklyAnchor, monthlyAnchor])

  const loadSchedules = useCallback(async () => {
    if (!token) return
    setLoading(true)
    try {
      const data = await apiRequest<WorkScheduleRow[]>('/api/work-schedules', { token })
      setSchedules(data)
    } catch {
      setSchedules([])
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    if (tab === 'schedules') void loadSchedules()
  }, [tab, loadSchedules])

  const loadLeaves = useCallback(async () => {
    if (!token) return
    setLeavesLoading(true)
    setSelfServiceLoading(true)
    try {
      const [leavesData, reqsData] = await Promise.all([
        // Отпуска — только выбранного типа (сотрудники или студенты).
        apiRequest<LeaveRow[]>(`/api/leaves?kind=${kind}`, { token }),
        apiRequest<SelfServiceRequestRow[]>('/api/attendance-requests?types=Vacation,Absence,Overtime', { token }),
      ])
      setLeaves(leavesData)
      setSelfServiceReqs(reqsData)
    } catch {
      setLeaves([])
      setSelfServiceReqs([])
    } finally {
      setLeavesLoading(false)
      setSelfServiceLoading(false)
    }
  }, [token, kind])

  useEffect(() => {
    if (tab === 'leaves') void loadLeaves()
  }, [tab, loadLeaves])

  const authOpts = { token }

  const loadMeta = async () => {
    const depts = await apiRequest<WhDept[]>('/api/departments/tree', authOpts).catch(() => [] as WhDept[])
    setDeptTree(depts)
  }

  // Люди для окна выбора и формы отпуска — того типа, что выбран переключателем.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    apiRequest<Employee[]>(`/api/employees?kind=${kind}`, { token })
      .then((list) => { if (!cancelled) setEmployees(list) })
      .catch(() => { if (!cancelled) setEmployees([]) })
    return () => { cancelled = true }
  }, [token, kind])

  // Блоки ЖКХ — группы студентов; нужны только в модуле ADAU.
  useEffect(() => {
    if (!token || !adauModule) return
    let cancelled = false
    loadHousingBlocks(token)
      .then((list) => { if (!cancelled) setBlockTree(list) })
      .catch(() => { if (!cancelled) setBlockTree([]) })
    return () => { cancelled = true }
  }, [token, adauModule])

  function openPermission(d: DailySummary) {
    setPermissionForm({
      from: d.permissionFrom ?? '13:00',
      to: d.permissionTo ?? '15:00',
      reason: d.permissionReason ?? '',
      showInReport: d.permissionShowInReport ?? true,
    })
    setPermissionModal(d)
  }

  async function savePermission() {
    if (!permissionModal || !token) return
    setPermissionSaving(true)
    try {
      await apiRequest('/api/attendance/permission', {
        method: 'POST', token,
        body: JSON.stringify({
          employeeId: permissionModal.employeeId,
          date: filterDailyDate,
          fromTime: permissionForm.from,
          toTime: permissionForm.to,
          reason: permissionForm.reason.trim() || null,
          showInReport: permissionForm.showInReport,
        }),
      })
      setPermissionModal(null)
      await loadDaily()
    } finally {
      setPermissionSaving(false)
    }
  }

  async function deletePermission() {
    if (!permissionModal || !token) return
    const params = new URLSearchParams({ employeeId: permissionModal.employeeId, date: filterDailyDate })
    await apiRequest(`/api/attendance/permission?${params}`, { method: 'DELETE', token })
    setPermissionModal(null)
    await loadDaily()
  }

  function openCorrection(d: DailySummary) {
    const toLocalHHMM = (iso: string | null) => iso
      ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
      : ''
    setCorrectionForm({
      checkIn: toLocalHHMM(d.checkInUtc),
      checkOut: toLocalHHMM(d.checkOutUtc),
      comment: d.correctionComment ?? '',
    })
    setCorrectionModal(d)
  }

  async function saveCorrection() {
    if (!correctionModal || !token) return
    setCorrectionSaving(true)
    try {
      // HH:MM (local) → ISO UTC, привязанные к выбранному дню в local TZ.
      const toIsoUtc = (hhmm: string): string | null => {
        const m = hhmm.match(/^([01][0-9]|2[0-3]):([0-5][0-9])$/)
        if (!m) return null
        const d = new Date(filterDailyDate + 'T00:00:00')
        d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0)
        return d.toISOString()
      }
      await apiRequest('/api/attendance/daily/correction', {
        method: 'POST',
        token,
        body: JSON.stringify({
          employeeId: correctionModal.employeeId,
          date: new Date(filterDailyDate).toISOString(),
          checkInUtc: toIsoUtc(correctionForm.checkIn),
          checkOutUtc: toIsoUtc(correctionForm.checkOut),
          comment: correctionForm.comment.trim() || null,
        }),
      })
      setCorrectionModal(null)
      await loadDaily()
    } finally {
      setCorrectionSaving(false)
    }
  }

  async function clearCorrection() {
    if (!correctionModal || !token) return
    setCorrectionSaving(true)
    try {
      const params = new URLSearchParams({
        employeeId: correctionModal.employeeId,
        date: new Date(filterDailyDate).toISOString(),
      })
      await apiRequest(`/api/attendance/daily/correction?${params}`, { method: 'DELETE', token })
      setCorrectionModal(null)
      await loadDaily()
    } finally {
      setCorrectionSaving(false)
    }
  }

  const loadPeriod = async () => {
    setLoading(true)
    try {
      const range = tab === 'weekly' ? weekRange(weeklyAnchor) : monthRange(monthlyAnchor)
      const params = new URLSearchParams(peopleFilterQuery)
      params.set('from', new Date(range.from + 'T00:00:00').toISOString())
      params.set('to', new Date(range.to + 'T00:00:00').toISOString())
      const data = await apiRequest<PeriodRow[]>(`/api/attendance/period?${params}`, authOpts)
      setPeriod(data)
    } finally {
      setLoading(false)
    }
  }

  const loadDaily = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams(peopleFilterQuery)
      if (filterDailyDate) params.set('date', new Date(filterDailyDate).toISOString())
      const data = await apiRequest<DailySummary[]>(`/api/attendance/daily?${params}`, authOpts)
      setDaily(data)
    } finally {
      setLoading(false)
    }
  }


  function openCreateSchedule() {
    setScheduleForm({
      name: '',
      type: 'Standard',
      shiftStart: '09:00',
      shiftEnd: '18:00',
      requiredHoursPerDay: '8',
      color: '#6366f1',
      countEarlyArrival: true,
      overtimeDailyThresholdMinutes: '0',
      lunchBreakDeductionEnabled: false,
      lunchBreakMinutes: '30',
      lateToleranceMinutes: '0',
    })
    setScheduleShifts([])
    setEditingSchedule(null)
    setScheduleModal('create')
  }

  function openEditSchedule(s: WorkScheduleRow) {
    setEditingSchedule(s)
    setScheduleForm({
      name: s.name,
      type: (['Standard', 'Flexible', 'Multi', 'Off'].includes(s.type) ? s.type : 'Standard') as 'Standard' | 'Flexible' | 'Multi' | 'Off',
      shiftStart: timeToInput(s.shiftStart) || '09:00',
      shiftEnd: timeToInput(s.shiftEnd) || '18:00',
      requiredHoursPerDay: String(s.requiredHoursPerDay ?? 8),
      color: s.color || '#6366f1',
      countEarlyArrival: s.countEarlyArrival ?? true,
      overtimeDailyThresholdMinutes: String(s.overtimeDailyThresholdMinutes ?? 0),
      lunchBreakDeductionEnabled: s.lunchBreakDeductionEnabled ?? false,
      lunchBreakMinutes: String(s.lunchBreakMinutes ?? 30),
      lateToleranceMinutes: String(s.lateToleranceMinutes ?? 0),
    })
    // Load sub-shifts for Multi schedules
    setScheduleShifts(s.shifts?.map(sh => ({
      id: sh.id,
      name: sh.name,
      shiftStart: sh.shiftStart,
      shiftEnd: sh.shiftEnd,
      validEntryFrom: sh.validEntryFrom,
      validEntryTo: sh.validEntryTo,
      requiredHoursPerDay: sh.requiredHoursPerDay,
      sortOrder: sh.sortOrder,
    })) ?? [])
    setScheduleModal('edit')
  }

  async function saveSchedule() {
    if (!token) return
    const name = scheduleForm.name.trim()
    if (!name) return
    setScheduleSaving(true)
    try {
      const isFlex = scheduleForm.type === 'Flexible'
      const isMulti = scheduleForm.type === 'Multi'
      const isOff = scheduleForm.type === 'Off'
      // Для Standard/Shift Norm = (end − start), считается автоматически.
      const computed = (isFlex || isMulti || isOff) ? null : computeShiftHours(scheduleForm.shiftStart, scheduleForm.shiftEnd)
      const body: Record<string, unknown> = {
        name,
        type: scheduleForm.type,
        shiftStart: (isFlex || isMulti || isOff) ? null : inputTimeToApi(scheduleForm.shiftStart),
        shiftEnd: (isFlex || isMulti || isOff) ? null : inputTimeToApi(scheduleForm.shiftEnd),
        requiredHoursPerDay: isFlex
          ? (parseFloat(scheduleForm.requiredHoursPerDay) || 8)
          : (isMulti || isOff)
            ? 0
            : (computed ?? 8),
        color: scheduleForm.color,
        countEarlyArrival: scheduleForm.countEarlyArrival,
        overtimeDailyThresholdMinutes: Math.max(0, parseInt(scheduleForm.overtimeDailyThresholdMinutes, 10) || 0),
        lunchBreakDeductionEnabled: scheduleForm.lunchBreakDeductionEnabled,
        lunchBreakMinutes: Math.max(0, parseInt(scheduleForm.lunchBreakMinutes, 10) || 30),
        lateToleranceMinutes: Math.max(0, parseInt(scheduleForm.lateToleranceMinutes, 10) || 0),
      }
      if (isMulti) {
        body.shifts = scheduleShifts.map((sh, idx) => ({
          name: sh.name,
          shiftStart: inputTimeToApi(sh.shiftStart),
          shiftEnd: inputTimeToApi(sh.shiftEnd),
          validEntryFrom: inputTimeToApi(sh.validEntryFrom),
          validEntryTo: inputTimeToApi(sh.validEntryTo),
          requiredHoursPerDay: sh.requiredHoursPerDay,
          sortOrder: idx,
        }))
      }
      if (scheduleModal === 'create') {
        await apiRequest('/api/work-schedules', { method: 'POST', token, body: JSON.stringify(body) })
      } else if (scheduleModal === 'edit' && editingSchedule) {
        await apiRequest(`/api/work-schedules/${editingSchedule.id}`, { method: 'PUT', token, body: JSON.stringify(body) })
      }
      setScheduleModal(null)
      setEditingSchedule(null)
      setScheduleShifts([])
      await loadSchedules()
    } finally {
      setScheduleSaving(false)
    }
  }

  async function deleteSchedule() {
    if (!token || !editingSchedule) return
    setScheduleSaving(true)
    try {
      await apiRequest(`/api/work-schedules/${editingSchedule.id}`, { method: 'DELETE', token })
      setScheduleModal(null)
      setEditingSchedule(null)
      await loadSchedules()
    } finally {
      setScheduleSaving(false)
    }
  }

  async function openAssignModal(s: WorkScheduleRow) {
    setAssignSchedule(s)
    setAssignSearch('')
    setAssignError(null)
    setAssignRemoveMode(false)
    try {
      type EmpItem = { id: string; firstName: string; lastName: string; department?: { name: string } | null; housingBlockName?: string | null }
      type AssignmentState = { employeeIds: string[]; fromDate: string | null; toDate: string | null; daysOfWeek: number[] }

      // График назначаем людям выбранного типа: студентам он нужен, чтобы попасть в отчёт.
      const [empData, state] = await Promise.all([
        apiRequest<EmpItem[]>(`/api/employees?isActive=true&kind=${kind}`, { token }),
        apiRequest<AssignmentState>(`/api/work-schedules/${s.id}/assignment?kind=${kind}`, { token }),
      ])

      setAssignEmps(empData.map(e => ({ id: e.id, name: `${e.firstName} ${e.lastName}`, dept: e.department?.name ?? e.housingBlockName ?? '' })))
      setAssignSelEmps(new Set(state.employeeIds))

      // Days of week derived from actual patterns in DB (always accurate after clean overwrite)
      const dows = state.daysOfWeek.length > 0 ? state.daysOfWeek : [1, 2, 3, 4, 5]
      setAssignSelDows(new Set(dows))
      setAssignLastDows(new Set(dows))

      // Date range: from actual pattern min/max dates, or default to current month
      if (state.fromDate && state.toDate) {
        setAssignFrom(state.fromDate)
        setAssignTo(state.toDate)
      } else {
        const now = new Date()
        const y = now.getFullYear(), mo = now.getMonth()
        const pad = (n: number) => String(n).padStart(2, '0')
        setAssignFrom(`${y}-${pad(mo + 1)}-01`)
        setAssignTo(`${y}-${pad(mo + 1)}-${pad(new Date(y, mo + 1, 0).getDate())}`)
      }
    } catch {
      setAssignEmps([])
      setAssignSelEmps(new Set())
      setAssignSelDows(new Set(assignLastDows))
      const now = new Date()
      const y = now.getFullYear(), mo = now.getMonth()
      const pad = (n: number) => String(n).padStart(2, '0')
      setAssignFrom(`${y}-${pad(mo + 1)}-01`)
      setAssignTo(`${y}-${pad(mo + 1)}-${pad(new Date(y, mo + 1, 0).getDate())}`)
    }
  }

  async function doAssign() {
    if (!token || !assignSchedule || assignSelEmps.size === 0) return
    if (!assignRemoveMode && assignSelDows.size === 0) return
    setAssignSaving(true)
    setAssignError(null)
    try {
      const empIds = [...assignSelEmps]

      if (assignRemoveMode) {
        // Remove mode: clear WorkScheduleId + delete all day patterns via backend (one call).
        // Backend handles deleting all patterns when scheduleId = null.
        await apiRequest('/api/employees/bulk-schedule', {
          method: 'PUT', token,
          body: JSON.stringify({ employeeIds: empIds, scheduleId: null }),
        })
      } else {
        // Assign mode: build day-pattern payload for the date range + days of week
        const parseLocal = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }
        const from = parseLocal(assignFrom), to = parseLocal(assignTo)
        const pad = (n: number) => String(n).padStart(2, '0')
        const days: { date: string; scheduleId: string; isDayOff: boolean; reset: boolean }[] = []
        for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
          const dow = d.getDay() === 0 ? 7 : d.getDay()
          if (assignSelDows.has(dow)) {
            const ds = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
            days.push({ date: ds, scheduleId: assignSchedule.id, isDayOff: false, reset: false })
          }
        }
        if (days.length === 0) { setAssignError(t('workHours.noDatesMatch')); return }

        // Set WorkScheduleId for all employees
        await apiRequest('/api/employees/bulk-schedule', {
          method: 'PUT', token,
          body: JSON.stringify({ employeeIds: empIds, scheduleId: assignSchedule.id }),
        })
        // Delete old patterns for this schedule and write fresh ones (clean overwrite)
        await apiRequest('/api/schedule-planner/bulk-days', {
          method: 'PUT', token,
          body: JSON.stringify({ employeeIds: empIds, days, replaceScheduleId: assignSchedule.id }),
        })
        setAssignLastDows(new Set(assignSelDows))
      }

      setAssignSuccessCount(assignSelEmps.size)
      setAssignError(null)
      setAssignSchedule(null)
      setAssignRemoveMode(false)
    } catch (err) {
      setAssignError(err instanceof Error ? err.message : t('workHours.assignmentFailed'))
    } finally {
      setAssignSaving(false)
    }
  }

  async function saveLeave() {
    if (!token || !leaveForm.employeeId) return
    setLeaveSaving(true)
    try {
      const body = {
        employeeId: leaveForm.employeeId,
        leaveType: leaveForm.leaveType,
        isPaid: leaveForm.isPaid,
        startDate: leaveForm.startDate,
        endDate: leaveForm.endDate,
        reason: leaveForm.reason.trim() || null,
        notes: null,
      }
      if (leaveModal === 'edit' && editingLeaveId) {
        await apiRequest(`/api/leaves/${editingLeaveId}`, { method: 'PUT', token, body: JSON.stringify(body) })
      } else {
        await apiRequest('/api/leaves', { method: 'POST', token, body: JSON.stringify(body) })
      }
      setLeaveModal(null)
      setEditingLeaveId(null)
      setLeaveForm({ employeeId: '', leaveType: 'Vacation', isPaid: true, startDate: new Date().toISOString().slice(0, 10), endDate: new Date().toISOString().slice(0, 10), reason: '' })
      await loadLeaves()
    } finally {
      setLeaveSaving(false)
    }
  }

  function openEditLeave(lv: LeaveRow) {
    setLeaveForm({
      employeeId: lv.employeeId,
      leaveType: lv.leaveType === 'DayOff' ? 'DayOff' : 'Vacation',
      isPaid: lv.isPaid,
      startDate: lv.startDate,
      endDate: lv.endDate,
      reason: lv.reason ?? '',
    })
    setEditingLeaveId(lv.id)
    setLeaveModal('edit')
  }

  async function cancelLeave(id: string) {
    if (!token) return
    if (!window.confirm(t('workHours.cancelLeaveConfirm'))) return
    await apiRequest(`/api/leaves/${id}/cancel`, { method: 'POST', token })
    await loadLeaves()
  }

  async function approveLeave(id: string) {
    if (!token) return
    await apiRequest(`/api/leaves/${id}/approve`, { method: 'POST', token })
    await loadLeaves()
  }

  async function rejectLeave(id: string) {
    if (!token) return
    await apiRequest(`/api/leaves/${id}/reject`, { method: 'POST', token })
    await loadLeaves()
  }

  async function deleteLeave(id: string) {
    if (!token) return
    await apiRequest(`/api/leaves/${id}`, { method: 'DELETE', token })
    await loadLeaves()
  }

  async function approveSelfServiceReq(id: string) {
    if (!token) return
    await apiRequest(`/api/attendance-requests/${id}/approve`, { method: 'PUT', token })
    await loadLeaves()
  }

  async function rejectSelfServiceReq(id: string) {
    if (!token) return
    await apiRequest(`/api/attendance-requests/${id}/reject`, { method: 'PUT', token })
    await loadLeaves()
  }

  return (
    <AppLayout onAction={() => {}}>
      <div className="flex-1 overflow-y-auto bg-background-light pb-20 md:pb-0">
        <div className="p-6 md:p-10 space-y-6">

          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 animate-in slide-in-from-top-4 duration-500">
            <PageHeader
              className="p-0 border-none shadow-none bg-transparent"
              title={t('workHours.pageTitle')}
              description={t('workHours.pageDescription')}
            />
            {/* Сотрудники / студенты — только в модуле ADAU. Действует на все вкладки,
                включая графики и отпуска, поэтому стоит в шапке, а не в панели фильтров. */}
            {adauModule && (
              <div className="flex rounded-xl bg-surface p-1 gap-1 w-fit shadow-sm shrink-0" role="tablist" aria-label={t('workHours.kindSwitchLabel')}>
                {(['employee', 'resident'] as PersonKind[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={kind === k}
                    onClick={() => switchKind(k)}
                    className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition-colors ${kind === k ? 'bg-primary text-white' : 'text-text-light hover:text-text-dark'}`}
                  >
                    {t(k === 'resident' ? 'people.residents' : 'people.employees')}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Combined tab + sub-tab bar */}
          {(() => {
            const showSub = tab === 'daily' || tab === 'weekly' || tab === 'monthly'
            const subTabCounts: Record<SubTab, number> = (() => {
              if (!showSub) return { all: 0, present: 0, absent: 0, late: 0, early: 0, overtime: 0, permission: 0 }
              // Sayğaclar cədvəl filtri ilə EYNİ şərtlərdən istifadə edir — yoxsa "1" göstərib boş cədvəl açılır.
              if (tab === 'daily') {
                return {
                  all: daily.length,
                  present: daily.filter(d => !d.isDayOff && !d.isAbsent && d.checkInUtc != null).length,
                  absent: daily.filter(d => !d.isDayOff && d.isAbsent).length,
                  late: daily.filter(d => !d.isDayOff && (d.lateMinutes ?? 0) > 0).length,
                  early: daily.filter(d => !d.isDayOff && (d.earlyLeaveMinutes ?? 0) > 0).length,
                  overtime: daily.filter(d => !d.isDayOff && d.overtimeHours > 0).length,
                  permission: daily.filter(d => !d.isDayOff && (d.permissionHours ?? 0) > 0).length,
                }
              }
              const empMap = new Map<string, PeriodRow[]>()
              for (const r of period) {
                if (!empMap.has(r.employeeId)) empMap.set(r.employeeId, [])
                empMap.get(r.employeeId)!.push(r)
              }
              const emps = Array.from(empMap.values())
              return {
                all: emps.length,
                present: emps.filter(rows => rows.some(r => rowMatchesSubTab(r, 'present'))).length,
                absent: emps.filter(rows => rows.some(r => rowMatchesSubTab(r, 'absent'))).length,
                late: emps.filter(rows => rows.some(r => rowMatchesSubTab(r, 'late'))).length,
                early: emps.filter(rows => rows.some(r => rowMatchesSubTab(r, 'early'))).length,
                overtime: emps.filter(rows => rows.some(r => rowMatchesSubTab(r, 'overtime'))).length,
                permission: emps.filter(rows => rows.some(r => rowMatchesSubTab(r, 'permission'))).length,
              }
            })()
            const subLabels: Record<SubTab, string> = {
              all: t('common.all'),
              present: t('workHours.subTabPresent'),
              absent: t('workHours.subTabAbsent'),
              late: t('workHours.subTabLate'),
              early: t('workHours.subTabEarly'),
              overtime: t('workHours.subTabOvertime'),
              permission: t('workHours.subTabPermission'),
            }
            const tabLabels: Record<PageTab, string> = {
              daily: t('workHours.tabDaily'),
              weekly: t('workHours.tabWeekly'),
              monthly: t('workHours.tabMonthly'),
              schedules: t('workHours.tabSchedules'),
              leaves: t('workHours.tabLeaves'),
              monthlyHours: t('workHours.tabTabel'),
            }
            const btnBase = 'flex-1 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all whitespace-nowrap'
            const btnActive = 'bg-primary text-white shadow-sm'
            const btnIdle = 'text-text-light hover:text-text-dark'
            return (
              <div className="bg-surface rounded-2xl shadow-sm p-1 w-fit max-w-full">
                {/* Main tabs row */}
                <div className="flex gap-1">
                  {(['daily', 'weekly', 'monthly', 'monthlyHours', 'schedules', 'leaves'] as PageTab[]).map(tt => (
                    <button
                      key={tt}
                      type="button"
                      onClick={() => { setTab(tt); setSubTab('all') }}
                      className={`${btnBase} px-5 ${tab === tt ? btnActive : btnIdle}`}
                    >
                      {tabLabels[tt]}
                    </button>
                  ))}
                </div>

                {/* Sub-tabs row — grows from the active main tab */}
                {showSub && (
                  <>
                    <div className="h-px bg-black/[0.06] mx-1 my-1" />
                    <div className="flex gap-1">
                      {(['all', 'present', 'absent', 'late', 'early', 'overtime', 'permission'] as SubTab[]).map(st => (
                        <button
                          key={st}
                          type="button"
                          onClick={() => setSubTab(st)}
                          className={`${btnBase} flex items-center justify-center gap-1.5 px-3 ${subTab === st ? btnActive : btnIdle}`}
                        >
                          {subLabels[st]}
                          <span className={`text-[9px] font-black px-1.5 py-0.5 rounded-md leading-none ${subTab === st ? 'bg-white/20' : 'bg-background-light text-text-muted'}`}>
                            {subTabCounts[st]}
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )
          })()}

          {/* Filters */}
          {tab !== 'schedules' && tab !== 'leaves' && (
          <div className="bg-surface rounded-2xl p-5 shadow-sm flex flex-wrap gap-4 items-end">
            <div className="space-y-1 flex-1 min-w-[160px]">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t(kindText.person)}</label>
              <button
                type="button"
                onClick={() => setEmpPickerOpen(true)}
                className="w-full rounded-xl bg-background-light border-none px-3 py-2 text-sm font-bold text-text-dark text-left focus:ring-2 focus:ring-primary/20 outline-none flex items-center justify-between gap-2"
              >
                <span className="truncate">
                  {(() => {
                    const names = [
                      ...filterEmployees.map((id) => employees.find((e) => e.id === id)).filter((e) => !!e)
                        .map((e) => `${e.firstName} ${e.lastName}`),
                      ...selectedGroupNames().map((name) => `${name} · ${t(kindText.whole)}`),
                    ]
                    if (names.length === 0) return t(kindText.all)
                    if (names.length === 1) return names[0]
                    // Много выбранных — два первых имени и счётчик остальных, иначе кнопка расползается.
                    return names.length === 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`
                  })()}
                </span>
                <span className="material-symbols-outlined text-base text-text-light shrink-0">expand_more</span>
              </button>
              {/* Выбранные группы — чипами: видно весь список и можно снять по одной. */}
              {filterGroups.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {filterGroups.map((id) => {
                    const group = groupTree.find((d) => d.id === id)
                    if (!group) return null
                    return (
                      <span key={id} className="inline-flex items-center gap-1 rounded-lg bg-primary/10 pl-2 pr-1 py-0.5 text-[11px] font-bold text-primary">
                        <span className="truncate max-w-[140px]">{group.name}</span>
                        <button
                          type="button"
                          aria-label={t(kindText.remove, { name: group.name })}
                          onClick={() => toggleFilterGroup(id)}
                          className="material-symbols-outlined text-[13px] leading-none hover:text-primary-dark"
                        >
                          close
                        </button>
                      </span>
                    )
                  })}
                  {filterGroups.length > 1 && (
                    <button type="button" onClick={clearFilters} className="px-2 py-0.5 text-[11px] font-black uppercase tracking-wide text-text-light hover:text-primary">
                      {t(kindText.clear)}
                    </button>
                  )}
                </div>
              )}
            </div>

            {tab === 'daily' && (
              <div className="space-y-1">
                <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('common.date')}</label>
                <input
                  type="date"
                  value={filterDailyDate}
                  onChange={(e) => setFilterDailyDate(e.target.value)}
                  className="rounded-xl bg-background-light border-none px-3 py-2 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                />
              </div>
            )}

            {tab === 'weekly' && (
              <div className="space-y-1">
                <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.weekOf')}</label>
                <input type="date" value={weeklyAnchor} onChange={(e) => setWeeklyAnchor(e.target.value)}
                  className="rounded-xl bg-background-light border-none px-3 py-2 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none" />
              </div>
            )}

            {tab === 'monthly' && (
              <div className="space-y-1">
                <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.month')}</label>
                <input type="month" value={monthlyAnchor} onChange={(e) => setMonthlyAnchor(e.target.value)}
                  className="rounded-xl bg-background-light border-none px-3 py-2 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none" />
              </div>
            )}

            {tab === 'monthlyHours' && (
              <div className="space-y-1">
                <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.month')}</label>
                <input type="month" value={mhMonth} onChange={(e) => setMhMonth(e.target.value)}
                  className="rounded-xl bg-background-light border-none px-3 py-2 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none" />
              </div>
            )}

            {tab === 'monthlyHours' && (
              <div className="flex items-end gap-2 flex-wrap">
                <Button type="button" icon="send" variant="outline" onClick={() => setEmailReportModal(true)}>
                  {t('workHours.sendReport')}
                </Button>
                <Button type="button" icon="table_view" variant="outline" disabled={!!exporting}
                  onClick={() => downloadReport(`/api/reports/work-hours/monthly/excel?${tabelParams()}`, 'excel')}>
                  {exporting === 'excel' ? t('workHours.exporting') : t('workHours.excel')}
                </Button>
                <Button type="button" icon="picture_as_pdf" variant="outline" disabled={!!exporting}
                  onClick={() => downloadReport(`/api/reports/work-hours/monthly/pdf?${tabelParams()}`, 'pdf')}>
                  {exporting === 'pdf' ? t('workHours.exporting') : t('workHours.pdf')}
                </Button>
              </div>
            )}

            {(tab === 'daily' || tab === 'weekly' || tab === 'monthly') && (
              <div className="flex items-end gap-2 flex-wrap">
                {/* Выбор колонок: применяется и к таблице, и к Excel/PDF/письму. */}
                <div className="relative">
                  <Button type="button" icon="view_column" variant="outline" onClick={() => setColumnsMenuOpen((o) => !o)}>
                    {t('workHours.columns.button')}
                    {visibleColumns.size < ATTENDANCE_COLUMNS.length && (
                      <span className="ml-1 text-[10px] font-black text-primary">
                        {visibleColumns.size}/{ATTENDANCE_COLUMNS.length}
                      </span>
                    )}
                  </Button>
                  {columnsMenuOpen && (
                    <>
                      {/* Клик мимо панели закрывает её. */}
                      <div className="fixed inset-0 z-10" onClick={() => setColumnsMenuOpen(false)} />
                      <div className="absolute right-0 z-20 mt-1 w-64 rounded-xl border border-border-base bg-white p-2 shadow-lg">
                        <p className="px-2 pt-1 pb-2 text-[10px] leading-snug text-text-light">
                          {t('workHours.columns.hint')}
                        </p>
                        <div className="max-h-72 overflow-y-auto">
                          {ATTENDANCE_COLUMNS.map((key) => (
                            <label key={key} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-slate-75">
                              <input
                                type="checkbox"
                                checked={showCol(key)}
                                onChange={() => toggleColumn(key)}
                                className="h-3.5 w-3.5 accent-primary"
                              />
                              <span>{t(`workHours.columns.names.${key}`)}</span>
                            </label>
                          ))}
                        </div>
                        <button
                          type="button"
                          onClick={resetColumns}
                          className="mt-1 w-full rounded-md px-2 py-1.5 text-[10px] font-black uppercase tracking-widest text-primary hover:bg-slate-75"
                        >
                          {t('workHours.columns.showAll')}
                        </button>
                      </div>
                    </>
                  )}
                </div>
                <Button type="button" icon="send" variant="outline" onClick={() => setEmailReportModal(true)}>
                  {t('workHours.sendReport')}
                </Button>
                <Button
                  type="button"
                  icon="table_view"
                  variant="outline"
                  disabled={!!exporting}
                  onClick={() => {
                    const range = tab === 'daily'
                      ? { from: filterDailyDate, to: filterDailyDate }
                      : tab === 'weekly'
                        ? weekRange(weeklyAnchor)
                        : monthRange(monthlyAnchor)
                    const params = new URLSearchParams(peopleFilterQuery)
                    params.set('from', range.from)
                    params.set('to', range.to)
                    params.set('columns', columnsParam)
                    downloadReport(`/api/reports/work-hours/excel?${params}`, 'excel')
                  }}
                >
                  {exporting === 'excel' ? t('workHours.exporting') : t('workHours.excel')}
                </Button>
                <Button
                  type="button"
                  icon="picture_as_pdf"
                  variant="outline"
                  disabled={!!exporting}
                  onClick={() => {
                    const range = tab === 'daily'
                      ? { from: filterDailyDate, to: filterDailyDate }
                      : tab === 'weekly'
                        ? weekRange(weeklyAnchor)
                        : monthRange(monthlyAnchor)
                    const params = new URLSearchParams(peopleFilterQuery)
                    params.set('from', range.from)
                    params.set('to', range.to)
                    params.set('columns', columnsParam)
                    downloadReport(`/api/reports/work-hours/pdf?${params}`, 'pdf')
                  }}
                >
                  {exporting === 'pdf' ? t('workHours.exporting') : t('workHours.pdf')}
                </Button>
              </div>
            )}
          </div>
          )}

          {/* Окно выбора: слева дерево групп (отделы у сотрудников, факультеты у студентов),
              справа люди; «Несколько» включает накопительный выбор. */}
          {empPickerOpen && (
            <PeoplePicker
              title={t(kindText.pickTitle)}
              groups={groupTree}
              people={employees.map((e) => ({
                ...e,
                groupId: groupIdOf(e),
                groupName: (students ? blockTree.find((b) => b.id === e.housingBlockId)?.name : e.department?.name) ?? null,
              }))}
              selection={{ personIds: filterEmployees, groupIds: filterGroups }}
              onApply={(sel) => { setFilterEmployees(sel.personIds); setFilterGroups(sel.groupIds) }}
              onClose={() => setEmpPickerOpen(false)}
              text={{
                groupSearch: kindText.groupSearch,
                personSearch: kindText.personSearch,
                allGroups: kindText.allGroups,
                allPeople: kindText.all,
                noneInGroup: kindText.noneInGroup,
                selectWholeGroup: kindText.selectWhole,
                unselectWholeGroup: kindText.unselectWhole,
              }}
            />
          )}

          {/* Schedules — company work time templates */}
          {tab === 'schedules' && (() => {
            const pagedSchedules = pageSlice(schedules, schedulesPage)
            return (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <p className="text-xs text-text-light max-w-xl">
                  {t('workHours.schedulesIntroPrefix')}{' '}
                  <span className="font-bold text-text-dark">{t('workHours.schedulesIntroPath')}</span>.
                </p>
                <Button type="button" icon="add" onClick={openCreateSchedule}>
                  {t('workHours.newSchedule')}
                </Button>
              </div>
              <div className="bg-surface rounded-2xl shadow-sm overflow-hidden">
                <div className="px-5 py-3 border-b border-border flex items-center justify-between">
                  <p className="text-xs font-black text-text-light uppercase tracking-widest">{t('workHours.schedulesCount', { count: schedules.length })}</p>
                </div>
                {loading ? (
                  <div className="flex items-center justify-center py-16">
                    <span className="spinner-ring text-3xl text-primary" aria-hidden="true" />
                  </div>
                ) : schedules.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 gap-2 text-text-light px-4 text-center">
                    <span className="material-symbols-outlined text-4xl">calendar_month</span>
                    <p className="text-sm">{t('workHours.noSchedulesYet')}</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[10px] font-black text-text-light uppercase tracking-widest border-b border-border">
                          <th className="px-5 py-3 text-left">{t('common.name')}</th>
                          <th className="px-5 py-3 text-left">{t('common.type')}</th>
                          <th className="px-5 py-3 text-left">{t('workHours.hours')}</th>
                          <th className="px-5 py-3 text-left">{t('workHours.normPerDay')}</th>
                          <th className="px-5 py-3 text-right">{t('common.actions')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pagedSchedules.rows.map((s) => (
                          <tr key={s.id} className="border-b border-border last:border-none hover:bg-background-light transition-colors">
                            <td className="px-5 py-3 font-bold text-text-dark">
                              <div className="flex items-center gap-2">
                                <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: s.color || '#6366f1' }} />
                                {s.name}
                              </div>
                            </td>
                            <td className="px-5 py-3 text-text-dark">{t(`workHours.scheduleType.${s.type}`, { defaultValue: s.type })}</td>
                            <td className="px-5 py-3 text-text-light text-xs">
                              {s.type === 'Flexible'
                                ? '—'
                                : s.type === 'Multi'
                                  ? (s.shifts && s.shifts.length > 0
                                    ? s.shifts.map(sh => `${sh.name} ${sh.shiftStart}–${sh.shiftEnd}`).join(', ')
                                    : '—')
                                  : `${timeToInput(s.shiftStart) || '—'} – ${timeToInput(s.shiftEnd) || '—'}`}
                            </td>
                            <td className="px-5 py-3 text-text-light">
                              {s.type === 'Multi' && s.shifts && s.shifts.length > 0
                                ? s.shifts.map(sh => `${sh.name}: ${sh.requiredHoursPerDay}h`).join(', ')
                                : `${s.requiredHoursPerDay} h`}
                            </td>
                            <td className="px-5 py-3 text-right">
                              <button
                                type="button"
                                onClick={() => openAssignModal(s)}
                                className="text-[10px] font-black uppercase tracking-wider hover:underline mr-3"
                                style={{ color: s.color || '#6366f1' }}
                              >
                                {t('workHours.assign')}
                              </button>
                              <button
                                type="button"
                                onClick={() => openEditSchedule(s)}
                                className="text-[10px] font-black uppercase tracking-wider text-primary hover:underline mr-3"
                              >
                                {t('common.edit')}
                              </button>
                              <button
                                type="button"
                                onClick={() => { setEditingSchedule(s); setScheduleModal('delete') }}
                                className="text-[10px] font-black uppercase tracking-wider text-error-text hover:underline"
                              >
                                {t('common.delete')}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {!loading && <Pagination page={pagedSchedules.page} totalPages={pagedSchedules.totalPages} total={schedules.length} onPage={setSchedulesPage} />}
              </div>
            </div>
            )
          })()}

          {/* Daily Report — one day, only employees with assigned schedule */}
          {tab === 'monthlyHours' && <MonthlyHoursTable month={mhMonth} filterQuery={peopleFilterQuery} />}

          {tab === 'daily' && (() => {
            const filteredDaily = daily.filter(d => {
              if (d.isDayOff) return subTab === 'all'
              switch (subTab) {
                case 'present': return !d.isAbsent && d.checkInUtc != null
                case 'absent': return d.isAbsent
                case 'late': return (d.lateMinutes ?? 0) > 0
                case 'early': return (d.earlyLeaveMinutes ?? 0) > 0
                case 'overtime': return d.overtimeHours > 0
                case 'permission': return (d.permissionHours ?? 0) > 0
                default: return true
              }
            })
            const pagedDaily = pageSlice(filteredDaily, dailyPage)
            return (
            <div className="bg-surface rounded-2xl shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-border flex items-center justify-between">
                <p className="text-xs font-black text-text-light uppercase tracking-widest">
                  {t('workHours.employeesOnDate', { count: filteredDaily.length, date: formatDateOnly(filterDailyDate) })}
                </p>
              </div>
              {loading ? (
                <div className="flex items-center justify-center py-16">
                  <span className="spinner-ring text-3xl text-primary" aria-hidden="true" />
                </div>
              ) : daily.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-2 text-text-light px-4 text-center">
                  <span className="material-symbols-outlined text-4xl">event_busy</span>
                  <p className="text-sm">{t('workHours.noEmployeesWithSchedule')}</p>
                </div>
              ) : filteredDaily.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-2 text-text-light">
                  <span className="material-symbols-outlined text-4xl">check_circle</span>
                  <p className="text-sm">{t('workHours.noEmployeesMatchFilter')}</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[10px] font-black text-text-light uppercase tracking-widest border-b border-border">
                        {showCol('employee') && <th className="px-5 py-3 text-left">{t('workHours.employee')}</th>}
                        {showCol('schedule') && <th className="px-5 py-3 text-left">{t('workHours.schedule')}</th>}
                        {showCol('shift') && <th className="px-5 py-3 text-left">{t('workHours.shift')}</th>}
                        {showCol('checkIn') && <th className="px-5 py-3 text-left">{t('workHours.checkIn')}</th>}
                        {showCol('checkOut') && <th className="px-5 py-3 text-left">{t('workHours.checkOut')}</th>}
                        {showCol('hours') && <th className="px-5 py-3 text-right">{t('workHours.actual')}</th>}
                        {showCol('norm') && <th className="px-5 py-3 text-right">{t('workHours.norm')}</th>}
                        {showCol('late') && <th className="px-5 py-3 text-right">{t('workHours.late')}</th>}
                        {showCol('early') && <th className="px-5 py-3 text-right">{t('workHours.early')}</th>}
                        {showCol('overtime') && <th className="px-5 py-3 text-right">{t('workHours.ot')}</th>}
                        <th className="px-5 py-3 text-right">{t('common.edit')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedDaily.rows.map((d) => (
                        <tr key={`${d.employeeId}-${d.date}`} className={`border-b border-border last:border-none hover:bg-background-light transition-colors ${d.isAbsent ? 'opacity-60' : ''}`}>
                          {showCol('employee') && (
                          <td className="px-5 py-3 font-bold text-text-dark">
                            {d.employeeName ?? '—'}
                            {d.corrected && <span className="ml-1 text-[9px] font-black text-amber-700 uppercase tracking-widest" title={d.correctionComment ?? t('workHours.corrected')}>✎</span>}
                          </td>
                          )}
                          {showCol('schedule') && (
                          <td className="px-5 py-3 text-text-light text-xs">
                            {d.isDayOff ? <span className="text-slate-400 italic">{t('workHours.dayOff')}</span> : (d.scheduleName ?? '—')}
                          </td>
                          )}
                          {showCol('shift') && <td className="px-5 py-3 text-text-light font-mono text-xs">{d.shiftStart && d.shiftEnd ? `${d.shiftStart}–${d.shiftEnd}` : '—'}</td>}
                          {showCol('checkIn') && (
                          <td className="px-5 py-3 font-mono">
                            {d.isDayOff ? <span className="text-slate-400">—</span>
                              : d.checkInUtc ? <span className="text-green-700">{formatTimeOnly(d.checkInUtc)}</span>
                              : d.onLeave ? <span className="text-indigo-600 font-bold" title={d.leaveType ?? undefined}>{t(d.leaveType === 'DayOff' ? 'workHours.onDayOff' : 'workHours.onLeave')}</span>
                              : <span className="text-error-text font-bold">{t('workHours.absent')}</span>}
                          </td>
                          )}
                          {showCol('checkOut') && <td className="px-5 py-3 font-mono">{d.checkOutUtc ? <span className="text-blue-700">{formatTimeOnly(d.checkOutUtc)}</span> : <span className="text-text-light">—</span>}</td>}
                          {showCol('hours') && (
                          <td className="px-5 py-3 text-right font-mono text-text-dark">
                            {d.totalHours > 0 ? formatHM(d.totalHours) : <span className="text-text-light">—</span>}
                            {(d.permissionHours ?? 0) > 0 && (
                              <span className="ml-1 text-[10px] font-bold text-sky-600" title={`${d.permissionFrom}–${d.permissionTo}`}>
                                {d.permissionShowInReport ? `−${formatHM(d.permissionHours!)}` : `(${formatHM(d.permissionHours!)})`}
                              </span>
                            )}
                          </td>
                          )}
                          {showCol('norm') && <td className="px-5 py-3 text-right font-mono text-text-light">{d.normHours > 0 ? formatHM(d.normHours) : '—'}</td>}
                          {showCol('late') && <td className="px-5 py-3 text-right">{(d.lateMinutes ?? 0) > 0 ? <span className="text-amber-700 font-bold">+{formatMinutesHM(d.lateMinutes!)}</span> : <span className="text-text-light">—</span>}</td>}
                          {showCol('early') && <td className="px-5 py-3 text-right">{(d.earlyLeaveMinutes ?? 0) > 0 ? <span className="text-orange-600 font-bold">-{formatMinutesHM(d.earlyLeaveMinutes!)}</span> : <span className="text-text-light">—</span>}</td>}
                          {showCol('overtime') && <td className="px-5 py-3 text-right">{d.overtimeHours > 0 ? <span className="text-purple-700 font-bold">+{formatHM(d.overtimeHours)}</span> : <span className="text-text-light">—</span>}</td>}
                          <td className="px-5 py-3 text-right space-x-2 whitespace-nowrap">
                            <button type="button" onClick={() => openCorrection(d)} className="text-[10px] font-black uppercase tracking-wider text-primary hover:underline">{t('common.edit')}</button>
                            <button type="button" onClick={() => openPermission(d)} className={`text-[10px] font-black uppercase tracking-wider hover:underline ${(d.permissionHours ?? 0) > 0 ? 'text-sky-600' : 'text-text-light'}`}>
                              {t('workHours.permissionShort')}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {!loading && <Pagination page={pagedDaily.page} totalPages={pagedDaily.totalPages} total={filteredDaily.length} onPage={setDailyPage} />}
            </div>
            )
          })()}


          {/* Weekly / Monthly Period Reports — per-employee per-day breakdown + totals */}
          {(tab === 'weekly' || tab === 'monthly') && (() => {
            const range = tab === 'weekly' ? weekRange(weeklyAnchor) : monthRange(monthlyAnchor)
            const byEmp = new Map<string, { name: string; rows: PeriodRow[] }>()
            for (const r of period) {
              if (!byEmp.has(r.employeeId)) byEmp.set(r.employeeId, { name: r.employeeName ?? '—', rows: [] })
              byEmp.get(r.employeeId)!.rows.push(r)
            }
            // For each employee: filter rows by subTab, then hide employee if no rows match
            const filteredEmps = Array.from(byEmp.values())
              .map(emp => ({
                ...emp,
                visibleRows: subTab === 'all' ? emp.rows : emp.rows.filter(r => rowMatchesSubTab(r, subTab)),
              }))
              .filter(emp => emp.visibleRows.length > 0)
            // Səhifədə 50 işçi bloku (hər blok — bir işçinin cədvəli).
            const pagedEmps = pageSlice(filteredEmps, periodPage)

            return (
              <div className="space-y-4">
                <div className="bg-surface rounded-2xl shadow-sm px-5 py-3 text-xs font-black text-text-light uppercase tracking-widest">
                  {formatDateOnly(range.from + 'T00:00:00')} — {formatDateOnly(range.to + 'T00:00:00')} · {t('workHours.employeesCount', { count: filteredEmps.length })}
                </div>
                {loading ? (
                  <div className="flex items-center justify-center py-16">
                    <span className="spinner-ring text-3xl text-primary" aria-hidden="true" />
                  </div>
                ) : byEmp.size === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 gap-2 text-text-light bg-surface rounded-2xl">
                    <span className="material-symbols-outlined text-4xl">event_busy</span>
                    <p className="text-sm">{t('workHours.noEmployeesAssignedShort')}</p>
                  </div>
                ) : filteredEmps.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 gap-2 text-text-light bg-surface rounded-2xl">
                    <span className="material-symbols-outlined text-4xl">check_circle</span>
                    <p className="text-sm">{t('workHours.noEmployeesMatchFilter')}</p>
                  </div>
                ) : (
                  pagedEmps.rows.map((emp) => {
                    const workRows = emp.rows.filter(r => !r.isDayOff)
                    const present = workRows.filter(r => r.checkInUtc).length
                    const absent = workRows.filter(r => r.isAbsent).length
                    const totalActual = emp.rows.reduce((s, r) => s + r.totalHours, 0)
                    const totalNorm = workRows.reduce((s, r) => s + r.normHours, 0)
                    const totalOT = emp.rows.reduce((s, r) => s + r.overtimeHours, 0)
                    const totalLate = emp.rows.reduce((s, r) => s + (r.lateMinutes ?? 0), 0)
                    const totalEarlyDays = emp.rows.filter(r => (r.earlyLeaveMinutes ?? 0) > 0).length
                    const deficit = Math.max(0, totalNorm - totalActual - totalOT)
                    return (
                      <div key={emp.name} className="bg-surface rounded-2xl shadow-sm overflow-hidden">
                        <div className="px-5 py-3 border-b border-border flex flex-wrap items-center justify-between gap-3">
                          <p className="text-sm font-black text-text-dark">{emp.name}</p>
                          <div className="flex flex-wrap gap-4 text-[10px] font-black text-text-light uppercase tracking-widest">
                            <span>{t('workHours.present')}: <strong className="text-text-dark">{present}/{workRows.length}</strong></span>
                            {absent > 0 && <span>{t('workHours.absentLabel')}: <strong className="text-error-text">{absent}d</strong></span>}
                            <span>{t('workHours.actual')}: <strong className="text-text-dark">{formatHM(totalActual)}</strong></span>
                            <span>{t('workHours.norm')}: <strong className="text-text-dark">{formatHM(totalNorm)}</strong></span>
                            {totalOT > 0 && <span>{t('workHours.ot')}: <strong className="text-purple-700">+{formatHM(totalOT)}</strong></span>}
                            {deficit > 0.05 && <span>{t('workHours.deficit')}: <strong className="text-red-600">-{formatHM(deficit)}</strong></span>}
                            {totalLate > 0 && <span>{t('workHours.late')}: <strong className="text-amber-700">{formatMinutesHM(totalLate)}</strong></span>}
                            {totalEarlyDays > 0 && <span>{t('workHours.early')}: <strong className="text-orange-600">{totalEarlyDays}d</strong></span>}
                          </div>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-[10px] font-black text-text-light uppercase tracking-widest border-b border-border">
                                <th className="px-5 py-2 text-left">{t('common.date')}</th>
                                <th className="px-5 py-2 text-left">{t('workHours.checkIn')}</th>
                                <th className="px-5 py-2 text-left">{t('workHours.checkOut')}</th>
                                <th className="px-5 py-2 text-right">{t('workHours.actual')}</th>
                                <th className="px-5 py-2 text-right">{t('workHours.norm')}</th>
                                <th className="px-5 py-2 text-right">{t('workHours.late')}</th>
                                <th className="px-5 py-2 text-right">{t('workHours.early')}</th>
                                <th className="px-5 py-2 text-right">{t('workHours.ot')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {emp.visibleRows.map((r) => (
                                <tr key={r.date} className={`border-b border-border last:border-none ${r.isAbsent ? 'opacity-60' : ''} ${r.isDayOff ? 'bg-slate-50' : ''}`}>
                                  <td className="px-5 py-2 text-text-dark">
                                    {formatDateOnly(r.date)}
                                    {r.corrected && <span className="ml-1 text-[9px] text-amber-700" title={t('workHours.corrected')}>✎</span>}
                                    {r.isDayOff && <span className="ml-1 text-[9px] text-slate-400 italic">{t('workHours.dayOffLower')}</span>}
                                  </td>
                                  <td className="px-5 py-2 font-mono">
                                    {r.isDayOff ? <span className="text-slate-400">—</span>
                                      : r.checkInUtc ? <span className="text-green-700">{formatTimeOnly(r.checkInUtc)}</span>
                                      : r.onLeave ? <span className="text-indigo-600 font-bold" title={r.leaveType ?? undefined}>{t(r.leaveType === 'DayOff' ? 'workHours.onDayOff' : 'workHours.onLeave')}</span>
                                      : <span className="text-error-text font-bold">{t('workHours.absent')}</span>}
                                  </td>
                                  <td className="px-5 py-2 font-mono">
                                    {r.checkOutUtc
                                      ? <span className={(r.earlyLeaveMinutes ?? 0) > 0 ? 'text-orange-600' : 'text-blue-700'}>{formatTimeOnly(r.checkOutUtc)}</span>
                                      : <span className="text-text-light">—</span>}
                                  </td>
                                  <td className="px-5 py-2 text-right font-mono text-text-dark">{r.totalHours > 0 ? formatHM(r.totalHours) : <span className="text-text-light">—</span>}</td>
                                  <td className="px-5 py-2 text-right font-mono text-text-light">{r.normHours > 0 ? formatHM(r.normHours) : '—'}</td>
                                  <td className="px-5 py-2 text-right">{(r.lateMinutes ?? 0) > 0 ? <span className="text-amber-700 font-bold">+{formatMinutesHM(r.lateMinutes!)}</span> : <span className="text-text-light">—</span>}</td>
                                  <td className="px-5 py-2 text-right">{(r.earlyLeaveMinutes ?? 0) > 0 ? <span className="text-orange-600 font-bold">-{formatMinutesHM(r.earlyLeaveMinutes!)}</span> : <span className="text-text-light">—</span>}</td>
                                  <td className="px-5 py-2 text-right">{r.overtimeHours > 0 ? <span className="text-purple-700 font-bold">+{formatHM(r.overtimeHours)}</span> : <span className="text-text-light">—</span>}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )
                  })
                )}
                {!loading && pagedEmps.totalPages > 1 && (
                  <div className="bg-surface rounded-2xl shadow-sm">
                    <Pagination page={pagedEmps.page} totalPages={pagedEmps.totalPages} total={filteredEmps.length} onPage={setPeriodPage} bordered={false} />
                  </div>
                )}
              </div>
            )
          })()}

          {/* Leaves tab */}
          {tab === 'leaves' && (
            <div className="space-y-6">
              {/* Admin-assigned leaves */}
              <div className="space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-bold text-text-dark">{t('workHours.adminAssignedLeaves')}</p>
                    <p className="text-xs text-text-light">{t('workHours.adminAssignedLeavesDesc')}</p>
                  </div>
                  <Button type="button" icon="add" onClick={() => setLeaveModal('create')}>
                    {t('workHours.newLeave')}
                  </Button>
                </div>
                {(() => {
                  const leaveDepts = Array.from(new Set(leaves.map(l => l.department).filter((d): d is string => !!d))).sort()
                  const q = leaveSearch.trim().toLowerCase()
                  const leavesFiltered = leaves.filter(lv =>
                    (!q || lv.employeeName.toLowerCase().includes(q)) &&
                    (!leaveDept || lv.department === leaveDept))
                  const pagedLeaves = pageSlice(leavesFiltered, leavesPage)
                  return (
                <div className="bg-surface rounded-2xl shadow-sm overflow-hidden">
                  <div className="px-5 py-3 border-b border-border flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs font-black text-text-light uppercase tracking-widest">{t('workHours.leavesCount', { count: leavesFiltered.length })}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        value={leaveSearch}
                        onChange={(e) => setLeaveSearch(e.target.value)}
                        placeholder={t('workHours.empSearchPlaceholder')}
                        className="w-44 rounded-xl bg-background-light border-none px-3 py-2 text-xs font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                      />
                      <select
                        value={leaveDept}
                        onChange={(e) => setLeaveDept(e.target.value)}
                        className="rounded-xl bg-background-light border-none px-3 py-2 text-xs font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                      >
                        <option value="">{t('people.allDepartments')}</option>
                        {leaveDepts.map(d => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </div>
                  </div>
                  {leavesLoading ? (
                    <div className="flex items-center justify-center py-16">
                      <span className="spinner-ring text-3xl text-primary" aria-hidden="true" />
                    </div>
                  ) : leavesFiltered.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 gap-2 text-text-light px-4 text-center">
                      <span className="material-symbols-outlined text-4xl">beach_access</span>
                      <p className="text-sm">{t('workHours.noLeavesYet')}</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-[10px] font-black text-text-light uppercase tracking-widest border-b border-border">
                            <th className="px-5 py-3 text-left">{t('workHours.employee')}</th>
                            <th className="px-5 py-3 text-left">{t('common.type')}</th>
                            <th className="px-5 py-3 text-left">{t('workHours.dates')}</th>
                            <th className="px-5 py-3 text-left">{t('workHours.reason')}</th>
                            <th className="px-5 py-3 text-left">{t('common.status')}</th>
                            <th className="px-5 py-3 text-right">{t('common.actions')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pagedLeaves.rows.map((lv) => (
                            <tr key={lv.id} className="border-b border-border last:border-none hover:bg-background-light transition-colors">
                              <td className="px-5 py-3 font-bold text-text-dark">
                                <p>{lv.employeeName}</p>
                                {lv.department && <p className="text-[10px] text-text-muted">{lv.department}</p>}
                              </td>
                              <td className="px-5 py-3">
                                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold ${lv.leaveType === 'Vacation' ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'}`}>
                                  {lv.leaveType === 'Vacation' ? t('workHours.vacation') : t('workHours.dayOffNoun')}
                                </span>
                                <span className={`ml-1.5 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${lv.isPaid ? 'bg-green-50 text-green-700' : 'bg-yellow-50 text-yellow-700'}`}>
                                  {lv.isPaid ? t('workHours.paid') : t('workHours.unpaid')}
                                </span>
                              </td>
                              <td className="px-5 py-3 text-text-light font-mono text-xs">
                                {lv.startDate} — {lv.endDate}
                              </td>
                              <td className="px-5 py-3 text-text-light text-xs max-w-[200px] truncate">{lv.reason ?? '—'}</td>
                              <td className="px-5 py-3">
                                <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-bold ${
                                  lv.status === 'Approved' ? 'bg-green-50 text-green-700' :
                                  lv.status === 'Rejected' ? 'bg-red-50 text-red-700' :
                                  lv.status === 'Cancelled' ? 'bg-slate-100 text-slate-500' :
                                  'bg-amber-50 text-amber-700'
                                }`}>
                                  {t(`workHours.status.${lv.status}`, { defaultValue: lv.status })}
                                </span>
                              </td>
                              <td className="px-5 py-3 text-right space-x-2 whitespace-nowrap">
                                {lv.status === 'Pending' && (
                                  <>
                                    <button type="button" onClick={() => approveLeave(lv.id)} className="text-[10px] font-black uppercase tracking-wider text-green-700 hover:underline">
                                      {t('workHours.approve')}
                                    </button>
                                    <button type="button" onClick={() => rejectLeave(lv.id)} className="text-[10px] font-black uppercase tracking-wider text-error-text hover:underline">
                                      {t('workHours.reject')}
                                    </button>
                                  </>
                                )}
                                {lv.status !== 'Cancelled' && (
                                  <button type="button" onClick={() => openEditLeave(lv)} className="text-[10px] font-black uppercase tracking-wider text-primary hover:underline">
                                    {t('common.edit')}
                                  </button>
                                )}
                                {(lv.status === 'Approved' || lv.status === 'Pending') && (
                                  <button type="button" onClick={() => cancelLeave(lv.id)} className="text-[10px] font-black uppercase tracking-wider text-amber-700 hover:underline">
                                    {t('workHours.cancelLeave')}
                                  </button>
                                )}
                                {(lv.status === 'Rejected' || lv.status === 'Cancelled') && (
                                  <button type="button" onClick={() => deleteLeave(lv.id)} className="text-[10px] font-black uppercase tracking-wider text-error-text hover:underline">
                                    {t('common.delete')}
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {!leavesLoading && <Pagination page={pagedLeaves.page} totalPages={pagedLeaves.totalPages} total={leavesFiltered.length} onPage={setLeavesPage} />}
                </div>
                  )
                })()}
              </div>

              {/* Self-service requests */}
              <div className="space-y-3">
                <div>
                  <p className="text-sm font-bold text-text-dark">{t('workHours.selfServiceRequests')}</p>
                  <p className="text-xs text-text-light">{t('workHours.selfServiceRequestsDesc')}</p>
                </div>
                <div className="bg-surface rounded-2xl shadow-sm overflow-hidden">
                  {(() => {
                    const ssFiltered = selfServiceReqs.filter((r) => r.status === ssTab)
                    const pagedSs = pageSlice(ssFiltered, ssPage)
                    const ssCount = (s: 'Pending' | 'Approved' | 'Rejected') => selfServiceReqs.filter((r) => r.status === s).length
                    return (
                      <>
                  <div className="px-5 py-3 border-b border-border flex flex-wrap items-center justify-between gap-3">
                    <div className="flex gap-1 bg-background-light rounded-xl p-1">
                      {(['Pending', 'Approved', 'Rejected'] as const).map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setSsTab(s)}
                          className={`px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-1.5 ${ssTab === s ? 'bg-primary text-white shadow-sm' : 'text-text-light hover:text-text-dark'}`}
                        >
                          {t(`workHours.status.${s}`, { defaultValue: s })}
                          <span className={`text-[9px] font-black px-1.5 py-0.5 rounded-md leading-none ${ssTab === s ? 'bg-white/20' : 'bg-surface text-text-muted'}`}>
                            {ssCount(s)}
                          </span>
                        </button>
                      ))}
                    </div>
                    <p className="text-xs font-black text-text-light uppercase tracking-widest">{t('workHours.requestsCount', { count: ssFiltered.length })}</p>
                  </div>
                  {selfServiceLoading ? (
                    <div className="flex items-center justify-center py-16">
                      <span className="spinner-ring text-3xl text-primary" aria-hidden="true" />
                    </div>
                  ) : ssFiltered.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 gap-2 text-text-light px-4 text-center">
                      <span className="material-symbols-outlined text-4xl">inbox</span>
                      <p className="text-sm">{t('workHours.noSelfServiceRequests')}</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-[10px] font-black text-text-light uppercase tracking-widest border-b border-border">
                            <th className="px-5 py-3 text-left">{t('workHours.employee')}</th>
                            <th className="px-5 py-3 text-left">{t('common.type')}</th>
                            <th className="px-5 py-3 text-left">{t('common.from')}</th>
                            <th className="px-5 py-3 text-left">{t('common.to')}</th>
                            <th className="px-5 py-3 text-left">{t('workHours.comment')}</th>
                            <th className="px-5 py-3 text-left">{t('common.status')}</th>
                            <th className="px-5 py-3 text-right">{t('common.actions')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pagedSs.rows.map((req) => (
                            <tr key={req.id} className="border-b border-border last:border-none hover:bg-background-light transition-colors">
                              <td className="px-5 py-3 font-bold text-text-dark">{req.employeeName}</td>
                              <td className="px-5 py-3">
                                <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-bold ${
                                  req.type === 'Vacation' ? 'bg-emerald-50 text-emerald-700' :
                                  req.type === 'Overtime' ? 'bg-amber-50 text-amber-700' :
                                  'bg-blue-50 text-blue-700'
                                }`}>
                                  {t(`workHours.requestType.${req.type}`, { defaultValue: req.type })}
                                </span>
                              </td>
                              <td className="px-5 py-3 text-text-light font-mono text-xs">
                                {new Date(req.requestedTimeUtc).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                              </td>
                              <td className="px-5 py-3 text-text-light font-mono text-xs">
                                {req.requestedEndTimeUtc ? new Date(req.requestedEndTimeUtc).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—'}
                              </td>
                              <td className="px-5 py-3 text-text-light text-xs max-w-[180px] truncate">{req.comment ?? '—'}</td>
                              <td className="px-5 py-3">
                                <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-bold ${
                                  req.status === 'Approved' ? 'bg-green-50 text-green-700' :
                                  req.status === 'Rejected' ? 'bg-red-50 text-red-700' :
                                  'bg-amber-50 text-amber-700'
                                }`}>
                                  {t(`workHours.status.${req.status}`, { defaultValue: req.status })}
                                </span>
                              </td>
                              <td className="px-5 py-3 text-right space-x-2">
                                {req.status === 'Pending' && (
                                  <>
                                    <button type="button" onClick={() => approveSelfServiceReq(req.id)} className="text-[10px] font-black uppercase tracking-wider text-green-700 hover:underline">
                                      {t('workHours.approve')}
                                    </button>
                                    <button type="button" onClick={() => rejectSelfServiceReq(req.id)} className="text-[10px] font-black uppercase tracking-wider text-error-text hover:underline">
                                      {t('workHours.reject')}
                                    </button>
                                  </>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {!selfServiceLoading && <Pagination page={pagedSs.page} totalPages={pagedSs.totalPages} total={ssFiltered.length} onPage={setSsPage} />}
                      </>
                    )
                  })()}
                </div>
              </div>
            </div>
          )}

        </div>
      </div>

      <Modal
        isOpen={scheduleModal === 'create' || scheduleModal === 'edit'}
        onClose={() => { setScheduleModal(null); setEditingSchedule(null) }}
        title={scheduleModal === 'create' ? t('workHours.newWorkSchedule') : t('workHours.editWorkSchedule')}
      >
        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('common.name')}</label>
            <Input
              value={scheduleForm.name}
              onChange={(e) => setScheduleForm((p) => ({ ...p, name: e.target.value }))}
              placeholder={t('workHours.scheduleNamePlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.color')}</label>
            <div className="flex items-center gap-2 flex-wrap">
              {['#6366f1','#8b5cf6','#ec4899','#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#3b82f6','#64748b'].map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setScheduleForm(p => ({ ...p, color: c }))}
                  className="w-7 h-7 rounded-full border-2 transition-all"
                  style={{
                    backgroundColor: c,
                    borderColor: scheduleForm.color === c ? '#000' : 'transparent',
                    outline: scheduleForm.color === c ? `2px solid ${c}` : 'none',
                    outlineOffset: 2,
                  }}
                />
              ))}
              <label className="w-7 h-7 rounded-full border-2 border-dashed border-black/20 flex items-center justify-center cursor-pointer hover:border-black/40 transition-colors overflow-hidden relative"
                title={t('workHours.customColor')}>
                <input
                  type="color"
                  value={scheduleForm.color}
                  onChange={e => setScheduleForm(p => ({ ...p, color: e.target.value }))}
                  className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                />
                <span className="material-symbols-outlined text-[14px] text-text-muted pointer-events-none">colorize</span>
              </label>
              <span className="text-xs font-mono text-text-muted ml-1">{scheduleForm.color}</span>
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('common.type')}</label>
            <select
              value={scheduleForm.type}
              onChange={(e) => {
                const newType = e.target.value as typeof scheduleForm.type
                setScheduleForm((p) => ({ ...p, type: newType }))
                if (newType === 'Multi' && scheduleShifts.length === 0) {
                  setScheduleShifts([{ name: 'Day', shiftStart: '08:00', shiftEnd: '17:00', validEntryFrom: '06:00', validEntryTo: '10:00', requiredHoursPerDay: 8, sortOrder: 0 }])
                }
              }}
              className="w-full rounded-xl bg-background-light border-none px-3 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
            >
              <option value="Standard">{t('workHours.typeStandard')}</option>
              <option value="Flexible">{t('workHours.typeFlexible')}</option>
              <option value="Multi">{t('workHours.typeMulti')}</option>
              <option value="Off">{t('workHours.typeOff')}</option>
            </select>
          </div>
          {scheduleForm.type !== 'Flexible' && scheduleForm.type !== 'Off' && (
            <label className="flex items-start gap-2.5 rounded-xl bg-background-light px-4 py-3 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 rounded accent-primary"
                checked={scheduleForm.countEarlyArrival}
                onChange={(e) => setScheduleForm((p) => ({ ...p, countEarlyArrival: e.target.checked }))}
              />
              <div className="text-xs leading-relaxed">
                <div className="font-black text-text-dark">{t('workHours.countEarlyArrival')}</div>
                <div className="text-text-muted">{t('workHours.countEarlyArrivalDesc')}</div>
              </div>
            </label>
          )}
          {scheduleForm.type !== 'Flexible' && scheduleForm.type !== 'Off' && (
            <div className="space-y-1.5">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.overtimeDailyThreshold')}</label>
              <Input
                type="number"
                value={scheduleForm.overtimeDailyThresholdMinutes}
                onChange={(e) => setScheduleForm((p) => ({ ...p, overtimeDailyThresholdMinutes: e.target.value }))}
                min={0}
                step={1}
              />
              <p className="text-[10px] text-text-muted">{t('workHours.overtimeDailyThresholdDesc')}</p>
            </div>
          )}
          {scheduleForm.type !== 'Flexible' && scheduleForm.type !== 'Off' && (
            <div className="space-y-1.5">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.lateToleranceMinutes')}</label>
              <Input
                type="number"
                value={scheduleForm.lateToleranceMinutes}
                onChange={(e) => setScheduleForm((p) => ({ ...p, lateToleranceMinutes: e.target.value }))}
                min={0}
                step={1}
              />
              <p className="text-[10px] text-text-muted">{t('workHours.lateToleranceMinutesDesc')}</p>
            </div>
          )}
          <label className="flex items-start gap-2.5 rounded-xl bg-background-light px-4 py-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 rounded accent-primary"
              checked={scheduleForm.lunchBreakDeductionEnabled}
              onChange={(e) => setScheduleForm((p) => ({ ...p, lunchBreakDeductionEnabled: e.target.checked }))}
            />
            <div className="text-xs leading-relaxed">
              <div className="font-black text-text-dark">{t('workHours.lunchBreakDeduction')}</div>
              <div className="text-text-muted">{t('workHours.lunchBreakDeductionDesc')}</div>
            </div>
          </label>
          {scheduleForm.lunchBreakDeductionEnabled && (
            <div className="space-y-1.5">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.lunchBreakMinutes')}</label>
              <Input
                type="number"
                value={scheduleForm.lunchBreakMinutes}
                onChange={(e) => setScheduleForm((p) => ({ ...p, lunchBreakMinutes: e.target.value }))}
                min={0}
                step={5}
              />
              <p className="text-[10px] text-text-muted">{t('workHours.lunchBreakMinutesDesc')}</p>
            </div>
          )}
          {scheduleForm.type === 'Flexible' && (
            <div className="flex items-start gap-2.5 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
              <span className="material-symbols-outlined text-amber-600 text-lg mt-0.5 shrink-0">warning</span>
              <p className="text-xs text-amber-800 leading-relaxed">
                <strong className="font-black">{t('workHours.flexibleScheduleTitle')}:</strong> {t('workHours.flexibleScheduleDesc')}
              </p>
            </div>
          )}
          {scheduleForm.type === 'Off' && (
            <div className="flex items-start gap-2.5 rounded-xl bg-info-bg border border-info-text/20 px-4 py-3">
              <span className="material-symbols-outlined text-info-text text-lg mt-0.5 shrink-0">event_busy</span>
              <p className="text-xs text-info-text leading-relaxed">
                <strong className="font-black">{t('workHours.offScheduleTitle')}:</strong> {t('workHours.offScheduleDesc')}
              </p>
            </div>
          )}
          {scheduleForm.type === 'Standard' && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.shiftStart')}</label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="^([01][0-9]|2[0-3]):[0-5][0-9]$"
                  placeholder="HH:MM"
                  maxLength={5}
                  value={scheduleForm.shiftStart}
                  onChange={(e) => setScheduleForm((p) => ({ ...p, shiftStart: maskHHMM(e.target.value) }))}
                  className="w-full rounded-xl bg-background-light border-none px-3 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.shiftEnd')}</label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="^([01][0-9]|2[0-3]):[0-5][0-9]$"
                  placeholder="HH:MM"
                  maxLength={5}
                  value={scheduleForm.shiftEnd}
                  onChange={(e) => setScheduleForm((p) => ({ ...p, shiftEnd: maskHHMM(e.target.value) }))}
                  className="w-full rounded-xl bg-background-light border-none px-3 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none font-mono"
                />
              </div>
            </div>
          )}
          {scheduleForm.type !== 'Flexible' && scheduleForm.type !== 'Multi' && (
            <div className="space-y-1.5">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">
                {t('workHours.normComputed')}
              </label>
              <Input
                type="text"
                value={(() => {
                  const h = computeShiftHours(scheduleForm.shiftStart, scheduleForm.shiftEnd)
                  return h !== null ? `${h.toFixed(2)} h` : '—'
                })()}
                readOnly
                className="opacity-70 cursor-not-allowed"
              />
              {(() => {
                const s = scheduleForm.shiftStart, e = scheduleForm.shiftEnd
                const re = /^([01][0-9]|2[0-3]):([0-5][0-9])$/
                return re.test(s) && re.test(e) && e <= s ? (
                  <p className="text-[10px] font-bold text-indigo-600 flex items-center gap-1">
                    <span className="material-symbols-outlined text-sm">dark_mode</span>
                    {t('workHours.nightShiftHint')}
                  </p>
                ) : null
              })()}
            </div>
          )}
          {scheduleForm.type === 'Flexible' && (
            <div className="space-y-1.5">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.requiredHoursPerDay')}</label>
              <Input
                type="number"
                min={0.5}
                max={24}
                step={0.5}
                value={scheduleForm.requiredHoursPerDay}
                onChange={(e) => setScheduleForm((p) => ({ ...p, requiredHoursPerDay: e.target.value }))}
              />
            </div>
          )}
          {scheduleForm.type === 'Multi' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.subShifts')}</label>
                <button
                  type="button"
                  onClick={() => setScheduleShifts(prev => [...prev, {
                    name: `Shift ${prev.length + 1}`,
                    shiftStart: '08:00', shiftEnd: '17:00',
                    validEntryFrom: '06:00', validEntryTo: '10:00',
                    requiredHoursPerDay: 8, sortOrder: prev.length,
                  }])}
                  className="text-[10px] font-black uppercase tracking-wider text-primary hover:underline flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-[14px]">add</span> {t('workHours.addShift')}
                </button>
              </div>
              {scheduleShifts.length === 0 && (
                <p className="text-xs text-text-light italic">{t('workHours.noSubShiftsYet')}</p>
              )}
              {scheduleShifts.map((sh, idx) => (
                <div key={idx} className="rounded-xl bg-background-light p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <input
                      type="text"
                      placeholder={t('workHours.shiftNamePlaceholder')}
                      value={sh.name}
                      onChange={e => setScheduleShifts(prev => prev.map((s, i) => i === idx ? { ...s, name: e.target.value } : s))}
                      className="flex-1 rounded-lg bg-white border border-border px-2 py-1.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none mr-2"
                    />
                    <button
                      type="button"
                      onClick={() => setScheduleShifts(prev => prev.filter((_, i) => i !== idx))}
                      className="text-error-text hover:text-error-text/70"
                      title={t('workHours.removeShift')}
                    >
                      <span className="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="block text-[9px] font-black text-text-light uppercase tracking-widest">{t('workHours.shiftStart')}</label>
                      <input
                        type="text" inputMode="numeric" placeholder="HH:MM" maxLength={5}
                        value={sh.shiftStart}
                        onChange={e => setScheduleShifts(prev => prev.map((s, i) => i === idx ? { ...s, shiftStart: maskHHMM(e.target.value) } : s))}
                        className="w-full rounded-lg bg-white border border-border px-2 py-1.5 text-xs font-bold font-mono text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-[9px] font-black text-text-light uppercase tracking-widest">{t('workHours.shiftEnd')}</label>
                      <input
                        type="text" inputMode="numeric" placeholder="HH:MM" maxLength={5}
                        value={sh.shiftEnd}
                        onChange={e => setScheduleShifts(prev => prev.map((s, i) => i === idx ? { ...s, shiftEnd: maskHHMM(e.target.value) } : s))}
                        className="w-full rounded-lg bg-white border border-border px-2 py-1.5 text-xs font-bold font-mono text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-[9px] font-black text-text-light uppercase tracking-widest">{t('workHours.entryWindowFrom')}</label>
                      <input
                        type="text" inputMode="numeric" placeholder="HH:MM" maxLength={5}
                        value={sh.validEntryFrom}
                        onChange={e => setScheduleShifts(prev => prev.map((s, i) => i === idx ? { ...s, validEntryFrom: maskHHMM(e.target.value) } : s))}
                        className="w-full rounded-lg bg-white border border-border px-2 py-1.5 text-xs font-bold font-mono text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-[9px] font-black text-text-light uppercase tracking-widest">{t('workHours.entryWindowTo')}</label>
                      <input
                        type="text" inputMode="numeric" placeholder="HH:MM" maxLength={5}
                        value={sh.validEntryTo}
                        onChange={e => setScheduleShifts(prev => prev.map((s, i) => i === idx ? { ...s, validEntryTo: maskHHMM(e.target.value) } : s))}
                        className="w-full rounded-lg bg-white border border-border px-2 py-1.5 text-xs font-bold font-mono text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="block text-[9px] font-black text-text-light uppercase tracking-widest">{t('workHours.requiredHoursPerDayShort')}</label>
                    <input
                      type="number" min={0.5} max={24} step={0.5}
                      value={sh.requiredHoursPerDay}
                      onChange={e => setScheduleShifts(prev => prev.map((s, i) => i === idx ? { ...s, requiredHoursPerDay: parseFloat(e.target.value) || 8 } : s))}
                      className="w-full rounded-lg bg-white border border-border px-2 py-1.5 text-xs font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                    />
                  </div>
                  {(() => {
                    const re = /^([01][0-9]|2[0-3]):([0-5][0-9])$/
                    return re.test(sh.shiftStart) && re.test(sh.shiftEnd) && sh.shiftEnd < sh.shiftStart ? (
                      <p className="text-[10px] font-bold text-indigo-600 flex items-center gap-1">
                        <span className="material-symbols-outlined text-sm">dark_mode</span>
                        {t('workHours.nightShiftHint')}
                      </p>
                    ) : null
                  })()}
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-3 pt-2">
            <Button variant="outline" fullWidth onClick={() => { setScheduleModal(null); setEditingSchedule(null); setScheduleShifts([]) }}>{t('common.cancel')}</Button>
            <Button fullWidth isLoading={scheduleSaving} onClick={saveSchedule} disabled={!scheduleForm.name.trim() || (scheduleForm.type === 'Multi' && scheduleShifts.length === 0)}>
              {scheduleModal === 'create' ? t('common.create') : t('common.save')}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={scheduleModal === 'delete'}
        onClose={() => { setScheduleModal(null); setEditingSchedule(null); setScheduleShifts([]) }}
        title={t('workHours.deleteSchedule')}
      >
        <div className="space-y-4 pt-2">
          <p className="text-sm text-text-dark">
            <span dangerouslySetInnerHTML={{ __html: t('workHours.deleteScheduleConfirm', { name: editingSchedule?.name ?? '' }) }} />
          </p>
          <div className="flex gap-3">
            <Button variant="outline" fullWidth onClick={() => { setScheduleModal(null); setEditingSchedule(null); setScheduleShifts([]) }}>{t('common.cancel')}</Button>
            <Button variant="danger" fullWidth isLoading={scheduleSaving} onClick={deleteSchedule}>
              {t('common.delete')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Разрешение на отлучку (почасовое) ── */}
      <Modal
        isOpen={permissionModal !== null}
        onClose={() => setPermissionModal(null)}
        title={t('workHours.permissionTitle', { name: permissionModal?.employeeName ?? '' })}
      >
        <div className="space-y-4 pt-2">
          <p className="text-xs text-text-muted">
            {t('common.date')}: <strong className="text-text-dark">{permissionModal ? formatDateOnly(permissionModal.date) : ''}</strong>
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.permissionFromTime')}</label>
              <input
                type="time"
                value={permissionForm.from}
                onChange={(e) => setPermissionForm(p => ({ ...p, from: e.target.value }))}
                className="w-full rounded-xl bg-background-light border-none px-3 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.permissionToTime')}</label>
              <input
                type="time"
                value={permissionForm.to}
                onChange={(e) => setPermissionForm(p => ({ ...p, to: e.target.value }))}
                className="w-full rounded-xl bg-background-light border-none px-3 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.reasonOptional')}</label>
            <input
              type="text"
              value={permissionForm.reason}
              onChange={(e) => setPermissionForm(p => ({ ...p, reason: e.target.value }))}
              placeholder={t('workHours.reasonPlaceholder')}
              className="w-full rounded-xl bg-background-light border-none px-3 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
            />
          </div>
          <label className={`flex items-start gap-3 p-3 rounded-xl cursor-pointer transition-colors border ${permissionForm.showInReport ? 'bg-sky-50 border-sky-200' : 'border-transparent hover:bg-black/[0.04]'}`}>
            <input
              type="checkbox"
              checked={permissionForm.showInReport}
              onChange={(e) => setPermissionForm(p => ({ ...p, showInReport: e.target.checked }))}
              className="w-4 h-4 mt-0.5 rounded accent-sky-500"
            />
            <div>
              <p className="text-sm font-bold text-text-dark">{t('workHours.permissionShowInReport')}</p>
              <p className="text-[10px] text-text-muted">{t('workHours.permissionDeductHint')}</p>
            </div>
          </label>
          <div className="flex gap-3 pt-2">
            {(permissionModal?.permissionHours ?? 0) > 0 && (
              <Button variant="danger" onClick={deletePermission}>{t('common.delete')}</Button>
            )}
            <Button variant="outline" fullWidth onClick={() => setPermissionModal(null)}>{t('common.cancel')}</Button>
            <Button fullWidth isLoading={permissionSaving} onClick={savePermission} disabled={!permissionForm.from || !permissionForm.to || permissionForm.to <= permissionForm.from}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={correctionModal !== null}
        onClose={() => setCorrectionModal(null)}
        title={t('workHours.correctAttendanceTitle', { name: correctionModal?.employeeName ?? '' })}
      >
        <div className="space-y-4 pt-2">
          <p className="text-[11px] text-text-light">
            {t('common.date')}: <strong className="text-text-dark">{correctionModal ? formatDateOnly(correctionModal.date) : ''}</strong>.
            {' '}{t('workHours.correctionOverrideHint')}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.checkInHHMM')}</label>
              <input
                type="text" inputMode="numeric" placeholder="HH:MM" maxLength={5}
                value={correctionForm.checkIn}
                onChange={(e) => setCorrectionForm((p) => ({ ...p, checkIn: maskHHMM(e.target.value) }))}
                className="w-full rounded-xl bg-background-light border-none px-3 py-2.5 text-sm font-bold font-mono text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.checkOutHHMM')}</label>
              <input
                type="text" inputMode="numeric" placeholder="HH:MM" maxLength={5}
                value={correctionForm.checkOut}
                onChange={(e) => setCorrectionForm((p) => ({ ...p, checkOut: maskHHMM(e.target.value) }))}
                className="w-full rounded-xl bg-background-light border-none px-3 py-2.5 text-sm font-bold font-mono text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.comment')}</label>
            <input
              type="text" placeholder={t('workHours.correctionReasonPlaceholder')}
              value={correctionForm.comment}
              onChange={(e) => setCorrectionForm((p) => ({ ...p, comment: e.target.value }))}
              className="w-full rounded-xl bg-background-light border-none px-3 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
            />
          </div>
          <div className="flex gap-3 pt-2">
            <Button variant="outline" fullWidth onClick={() => setCorrectionModal(null)}>{t('common.cancel')}</Button>
            {correctionModal?.corrected && (
              <Button variant="danger" fullWidth isLoading={correctionSaving} onClick={clearCorrection}>{t('common.reset')}</Button>
            )}
            <Button fullWidth isLoading={correctionSaving} onClick={saveCorrection}>{t('common.save')}</Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={leaveModal === 'create' || leaveModal === 'edit'}
        onClose={() => { setLeaveModal(null); setEditingLeaveId(null) }}
        title={leaveModal === 'edit' ? t('workHours.editLeave') : t('workHours.newLeave')}
      >
        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.employee')}</label>
            <button
              type="button"
              disabled={leaveModal === 'edit'}
              onClick={() => setLeaveEmpPickerOpen(true)}
              className="w-full rounded-xl bg-background-light border-none px-3 py-2.5 text-sm font-bold text-text-dark text-left focus:ring-2 focus:ring-primary/20 outline-none flex items-center justify-between gap-2 disabled:opacity-60"
            >
              <span className={`truncate ${leaveForm.employeeId ? '' : 'text-text-light'}`}>
                {(() => {
                  const sel = employees.find((e) => e.id === leaveForm.employeeId)
                  return sel ? `${sel.firstName} ${sel.lastName}` : t('workHours.selectEmployee')
                })()}
              </span>
              <span className="material-symbols-outlined text-base text-text-light shrink-0">expand_more</span>
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.leaveType')}</label>
              <select
                value={leaveForm.leaveType}
                onChange={(e) => setLeaveForm(p => ({ ...p, leaveType: e.target.value as 'Vacation' | 'DayOff' }))}
                className="w-full rounded-xl bg-background-light border-none px-3 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
              >
                <option value="Vacation">{t('workHours.vacation')}</option>
                <option value="DayOff">{t('workHours.dayOffOption')}</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.payment')}</label>
              <label className="flex items-center gap-2 h-10 px-3 rounded-xl bg-background-light cursor-pointer">
                <input
                  type="checkbox"
                  checked={leaveForm.isPaid}
                  onChange={(e) => setLeaveForm(p => ({ ...p, isPaid: e.target.checked }))}
                  className="w-4 h-4 rounded accent-primary"
                />
                <span className="text-sm font-bold text-text-dark">{t('workHours.paid')}</span>
              </label>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.startDate')}</label>
              <input
                type="date"
                value={leaveForm.startDate}
                onChange={(e) => setLeaveForm(p => ({ ...p, startDate: e.target.value }))}
                className="w-full rounded-xl bg-background-light border-none px-3 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.endDate')}</label>
              <input
                type="date"
                value={leaveForm.endDate}
                onChange={(e) => setLeaveForm(p => ({ ...p, endDate: e.target.value }))}
                className="w-full rounded-xl bg-background-light border-none px-3 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.reasonOptional')}</label>
            <input
              type="text"
              placeholder={t('workHours.reasonPlaceholder')}
              value={leaveForm.reason}
              onChange={(e) => setLeaveForm(p => ({ ...p, reason: e.target.value }))}
              className="w-full rounded-xl bg-background-light border-none px-3 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
            />
          </div>
          <div className="flex gap-3 pt-2">
            <Button variant="outline" fullWidth onClick={() => { setLeaveModal(null); setEditingLeaveId(null) }}>{t('common.cancel')}</Button>
            <Button fullWidth isLoading={leaveSaving} onClick={saveLeave} disabled={!leaveForm.employeeId}>
              {leaveModal === 'edit' ? t('common.save') : t('common.create')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Выбор сотрудника для отпуска — как фильтр-попап, но строго один человек */}
      <EmployeeSinglePickerModal
        isOpen={leaveEmpPickerOpen}
        onClose={() => setLeaveEmpPickerOpen(false)}
        employees={employees}
        deptTree={groupTree}
        groupOf={groupIdOf}
        text={kindText}
        selectedId={leaveForm.employeeId}
        onPick={(id) => { setLeaveForm(p => ({ ...p, employeeId: id })); setLeaveEmpPickerOpen(false) }}
      />

      {/* ── Quick Assign Modal ── */}
      {assignSchedule && (() => {
        const DOW_LABELS = [
          t('workHours.dow.mon'),
          t('workHours.dow.tue'),
          t('workHours.dow.wed'),
          t('workHours.dow.thu'),
          t('workHours.dow.fri'),
          t('workHours.dow.sat'),
          t('workHours.dow.sun'),
        ]
        const filtered = assignEmps.filter(e =>
          e.name.toLowerCase().includes(assignSearch.toLowerCase()) ||
          e.dept.toLowerCase().includes(assignSearch.toLowerCase())
        )
        const allSelected = filtered.length > 0 && filtered.every(e => assignSelEmps.has(e.id))

        const toggleEmp = (id: string) =>
          setAssignSelEmps(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
        const toggleDow = (d: number) =>
          setAssignSelDows(prev => { const n = new Set(prev); n.has(d) ? n.delete(d) : n.add(d); return n })
        const toggleAll = () =>
          setAssignSelEmps(prev => {
            const n = new Set(prev)
            if (allSelected) { filtered.forEach(e => n.delete(e.id)) }
            else { filtered.forEach(e => n.add(e.id)) }
            return n
          })

        // count matching dates (only relevant for Assign mode)
        const parseLocal = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }
        let dateCount = 0
        if (!assignRemoveMode && assignFrom && assignTo) {
          const from = parseLocal(assignFrom), to = parseLocal(assignTo)
          for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
            const dow = d.getDay() === 0 ? 7 : d.getDay()
            if (assignSelDows.has(dow)) dateCount++
          }
        }
        const canAssign = assignSelEmps.size > 0 && (assignRemoveMode || (assignSelDows.size > 0 && dateCount > 0))

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[2px]"
            onClick={() => setAssignSchedule(null)}>
            <div className="bg-surface rounded-3xl shadow-2xl w-[760px] max-h-[88vh] flex flex-col overflow-hidden"
              onClick={e => e.stopPropagation()}>

              {/* Header */}
              <div className="px-6 pt-5 pb-4 border-b border-black/[0.07] flex items-center justify-between shrink-0">
                <div className="flex items-center gap-3">
                  <span className="w-4 h-4 rounded-full shrink-0" style={{ backgroundColor: assignSchedule.color }} />
                  <div>
                    <h2 className="text-base font-black text-text-dark">{t('workHours.assignTitle', { name: assignSchedule.name })}</h2>
                    <p className="text-[11px] text-text-muted">
                      {assignSchedule.shiftStart && assignSchedule.shiftEnd
                        ? `${assignSchedule.shiftStart} – ${assignSchedule.shiftEnd}`
                        : t('workHours.flexibleHoursPerDay', { hours: assignSchedule.requiredHoursPerDay })}
                    </p>
                  </div>
                </div>
                <button onClick={() => setAssignSchedule(null)}
                  className="w-8 h-8 flex items-center justify-center rounded-xl hover:bg-black/[0.06] text-text-muted">
                  <span className="material-symbols-outlined text-[18px]">close</span>
                </button>
              </div>

              {/* Body */}
              <div className="flex flex-1 min-h-0">

                {/* Left — Employees */}
                <div className="flex flex-col w-[420px] border-r border-black/[0.07] min-h-0">
                  <div className="px-4 py-3 border-b border-black/[0.06] shrink-0 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-black text-text-muted uppercase tracking-widest">
                        {t('workHours.employees')}
                        {assignSelEmps.size > 0 && (
                          <span className="ml-2 text-primary bg-primary/10 px-1.5 py-0.5 rounded font-black">{assignSelEmps.size}</span>
                        )}
                      </span>
                      <button onClick={toggleAll}
                        className="text-[10px] font-black uppercase tracking-wider text-primary hover:underline">
                        {allSelected ? t('workHours.deselectAll') : t('common.selectAll')}
                      </button>
                    </div>
                    <div className="relative">
                      <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[14px]">search</span>
                      <input type="text" placeholder={t('common.search')} value={assignSearch}
                        onChange={e => setAssignSearch(e.target.value)}
                        className="w-full pl-7 pr-3 py-1.5 text-xs bg-black/[0.04] rounded-xl border border-black/10 outline-none focus:ring-2 focus:ring-primary/20" />
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto">
                    {assignEmps.length === 0 ? (
                      <div className="flex items-center justify-center h-full text-text-muted text-sm">{t('common.loading')}</div>
                    ) : filtered.length === 0 ? (
                      <div className="flex items-center justify-center h-full text-text-muted text-sm">{t('workHours.noEmployeesMatch')}</div>
                    ) : filtered.map(e => {
                      const sel = assignSelEmps.has(e.id)
                      return (
                        <label key={e.id}
                          className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors border-b border-black/[0.04] last:border-none
                            ${sel ? 'bg-primary/5' : 'hover:bg-black/[0.03]'}`}>
                          <input type="checkbox" checked={sel} onChange={() => toggleEmp(e.id)}
                            className="w-4 h-4 rounded accent-primary shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className={`text-sm font-bold truncate ${sel ? 'text-primary' : 'text-text-dark'}`}>{e.name}</p>
                            {e.dept && <p className="text-[10px] text-text-muted truncate">{e.dept}</p>}
                          </div>
                          {sel && <span className="material-symbols-outlined text-primary text-[16px] shrink-0">check_circle</span>}
                        </label>
                      )
                    })}
                  </div>
                </div>

                {/* Right — Settings */}
                <div className="flex-1 flex flex-col p-5 gap-5 overflow-y-auto">

                  {/* Remove mode message */}
                  {assignRemoveMode && (
                    <div className="rounded-2xl p-4 bg-red-50 border border-red-200 text-xs font-bold text-red-600 space-y-1">
                      <p className="flex items-center gap-2"><span className="material-symbols-outlined text-base">warning</span>{t('workHours.removeSchedule')}</p>
                      <p className="font-normal text-red-500">{t('workHours.removeScheduleDesc')}</p>
                    </div>
                  )}

                  {/* Days of week — hidden in remove mode */}
                  {!assignRemoveMode && <div className="space-y-2.5">
                    <p className="text-[10px] font-black text-text-muted uppercase tracking-widest">{t('workHours.daysOfWeek')}</p>
                    <div className="grid grid-cols-7 gap-1.5">
                      {DOW_LABELS.map((label, i) => {
                        const dow = i + 1
                        const sel = assignSelDows.has(dow)
                        const isWeekend = dow >= 6
                        return (
                          <button key={dow} type="button" onClick={() => toggleDow(dow)}
                            className={`rounded-xl py-2.5 text-[11px] font-black transition-all border
                              ${sel
                                ? isWeekend
                                  ? 'bg-rose-500 border-rose-500 text-white'
                                  : 'border-transparent text-white'
                                : isWeekend
                                  ? 'bg-rose-50 border-rose-100 text-rose-400'
                                  : 'bg-black/[0.04] border-transparent text-text-muted hover:bg-black/[0.08]'}`}
                            style={sel && !isWeekend ? { backgroundColor: assignSchedule.color, borderColor: assignSchedule.color } : {}}>
                            {label}
                          </button>
                        )
                      })}
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => setAssignSelDows(new Set([1,2,3,4,5]))}
                        className="text-[10px] font-black text-text-muted hover:text-text-dark transition-colors">{t('workHours.weekdays')}</button>
                      <span className="text-text-muted/40">·</span>
                      <button onClick={() => setAssignSelDows(new Set([6,7]))}
                        className="text-[10px] font-black text-text-muted hover:text-text-dark transition-colors">{t('workHours.weekends')}</button>
                      <span className="text-text-muted/40">·</span>
                      <button onClick={() => setAssignSelDows(new Set([1,2,3,4,5,6,7]))}
                        className="text-[10px] font-black text-text-muted hover:text-text-dark transition-colors">{t('common.all')}</button>
                    </div>
                  </div>}

                  {/* Date range — hidden in remove mode */}
                  {!assignRemoveMode && <div className="space-y-2.5">
                    <p className="text-[10px] font-black text-text-muted uppercase tracking-widest">{t('workHours.dateRange')}</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-[10px] text-text-muted font-bold">{t('common.from')}</label>
                        <input type="date" value={assignFrom} onChange={e => setAssignFrom(e.target.value)}
                          className="w-full rounded-xl bg-black/[0.04] border border-black/10 px-3 py-2 text-sm font-bold text-text-dark outline-none focus:ring-2 focus:ring-primary/20" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-text-muted font-bold">{t('common.to')}</label>
                        <input type="date" value={assignTo} onChange={e => setAssignTo(e.target.value)}
                          className="w-full rounded-xl bg-black/[0.04] border border-black/10 px-3 py-2 text-sm font-bold text-text-dark outline-none focus:ring-2 focus:ring-primary/20" />
                      </div>
                    </div>
                  </div>}

                  {/* Summary */}
                  {canAssign && !assignRemoveMode && (
                    <div className="rounded-2xl px-4 py-3 text-[11px] font-bold space-y-1"
                      style={{ backgroundColor: assignSchedule.color + '15', color: assignSchedule.color }}>
                      <p dangerouslySetInnerHTML={{ __html: t('workHours.willAssignSummary', { days: dateCount, employees: assignSelEmps.size }) }} />
                      <p className="opacity-70">{t('workHours.willAssignDefaultNote')}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Footer */}
              <div className="px-6 py-4 border-t border-black/[0.07] flex flex-col gap-3 shrink-0">
                {/* Assign / Remove toggle */}
                <div className="flex rounded-2xl overflow-hidden border border-black/[0.08] text-[11px] font-black">
                  <button
                    type="button"
                    onClick={() => setAssignRemoveMode(false)}
                    className={`flex-1 py-2 transition-colors ${!assignRemoveMode ? 'text-white' : 'text-text-muted bg-black/[0.04] hover:bg-black/[0.07]'}`}
                    style={!assignRemoveMode ? { backgroundColor: assignSchedule.color } : {}}>
                    {t('workHours.assign')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAssignRemoveMode(true)}
                    className={`flex-1 py-2 transition-colors ${assignRemoveMode ? 'bg-red-500 text-white' : 'text-text-muted bg-black/[0.04] hover:bg-black/[0.07]'}`}>
                    {t('common.remove')}
                  </button>
                </div>
                {assignError && (
                  <div className="flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-xl text-xs font-bold text-red-600">
                    <span className="material-symbols-outlined text-sm">error</span>
                    {assignError}
                  </div>
                )}
                <div className="flex gap-3">
                  <button onClick={() => { setAssignSchedule(null); setAssignError(null); setAssignRemoveMode(false) }}
                    className="flex-1 py-2.5 text-sm font-bold text-text-muted bg-black/[0.05] rounded-2xl hover:bg-black/[0.08] transition-colors">
                    {t('common.cancel')}
                  </button>
                  <button onClick={doAssign} disabled={!canAssign || assignSaving}
                    className={`flex-1 py-2.5 text-sm font-bold text-white rounded-2xl transition-all disabled:opacity-40 flex items-center justify-center gap-2 ${assignRemoveMode ? 'bg-red-500' : ''}`}
                    style={!assignRemoveMode ? { backgroundColor: assignSchedule.color } : {}}>
                    {assignSaving && <span className="spinner-ring text-[14px]" aria-hidden="true" />}
                    {assignSaving
                      ? (assignRemoveMode ? t('workHours.removing') : t('workHours.assigning'))
                      : (assignRemoveMode
                          ? t('workHours.removeFromEmployees', { count: assignSelEmps.size || '?' })
                          : t('workHours.assignToEmployees', { count: assignSelEmps.size || '?' }))}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}

      {emailReportModal && (
        <Modal isOpen title={t('workHours.sendAttendanceReport')} onClose={() => { setEmailReportModal(false); setEmailReportTo('') }}>
          <div className="space-y-4">
            <p className="text-xs text-text-light">
              {t('workHours.sendReportHint', { period: tab === 'daily' ? t('workHours.periodDay') : tab === 'weekly' ? t('workHours.periodWeek') : t('workHours.periodMonth') })}
            </p>
            <div className="space-y-2">
              <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('workHours.recipientEmail')}</label>
              <Input
                type="email"
                placeholder="manager@company.com"
                value={emailReportTo}
                onChange={e => setEmailReportTo(e.target.value)}
                autoFocus
              />
            </div>
            <div className="flex gap-2">
              <Button fullWidth onClick={sendAttendanceReport} isLoading={emailReportSending} disabled={!emailReportTo.trim()}>
                {t('common.send')}
              </Button>
              <Button fullWidth variant="outline" onClick={() => { setEmailReportModal(false); setEmailReportTo('') }} disabled={emailReportSending}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Success toast after assign */}
      {assignSuccessCount > 0 && (
        <div className="fixed bottom-6 right-6 z-50 animate-in slide-in-from-bottom-4 duration-300">
          <div className="flex items-center gap-3 bg-green-600 text-white px-4 py-3 rounded-2xl shadow-xl">
            <span className="material-symbols-outlined text-xl">check_circle</span>
            <span className="text-sm font-bold">{t('workHours.assignedToEmployees', { count: assignSuccessCount })}</span>
            <button
              type="button"
              onClick={() => setAssignSuccessCount(0)}
              className="ml-2 opacity-70 hover:opacity-100 transition-opacity"
            >
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          </div>
        </div>
      )}
    </AppLayout>
  )
}
