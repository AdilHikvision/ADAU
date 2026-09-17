import { useEffect, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { AppLayout } from '../components/templates'
import { Pagination, usePageReset, pageSlice } from '../components/molecules'
import { apiRequest } from '../lib/api'
import { useAuth } from '../auth/AuthContext'

function toDateStr(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function getMondayOfWeek(d: Date): Date {
    const date = new Date(d)
    const day = date.getDay()
    const diff = day === 0 ? -6 : 1 - day
    date.setDate(date.getDate() + diff)
    return date
}

function timeToMins(t: string): number {
    const [h, m] = t.split(':').map(Number)
    return h * 60 + m
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScheduleShift {
    id: string
    name: string
    shiftStart: string
    shiftEnd: string
    validEntryFrom: string
    validEntryTo: string
    requiredHoursPerDay: number
}

interface Schedule {
    id: string
    name: string
    type: string
    shiftStart: string | null
    shiftEnd: string | null
    requiredHoursPerDay: number
    color: string
    shifts: ScheduleShift[]
}

interface DateData {
    date: string  // "yyyy-MM-dd"
    scheduleId: string | null
    scheduleName: string | null
    shiftStart: string | null
    shiftEnd: string | null
    isDayOff: boolean
    leaveId?: string | null
    leaveType?: string | null
    leaveIsPaid?: boolean | null
    leaveStatus?: string | null
    leaveReason?: string | null
    requestId?: string | null
    requestType?: string | null
    requestStatus?: string | null
    requestComment?: string | null
}

interface Employee {
    employeeId: string
    employeeName: string
    defaultScheduleId: string | null
    defaultScheduleName: string | null
    defaultShiftStart: string | null
    defaultShiftEnd: string | null
    defaultColor: string | null
    dates: DateData[]
}

interface PlannerData {
    schedules: Schedule[]
    employees: Employee[]
}

interface PendingChange {
    date: string  // "yyyy-MM-dd"
    scheduleId: string | null
    isDayOff: boolean
    reset: boolean
}

interface CalCol {
    key: string
    dateStr: string  // "yyyy-MM-dd"
    date: Date
    dayNum: number
    dayLabel: string
    isWeekend: boolean
    isToday: boolean
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SchedulePlannerPage() {
    const { t } = useTranslation()
    const DOW_SHORT = [
        t('schedulePlanner.days.mon'),
        t('schedulePlanner.days.tue'),
        t('schedulePlanner.days.wed'),
        t('schedulePlanner.days.thu'),
        t('schedulePlanner.days.fri'),
        t('schedulePlanner.days.sat'),
        t('schedulePlanner.days.sun'),
    ]
    const MONTHS = [
        t('schedulePlanner.months.january'),
        t('schedulePlanner.months.february'),
        t('schedulePlanner.months.march'),
        t('schedulePlanner.months.april'),
        t('schedulePlanner.months.may'),
        t('schedulePlanner.months.june'),
        t('schedulePlanner.months.july'),
        t('schedulePlanner.months.august'),
        t('schedulePlanner.months.september'),
        t('schedulePlanner.months.october'),
        t('schedulePlanner.months.november'),
        t('schedulePlanner.months.december'),
    ]
    const { token } = useAuth()
    const [data, setData] = useState<PlannerData | null>(null)
    const [loading, setLoading] = useState(true)
    const [viewMode, setViewMode] = useState<'week' | 'month'>('month')
    const [exporting, setExporting] = useState<'excel' | 'pdf' | null>(null)
    const [emailModalOpen, setEmailModalOpen] = useState(false)
    const [emailTo, setEmailTo] = useState('')
    const [emailSending, setEmailSending] = useState(false)

    // In month mode: first day of month. In week mode: Monday of the week.
    const [viewDate, setViewDate] = useState(() => {
        const n = new Date()
        return new Date(n.getFullYear(), n.getMonth(), 1)
    })

    const [search, setSearch] = useState('')
    const [pendingByEmp, setPendingByEmp] = useState<Record<string, PendingChange[]>>({})
    const [savingEmpId, setSavingEmpId] = useState<string | null>(null)

    // Modal
    const [modal, setModal] = useState<{ empId: string; dateStr: string; dayLabel: string; dayNum: number } | null>(null)
    const [mScheduleId, setMScheduleId] = useState<string | null>(null)
    const [mDayOff, setMDayOff] = useState(false)
    const [mReset, setMReset] = useState(false)
    const [mHasExisting, setMHasExisting] = useState(false)

    // ─── Date range from columns ───────────────────────────────────────────────

    const columns = useMemo((): CalCol[] => {
        const today = new Date()
        const todayStr = toDateStr(today)

        if (viewMode === 'month') {
            const y = viewDate.getFullYear(), mo = viewDate.getMonth()
            const dim = new Date(y, mo + 1, 0).getDate()
            return Array.from({ length: dim }, (_, i) => {
                const date = new Date(y, mo, i + 1)
                const dow = date.getDay()  // 0=Sun
                const dateStr = toDateStr(date)
                return {
                    key: dateStr, dateStr, date, dayNum: i + 1,
                    dayLabel: DOW_SHORT[dow === 0 ? 6 : dow - 1],
                    isWeekend: dow === 0 || dow === 6,
                    isToday: dateStr === todayStr,
                }
            })
        } else {
            // Week mode: viewDate is Monday
            return Array.from({ length: 7 }, (_, i) => {
                const date = new Date(viewDate)
                date.setDate(viewDate.getDate() + i)
                const dow = date.getDay()
                const dateStr = toDateStr(date)
                return {
                    key: dateStr, dateStr, date, dayNum: date.getDate(),
                    dayLabel: DOW_SHORT[i],
                    isWeekend: dow === 0 || dow === 6,
                    isToday: dateStr === todayStr,
                }
            })
        }
    }, [viewMode, viewDate])

    const rangeFrom = columns[0]?.dateStr ?? toDateStr(new Date())
    const rangeTo = columns[columns.length - 1]?.dateStr ?? rangeFrom

    // ─── Fetch ────────────────────────────────────────────────────────────────

    const [fetchError, setFetchError] = useState<string | null>(null)

    const fetchData = useCallback(async () => {
        setLoading(true)
        setFetchError(null)
        try {
            const d = await apiRequest<PlannerData>(
                `/api/schedule-planner?from=${rangeFrom}&to=${rangeTo}`, { token }
            )
            setData(d)
        } catch (e) {
            setFetchError(e instanceof Error ? e.message : t('schedulePlanner.errors.loadPlannerData'))
        }
        finally { setLoading(false) }
    }, [token, rangeFrom, rangeTo, t])

    useEffect(() => { fetchData() }, [fetchData])

    // ─── Navigation ───────────────────────────────────────────────────────────

    const navigate = (dir: -1 | 1) => {
        if (viewMode === 'week') {
            setViewDate(d => { const n = new Date(d); n.setDate(n.getDate() + dir * 7); return n })
        } else {
            setViewDate(d => new Date(d.getFullYear(), d.getMonth() + dir, 1))
        }
    }

    const goToday = () => {
        const n = new Date()
        if (viewMode === 'week') {
            setViewDate(getMondayOfWeek(n))
        } else {
            setViewDate(new Date(n.getFullYear(), n.getMonth(), 1))
        }
    }

    const switchMode = (m: 'week' | 'month') => {
        if (m === viewMode) return
        if (m === 'week') {
            // Switch to week containing first visible day of current month view
            setViewDate(getMondayOfWeek(viewDate))
        } else {
            // Switch to month of current week's Monday
            setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth(), 1))
        }
        setViewMode(m)
    }

    // ─── Effective state ──────────────────────────────────────────────────────

    const getEffective = (emp: Employee, dateStr: string) => {
        const pending = (pendingByEmp[emp.employeeId] ?? []).find(p => p.date === dateStr)
        if (pending) {
            const sched = data?.schedules.find(s => s.id === pending.scheduleId) ?? null
            return {
                scheduleId: pending.scheduleId,
                scheduleName: sched?.name ?? null,
                shiftStart: sched?.shiftStart ?? null,
                shiftEnd: sched?.shiftEnd ?? null,
                isDayOff: pending.isDayOff,
                color: sched?.color ?? emp.defaultColor ?? '#6366f1',
                isPending: true,
                isReset: pending.reset,
                leaveId: null, leaveType: null, leaveIsPaid: null, leaveStatus: null, leaveReason: null,
                requestId: null, requestType: null, requestStatus: null, requestComment: null,
            }
        }
        const base = emp.dates.find(d => d.date === dateStr)
        if (base) {
            const sched = data?.schedules.find(s => s.id === base.scheduleId) ?? null
            const color = sched?.color ?? emp.defaultColor ?? '#6366f1'
            return { ...base, color, isPending: false, isReset: false }
        }
        // Fallback: use employee's default schedule on weekdays
        if (emp.defaultScheduleId) {
            const dow = new Date(dateStr + 'T00:00:00').getDay() // 0=Sun, 6=Sat
            if (dow !== 0 && dow !== 6) {
                return {
                    scheduleId: emp.defaultScheduleId,
                    scheduleName: emp.defaultScheduleName,
                    shiftStart: emp.defaultShiftStart,
                    shiftEnd: emp.defaultShiftEnd,
                    isDayOff: false,
                    color: emp.defaultColor ?? '#6366f1',
                    isPending: false, isReset: false,
                    leaveId: null, leaveType: null, leaveIsPaid: null, leaveStatus: null, leaveReason: null,
                    requestId: null, requestType: null, requestStatus: null, requestComment: null,
                }
            }
        }
        return { scheduleId: null, scheduleName: null, shiftStart: null, shiftEnd: null, isDayOff: false, color: emp.defaultColor ?? '#6366f1', isPending: false, isReset: false, leaveId: null, leaveType: null, leaveIsPaid: null, leaveStatus: null, leaveReason: null, requestId: null, requestType: null, requestStatus: null, requestComment: null }
    }

    // ─── Totals ───────────────────────────────────────────────────────────────

    const computeTotals = (emp: Employee) => {
        let days = 0, mins = 0
        for (const col of columns) {
            const p = getEffective(emp, col.dateStr)
            if (!p.isDayOff && !p.leaveType && p.scheduleId) {
                days++
                if (p.shiftStart && p.shiftEnd) {
                    mins += timeToMins(p.shiftEnd) - timeToMins(p.shiftStart)
                } else {
                    // Flexible / Multi: use requiredHoursPerDay from schedule
                    const sched = schedules.find(s => s.id === p.scheduleId)
                    mins += (sched?.requiredHoursPerDay ?? 8) * 60
                }
            }
        }
        return { days, hours: Math.round(mins / 60) }
    }

    // ─── Modal ────────────────────────────────────────────────────────────────

    const openModal = (empId: string, dateStr: string, dayLabel: string, dayNum: number) => {
        const emp = data?.employees.find(e => e.employeeId === empId)
        if (!emp) return
        const p = getEffective(emp, dateStr)
        setMScheduleId(p.scheduleId)
        setMDayOff(false) // отметка «выходной» из планировщика убрана; существующий day-off можно только сбросить или перезаписать графиком
        setMReset(false)
        setMHasExisting(!!(p.scheduleId || p.isDayOff))
        setModal({ empId, dateStr, dayLabel, dayNum })
    }

    const applyModal = () => {
        if (!modal) return
        const change: PendingChange = {
            date: modal.dateStr,
            scheduleId: mReset || mDayOff ? null : mScheduleId,
            isDayOff: !mReset && mDayOff,
            reset: mReset,
        }
        setPendingByEmp(prev => {
            const existing = (prev[modal.empId] ?? []).filter(p => p.date !== modal.dateStr)
            return { ...prev, [modal.empId]: [...existing, change] }
        })
        setModal(null)
    }

    // ─── Save / Discard ───────────────────────────────────────────────────────

    const saveEmployee = async (empId: string) => {
        const changes = pendingByEmp[empId] ?? []
        if (!changes.length) return
        setSavingEmpId(empId)
        try {
            const payload = changes.map(c => ({
                date: c.date,
                scheduleId: c.scheduleId ?? null,
                isDayOff: c.isDayOff,
                reset: c.reset,
            }))
            await apiRequest(`/api/schedule-planner/${empId}/days`, {
                method: 'PUT', token,
                body: JSON.stringify(payload),
                headers: { 'Content-Type': 'application/json' },
            })
            setPendingByEmp(prev => { const n = { ...prev }; delete n[empId]; return n })
            await fetchData()
        } catch { /* ignore */ }
        finally { setSavingEmpId(null) }
    }

    const discard = (empId: string) =>
        setPendingByEmp(prev => { const n = { ...prev }; delete n[empId]; return n })

    // ─── Derived ──────────────────────────────────────────────────────────────

    const filtered = (data?.employees ?? []).filter(e =>
        e.employeeName.toLowerCase().includes(search.toLowerCase())
    )
    // Сетка широкая, поэтому сотрудников листаем страницами; поиск и период возвращают на первую.
    const [page, setPage] = usePageReset(`${search}|${rangeFrom}|${rangeTo}`)
    const pagedEmployees = pageSlice(filtered, page)

    const schedules = data?.schedules ?? []

    async function downloadReport(kind: 'excel' | 'pdf') {
        if (!token) return
        setExporting(kind)
        try {
            const res = await fetch(`/api/reports/schedule-planner/${kind}?from=${rangeFrom}&to=${rangeTo}`, {
                headers: { Authorization: `Bearer ${token}` },
            })
            if (!res.ok) throw new Error(await res.text())
            const blob = await res.blob()
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `schedule-${rangeFrom}-${rangeTo}.${kind === 'excel' ? 'xlsx' : 'pdf'}`
            document.body.appendChild(a); a.click(); a.remove()
            URL.revokeObjectURL(url)
        } catch (e) {
            alert((e as Error).message || t('schedulePlanner.errors.exportFailed'))
        } finally {
            setExporting(null)
        }
    }

    async function sendEmail() {
        if (!token || !emailTo.trim()) return
        setEmailSending(true)
        try {
            await apiRequest('/api/reports/schedule-planner/send-email', {
                token, method: 'POST',
                body: JSON.stringify({ from: rangeFrom, toDate: rangeTo, to: emailTo.trim() }),
            })
            setEmailModalOpen(false); setEmailTo('')
        } catch (e) {
            alert((e as Error).message || t('schedulePlanner.errors.sendEmailFailed'))
        } finally {
            setEmailSending(false)
        }
    }

    const headerLabel = viewMode === 'month'
        ? `${MONTHS[viewDate.getMonth()]} ${viewDate.getFullYear()}`
        : (() => {
            const end = new Date(viewDate)
            end.setDate(end.getDate() + 6)
            if (viewDate.getMonth() === end.getMonth())
                return `${viewDate.getDate()}–${end.getDate()} ${MONTHS[end.getMonth()]} ${end.getFullYear()}`
            return `${viewDate.getDate()} ${MONTHS[viewDate.getMonth()]} – ${end.getDate()} ${MONTHS[end.getMonth()]} ${end.getFullYear()}`
        })()

    const EMP_W = 220, TOT_W = 76, CELL_W = viewMode === 'week' ? 110 : 80

    // ─── Render ───────────────────────────────────────────────────────────────

    return (
        <AppLayout>
            <div className="flex flex-col h-full overflow-hidden">

                {/* ── Top bar ── */}
                <div className="shrink-0 flex items-center justify-between gap-4 px-5 py-3 bg-surface border-b border-black/[0.07]">
                    <div className="flex items-center gap-3">
                        <div className="flex items-center gap-0.5">
                            <button onClick={() => navigate(-1)}
                                className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-black/[0.06] text-text-muted transition-colors">
                                <span className="material-symbols-outlined text-[18px]">chevron_left</span>
                            </button>
                            <span className="text-sm font-bold text-text-dark px-2 min-w-[220px] text-center">{headerLabel}</span>
                            <button onClick={() => navigate(1)}
                                className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-black/[0.06] text-text-muted transition-colors">
                                <span className="material-symbols-outlined text-[18px]">chevron_right</span>
                            </button>
                        </div>

                        <button onClick={goToday}
                            className="text-xs font-bold text-primary border border-primary/40 px-3 py-1 rounded-lg hover:bg-primary/5 transition-colors">
                            {t('common.today')}
                        </button>
                    </div>

                    <div className="flex items-center gap-3">
                        <div className="relative">
                            <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[15px]">search</span>
                            <input type="text" placeholder={t('schedulePlanner.searchEmployees')} value={search}
                                onChange={e => setSearch(e.target.value)}
                                className="pl-8 pr-3 py-1.5 text-xs bg-black/[0.04] rounded-xl border border-black/10 outline-none focus:ring-2 focus:ring-primary/20 w-44" />
                        </div>
                        <div className="flex bg-black/[0.04] rounded-xl p-0.5 gap-0.5">
                            {(['week', 'month'] as const).map(m => (
                                <button key={m} onClick={() => switchMode(m)}
                                    className={`px-4 py-1.5 text-[11px] font-bold rounded-[10px] capitalize transition-all
                                        ${viewMode === m ? 'bg-surface shadow text-text-dark' : 'text-text-muted hover:text-text-dark'}`}>
                                    {m === 'week' ? t('schedulePlanner.week') : t('schedulePlanner.month')}
                                </button>
                            ))}
                        </div>
                        <div className="flex items-center gap-1.5">
                            <button type="button" disabled={!!exporting} onClick={() => downloadReport('excel')}
                                className="flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold rounded-xl bg-black/[0.04] hover:bg-black/[0.08] text-text-dark transition disabled:opacity-50">
                                <span className="material-symbols-outlined text-[15px]">table_view</span>
                                {exporting === 'excel' ? '...' : t('schedulePlanner.excel')}
                            </button>
                            <button type="button" disabled={!!exporting} onClick={() => downloadReport('pdf')}
                                className="flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold rounded-xl bg-black/[0.04] hover:bg-black/[0.08] text-text-dark transition disabled:opacity-50">
                                <span className="material-symbols-outlined text-[15px]">picture_as_pdf</span>
                                {exporting === 'pdf' ? '...' : t('schedulePlanner.pdf')}
                            </button>
                            <button type="button" onClick={() => setEmailModalOpen(true)}
                                className="flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold rounded-xl bg-black/[0.04] hover:bg-black/[0.08] text-text-dark transition">
                                <span className="material-symbols-outlined text-[15px]">send</span>
                                {t('schedulePlanner.email')}
                            </button>
                        </div>
                    </div>
                </div>

                {emailModalOpen && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[2px]"
                        onClick={() => setEmailModalOpen(false)}>
                        <div className="bg-surface rounded-2xl shadow-2xl w-[420px] p-6" onClick={e => e.stopPropagation()}>
                            <h3 className="text-base font-black text-text-dark mb-1">{t('schedulePlanner.sendScheduleReport')}</h3>
                            <p className="text-xs text-text-muted mb-4">{t('schedulePlanner.period', { from: rangeFrom, to: rangeTo })}</p>
                            <label className="block text-[10px] font-black text-text-muted uppercase tracking-wider mb-1">{t('schedulePlanner.recipientEmail')}</label>
                            <input type="email" value={emailTo} onChange={e => setEmailTo(e.target.value)}
                                placeholder="hr@example.com"
                                className="w-full rounded-xl bg-background-light border-none px-3 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none mb-4" />
                            <div className="flex gap-2 justify-end">
                                <button onClick={() => setEmailModalOpen(false)}
                                    className="px-4 py-2 text-xs font-bold rounded-xl text-text-muted hover:bg-black/[0.04]">{t('common.cancel')}</button>
                                <button onClick={sendEmail} disabled={!emailTo.trim() || emailSending}
                                    className="px-4 py-2 text-xs font-bold rounded-xl bg-primary text-white hover:bg-primary/90 disabled:opacity-50">
                                    {emailSending ? t('schedulePlanner.sending') : t('common.send')}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* ── Schedule legend ── */}
                {!loading && schedules.length > 0 && (
                    <div className="shrink-0 flex items-center gap-2 px-5 py-2 bg-background-light border-b border-black/[0.06] overflow-x-auto">
                        <span className="text-[9px] font-black text-text-muted uppercase tracking-widest shrink-0">{t('schedulePlanner.schedulesLabel')}</span>
                        {schedules.map(s => (
                            <div key={s.id} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border shrink-0"
                                style={{ backgroundColor: s.color + '18', borderColor: s.color + '55', color: s.color }}>
                                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                                <span className="text-[10px] font-black whitespace-nowrap">{s.name}</span>
                                {s.type === 'Multi' ? (
                                    <span className="text-[9px] opacity-70">{t('schedulePlanner.multi')}</span>
                                ) : s.shiftStart && s.shiftEnd ? (
                                    <span className="text-[9px] opacity-70">{s.shiftStart}–{s.shiftEnd}</span>
                                ) : (
                                    <span className="text-[9px] opacity-70">{t('schedulePlanner.hoursShort', { count: s.requiredHoursPerDay })}</span>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                {/* ── Grid ── */}
                {loading ? (
                    <div className="flex-1 flex items-center justify-center text-text-muted text-sm gap-2">
                        <span className="spinner-ring text-xl" aria-hidden="true" />{t('common.loading')}
                    </div>
                ) : fetchError ? (
                    <div className="flex-1 flex items-center justify-center">
                        <div className="text-center space-y-2 text-red-600 p-8 bg-red-50 rounded-2xl max-w-lg">
                            <span className="material-symbols-outlined text-3xl">error</span>
                            <p className="text-sm font-bold">{t('schedulePlanner.errors.loadPlanner')}</p>
                            <p className="text-xs font-mono bg-white rounded-lg p-3 text-left">{fetchError}</p>
                        </div>
                    </div>
                ) : (
                    <div className="flex-1 overflow-auto">
                        <table className="border-collapse"
                            style={{ tableLayout: 'fixed', minWidth: EMP_W + TOT_W + columns.length * CELL_W }}>
                            <colgroup>
                                <col style={{ width: EMP_W }} />
                                <col style={{ width: TOT_W }} />
                                {columns.map(c => <col key={c.key} style={{ width: CELL_W }} />)}
                            </colgroup>

                            {/* ── Header ── */}
                            <thead>
                                <tr className="bg-surface" style={{ boxShadow: '0 1px 0 rgba(0,0,0,0.08)' }}>
                                    <th className="text-left px-4 py-3 border-r border-black/[0.07]"
                                        style={{ position: 'sticky', left: 0, background: '#fff', zIndex: 20 }}>
                                        <span className="text-[10px] font-black text-text-muted uppercase tracking-widest">
                                            {t('schedulePlanner.employees')}
                                            {filtered.length > 0 && (
                                                <span className="ml-2 text-primary bg-primary/10 px-1.5 py-0.5 rounded-md font-black">
                                                    {filtered.length}
                                                </span>
                                            )}
                                        </span>
                                    </th>
                                    <th className="text-center py-3 border-r border-black/[0.07]"
                                        style={{ position: 'sticky', left: EMP_W, background: '#fff', zIndex: 20 }}>
                                        <span className="text-[10px] font-black text-text-muted uppercase tracking-widest">{t('schedulePlanner.total')}</span>
                                    </th>
                                    {columns.map(col => (
                                        <th key={col.key}
                                            className={`text-center py-2.5 px-1 border-r border-black/[0.05] last:border-r-0
                                                ${col.isWeekend ? 'bg-rose-50/70' : 'bg-surface'}
                                                ${col.isToday ? '!bg-primary/10' : ''}`}>
                                            <span className={`block text-base font-black leading-tight
                                                ${col.isToday ? 'text-primary' : col.isWeekend ? 'text-rose-400' : 'text-text-dark'}`}>
                                                {col.dayNum}
                                            </span>
                                            <span className={`text-[9px] font-black uppercase tracking-[0.15em]
                                                ${col.isToday ? 'text-primary' : col.isWeekend ? 'text-rose-400' : 'text-text-muted'}`}>
                                                {col.dayLabel}
                                            </span>
                                            {col.isToday && (
                                                <span className="block w-1 h-1 rounded-full bg-primary mx-auto mt-0.5" />
                                            )}
                                        </th>
                                    ))}
                                </tr>
                            </thead>

                            {/* ── Body ── */}
                            <tbody>
                                {filtered.length === 0 ? (
                                    <tr>
                                        <td colSpan={2 + columns.length} className="text-center py-16 text-text-muted text-sm">
                                            {(data?.employees.length ?? 0) === 0
                                                ? t('schedulePlanner.noActiveEmployees')
                                                : t('schedulePlanner.noEmployeesMatch')}
                                        </td>
                                    </tr>
                                ) : pagedEmployees.rows.map((emp, idx) => {
                                    const { days: wDays, hours: wHours } = computeTotals(emp)
                                    const hasPending = (pendingByEmp[emp.employeeId]?.length ?? 0) > 0
                                    const isSaving = savingEmpId === emp.employeeId
                                    const rowBg = idx % 2 === 0 ? '#ffffff' : '#fafafa'

                                    return (
                                        <tr key={emp.employeeId} style={{ backgroundColor: rowBg }}
                                            className={`border-b border-black/[0.05] group/row
                                                ${hasPending ? 'outline outline-2 outline-primary/20 outline-offset-[-1px]' : ''}`}>

                                            {/* Employee */}
                                            <td className="px-3 py-2 border-r border-black/[0.07]"
                                                style={{ position: 'sticky', left: 0, backgroundColor: rowBg, zIndex: 10 }}>
                                                <div className="flex items-center gap-2">
                                                    <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-primary font-black text-[10px] shrink-0 uppercase">
                                                        {emp.employeeName.split(' ').map(n => n[0]).join('').slice(0, 2)}
                                                    </div>
                                                    <p className="text-xs font-bold text-text-dark truncate flex-1 min-w-0">
                                                        {emp.employeeName}
                                                    </p>
                                                    {hasPending && (
                                                        <div className="flex items-center gap-1 shrink-0">
                                                            <button onClick={() => discard(emp.employeeId)}
                                                                className="w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-rose-500 hover:bg-rose-50 transition-colors text-[10px]">
                                                                ✕
                                                            </button>
                                                            <button onClick={() => saveEmployee(emp.employeeId)}
                                                                disabled={isSaving}
                                                                className="text-[10px] font-black text-white bg-primary px-2 py-0.5 rounded-md hover:bg-primary/80 disabled:opacity-50 transition-colors flex items-center gap-1">
                                                                {isSaving && <span className="spinner-ring text-[10px]" aria-hidden="true" />}
                                                                {t('common.save')}
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                            </td>

                                            {/* Total */}
                                            <td className="px-2 py-2 text-center border-r border-black/[0.07]"
                                                style={{ position: 'sticky', left: EMP_W, backgroundColor: rowBg, zIndex: 10 }}>
                                                <p className="text-sm font-black text-text-dark">{wDays}</p>
                                                <p className="text-[10px] text-text-muted">{t('schedulePlanner.hoursWithCount', { count: wHours })}</p>
                                            </td>

                                            {/* Day cells */}
                                            {columns.map(col => {
                                                const p = getEffective(emp, col.dateStr)
                                                const hasShift = !p.isDayOff && !!p.scheduleId

                                                let cellBg = col.isWeekend ? 'rgba(255,240,240,0.4)' : 'transparent'
                                                if (col.isToday) cellBg = 'rgba(170,154,212,0.08)'

                                                const chipStyle = p.isPending
                                                    ? { backgroundColor: '#fef3c7', borderColor: '#fcd34d', color: '#92400e', border: '1px solid' }
                                                    : hasShift
                                                    ? { backgroundColor: p.color + '1a', borderColor: p.color + '66', color: p.color, border: '1px solid' }
                                                    : {}

                                                return (
                                                    <td key={col.key}
                                                        onClick={() => openModal(emp.employeeId, col.dateStr, col.dayLabel, col.dayNum)}
                                                        className="border-r border-black/[0.05] last:border-r-0 cursor-pointer p-1 transition-all hover:brightness-95"
                                                        style={{ backgroundColor: cellBg }}>
                                                        <div className="flex flex-col items-center justify-center gap-0.5 w-full" style={{ minHeight: 52 }}>
                                                            {p.leaveType ? (
                                                                <div className={`w-full rounded-lg px-1.5 py-1.5 text-center ${
                                                                    p.leaveType === 'Vacation'
                                                                        ? p.leaveIsPaid ? 'bg-emerald-100 border border-emerald-300' : 'bg-yellow-50 border border-yellow-200'
                                                                        : p.leaveIsPaid ? 'bg-blue-100 border border-blue-300' : 'bg-slate-100 border border-slate-300'
                                                                }`}>
                                                                    <p className={`text-[10px] font-black leading-none ${
                                                                        p.leaveType === 'Vacation' ? (p.leaveIsPaid ? 'text-emerald-700' : 'text-yellow-700') : (p.leaveIsPaid ? 'text-blue-700' : 'text-slate-600')
                                                                    }`}>
                                                                        {p.leaveType === 'Vacation' ? t('schedulePlanner.vac') : t('schedulePlanner.off')}
                                                                    </p>
                                                                    <p className={`text-[9px] leading-none mt-0.5 ${p.leaveIsPaid ? 'text-emerald-500' : 'text-yellow-500'}`}>
                                                                        {p.leaveIsPaid ? t('schedulePlanner.paid') : t('schedulePlanner.unpaid')}
                                                                    </p>
                                                                    {p.leaveStatus === 'Pending' && <p className="text-[8px] text-amber-500 font-bold">{t('schedulePlanner.pending')}</p>}
                                                                </div>
                                                            ) : p.requestType ? (
                                                                <div className={`w-full rounded-lg px-1.5 py-1.5 text-center ${
                                                                    p.requestType === 'Vacation' ? 'bg-emerald-50 border border-emerald-200' :
                                                                    p.requestType === 'Overtime' ? 'bg-amber-50 border border-amber-200' :
                                                                    'bg-blue-50 border border-blue-200'
                                                                }`}>
                                                                    <p className={`text-[10px] font-black leading-none ${
                                                                        p.requestType === 'Vacation' ? 'text-emerald-600' :
                                                                        p.requestType === 'Overtime' ? 'text-amber-600' :
                                                                        'text-blue-600'
                                                                    }`}>
                                                                        {p.requestType === 'Vacation' ? t('schedulePlanner.vac') : p.requestType === 'Overtime' ? t('schedulePlanner.ot') : t('schedulePlanner.abs')}
                                                                    </p>
                                                                    <p className={`text-[8px] font-bold leading-none mt-0.5 ${p.requestStatus === 'Approved' ? 'text-green-500' : 'text-amber-500'}`}>
                                                                        {p.requestStatus === 'Approved' ? t('schedulePlanner.approved') : t('schedulePlanner.pending')}
                                                                    </p>
                                                                    <p className="text-[7px] text-text-muted leading-none">{t('schedulePlanner.selfSvc')}</p>
                                                                </div>
                                                            ) : hasShift ? (
                                                                <div className="w-full rounded-lg px-1.5 py-1.5 text-center" style={chipStyle}>
                                                                    <p className="text-[10px] font-black leading-none truncate">{p.scheduleName}</p>
                                                                    {(() => {
                                                                        const sched = schedules.find(s => s.id === p.scheduleId)
                                                                        if (p.shiftStart && p.shiftEnd)
                                                                            return <p className="text-[9px] opacity-70 leading-none mt-1">{p.shiftStart}–{p.shiftEnd}</p>
                                                                        if (sched?.type === 'Multi')
                                                                            return <p className="text-[9px] opacity-70 leading-none mt-1">{t('schedulePlanner.multiShift')}</p>
                                                                        if (sched?.requiredHoursPerDay)
                                                                            return <p className="text-[9px] opacity-70 leading-none mt-1">{t('schedulePlanner.hoursPerDay', { count: sched.requiredHoursPerDay })}</p>
                                                                        return null
                                                                    })()}
                                                                </div>
                                                            ) : p.isDayOff ? (
                                                                <span className="text-[11px] text-rose-300 font-bold select-none">{t('schedulePlanner.off')}</span>
                                                            ) : (
                                                                <span className="text-[20px] text-text-muted/15 group-hover/row:text-text-muted/35 transition-colors select-none">+</span>
                                                            )}
                                                        </div>
                                                    </td>
                                                )
                                            })}
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
                {!loading && !fetchError && pagedEmployees.totalPages > 1 && (
                    <div className="bg-surface border-t border-black/[0.07]">
                        <Pagination page={pagedEmployees.page} totalPages={pagedEmployees.totalPages} total={filtered.length} onPage={setPage} bordered={false} />
                    </div>
                )}
            </div>

            {/* ── Edit Modal ── */}
            {modal && (() => {
                const emp = data?.employees.find(e => e.employeeId === modal.empId)
                return (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 backdrop-blur-[2px]"
                        onClick={() => setModal(null)}>
                        <div className="bg-surface rounded-3xl shadow-2xl w-[400px] p-6 space-y-4 max-h-[90vh] overflow-y-auto"
                            onClick={e => e.stopPropagation()}>

                            {/* Header */}
                            <div className="flex items-start justify-between">
                                <div>
                                    <span className="text-[10px] font-black uppercase tracking-widest text-text-muted bg-black/[0.05] px-2 py-0.5 rounded-md">
                                        {modal.dayLabel} {modal.dayNum} · {modal.dateStr}
                                    </span>
                                    <h3 className="text-base font-black text-text-dark mt-1">{emp?.employeeName}</h3>
                                    <p className="text-[11px] text-text-muted">{t('schedulePlanner.onlyThisDate')}</p>
                                </div>
                                <button onClick={() => setModal(null)}
                                    className="w-8 h-8 flex items-center justify-center rounded-xl hover:bg-black/[0.06] text-text-muted transition-colors">
                                    <span className="material-symbols-outlined text-[18px]">close</span>
                                </button>
                            </div>

                            {/* Schedule picker */}
                            {(
                                <div className="space-y-2">
                                    <p className="text-[10px] font-black text-text-muted uppercase tracking-widest px-1">
                                        {t('schedulePlanner.selectSchedule')}
                                    </p>
                                    <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                                        {schedules.map(s => {
                                            const selected = mScheduleId === s.id
                                            return (
                                                <label key={s.id}
                                                    className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-all border
                                                        ${selected
                                                            ? 'bg-primary/10 border-primary/40'
                                                            : 'border-transparent hover:bg-black/[0.04] hover:border-black/10'}`}>
                                                    <input type="radio" name="schedule" checked={selected}
                                                        onChange={() => { setMScheduleId(s.id); setMReset(false) }}
                                                        className="w-4 h-4 accent-primary shrink-0" />
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2">
                                                            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                                                            <p className={`text-sm font-bold truncate ${selected ? 'text-primary' : 'text-text-dark'}`}>
                                                                {s.name}
                                                            </p>
                                                        </div>
                                                        {s.shiftStart && s.shiftEnd ? (
                                                            <p className="text-[10px] text-text-muted">
                                                                {s.shiftStart} – {s.shiftEnd}
                                                                {' · '}
                                                                {t('schedulePlanner.hoursWithCount', { count: Math.round((timeToMins(s.shiftEnd) - timeToMins(s.shiftStart)) / 60 * 10) / 10 })}
                                                            </p>
                                                        ) : (
                                                            <p className="text-[10px] text-text-muted">
                                                                {t('schedulePlanner.flexibleHoursPerDay', { hours: s.requiredHoursPerDay })}
                                                            </p>
                                                        )}
                                                    </div>
                                                    {selected && (
                                                        <span className="material-symbols-outlined text-primary text-[18px] shrink-0">check_circle</span>
                                                    )}
                                                </label>
                                            )
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* Reset */}
                            {mHasExisting && (
                                <label className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-all border
                                    ${mReset ? 'bg-primary/10 border-primary/40' : 'border-transparent hover:bg-black/[0.04]'}`}>
                                    <input type="checkbox" checked={mReset}
                                        onChange={e => { setMReset(e.target.checked); if (e.target.checked) { setMDayOff(false); setMScheduleId(null) } }}
                                        className="w-4 h-4 rounded accent-primary" />
                                    <div>
                                        <p className="text-sm font-bold text-text-dark">{t('schedulePlanner.clearAssignment')}</p>
                                        <p className="text-[10px] text-text-muted">{t('schedulePlanner.removeScheduleForDate')}</p>
                                    </div>
                                </label>
                            )}

                            {/* Buttons */}
                            <div className="flex gap-2 pt-1">
                                <button onClick={() => setModal(null)}
                                    className="flex-1 py-2.5 text-sm font-bold text-text-muted bg-black/[0.05] rounded-2xl hover:bg-black/[0.08] transition-colors">
                                    {t('common.cancel')}
                                </button>
                                <button onClick={applyModal}
                                    disabled={!mDayOff && !mScheduleId && !mReset}
                                    className="flex-1 py-2.5 text-sm font-bold text-white bg-primary rounded-2xl hover:bg-primary/85 disabled:opacity-40 transition-colors">
                                    {t('common.apply')}
                                </button>
                            </div>
                        </div>
                    </div>
                )
            })()}
        </AppLayout>
    )
}
