import { DateInput } from '../components/atoms/DateInput'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AppLayout } from '../components/templates'
import { Badge, Button, Input } from '../components/atoms'
import { PageHeader, Modal } from '../components/organisms'
import { apiRequest } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { useExportReport } from '../hooks/useExportReport'

const MONTH_KEYS = ['monthJanuary', 'monthFebruary', 'monthMarch', 'monthApril', 'monthMay', 'monthJune',
    'monthJuly', 'monthAugust', 'monthSeptember', 'monthOctober', 'monthNovember', 'monthDecember']
const MONTH_SHORT_KEYS = ['monthShortJan', 'monthShortFeb', 'monthShortMar', 'monthShortApr', 'monthShortMay', 'monthShortJun',
    'monthShortJul', 'monthShortAug', 'monthShortSep', 'monthShortOct', 'monthShortNov', 'monthShortDec']

function fmt(n: number) { return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
function fmtH(n: number) { return n.toFixed(1) }

type Tab = 'periods' | 'setup' | 'components'
type PeriodStatus = 'Draft' | 'Calculated' | 'Approved' | 'Paid'
type EntryStatus = 'Pending' | 'Approved' | 'Rejected'
type ComponentType = 'Allowance' | 'Bonus' | 'Deduction'
type SalaryType = 'Monthly' | 'Hourly' | 'Daily'

interface Period {
    id: string; year: number; month: number
    startDate: string; endDate: string
    status: PeriodStatus
    hoursConfirmedAt: string | null
    calculatedAt: string | null; approvedAt: string | null; notes: string | null
    employeeCount: number; totalGross: number; totalNet: number; totalTax: number
}

interface AppliedComponent { item1: string; item2: string; item3: number }

interface PayrollEntry {
    id: string; employeeId: string; employeeName: string
    employeeNo: string | null; department: string | null
    workedDays: number; workedHours: number; overtimeHours: number; absentDays: number
    latenessMinutes?: number; latenessDaysCount?: number
    earlyLeaveMinutes?: number; earlyLeaveDaysCount?: number
    basePay: number; overtimePay: number; allowancesTotal: number; bonusesTotal: number
    grossPay: number; deductionsTotal: number
    latenessDeduction?: number; earlyLeaveDeduction?: number
    taxRate: number; taxAmount: number; netPay: number
    status: EntryStatus; notes: string | null; componentsJson: string | null
}

interface PeriodDetail { period: Period; entries: PayrollEntry[] }

interface PayrollComponent {
    id: string; name: string; componentType: ComponentType
    isFixed: boolean; amount: number; percentage: number
    isDefault: boolean; isActive: boolean; description: string | null
}

interface OvertimeTier { afterHours: number; multiplier: number }
interface LatenessTier { afterMinutes: number; deductionMultiplier: number }

interface EmpSalaryConfig {
    id: string; salaryType: SalaryType; baseAmount: number; currency: string
    overtimeMultiplier: number; overtimeEnabled: boolean
    payByWorkedHours: boolean
    overtimeTiersJson: string | null
    latenessDeductionEnabled: boolean
    latenessDeductionMode?: 'Coefficient' | 'Fixed'
    latenessTiersJson: string | null
    earlyLeaveDeductionEnabled?: boolean
    earlyLeaveDeductionMode?: 'Coefficient' | 'Fixed'
    earlyLeaveTiersJson?: string | null
    effectiveFrom: string
    components: { componentId: string; name: string; componentType: string; isFixed: boolean; amount: number; percentage: number }[]
}

interface EmpRow {
    id: string; firstName: string; lastName: string; employeeNo: string | null
    department: string | null; salaryConfig: EmpSalaryConfig | null
}

function periodStatusVariant(status: PeriodStatus): 'neutral' | 'warning' | 'success' | 'primary' {
    switch (status) {
        case 'Draft': return 'neutral'
        case 'Calculated': return 'warning'
        case 'Approved': return 'success'
        case 'Paid': return 'primary'
    }
}

function entryStatusVariant(status: EntryStatus): 'warning' | 'success' | 'error' {
    switch (status) {
        case 'Pending': return 'warning'
        case 'Approved': return 'success'
        case 'Rejected': return 'error'
    }
}

function compTypeVariant(type: ComponentType): 'success' | 'primary' | 'error' {
    switch (type) {
        case 'Allowance': return 'success'
        case 'Bonus': return 'primary'
        case 'Deduction': return 'error'
    }
}

const PAYROLL_TABS: { value: Tab; labelKey: string }[] = [
    { value: 'periods', labelKey: 'payroll.tabPeriods' },
    { value: 'setup', labelKey: 'payroll.tabSalarySetup' },
    { value: 'components', labelKey: 'payroll.tabComponents' },
]

export function PayrollCalculationPage() {
    const { t } = useTranslation()
    const { token } = useAuth()
    const { exporting, downloadReport } = useExportReport(token)
    const [tab, setTab] = useState<Tab>('periods')
    const [error, setError] = useState<string | null>(null)

    // ── Periods ──────────────────────────────────────────────────────────────
    const [periods, setPeriods] = useState<Period[]>([])
    const [periodLoading, setPeriodLoading] = useState(false)
    const [periodTab, setPeriodTab] = useState<'all' | 'calculated' | 'paid'>('all')
    const [filterYear, setFilterYear] = useState<string>('')
    const [filterMonth, setFilterMonth] = useState<string>('')

    const ENTRY_COLS = useMemo(() => [
        { key: 'employee', label: t('payroll.colEmployee'), required: true },
        { key: 'dept', label: t('payroll.colDept') },
        { key: 'days', label: t('payroll.colDays') },
        { key: 'hours', label: t('payroll.colHours') },
        { key: 'ot', label: t('payroll.colOtH') },
        { key: 'late', label: t('payroll.colLateH') },
        { key: 'early', label: t('payroll.colEarlyH') },
        { key: 'allowBonus', label: t('payroll.colAllowBonus') },
        { key: 'gross', label: t('payroll.colGross') },
        { key: 'lateFine', label: t('payroll.colLateFine') },
        { key: 'earlyFine', label: t('payroll.colEarlyFine') },
        { key: 'tax', label: t('payroll.colTax') },
        { key: 'net', label: t('payroll.colNet') },
        { key: 'status', label: t('common.status') },
    ], [t])
    const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => {
        try { return new Set(JSON.parse(localStorage.getItem('payrollHiddenCols') || '[]')) } catch { return new Set() }
    })
    const [colsMenuOpen, setColsMenuOpen] = useState(false)
    useEffect(() => { localStorage.setItem('payrollHiddenCols', JSON.stringify([...hiddenCols])) }, [hiddenCols])
    const toggleCol = (k: string) => setHiddenCols(prev => {
        const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n
    })
    const isVisible = (k: string) => !hiddenCols.has(k)
    const [detail, setDetail] = useState<PeriodDetail | null>(null)
    const [detailLoading, setDetailLoading] = useState<string | null>(null) // holds period id being loaded
    const [newPeriodOpen, setNewPeriodOpen] = useState(false)
    const [newStartDate, setNewStartDate] = useState(() => {
        const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10)
    })
    const [newEndDate, setNewEndDate] = useState(() => {
        const d = new Date(); d.setMonth(d.getMonth() + 1); d.setDate(0); return d.toISOString().slice(0, 10)
    })
    const [calcTaxRate, setCalcTaxRate] = useState('14')
    const [calcMode, setCalcMode] = useState<'Full' | 'OvertimeOnly' | 'NoOvertime'>('Full')
    const [calcOpen, setCalcOpen] = useState(false)
    const [calcPeriodId, setCalcPeriodId] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const [payslip, setPayslip] = useState<PayrollEntry | null>(null)

    // ── Components ────────────────────────────────────────────────────────────
    const [components, setComponents] = useState<PayrollComponent[]>([])
    const [compLoading, setCompLoading] = useState(false)
    const [compForm, setCompForm] = useState<Partial<PayrollComponent> & { open: boolean; editId: string | null }>({
        open: false, editId: null, name: '', componentType: 'Allowance', isFixed: true,
        amount: 0, percentage: 0, isDefault: false, isActive: true, description: ''
    })

    // ── Email Report ──────────────────────────────────────────────────────────
    const [emailModal, setEmailModal] = useState<{ periodId: string; periodLabel: string } | null>(null)
    const [emailTo, setEmailTo] = useState('')
    const [emailSending, setEmailSending] = useState(false)

    async function sendPayrollReport() {
        if (!token || !emailModal || !emailTo.trim()) return
        setEmailSending(true)
        try {
            await apiRequest(`/api/payroll/periods/${emailModal.periodId}/send-email`, {
                token, method: 'POST',
                body: JSON.stringify({ to: emailTo.trim() }),
            })
            alert(t('payroll.alertReportSentTo', { email: emailTo.trim() }))
            setEmailModal(null)
            setEmailTo('')
        } catch (e: any) { alert(e?.message ?? t('payroll.alertFailedToSend')) }
        setEmailSending(false)
    }

    // ── Salary Setup ─────────────────────────────────────────────────────────
    const [employees, setEmployees] = useState<EmpRow[]>([])
    const [empLoading, setEmpLoading] = useState(false)
    const [salaryForm, setSalaryForm] = useState<{
        open: boolean; emp: EmpRow | null
        salaryType: SalaryType; baseAmount: string; currency: string
        overtimeMultiplier: string; overtimeEnabled: boolean
        payByWorkedHours: boolean
        overtimeTiers: OvertimeTier[]
        latenessDeductionEnabled: boolean
        latenessDeductionMode: 'Coefficient' | 'Fixed'
        latenessTiers: LatenessTier[]
        earlyLeaveDeductionEnabled: boolean
        earlyLeaveDeductionMode: 'Coefficient' | 'Fixed'
        earlyLeaveTiers: LatenessTier[]
        effectiveFrom: string; componentIds: Set<string>
    }>({
        open: false, emp: null, salaryType: 'Monthly', baseAmount: '',
        currency: 'AZN', overtimeMultiplier: '1.5', overtimeEnabled: true,
        payByWorkedHours: false,
        overtimeTiers: [],
        latenessDeductionEnabled: false, latenessDeductionMode: 'Coefficient', latenessTiers: [],
        earlyLeaveDeductionEnabled: false, earlyLeaveDeductionMode: 'Coefficient', earlyLeaveTiers: [],
        effectiveFrom: new Date().toISOString().slice(0, 10), componentIds: new Set()
    })

    const loadPeriods = useCallback(async () => {
        if (!token) return
        setPeriodLoading(true)
        try {
            const data = await apiRequest<Period[]>('/api/payroll/periods', { token })
            setPeriods(data)
        } catch { /* silent */ }
        setPeriodLoading(false)
    }, [token])

    const loadComponents = useCallback(async () => {
        if (!token) return
        setCompLoading(true)
        try {
            const data = await apiRequest<PayrollComponent[]>('/api/payroll/components', { token })
            setComponents(data)
        } catch { /* silent */ }
        setCompLoading(false)
    }, [token])

    const loadEmployees = useCallback(async () => {
        if (!token) return
        setEmpLoading(true)
        try {
            const data = await apiRequest<EmpRow[]>('/api/payroll/employees', { token })
            setEmployees(data)
        } catch { /* silent */ }
        setEmpLoading(false)
    }, [token])

    useEffect(() => { loadPeriods() }, [loadPeriods])
    useEffect(() => { if (tab === 'components') loadComponents() }, [tab, loadComponents])
    useEffect(() => { if (tab === 'setup') { loadEmployees(); loadComponents() } }, [tab, loadEmployees, loadComponents])

    async function toggleDetail(p: Period) {
        if (detail?.period.id === p.id) { setDetail(null); return }
        setDetailLoading(p.id)
        try {
            const data = await apiRequest<PeriodDetail>(`/api/payroll/periods/${p.id}/entries`, { token: token! })
            setDetail(data)
        } catch { /* silent */ }
        setDetailLoading(null)
    }

    async function refreshDetail(periodId: string) {
        try {
            const data = await apiRequest<PeriodDetail>(`/api/payroll/periods/${periodId}/entries`, { token: token! })
            setDetail(data)
        } catch { /* silent */ }
    }

    async function createPeriod() {
        setSaving(true)
        try {
            await apiRequest('/api/payroll/periods', {
                token: token!, method: 'POST',
                body: JSON.stringify({ startDate: newStartDate, endDate: newEndDate })
            })
            setNewPeriodOpen(false)
            loadPeriods()
        } catch (e: any) { setError(e?.message ?? t('payroll.errorCreatePeriod')) }
        setSaving(false)
    }

    async function calculate() {
        if (!calcPeriodId) return
        setSaving(true)
        try {
            await apiRequest(`/api/payroll/periods/${calcPeriodId}/calculate`, {
                token: token!, method: 'POST',
                body: JSON.stringify({ taxRate: (() => { const r = parseFloat(calcTaxRate); return Number.isFinite(r) ? r : 14 })(), mode: calcMode })
            })
            setCalcOpen(false)
            loadPeriods()
            if (detail?.period.id === calcPeriodId) await refreshDetail(calcPeriodId)
        } catch (e: any) { setError(e?.message ?? t('payroll.errorCalculation')) }
        setSaving(false)
    }

    async function confirmHours(id: string) {
        try {
            await apiRequest(`/api/payroll/periods/${id}/confirm-hours`, { token: token!, method: 'POST' })
            loadPeriods()
            if (detail?.period.id === id) await refreshDetail(id)
        } catch (e: any) { setError(e?.message ?? t('payroll.errorConfirmHours')) }
    }

    async function approvePeriod(id: string) {
        if (!confirm(t('payroll.confirmApproveAllEntries'))) return
        try {
            await apiRequest(`/api/payroll/periods/${id}/approve`, { token: token!, method: 'POST' })
            loadPeriods()
            if (detail?.period.id === id) await refreshDetail(id)
        } catch (e: any) { setError(e?.message ?? t('payroll.errorApproval')) }
    }

    async function markAsPaid(id: string) {
        if (!confirm(t('payroll.confirmMarkAsPaid'))) return
        try {
            await apiRequest(`/api/payroll/periods/${id}/mark-paid`, { token: token!, method: 'POST' })
            loadPeriods()
            if (detail?.period.id === id) await refreshDetail(id)
        } catch (e: any) { setError(e?.message ?? t('payroll.errorMarkPaid')) }
    }

    async function deletePeriod(id: string) {
        if (!confirm(t('payroll.confirmDeletePeriod'))) return
        try {
            await apiRequest(`/api/payroll/periods/${id}`, { token: token!, method: 'DELETE' })
            if (detail?.period.id === id) setDetail(null)
            loadPeriods()
        } catch (e: any) { setError(e?.message ?? t('payroll.errorDeletePeriod')) }
    }

    async function approveEntry(periodId: string, entryId: string) {
        try {
            await apiRequest(`/api/payroll/periods/${periodId}/entries/${entryId}/approve`, { token: token!, method: 'PUT' })
            await refreshDetail(periodId)
            loadPeriods()
        } catch { /* silent */ }
    }

    async function rejectEntry(periodId: string, entryId: string) {
        try {
            await apiRequest(`/api/payroll/periods/${periodId}/entries/${entryId}/reject`, { token: token!, method: 'PUT' })
            await refreshDetail(periodId)
            loadPeriods()
        } catch { /* silent */ }
    }

    // ── Components CRUD ───────────────────────────────────────────────────────
    function openCompCreate() {
        setCompForm({ open: true, editId: null, name: '', componentType: 'Allowance', isFixed: true, amount: 0, percentage: 0, isDefault: false, isActive: true, description: '' })
    }
    function openCompEdit(c: PayrollComponent) {
        setCompForm({ open: true, editId: c.id, name: c.name, componentType: c.componentType, isFixed: c.isFixed, amount: c.amount, percentage: c.percentage, isDefault: c.isDefault, isActive: c.isActive, description: c.description ?? '' })
    }
    async function saveComp() {
        setSaving(true)
        try {
            const body = JSON.stringify({
                name: compForm.name,
                componentType: typeof compForm.componentType === 'number'
                    ? (['Allowance', 'Bonus', 'Deduction'][compForm.componentType as number] ?? 'Allowance')
                    : compForm.componentType,
                isFixed: compForm.isFixed,
                amount: compForm.amount, percentage: compForm.percentage, isDefault: compForm.isDefault,
                isActive: compForm.isActive, description: compForm.description
            })
            const url = compForm.editId ? `/api/payroll/components/${compForm.editId}` : '/api/payroll/components'
            await apiRequest(url, { token: token!, method: compForm.editId ? 'PUT' : 'POST', body })
            setCompForm(f => ({ ...f, open: false }))
            loadComponents()
        } catch (e: any) { setError(e?.message ?? t('payroll.errorSave')) }
        setSaving(false)
    }
    async function deleteComp(id: string) {
        if (!confirm(t('payroll.confirmDeleteComponent'))) return
        try {
            await apiRequest(`/api/payroll/components/${id}`, { token: token!, method: 'DELETE' })
            loadComponents()
        } catch { /* silent */ }
    }

    // ── Salary Setup ──────────────────────────────────────────────────────────
    function parseTiers<T>(json: string | null | undefined): T[] {
        if (!json) return []
        try {
            const raw = JSON.parse(json) as Record<string, unknown>[]
            // Бэкенд раньше писал PascalCase. Нормализуем оба варианта в camelCase.
            return raw.map(o => {
                const out: Record<string, unknown> = {}
                for (const k of Object.keys(o)) out[k.charAt(0).toLowerCase() + k.slice(1)] = o[k]
                return out as T
            })
        } catch { return [] }
    }

    function openSalaryEdit(emp: EmpRow) {
        const cfg = emp.salaryConfig
        setSalaryForm({
            open: true, emp,
            salaryType: cfg?.salaryType ?? 'Monthly',
            baseAmount: cfg?.baseAmount?.toString() ?? '',
            currency: cfg?.currency ?? 'AZN',
            overtimeMultiplier: cfg?.overtimeMultiplier?.toString() ?? '1.5',
            overtimeEnabled: cfg?.overtimeEnabled ?? true,
            payByWorkedHours: cfg?.payByWorkedHours ?? false,
            overtimeTiers: parseTiers<OvertimeTier>(cfg?.overtimeTiersJson),
            latenessDeductionEnabled: cfg?.latenessDeductionEnabled ?? false,
            latenessDeductionMode: cfg?.latenessDeductionMode ?? 'Coefficient',
            latenessTiers: parseTiers<LatenessTier>(cfg?.latenessTiersJson),
            earlyLeaveDeductionEnabled: cfg?.earlyLeaveDeductionEnabled ?? false,
            earlyLeaveDeductionMode: cfg?.earlyLeaveDeductionMode ?? 'Coefficient',
            earlyLeaveTiers: parseTiers<LatenessTier>(cfg?.earlyLeaveTiersJson),
            effectiveFrom: cfg?.effectiveFrom ?? new Date().toISOString().slice(0, 10),
            componentIds: new Set(cfg?.components.map(c => c.componentId) ?? [])
        })
    }
    async function saveSalary() {
        if (!salaryForm.emp) return
        setSaving(true)
        try {
            await apiRequest(`/api/payroll/employees/${salaryForm.emp.id}/salary`, {
                token: token!, method: 'PUT',
                body: JSON.stringify({
                    salaryType: salaryForm.salaryType,
                    baseAmount: parseFloat(salaryForm.baseAmount) || 0,
                    currency: salaryForm.currency,
                    overtimeMultiplier: parseFloat(salaryForm.overtimeMultiplier) || 1.5,
                    overtimeEnabled: salaryForm.overtimeEnabled,
                    payByWorkedHours: salaryForm.payByWorkedHours,
                    overtimeTiers: salaryForm.overtimeTiers.length > 0 ? salaryForm.overtimeTiers : null,
                    latenessDeductionEnabled: salaryForm.latenessDeductionEnabled,
                    latenessDeductionMode: salaryForm.latenessDeductionMode,
                    latenessTiers: salaryForm.latenessTiers.length > 0 ? salaryForm.latenessTiers : null,
                    earlyLeaveDeductionEnabled: salaryForm.earlyLeaveDeductionEnabled,
                    earlyLeaveDeductionMode: salaryForm.earlyLeaveDeductionMode,
                    earlyLeaveTiers: salaryForm.earlyLeaveTiers.length > 0 ? salaryForm.earlyLeaveTiers : null,
                    effectiveFrom: salaryForm.effectiveFrom,
                    componentIds: [...salaryForm.componentIds]
                })
            })
            setSalaryForm(f => ({ ...f, open: false }))
            loadEmployees()
        } catch (e: any) { setError(e?.message ?? t('payroll.errorSave')) }
        setSaving(false)
    }

    const totalGross = periods.reduce((s, p) => s + p.totalGross, 0)
    const totalNet = periods.reduce((s, p) => s + p.totalNet, 0)
    const configuredCount = employees.filter(e => e.salaryConfig).length

    function parseComponents(json: string | null): AppliedComponent[] {
        if (!json) return []
        try { return JSON.parse(json) } catch { return [] }
    }

    return (
        <AppLayout onAction={() => { }}>
            <div className="flex-1 overflow-y-auto bg-background-light pb-20 md:pb-0">
                <div className="p-6 md:p-8 space-y-6">

                    {/* Header */}
                    <PageHeader
                        className="hidden md:flex"
                        title={t('payroll.pageTitle')}
                        description={t('payroll.pageDescription')}
                        actions={
                            tab === 'periods' ? (
                                <Button icon="add" size="md" onClick={() => setNewPeriodOpen(true)}>
                                    {t('payroll.newPeriod')}
                                </Button>
                            ) : tab === 'components' ? (
                                <Button icon="add" size="md" onClick={openCompCreate}>
                                    {t('payroll.addComponent')}
                                </Button>
                            ) : undefined
                        }
                    />

                    {/* Error banner */}
                    {error && (
                        <div className="p-4 bg-error-bg text-error-text rounded-xl text-xs font-bold border border-error-text/10 flex items-center justify-between">
                            <span>{error}</span>
                            <button onClick={() => setError(null)} className="ml-4 text-error-text/70 hover:text-error-text">
                                <span className="material-symbols-outlined text-base">close</span>
                            </button>
                        </div>
                    )}

                    {/* Summary stat cards — periods tab only */}
                    {tab === 'periods' && (
                        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 mb-2">
                            <div className="bg-surface p-4 rounded-2xl shadow-md flex flex-col items-center md:items-start text-center md:text-left">
                                <p className="text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('payroll.totalPeriods')}</p>
                                <p className="text-2xl font-black text-primary leading-none">{periods.length}</p>
                            </div>
                            <div className="bg-surface p-4 rounded-2xl shadow-md flex flex-col items-center md:items-start text-center md:text-left">
                                <p className="text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('payroll.totalGross')}</p>
                                <p className="text-2xl font-black text-primary leading-none">{fmt(totalGross)}</p>
                            </div>
                            <div className="bg-surface p-4 rounded-2xl shadow-md flex flex-col items-center md:items-start text-center md:text-left">
                                <p className="text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('payroll.totalNet')}</p>
                                <p className="text-2xl font-black text-primary leading-none">{fmt(totalNet)}</p>
                            </div>
                            <div className="bg-surface p-4 rounded-2xl shadow-md flex flex-col items-center md:items-start text-center md:text-left">
                                <p className="text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('payroll.approved')}</p>
                                <p className="text-2xl font-black text-primary leading-none">
                                    {periods.filter(p => p.status === 'Approved' || p.status === 'Paid').length}
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Tab bar */}
                    <div className="flex overflow-x-auto no-scrollbar gap-8 mt-6">
                        {PAYROLL_TABS.map(tabItem => (
                            <button
                                key={tabItem.value}
                                type="button"
                                onClick={() => setTab(tabItem.value)}
                                className={`pb-2.5 text-xs font-black whitespace-nowrap uppercase tracking-widest border-b-2 transition-colors ${tab === tabItem.value
                                    ? 'border-primary text-primary'
                                    : 'border-transparent text-text-light hover:text-text-muted'
                                    }`}
                            >
                                {t(tabItem.labelKey)}
                            </button>
                        ))}
                    </div>

                    {/* ── Periods Tab ───────────────────────────────────────────────────── */}
                    {tab === 'periods' && (() => {
                        const filtered = periods.filter(p => {
                            if (periodTab === 'calculated' && p.status !== 'Calculated') return false
                            if (periodTab === 'paid' && p.status !== 'Paid') return false
                            if (filterYear && String(p.year) !== filterYear) return false
                            if (filterMonth && String(p.month) !== filterMonth) return false
                            return true
                        })
                        const years = [...new Set(periods.map(p => p.year))].sort((a, b) => b - a)
                        return (
                        <div className="space-y-3">
                            {/* Tabs + filters */}
                            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between bg-surface rounded-2xl shadow-sm p-3">
                                <div className="flex gap-1 bg-background-light rounded-xl p-1">
                                    {(['all', 'calculated', 'paid'] as const).map(pt => (
                                        <button key={pt} type="button" onClick={() => setPeriodTab(pt)}
                                            className={`px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition ${periodTab === pt ? 'bg-primary text-white shadow-sm' : 'text-text-light hover:text-text-dark'}`}>
                                            {pt === 'all' ? t('common.all') : pt === 'calculated' ? t('payroll.statusCalculated') : t('payroll.statusPaid')} <span className="opacity-60">({pt === 'all' ? periods.length : periods.filter(p => p.status === (pt === 'calculated' ? 'Calculated' : 'Paid')).length})</span>
                                        </button>
                                    ))}
                                </div>
                                <div className="flex gap-2 items-center">
                                    <select value={filterMonth} onChange={e => setFilterMonth(e.target.value)}
                                        className="rounded-xl bg-background-light border-none px-3 py-2 text-xs font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none">
                                        <option value="">{t('payroll.allMonths')}</option>
                                        {MONTH_KEYS.map((mk, i) => <option key={i} value={i + 1}>{t(`payroll.${mk}`)}</option>)}
                                    </select>
                                    <select value={filterYear} onChange={e => setFilterYear(e.target.value)}
                                        className="rounded-xl bg-background-light border-none px-3 py-2 text-xs font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none">
                                        <option value="">{t('payroll.allYears')}</option>
                                        {years.map(y => <option key={y} value={y}>{y}</option>)}
                                    </select>
                                    {(filterMonth || filterYear) && (
                                        <button type="button" onClick={() => { setFilterMonth(''); setFilterYear('') }}
                                            className="text-[10px] font-black text-text-light hover:text-text-dark uppercase tracking-wider">
                                            {t('common.clear')}
                                        </button>
                                    )}
                                </div>
                            </div>

                            {periodLoading && (
                                <div className="flex items-center justify-center py-16">
                                    <span className="spinner-ring text-3xl text-primary" aria-hidden="true" />
                                </div>
                            )}
                            {filtered.length === 0 && !periodLoading && (
                                <div className="p-12 text-center bg-surface rounded-2xl shadow-md border-none">
                                    <span className="material-symbols-outlined text-4xl text-text-muted mb-3 block">payments</span>
                                    <p className="text-sm font-bold text-text-muted">{periods.length === 0 ? t('payroll.noPayrollPeriodsYet') : t('payroll.noPeriodsMatchFilter')}</p>
                                    <p className="text-xs text-text-light mt-1">{periods.length === 0 ? t('payroll.createNewPeriodHint') : t('payroll.tryClearingFilters')}</p>
                                </div>
                            )}
                            {filtered.map(p => (
                                <div key={p.id} className="bg-surface rounded-2xl shadow-sm overflow-hidden">
                                    <div className="p-5 flex flex-col lg:flex-row lg:items-center gap-4">
                                        {/* Period badge */}
                                        <div className="flex items-center gap-4 min-w-[200px]">
                                            <div className="w-12 h-12 rounded-2xl bg-primary/10 flex flex-col items-center justify-center shrink-0">
                                                <span className="text-[10px] font-black text-primary">{t(`payroll.${MONTH_SHORT_KEYS[p.month - 1]}`).toUpperCase()}</span>
                                                <span className="text-sm font-black text-primary">{p.year}</span>
                                            </div>
                                            <div>
                                                <p className="font-black text-text-dark text-sm">{p.startDate} — {p.endDate}</p>
                                                <Badge variant={periodStatusVariant(p.status)} className="mt-1">{t(`payroll.status${p.status}`)}</Badge>
                                            </div>
                                        </div>

                                        {/* Stats */}
                                        <div className="flex-1 grid grid-cols-2 sm:grid-cols-4 gap-4">
                                            <div>
                                                <p className="text-[8px] font-black text-text-muted uppercase tracking-widest">{t('payroll.employees')}</p>
                                                <p className="text-sm font-bold text-text-dark">{p.employeeCount}</p>
                                            </div>
                                            <div>
                                                <p className="text-[8px] font-black text-text-muted uppercase tracking-widest">{t('payroll.gross')}</p>
                                                <p className="text-sm font-bold text-text-dark">{fmt(p.totalGross)}</p>
                                            </div>
                                            <div>
                                                <p className="text-[8px] font-black text-text-muted uppercase tracking-widest">{t('payroll.tax')}</p>
                                                <p className="text-sm font-bold text-error-text">{fmt(p.totalTax)}</p>
                                            </div>
                                            <div>
                                                <p className="text-[8px] font-black text-text-muted uppercase tracking-widest">{t('payroll.net')}</p>
                                                <p className="text-sm font-black text-success-text">{fmt(p.totalNet)}</p>
                                            </div>
                                        </div>

                                        {/* Actions */}
                                        <div className="flex items-center gap-2 shrink-0 flex-wrap">
                                            {p.status === 'Draft' && !p.hoursConfirmedAt && (
                                                <Button
                                                    size="md"
                                                    onClick={() => confirmHours(p.id)}
                                                    className="bg-info-bg text-info-text hover:bg-info-text hover:text-white shadow-none"
                                                >
                                                    {t('payroll.confirmHours')}
                                                </Button>
                                            )}
                                            {p.status === 'Draft' && p.hoursConfirmedAt && (
                                                <>
                                                    <Button
                                                        variant="outline"
                                                        size="md"
                                                        onClick={() => confirmHours(p.id)}
                                                    >
                                                        {t('payroll.reSnapshot')}
                                                    </Button>
                                                    <Button
                                                        size="md"
                                                        onClick={() => { setCalcPeriodId(p.id); setCalcOpen(true) }}
                                                        className="bg-warning-bg text-warning-text hover:bg-warning-text hover:text-white shadow-none"
                                                    >
                                                        {t('payroll.calculatePay')}
                                                    </Button>
                                                </>
                                            )}
                                            {p.status === 'Calculated' && (
                                                <>
                                                    <Button
                                                        variant="outline"
                                                        size="md"
                                                        onClick={() => { setCalcPeriodId(p.id); setCalcOpen(true) }}
                                                    >
                                                        {t('payroll.recalc')}
                                                    </Button>
                                                    <Button
                                                        size="md"
                                                        onClick={() => approvePeriod(p.id)}
                                                        className="bg-success-bg text-success-text hover:bg-success-text hover:text-white shadow-none"
                                                    >
                                                        {t('payroll.approve')}
                                                    </Button>
                                                </>
                                            )}
                                            {p.status === 'Approved' && (
                                                <Button
                                                    size="md"
                                                    onClick={() => markAsPaid(p.id)}
                                                    className="bg-primary/10 text-primary hover:bg-primary hover:text-white shadow-none"
                                                >
                                                    {t('payroll.markPaid')}
                                                </Button>
                                            )}
                                            <Button
                                                variant="outline"
                                                size="md"
                                                icon="send"
                                                onClick={() => setEmailModal({ periodId: p.id, periodLabel: `${t(`payroll.${MONTH_KEYS[p.month - 1]}`)} ${p.year}` })}
                                            >
                                                {t('common.send')}
                                            </Button>
                                            <Button
                                                variant="outline"
                                                size="md"
                                                icon="table_view"
                                                disabled={!!exporting}
                                                onClick={() => downloadReport(`/api/reports/payroll/${p.id}/excel`, 'excel')}
                                            >
                                                {exporting === 'excel' ? '...' : 'Excel'}
                                            </Button>
                                            <Button
                                                variant="outline"
                                                size="md"
                                                icon="picture_as_pdf"
                                                disabled={!!exporting}
                                                onClick={() => downloadReport(`/api/reports/payroll/${p.id}/pdf`, 'pdf')}
                                            >
                                                {exporting === 'pdf' ? '...' : 'PDF'}
                                            </Button>
                                            <Button
                                                variant={detail?.period.id === p.id ? 'secondary' : 'outline'}
                                                size="md"
                                                icon={detail?.period.id === p.id ? 'expand_less' : 'expand_more'}
                                                onClick={() => toggleDetail(p)}
                                            >
                                                {detailLoading === p.id ? '...' : detail?.period.id === p.id ? t('common.close') : t('common.view')}
                                            </Button>
                                            {p.status !== 'Paid' && (
                                                <Button
                                                    variant="outline"
                                                    size="md"
                                                    icon="delete"
                                                    onClick={() => deletePeriod(p.id)}
                                                    className="text-error-text hover:bg-error-bg"
                                                >
                                                    {t('common.delete')}
                                                </Button>
                                            )}
                                        </div>
                                    </div>

                                    {/* Inline detail table */}
                                    {detail?.period.id === p.id && (
                                        <div className="border-t border-divider-light">
                                            {/* Summary row */}
                                            {detail.entries.length > 0 && (
                                                <div className="px-5 py-3 bg-slate-50/70 border-b border-divider-light grid grid-cols-2 sm:grid-cols-4 gap-4">
                                                    {[
                                                        { label: t('payroll.totalGross'), value: fmt(detail.entries.reduce((s, e) => s + e.grossPay, 0)), color: 'text-text-dark' },
                                                        { label: t('payroll.allowances'), value: fmt(detail.entries.reduce((s, e) => s + e.allowancesTotal + e.bonusesTotal, 0)), color: 'text-success-text' },
                                                        { label: t('payroll.taxPlusDeductions'), value: fmt(detail.entries.reduce((s, e) => s + e.taxAmount + e.deductionsTotal, 0)), color: 'text-error-text' },
                                                        { label: t('payroll.totalNet'), value: fmt(detail.entries.reduce((s, e) => s + e.netPay, 0)), color: 'text-success-text font-black' },
                                                    ].map(s => (
                                                        <div key={s.label}>
                                                            <p className="text-[8px] font-black text-text-muted uppercase tracking-widest">{s.label}</p>
                                                            <p className={`text-sm font-bold ${s.color}`}>{s.value}</p>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                            <div className="px-5 py-2.5 border-b border-border flex items-center justify-end">
                                                <button type="button" onClick={() => setColsMenuOpen(o => !o)}
                                                    className="text-[10px] font-black text-text-light hover:text-text-dark uppercase tracking-widest flex items-center gap-1.5 transition">
                                                    <span className="material-symbols-outlined text-base">view_column</span>
                                                    {t('payroll.columns')} ({ENTRY_COLS.filter(c => isVisible(c.key)).length}/{ENTRY_COLS.length})
                                                    <span className="material-symbols-outlined text-sm">{colsMenuOpen ? 'expand_less' : 'expand_more'}</span>
                                                </button>
                                            </div>
                                            {colsMenuOpen && (
                                                <div className="px-5 py-3 border-b border-border bg-background-light flex flex-wrap gap-x-5 gap-y-2">
                                                    {ENTRY_COLS.map(c => (
                                                        <label key={c.key} className={`flex items-center gap-2 cursor-pointer ${c.required ? 'opacity-50 cursor-not-allowed' : ''}`}>
                                                            <input type="checkbox" checked={isVisible(c.key)} disabled={c.required}
                                                                onChange={() => !c.required && toggleCol(c.key)}
                                                                className="rounded w-3.5 h-3.5 accent-primary" />
                                                            <span className="text-xs font-bold text-text-dark">{c.label}</span>
                                                        </label>
                                                    ))}
                                                </div>
                                            )}
                                            <div className="overflow-x-auto">
                                                <table className="w-full text-sm">
                                                    <thead>
                                                        <tr className="text-[10px] font-black text-text-light uppercase tracking-widest border-b border-border">
                                                            {ENTRY_COLS.filter(c => isVisible(c.key)).map(c => (
                                                                <th key={c.key} className="px-4 py-3 text-left whitespace-nowrap">{c.label}</th>
                                                            ))}
                                                            <th className="px-4 py-3"></th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {detail.entries.map(e => (
                                                            <tr key={e.id}
                                                                onClick={() => setPayslip(e)}
                                                                className="border-b border-border hover:bg-background-light cursor-pointer transition-colors group">
                                                                {isVisible('employee') && <td className="px-4 py-3 font-bold text-text-dark whitespace-nowrap group-hover:text-primary transition-colors">{e.employeeName}</td>}
                                                                {isVisible('dept') && <td className="px-4 py-3 text-text-light whitespace-nowrap">{e.department ?? '—'}</td>}
                                                                {isVisible('days') && <td className="px-4 py-3 text-text-dark">{e.workedDays}<span className="text-text-light text-xs">/{e.workedDays + e.absentDays}</span></td>}
                                                                {isVisible('hours') && <td className="px-4 py-3 text-text-dark">{fmtH(e.workedHours)}h</td>}
                                                                {isVisible('ot') && <td className="px-4 py-3 text-warning-text font-bold">{fmtH(e.overtimeHours)}h</td>}
                                                                {isVisible('late') && <td className="px-4 py-3 text-error-text">{fmtH((e.latenessMinutes ?? 0) / 60)}h</td>}
                                                                {isVisible('early') && <td className="px-4 py-3 text-error-text">{fmtH((e.earlyLeaveMinutes ?? 0) / 60)}h</td>}
                                                                {isVisible('allowBonus') && <td className="px-4 py-3 text-success-text font-bold">{fmt(e.allowancesTotal + e.bonusesTotal)}</td>}
                                                                {isVisible('gross') && <td className="px-4 py-3 font-bold text-text-dark">{fmt(e.grossPay)}</td>}
                                                                {isVisible('lateFine') && <td className="px-4 py-3 text-error-text">{fmt(e.latenessDeduction ?? 0)}</td>}
                                                                {isVisible('earlyFine') && <td className="px-4 py-3 text-error-text">{fmt(e.earlyLeaveDeduction ?? 0)}</td>}
                                                                {isVisible('tax') && <td className="px-4 py-3 text-error-text">{fmt(e.taxAmount)}<span className="text-xs text-text-light ml-1">{e.taxRate}%</span></td>}
                                                                {isVisible('net') && <td className="px-4 py-3 font-black text-success-text whitespace-nowrap">{fmt(e.netPay)}</td>}
                                                                {isVisible('status') && <td className="px-4 py-3">
                                                                    <Badge variant={entryStatusVariant(e.status)}>{t(`payroll.entryStatus${e.status}`)}</Badge>
                                                                </td>}
                                                                <td className="px-4 py-3" onClick={ev => ev.stopPropagation()}>
                                                                    {e.status === 'Pending' && (
                                                                        <div className="flex gap-1.5">
                                                                            <Button
                                                                                variant="ghost"
                                                                                size="icon"
                                                                                icon="check"
                                                                                className="text-success-text hover:bg-success-bg"
                                                                                onClick={() => approveEntry(p.id, e.id)}
                                                                            />
                                                                            <Button
                                                                                variant="ghost"
                                                                                size="icon"
                                                                                icon="close"
                                                                                className="text-error-text hover:bg-error-bg"
                                                                                onClick={() => rejectEntry(p.id, e.id)}
                                                                            />
                                                                        </div>
                                                                    )}
                                                                </td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                                {detail.entries.length === 0 && (
                                                    <p className="p-6 text-text-muted text-sm text-center italic">{t('payroll.noEntriesRunFirst')}</p>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                        )
                    })()}

                    {/* ── Setup Tab ─────────────────────────────────────────────────────── */}
                    {tab === 'setup' && (
                        <div className="space-y-4">
                            <div className="flex items-center gap-2 text-[11px] text-text-muted font-bold">
                                <span className="material-symbols-outlined text-base text-primary">info</span>
                                {t('payroll.configuredEmployeesNote', { configured: configuredCount, total: employees.length })}
                            </div>
                            {empLoading && (
                                <div className="flex items-center justify-center py-16">
                                    <span className="spinner-ring text-3xl text-primary" aria-hidden="true" />
                                </div>
                            )}
                            <div className="bg-surface rounded-2xl shadow-md overflow-hidden border-none">
                                <table className="w-full text-xs">
                                    <thead>
                                        <tr className="bg-slate-50/70">
                                            {[t('payroll.empColEmployee'), t('payroll.empColDepartment'), t('payroll.empColSalaryType'), t('payroll.empColBaseAmount'), t('payroll.empColCurrency'), t('payroll.empColOt'), t('payroll.empColComponents'), t('payroll.empColEffectiveFrom'), ''].map((h, hi) => (
                                                <th key={hi} className="px-4 py-3 text-left text-[9px] font-black text-text-muted uppercase tracking-widest">{h}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {employees.map(emp => {
                                            const cfg = emp.salaryConfig
                                            return (
                                                <tr key={emp.id} className="border-t border-divider-light hover:bg-primary/5 cursor-pointer transition-colors">
                                                    <td className="px-4 py-3 font-bold text-text-dark">{emp.firstName} {emp.lastName}</td>
                                                    <td className="px-4 py-3 text-text-muted">{emp.department ?? '—'}</td>
                                                    <td className="px-4 py-3">
                                                        {cfg
                                                            ? <Badge variant="primary">{t(`payroll.salaryType${cfg.salaryType}`)}</Badge>
                                                            : <Badge variant="error">{t('payroll.notSet')}</Badge>}
                                                    </td>
                                                    <td className="px-4 py-3 font-bold text-text-dark">{cfg ? fmt(cfg.baseAmount) : '—'}</td>
                                                    <td className="px-4 py-3 text-text-muted">{cfg?.currency ?? '—'}</td>
                                                    <td className="px-4 py-3 text-text-muted">{cfg ? `×${cfg.overtimeMultiplier}` : '—'}</td>
                                                    <td className="px-4 py-3">
                                                        {cfg ? (
                                                            <div className="flex gap-1 flex-wrap">
                                                                {cfg.components.slice(0, 3).map(c => (
                                                                    <Badge key={c.componentId} variant={compTypeVariant(c.componentType as ComponentType)}>
                                                                        {c.name}
                                                                    </Badge>
                                                                ))}
                                                                {cfg.components.length > 3 && (
                                                                    <span className="text-[8px] text-text-muted font-bold">+{cfg.components.length - 3}</span>
                                                                )}
                                                                {cfg.components.length === 0 && (
                                                                    <span className="text-[9px] text-text-muted">{t('common.none').toLowerCase()}</span>
                                                                )}
                                                            </div>
                                                        ) : '—'}
                                                    </td>
                                                    <td className="px-4 py-3 text-text-muted">{cfg?.effectiveFrom?.slice(0, 10) ?? '—'}</td>
                                                    <td className="px-4 py-3">
                                                        <Button
                                                            variant={cfg ? 'secondary' : 'outline'}
                                                            size="sm"
                                                            onClick={() => openSalaryEdit(emp)}
                                                        >
                                                            {cfg ? t('common.edit') : t('payroll.setUp')}
                                                        </Button>
                                                    </td>
                                                </tr>
                                            )
                                        })}
                                    </tbody>
                                </table>
                                {employees.length === 0 && !empLoading && (
                                    <p className="p-8 text-center text-text-muted text-sm italic">{t('payroll.noActiveEmployees')}</p>
                                )}
                            </div>
                        </div>
                    )}

                    {/* ── Components Tab ────────────────────────────────────────────────── */}
                    {tab === 'components' && (
                        <div className="space-y-4">
                            {compLoading && (
                                <div className="flex items-center justify-center py-16">
                                    <span className="spinner-ring text-3xl text-primary" aria-hidden="true" />
                                </div>
                            )}
                            <div className="bg-surface rounded-2xl shadow-md overflow-hidden border-none">
                                <table className="w-full text-xs">
                                    <thead>
                                        <tr className="bg-slate-50/70">
                                            {[t('common.name'), t('common.type'), t('payroll.compColCalculation'), t('payroll.compColValue'), t('payroll.compColAppliesTo'), t('common.active'), t('payroll.compColDescription'), ''].map((h, hi) => (
                                                <th key={hi} className="px-4 py-3 text-left text-[9px] font-black text-text-muted uppercase tracking-widest">{h}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {components.map(c => (
                                            <tr key={c.id} className="border-t border-divider-light hover:bg-primary/5 transition-colors">
                                                <td className="px-4 py-3 font-bold text-text-dark">{c.name}</td>
                                                <td className="px-4 py-3">
                                                    <Badge variant={compTypeVariant(c.componentType)}>{t(`payroll.componentType${c.componentType}`)}</Badge>
                                                </td>
                                                <td className="px-4 py-3 text-text-muted">{c.isFixed ? t('payroll.fixed') : t('payroll.percentOfBase')}</td>
                                                <td className="px-4 py-3 font-bold text-text-dark">{c.isFixed ? fmt(c.amount) : `${c.percentage}%`}</td>
                                                <td className="px-4 py-3">
                                                    {c.isDefault
                                                        ? <span className="text-[9px] font-black text-success-text">{t('payroll.allEmployees')}</span>
                                                        : <span className="text-[9px] text-text-muted">{t('payroll.individual')}</span>}
                                                </td>
                                                <td className="px-4 py-3">
                                                    <Badge variant={c.isActive ? 'success' : 'neutral'}>
                                                        {c.isActive ? t('common.active') : t('common.inactive')}
                                                    </Badge>
                                                </td>
                                                <td className="px-4 py-3 text-text-muted max-w-[180px] truncate">{c.description || '—'}</td>
                                                <td className="px-4 py-3">
                                                    <div className="flex gap-2">
                                                        <Button variant="ghost" size="sm" onClick={() => openCompEdit(c)}>{t('common.edit')}</Button>
                                                        <Button variant="ghost" size="sm" className="text-error-text hover:bg-error-bg" onClick={() => deleteComp(c.id)}>{t('common.delete')}</Button>
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                                {components.length === 0 && !compLoading && (
                                    <p className="p-8 text-center text-text-muted text-sm italic">{t('payroll.noComponentsYet')}</p>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* ── New Period Modal ───────────────────────────────────────────────────── */}
            <Modal
                isOpen={newPeriodOpen}
                onClose={() => setNewPeriodOpen(false)}
                title={t('payroll.newPayrollPeriod')}
            >
                <div className="space-y-5">
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-[10px] font-black text-text-muted uppercase tracking-wider mb-1">{t('common.from')}</label>
                            <DateInput
                                value={newStartDate}
                                onChange={e => setNewStartDate(e.target.value)}
                                className="w-full rounded-xl bg-background-light border-none px-3 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                            />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black text-text-muted uppercase tracking-wider mb-1">{t('common.to')}</label>
                            <DateInput
                                value={newEndDate}
                                onChange={e => setNewEndDate(e.target.value)}
                                className="w-full rounded-xl bg-background-light border-none px-3 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                            />
                        </div>
                    </div>
                    <div className="flex gap-3 pt-2">
                        <Button variant="outline" fullWidth onClick={() => setNewPeriodOpen(false)}>{t('common.cancel')}</Button>
                        <Button fullWidth isLoading={saving} onClick={createPeriod}>
                            {t('common.create')}
                        </Button>
                    </div>
                </div>
            </Modal>

            {/* ── Calculate Modal ────────────────────────────────────────────────────── */}
            <Modal
                isOpen={calcOpen}
                onClose={() => setCalcOpen(false)}
                title={t('payroll.runPayrollCalculation')}
            >
                <div className="space-y-5">
                    <p className="text-xs text-text-muted leading-relaxed">
                        {t('payroll.calcDescription')}
                    </p>
                    <div>
                        <label className="block text-[10px] font-black text-text-muted uppercase tracking-wider mb-1">{t('payroll.calculationMode')}</label>
                        <select
                            value={calcMode}
                            onChange={e => setCalcMode(e.target.value as 'Full' | 'OvertimeOnly' | 'NoOvertime')}
                            className="w-full rounded-xl bg-background-light border-none px-3 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                        >
                            <option value="Full">{t('payroll.calcModeFull')}</option>
                            <option value="NoOvertime">{t('payroll.calcModeNoOvertime')}</option>
                            <option value="OvertimeOnly">{t('payroll.calcModeOvertimeOnly')}</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-[10px] font-black text-text-muted uppercase tracking-wider mb-1">{t('payroll.incomeTaxRate')}</label>
                        <Input
                            type="number"
                            value={calcTaxRate}
                            onChange={e => setCalcTaxRate(e.target.value)}
                            min={0}
                            max={100}
                            step={0.5}
                        />
                    </div>
                    <div className="flex gap-3 pt-2">
                        <Button variant="outline" fullWidth onClick={() => setCalcOpen(false)}>{t('common.cancel')}</Button>
                        <Button
                            fullWidth
                            isLoading={saving}
                            onClick={calculate}
                            className="bg-warning-bg text-warning-text hover:bg-warning-text hover:text-white shadow-none"
                        >
                            {t('payroll.calculate')}
                        </Button>
                    </div>
                </div>
            </Modal>

            {/* ── Component Form Modal ───────────────────────────────────────────────── */}
            <Modal
                isOpen={compForm.open}
                onClose={() => setCompForm(f => ({ ...f, open: false }))}
                title={compForm.editId ? t('payroll.editPayComponent') : t('payroll.newPayComponent')}
            >
                <div className="space-y-4">
                    <div>
                        <label className="block text-[10px] font-black text-text-muted uppercase tracking-wider mb-1">{t('common.name')}</label>
                        <Input
                            value={compForm.name ?? ''}
                            onChange={e => setCompForm(f => ({ ...f, name: e.target.value }))}
                            placeholder={t('payroll.namePlaceholder')}
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-[10px] font-black text-text-muted uppercase tracking-wider mb-1">{t('common.type')}</label>
                            <select
                                value={compForm.componentType}
                                onChange={e => setCompForm(f => ({ ...f, componentType: e.target.value as ComponentType }))}
                                className="w-full rounded-xl bg-background-light border-none px-3 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                            >
                                <option value="Allowance">{t('payroll.componentTypeAllowance')}</option>
                                <option value="Bonus">{t('payroll.componentTypeBonus')}</option>
                                <option value="Deduction">{t('payroll.componentTypeDeduction')}</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-[10px] font-black text-text-muted uppercase tracking-wider mb-1">{t('payroll.compColCalculation')}</label>
                            <select
                                value={compForm.isFixed ? 'fixed' : 'percent'}
                                onChange={e => setCompForm(f => ({ ...f, isFixed: e.target.value === 'fixed' }))}
                                className="w-full rounded-xl bg-background-light border-none px-3 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                            >
                                <option value="fixed">{t('payroll.fixedAmount')}</option>
                                <option value="percent">{t('payroll.percentOfBaseSalary')}</option>
                            </select>
                        </div>
                    </div>
                    {compForm.isFixed ? (
                        <div>
                            <label className="block text-[10px] font-black text-text-muted uppercase tracking-wider mb-1">{t('payroll.fixedAmount')}</label>
                            <Input
                                type="number"
                                value={compForm.amount ?? 0}
                                onChange={e => setCompForm(f => ({ ...f, amount: +e.target.value }))}
                                min={0}
                            />
                        </div>
                    ) : (
                        <div>
                            <label className="block text-[10px] font-black text-text-muted uppercase tracking-wider mb-1">{t('payroll.percentageOfBase')}</label>
                            <Input
                                type="number"
                                value={compForm.percentage ?? 0}
                                onChange={e => setCompForm(f => ({ ...f, percentage: +e.target.value }))}
                                min={0}
                                max={100}
                                step={0.5}
                            />
                        </div>
                    )}
                    <div>
                        <label className="block text-[10px] font-black text-text-muted uppercase tracking-wider mb-1">{t('payroll.descriptionOptional')}</label>
                        <Input
                            value={compForm.description ?? ''}
                            onChange={e => setCompForm(f => ({ ...f, description: e.target.value }))}
                            placeholder={t('payroll.briefDescription')}
                        />
                    </div>
                    <div className="flex gap-6">
                        <label className="flex items-center gap-2 cursor-pointer select-none">
                            <input
                                type="checkbox"
                                checked={compForm.isDefault ?? false}
                                onChange={e => setCompForm(f => ({ ...f, isDefault: e.target.checked }))}
                                className="rounded w-4 h-4 accent-primary"
                            />
                            <span className="text-xs font-bold text-text-dark">{t('payroll.applyToAllEmployees')}</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer select-none">
                            <input
                                type="checkbox"
                                checked={compForm.isActive ?? true}
                                onChange={e => setCompForm(f => ({ ...f, isActive: e.target.checked }))}
                                className="rounded w-4 h-4 accent-primary"
                            />
                            <span className="text-xs font-bold text-text-dark">{t('common.active')}</span>
                        </label>
                    </div>
                    <div className="flex gap-3 pt-2">
                        <Button variant="outline" fullWidth onClick={() => setCompForm(f => ({ ...f, open: false }))}>{t('common.cancel')}</Button>
                        <Button fullWidth isLoading={saving} onClick={saveComp}>
                            {saving ? t('common.saving') : t('common.save')}
                        </Button>
                    </div>
                </div>
            </Modal>

            {/* ── Salary Config Modal ───────────────────────────────────────────────── */}
            <Modal
                isOpen={salaryForm.open && !!salaryForm.emp}
                onClose={() => setSalaryForm(f => ({ ...f, open: false }))}
                title={salaryForm.emp ? t('payroll.salaryForEmployee', { name: `${salaryForm.emp.firstName} ${salaryForm.emp.lastName}` }) : t('payroll.salarySetup')}
            >
                <div className="space-y-4">
                    {/* Base salary */}
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-[10px] font-black text-text-muted uppercase tracking-wider mb-1">{t('payroll.salaryTypeLabel')}</label>
                            <select
                                value={salaryForm.salaryType}
                                onChange={e => setSalaryForm(f => ({ ...f, salaryType: e.target.value as SalaryType }))}
                                className="w-full rounded-xl bg-background-light border-none px-3 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                            >
                                <option value="Monthly">{t('payroll.salaryTypeMonthly')}</option>
                                <option value="Hourly">{t('payroll.salaryTypeHourly')}</option>
                                <option value="Daily">{t('payroll.salaryTypeDaily')}</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-[10px] font-black text-text-muted uppercase tracking-wider mb-1">
                                {salaryForm.salaryType === 'Monthly' ? t('payroll.monthlySalary') : salaryForm.salaryType === 'Hourly' ? t('payroll.hourlyRate') : t('payroll.dailyRate')}
                            </label>
                            <Input
                                type="number"
                                value={salaryForm.baseAmount}
                                onChange={e => setSalaryForm(f => ({ ...f, baseAmount: e.target.value }))}
                                min={0}
                            />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black text-text-muted uppercase tracking-wider mb-1">{t('payroll.currency')}</label>
                            <Input
                                value={salaryForm.currency}
                                onChange={e => setSalaryForm(f => ({ ...f, currency: e.target.value }))}
                            />
                        </div>
                        <div className="flex items-end pb-1">
                            <label className="flex items-center gap-2 cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={salaryForm.payByWorkedHours}
                                    onChange={e => setSalaryForm(f => ({ ...f, payByWorkedHours: e.target.checked }))}
                                    className="rounded w-4 h-4 accent-primary"
                                />
                                <div>
                                    <span className="text-xs font-bold text-text-dark block">{t('payroll.payByWorkedHours')}</span>
                                    <span className="text-[9px] text-text-muted">{t('payroll.payByWorkedHoursHint')}</span>
                                </div>
                            </label>
                        </div>
                        <div className="col-span-2">
                            <label className="block text-[10px] font-black text-text-muted uppercase tracking-wider mb-1">{t('payroll.effectiveFrom')}</label>
                            <DateInput
                                value={salaryForm.effectiveFrom}
                                onChange={e => setSalaryForm(f => ({ ...f, effectiveFrom: e.target.value }))}
                                className="w-full rounded-xl bg-background-light border-none px-3 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                            />
                        </div>
                    </div>

                    {/* Overtime section */}
                    <div className="border border-divider-light rounded-2xl p-4 space-y-3">
                        <div className="flex items-center justify-between">
                            <p className="text-[10px] font-black text-text-muted uppercase tracking-wider">{t('payroll.overtime')}</p>
                            <label className="flex items-center gap-2 cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={salaryForm.overtimeEnabled}
                                    onChange={e => setSalaryForm(f => ({ ...f, overtimeEnabled: e.target.checked }))}
                                    className="rounded w-4 h-4 accent-primary"
                                />
                                <span className="text-xs font-bold text-text-dark">{salaryForm.overtimeEnabled ? t('common.enabled') : t('common.disabled')}</span>
                            </label>
                        </div>
                        {salaryForm.overtimeEnabled && (<>
                            {salaryForm.overtimeTiers.length === 0 && (
                                <div>
                                    <label className="block text-[10px] font-black text-text-muted uppercase tracking-wider mb-1">{t('payroll.singleMultiplier')}</label>
                                    <Input
                                        type="number"
                                        value={salaryForm.overtimeMultiplier}
                                        onChange={e => setSalaryForm(f => ({ ...f, overtimeMultiplier: e.target.value }))}
                                        min={1}
                                        step={0.25}
                                    />
                                </div>
                            )}
                            <div className="space-y-2">
                                <p className="text-[9px] font-black text-text-muted uppercase tracking-wider">{t('payroll.overtimeTiers')}</p>
                                {salaryForm.overtimeTiers.map((tier, i) => (
                                    <div key={i} className="flex items-center gap-2">
                                        <div className="flex-1">
                                            <label className="block text-[8px] text-text-muted font-bold mb-1">{t('payroll.afterOtHours')}</label>
                                            <input
                                                type="number"
                                                value={tier.afterHours}
                                                min={0}
                                                step={0.5}
                                                onChange={e => setSalaryForm(f => {
                                                    const t = [...f.overtimeTiers]; t[i] = { ...t[i], afterHours: parseFloat(e.target.value) || 0 }; return { ...f, overtimeTiers: t }
                                                })}
                                                className="w-full rounded-xl bg-background-light border-none px-3 py-2 text-xs font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                                            />
                                        </div>
                                        <div className="flex-1">
                                            <label className="block text-[8px] text-text-muted font-bold mb-1">{t('payroll.multiplierX')}</label>
                                            <input
                                                type="number"
                                                value={tier.multiplier}
                                                min={1}
                                                step={0.25}
                                                onChange={e => setSalaryForm(f => {
                                                    const t = [...f.overtimeTiers]; t[i] = { ...t[i], multiplier: parseFloat(e.target.value) || 1 }; return { ...f, overtimeTiers: t }
                                                })}
                                                className="w-full rounded-xl bg-background-light border-none px-3 py-2 text-xs font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                                            />
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => setSalaryForm(f => ({ ...f, overtimeTiers: f.overtimeTiers.filter((_, j) => j !== i) }))}
                                            className="mt-4 text-error-text hover:text-error-text/80 text-lg font-black leading-none"
                                        >
                                            <span className="material-symbols-outlined text-base">close</span>
                                        </button>
                                    </div>
                                ))}
                                <button
                                    type="button"
                                    onClick={() => setSalaryForm(f => ({ ...f, overtimeTiers: [...f.overtimeTiers, { afterHours: f.overtimeTiers.length === 0 ? 0 : (f.overtimeTiers[f.overtimeTiers.length - 1].afterHours + 10), multiplier: 1.5 }] }))}
                                    className="text-[9px] font-black text-primary hover:underline uppercase tracking-wider"
                                >
                                    {t('payroll.addTier')}
                                </button>
                            </div>
                        </>)}
                    </div>

                    {/* Lateness deduction section */}
                    <div className="border border-divider-light rounded-2xl p-4 space-y-3">
                        <div className="flex items-center justify-between">
                            <p className="text-[10px] font-black text-text-muted uppercase tracking-wider">{t('payroll.latenessDeduction')}</p>
                            <label className="flex items-center gap-2 cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={salaryForm.latenessDeductionEnabled}
                                    onChange={e => setSalaryForm(f => ({ ...f, latenessDeductionEnabled: e.target.checked }))}
                                    className="rounded w-4 h-4 accent-primary"
                                />
                                <span className="text-xs font-bold text-text-dark">{salaryForm.latenessDeductionEnabled ? t('common.enabled') : t('common.disabled')}</span>
                            </label>
                        </div>
                        {salaryForm.latenessDeductionEnabled && (
                            <div className="space-y-3">
                                <div>
                                    <label className="block text-[10px] font-black text-text-muted uppercase tracking-wider mb-1">{t('payroll.deductionMode')}</label>
                                    <select
                                        value={salaryForm.latenessDeductionMode}
                                        onChange={e => setSalaryForm(f => ({ ...f, latenessDeductionMode: e.target.value as 'Coefficient' | 'Fixed' }))}
                                        className="w-full rounded-xl bg-background-light border-none px-3 py-2 text-xs font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                                    >
                                        <option value="Coefficient">{t('payroll.latenessModeCoefficient')}</option>
                                        <option value="Fixed">{t('payroll.latenessModeFixed')}</option>
                                    </select>
                                    <p className="text-[10px] text-text-muted mt-1">
                                        {salaryForm.latenessDeductionMode === 'Fixed'
                                            ? t('payroll.latenessTierHintFixed')
                                            : t('payroll.latenessTierHintCoefficient')}
                                    </p>
                                </div>
                                <p className="text-[9px] font-black text-text-muted uppercase tracking-wider">{t('payroll.latenessTiersTitle')}</p>
                                {salaryForm.latenessTiers.map((tier, i) => (
                                    <div key={i} className="flex items-center gap-2">
                                        <div className="flex-1">
                                            <label className="block text-[8px] text-text-muted font-bold mb-1">{t('payroll.afterMinLate')}</label>
                                            <input
                                                type="number"
                                                value={tier.afterMinutes}
                                                min={0}
                                                onChange={e => setSalaryForm(f => {
                                                    const t = [...f.latenessTiers]; t[i] = { ...t[i], afterMinutes: parseInt(e.target.value) || 0 }; return { ...f, latenessTiers: t }
                                                })}
                                                className="w-full rounded-xl bg-background-light border-none px-3 py-2 text-xs font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                                            />
                                        </div>
                                        <div className="flex-1">
                                            <label className="block text-[8px] text-text-muted font-bold mb-1">{salaryForm.latenessDeductionMode === 'Fixed' ? t('payroll.fineFixedPerLateDay') : t('payroll.deductionMultiplier')}</label>
                                            <input
                                                type="number"
                                                value={tier.deductionMultiplier}
                                                min={0}
                                                step={0.25}
                                                onChange={e => setSalaryForm(f => {
                                                    const t = [...f.latenessTiers]; t[i] = { ...t[i], deductionMultiplier: parseFloat(e.target.value) || 1 }; return { ...f, latenessTiers: t }
                                                })}
                                                className="w-full rounded-xl bg-background-light border-none px-3 py-2 text-xs font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                                            />
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => setSalaryForm(f => ({ ...f, latenessTiers: f.latenessTiers.filter((_, j) => j !== i) }))}
                                            className="mt-4 text-error-text hover:text-error-text/80 text-lg font-black leading-none"
                                        >
                                            <span className="material-symbols-outlined text-base">close</span>
                                        </button>
                                    </div>
                                ))}
                                <button
                                    type="button"
                                    onClick={() => setSalaryForm(f => ({ ...f, latenessTiers: [...f.latenessTiers, { afterMinutes: f.latenessTiers.length === 0 ? 5 : (f.latenessTiers[f.latenessTiers.length - 1].afterMinutes + 15), deductionMultiplier: 1 }] }))}
                                    className="text-[9px] font-black text-primary hover:underline uppercase tracking-wider"
                                >
                                    {t('payroll.addTier')}
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Early-leave deduction section */}
                    <div className="border border-divider-light rounded-2xl p-4 space-y-3">
                        <div className="flex items-center justify-between">
                            <p className="text-[10px] font-black text-text-muted uppercase tracking-wider">{t('payroll.earlyLeaveDeduction')}</p>
                            <label className="flex items-center gap-2 cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={salaryForm.earlyLeaveDeductionEnabled}
                                    onChange={e => setSalaryForm(f => ({ ...f, earlyLeaveDeductionEnabled: e.target.checked }))}
                                    className="rounded w-4 h-4 accent-primary"
                                />
                                <span className="text-xs font-bold text-text-dark">{salaryForm.earlyLeaveDeductionEnabled ? t('common.enabled') : t('common.disabled')}</span>
                            </label>
                        </div>
                        {salaryForm.earlyLeaveDeductionEnabled && (
                            <div className="space-y-3">
                                <div>
                                    <label className="block text-[10px] font-black text-text-muted uppercase tracking-wider mb-1">{t('payroll.deductionMode')}</label>
                                    <select
                                        value={salaryForm.earlyLeaveDeductionMode}
                                        onChange={e => setSalaryForm(f => ({ ...f, earlyLeaveDeductionMode: e.target.value as 'Coefficient' | 'Fixed' }))}
                                        className="w-full rounded-xl bg-background-light border-none px-3 py-2 text-xs font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                                    >
                                        <option value="Coefficient">{t('payroll.earlyLeaveModeCoefficient')}</option>
                                        <option value="Fixed">{t('payroll.earlyLeaveModeFixed')}</option>
                                    </select>
                                    <p className="text-[10px] text-text-muted mt-1">
                                        {salaryForm.earlyLeaveDeductionMode === 'Fixed'
                                            ? t('payroll.earlyLeaveTierHintFixed')
                                            : t('payroll.earlyLeaveTierHintCoefficient')}
                                    </p>
                                </div>
                                <p className="text-[9px] font-black text-text-muted uppercase tracking-wider">{t('payroll.earlyLeaveTiersTitle')}</p>
                                {salaryForm.earlyLeaveTiers.map((tier, i) => (
                                    <div key={i} className="flex items-center gap-2">
                                        <div className="flex-1">
                                            <label className="block text-[8px] text-text-muted font-bold mb-1">{t('payroll.afterMinEarly')}</label>
                                            <input
                                                type="number"
                                                value={tier.afterMinutes}
                                                min={0}
                                                onChange={e => setSalaryForm(f => {
                                                    const t = [...f.earlyLeaveTiers]; t[i] = { ...t[i], afterMinutes: parseInt(e.target.value) || 0 }; return { ...f, earlyLeaveTiers: t }
                                                })}
                                                className="w-full rounded-xl bg-background-light border-none px-3 py-2 text-xs font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                                            />
                                        </div>
                                        <div className="flex-1">
                                            <label className="block text-[8px] text-text-muted font-bold mb-1">{salaryForm.earlyLeaveDeductionMode === 'Fixed' ? t('payroll.fineFixedPerEarlyDay') : t('payroll.deductionMultiplier')}</label>
                                            <input
                                                type="number"
                                                value={tier.deductionMultiplier}
                                                min={0}
                                                step={0.25}
                                                onChange={e => setSalaryForm(f => {
                                                    const t = [...f.earlyLeaveTiers]; t[i] = { ...t[i], deductionMultiplier: parseFloat(e.target.value) || 1 }; return { ...f, earlyLeaveTiers: t }
                                                })}
                                                className="w-full rounded-xl bg-background-light border-none px-3 py-2 text-xs font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                                            />
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => setSalaryForm(f => ({ ...f, earlyLeaveTiers: f.earlyLeaveTiers.filter((_, j) => j !== i) }))}
                                            className="mt-4 text-error-text hover:text-error-text/80 text-lg font-black leading-none"
                                        >
                                            <span className="material-symbols-outlined text-base">close</span>
                                        </button>
                                    </div>
                                ))}
                                <button
                                    type="button"
                                    onClick={() => setSalaryForm(f => ({ ...f, earlyLeaveTiers: [...f.earlyLeaveTiers, { afterMinutes: f.earlyLeaveTiers.length === 0 ? 5 : (f.earlyLeaveTiers[f.earlyLeaveTiers.length - 1].afterMinutes + 15), deductionMultiplier: 1 }] }))}
                                    className="text-[9px] font-black text-primary hover:underline uppercase tracking-wider"
                                >
                                    {t('payroll.addTier')}
                                </button>
                            </div>
                        )}
                    </div>

                    {components.filter(c => c.isActive).length > 0 && (
                        <div>
                            <p className="text-[10px] font-black text-text-muted uppercase tracking-wider mb-2">{t('payroll.payComponents')}</p>
                            <div className="space-y-1 max-h-52 overflow-y-auto border border-divider-light rounded-2xl p-3">
                                {components.filter(c => c.isActive).map(c => (
                                    <label
                                        key={c.id}
                                        className={`flex items-center gap-2 cursor-pointer py-1.5 px-2 rounded-xl transition ${salaryForm.componentIds.has(c.id) ? 'bg-primary/5' : 'hover:bg-slate-50'}`}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={salaryForm.componentIds.has(c.id)}
                                            onChange={ev => setSalaryForm(f => {
                                                const s = new Set(f.componentIds)
                                                ev.target.checked ? s.add(c.id) : s.delete(c.id)
                                                return { ...f, componentIds: s }
                                            })}
                                            className="rounded w-4 h-4 accent-primary"
                                        />
                                        <Badge variant={compTypeVariant(c.componentType)}>{c.componentType[0]}</Badge>
                                        <span className="text-xs font-bold text-text-dark flex-1">{c.name}</span>
                                        {c.isDefault && <span className="text-[8px] font-black text-text-muted">{t('payroll.defaultBadge')}</span>}
                                        <span className="text-xs text-text-muted">{c.isFixed ? fmt(c.amount) : `${c.percentage}%`}</span>
                                    </label>
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="flex gap-3 pt-2">
                        <Button variant="outline" fullWidth onClick={() => setSalaryForm(f => ({ ...f, open: false }))}>{t('common.cancel')}</Button>
                        <Button fullWidth isLoading={saving} onClick={saveSalary}>
                            {saving ? t('common.saving') : t('common.save')}
                        </Button>
                    </div>
                </div>
            </Modal>

            {/* ── Payslip Modal ─────────────────────────────────────────────────────── */}
            <Modal
                isOpen={!!payslip}
                onClose={() => setPayslip(null)}
                title={payslip?.employeeName ?? t('payroll.payslip')}
                actions={payslip ? <Badge variant={entryStatusVariant(payslip.status)}>{t(`payroll.entryStatus${payslip.status}`)}</Badge> : undefined}
            >
                {payslip && (
                    <div className="space-y-5">
                        <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">
                            {payslip.department ?? ''}{payslip.employeeNo ? ` · #${payslip.employeeNo}` : ''}
                        </p>

                        {/* Attendance */}
                        <div className="bg-slate-50/70 rounded-2xl p-4 grid grid-cols-3 gap-3 text-center">
                            {[
                                { label: t('payroll.workedDays'), value: payslip.workedDays },
                                { label: t('payroll.workedHours'), value: `${fmtH(payslip.workedHours)}h` },
                                { label: t('payroll.overtime'), value: `${fmtH(payslip.overtimeHours)}h` },
                            ].map(s => (
                                <div key={s.label}>
                                    <p className="text-[8px] font-black text-text-muted uppercase tracking-widest mb-1">{s.label}</p>
                                    <p className="text-base font-black text-text-dark">{s.value}</p>
                                </div>
                            ))}
                        </div>

                        {/* Earnings breakdown */}
                        <div className="space-y-2">
                            <p className="text-[9px] font-black text-text-muted uppercase tracking-widest">{t('payroll.earnings')}</p>
                            {[
                                { label: t('payroll.basePay'), value: payslip.basePay, color: 'text-text-dark' },
                                { label: t('payroll.overtimePay'), value: payslip.overtimePay, color: 'text-warning-text' },
                                { label: t('payroll.allowances'), value: payslip.allowancesTotal, color: 'text-success-text' },
                                { label: t('payroll.bonuses'), value: payslip.bonusesTotal, color: 'text-primary' },
                            ].map(r => r.value !== 0 && (
                                <div key={r.label} className="flex justify-between text-xs">
                                    <span className="text-text-muted font-bold">{r.label}</span>
                                    <span className={`font-bold ${r.color}`}>{fmt(r.value)}</span>
                                </div>
                            ))}
                            <div className="flex justify-between text-sm font-black border-t border-divider-light pt-2">
                                <span className="text-text-dark">{t('payroll.grossPay')}</span>
                                <span className="text-text-dark">{fmt(payslip.grossPay)}</span>
                            </div>
                        </div>

                        {/* Deductions */}
                        <div className="space-y-2">
                            <p className="text-[9px] font-black text-text-muted uppercase tracking-widest">{t('payroll.deductions')}</p>
                            {payslip.deductionsTotal > 0 && (
                                <div className="flex justify-between text-xs">
                                    <span className="text-text-muted font-bold">{t('payroll.otherDeductions')}</span>
                                    <span className="font-bold text-error-text">−{fmt(payslip.deductionsTotal)}</span>
                                </div>
                            )}
                            <div className="flex justify-between text-xs">
                                <span className="text-text-muted font-bold">{t('payroll.incomeTaxPercent', { rate: payslip.taxRate })}</span>
                                <span className="font-bold text-error-text">−{fmt(payslip.taxAmount)}</span>
                            </div>
                        </div>

                        {/* Applied components */}
                        {parseComponents(payslip.componentsJson).length > 0 && (
                            <div className="space-y-1.5">
                                <p className="text-[9px] font-black text-text-muted uppercase tracking-widest">{t('payroll.appliedComponents')}</p>
                                {parseComponents(payslip.componentsJson).map((c, i) => (
                                    <div key={i} className="flex justify-between text-xs items-center">
                                        <div className="flex items-center gap-1.5">
                                            <Badge variant={compTypeVariant(c.item2 as ComponentType)}>{c.item2[0]}</Badge>
                                            <span className="text-text-muted font-bold">{c.item1}</span>
                                        </div>
                                        <span className={`font-bold ${c.item2 === 'Deduction' ? 'text-error-text' : 'text-success-text'}`}>
                                            {c.item2 === 'Deduction' ? '−' : '+'}{fmt(c.item3)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Net */}
                        <div className="bg-success-bg rounded-2xl p-4 flex justify-between items-center">
                            <span className="text-sm font-black text-success-text">{t('payroll.netPay')}</span>
                            <span className="text-2xl font-black text-success-text">{fmt(payslip.netPay)}</span>
                        </div>

                        <Button variant="outline" fullWidth onClick={() => setPayslip(null)}>{t('common.close')}</Button>
                    </div>
                )}
            </Modal>

            {emailModal && (
                <Modal isOpen title={t('payroll.sendPayrollReportTitle', { period: emailModal.periodLabel })} onClose={() => { setEmailModal(null); setEmailTo('') }}>
                    <div className="space-y-4">
                        <p className="text-xs text-text-light">{t('payroll.payrollSummaryEmailNote', { period: emailModal.periodLabel })}</p>
                        <div className="space-y-2">
                            <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('payroll.recipientEmail')}</label>
                            <Input
                                type="email"
                                placeholder="accountant@company.com"
                                value={emailTo}
                                onChange={e => setEmailTo(e.target.value)}
                                autoFocus
                            />
                        </div>
                        <div className="flex gap-2">
                            <Button fullWidth onClick={sendPayrollReport} isLoading={emailSending} disabled={!emailTo.trim()}>
                                {t('common.send')}
                            </Button>
                            <Button fullWidth variant="outline" onClick={() => { setEmailModal(null); setEmailTo('') }} disabled={emailSending}>
                                {t('common.cancel')}
                            </Button>
                        </div>
                    </div>
                </Modal>
            )}
        </AppLayout>
    )
}
