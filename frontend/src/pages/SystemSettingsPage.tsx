import { useState, useRef, useEffect, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AppLayout } from '../components/templates'
import { Button, Input, Toggle } from '../components/atoms'
import { Modal, PageHeader } from '../components/organisms'
import { copyToClipboard } from '../lib/clipboard'
import { CompanyTab } from './CompanyTab'
import { HousingTab } from './HousingTab'
import { useModule } from '../context/ModuleContext'
import { DevicesTab } from './DevicesTab'
import { useAuth } from '../auth/AuthContext'
import { apiRequest, getApiBaseUrl } from '../lib/api'
import { useLoading } from '../context/LoadingContext'
import { SUPPORTED_LANGUAGES } from '../i18n'

function formatLocalDate(d: Date): string {
    const pad = (n: number) => n.toString().padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ─── AktivParking scoped restyle (page-only, prefixed .stg-*) ───────────────────
const STG_RESTYLE = `
.stg-page{--ap-acc:#6C5CE7;--ap-acc-soft:#EEECFB;--ap-acc-softer:#F3F1FC;--ap-bg:#F6F6FB;--ap-panel:#fff;--ap-line:#ECECF3;--ap-ink:#252641;--ap-ink2:#4A4B6B;--ap-muted:#8B8CA7;--ap-shadow:0 1px 2px rgba(37,38,65,.04),0 8px 24px rgba(37,38,65,.05);background:var(--ap-bg)}
.stg-page .rounded-3xl{border-radius:16px!important}
.stg-page .rounded-2xl{border-radius:12px!important}
.stg-page .shadow-md,.stg-page .shadow-sm,.stg-page .shadow{box-shadow:var(--ap-shadow)!important}
.stg-page h2,.stg-page h3{letter-spacing:-.3px}
.stg-page table thead th{font-size:12px;letter-spacing:.4px;color:var(--ap-muted)!important}
.stg-page table tbody tr:hover{background:var(--ap-acc-softer)!important}
.stg-page input:focus,.stg-page select:focus,.stg-page textarea:focus{border-color:var(--ap-acc)!important;box-shadow:0 0 0 3px var(--ap-acc-soft)!important}
.stg-page .shadow-primary{box-shadow:0 6px 16px rgba(108,92,231,.28)!important}
/* Вкладок много — горизонтальный скролл живёт внутри самой ленты вкладок,
   поэтому страница целиком больше не едет вбок. Полоса тонкая (глобальная — 10px). */
.stg-page .stg-tabs{overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;scrollbar-color:#d8d4e6 transparent;overscroll-behavior-x:contain}
.stg-page .stg-tabs::-webkit-scrollbar{height:6px}
.stg-page .stg-tabs::-webkit-scrollbar-thumb{background:#d8d4e6;border:none;border-radius:999px}
.stg-page .stg-tabs::-webkit-scrollbar-thumb:hover{background:#bcb5d4;border:none}
`

type SettingsTab = 'global' | 'criteria' | 'devices' | 'company' | 'housing' | 'logSync' | 'email' | 'assistant' | 'templates' | 'users' | 'roles' | 'debugLogs'

// Davamiyyət kriteriyaları (GET/PUT /api/attendance-criteria)
interface AttCriterion { key: string; label: string; letter: string; color: string; enabled: boolean; sortOrder: number; displayMode: string }

export function SystemSettingsPage() {
    const { t, i18n } = useTranslation()
    const location = useLocation()
    const queryParams = new URLSearchParams(location.search)
    const tabParam = queryParams.get('tab')
    const initialTab: SettingsTab =
        tabParam === 'devices' ? 'devices'
            : tabParam === 'company' ? 'company'
            : tabParam === 'log-sync' ? 'logSync'
            : tabParam === 'email' ? 'email'
            : tabParam === 'assistant' ? 'assistant'
            : tabParam === 'templates' ? 'templates'
            : tabParam === 'users' ? 'users'
            : tabParam === 'roles' ? 'roles'
            : tabParam === 'debug-logs' ? 'debugLogs'
            : tabParam === 'criteria' ? 'criteria'
            : 'global'

    const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab)
    // Структура дома нужна только в модуле ЖКХ — в остальных вкладка лишняя.
    const { activeModule } = useModule()
    const isHousing = activeModule === 'housing'
    const devicesRef = useRef<{ triggerAction: () => void } | null>(null)
    const tabsRef = useRef<HTMLDivElement>(null)
    const { token, user: currentUser } = useAuth()
    const { startLoading, stopLoading } = useLoading()
    const [companyMode, setCompanyMode] = useState<'Single' | 'Multiple' | 'None'>('None')
    const [companies, setCompanies] = useState<{ id: string; name: string }[]>([])
    const [isSavingMode, setIsSavingMode] = useState(false)
    const [showCompanyNameModal, setShowCompanyNameModal] = useState<'Single' | 'Multiple' | null>(null)
    const [companyNameInput, setCompanyNameInput] = useState('')

    useEffect(() => {
        const tab = new URLSearchParams(location.search).get('tab')
        if (tab === 'devices') setActiveTab('devices')
        else if (tab === 'company') setActiveTab('company')
        else if (tab === 'housing') setActiveTab('housing')
        else if (tab === 'log-sync') setActiveTab('logSync')
        else if (tab === 'global') setActiveTab('global')
        else if (tab === 'email') setActiveTab('email')
        else if (tab === 'assistant') setActiveTab('assistant')
        else if (tab === 'templates') setActiveTab('templates')
        else if (tab === 'users') setActiveTab('users')
        else if (tab === 'roles') setActiveTab('roles')
        else if (tab === 'debug-logs') setActiveTab('debugLogs')
        else if (tab === 'criteria') setActiveTab('criteria')
    }, [location.search])

    // Активная вкладка может оказаться за правым краем ленты — подтягиваем её в видимую часть.
    // block:'nearest' — чтобы страница при этом не прыгала по вертикали.
    useEffect(() => {
        tabsRef.current
            ?.querySelector<HTMLElement>('[data-active="true"]')
            ?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
    }, [activeTab])

    // ─── Localization & Runtime: time/timezone push to devices ───
    // POSIX-style strings as Hikvision ISAPI accepts (sign inverted relative to UTC).
    const TIMEZONE_OPTIONS: { label: string; posix: string }[] = [
        { label: '(UTC+04:00) Baku, Azerbaijan', posix: 'AZT-4:00:00' },
        { label: '(UTC+03:00) Istanbul, Moscow', posix: 'TRT-3:00:00' },
        { label: '(UTC+00:00) London, UTC', posix: 'GMT0:00:00' },
        { label: '(UTC+01:00) Berlin, Paris', posix: 'CET-1:00:00' },
        { label: '(UTC+02:00) Athens, Kyiv', posix: 'EET-2:00:00' },
        { label: '(UTC+05:00) Tashkent', posix: 'UZT-5:00:00' },
        { label: '(UTC+05:30) New Delhi', posix: 'IST-5:30:00' },
        { label: '(UTC+08:00) Beijing, Singapore', posix: 'CST-8:00:00' },
        { label: '(UTC+09:00) Tokyo', posix: 'JST-9:00:00' },
        { label: '(UTC-05:00) New York (EST)', posix: 'EST5:00:00' },
        { label: '(UTC-08:00) Los Angeles (PST)', posix: 'PST8:00:00' },
    ]
    const [selectedTimeZone, setSelectedTimeZone] = useState<string>(TIMEZONE_OPTIONS[0].posix)
    const [serverNow, setServerNow] = useState<Date>(new Date())
    const [timeSyncing, setTimeSyncing] = useState(false)
    type TimeSyncResult = { deviceId: string; deviceName: string; success: boolean; message: string | null }
    const [timeSyncResults, setTimeSyncResults] = useState<TimeSyncResult[] | null>(null)

    // Расписание автосинхронизации времени
    type TimeSchedule = {
        autoEnabled: boolean
        dailyTimeLocal: string
        timeZone: string | null
        lastRunUtc: string | null
        lastSuccessCount: number | null
        lastTotal: number | null
        lastRunKind: string | null
    }
    const [timeSchedule, setTimeSchedule] = useState<TimeSchedule | null>(null)
    const [timeScheduleDraftEnabled, setTimeScheduleDraftEnabled] = useState(false)
    const [timeScheduleDraftTime, setTimeScheduleDraftTime] = useState('03:00')
    const [timeScheduleSaving, setTimeScheduleSaving] = useState(false)

    useEffect(() => {
        const id = setInterval(() => setServerNow(new Date()), 1000)
        return () => clearInterval(id)
    }, [])

    const loadTimeSchedule = useCallback(async () => {
        if (!token) return
        try {
            const s = await apiRequest<TimeSchedule>('/api/devices/time/schedule', { token })
            setTimeSchedule(s)
            setTimeScheduleDraftEnabled(s.autoEnabled)
            setTimeScheduleDraftTime(s.dailyTimeLocal || '03:00')
            if (s.timeZone) setSelectedTimeZone(s.timeZone)
        } catch (e) {
            console.error('Failed to load time-sync schedule', e)
        }
    }, [token])

    useEffect(() => {
        if (!token || activeTab !== 'global') return
        void loadTimeSchedule()
    }, [token, activeTab, loadTimeSchedule])

    const saveTimeSchedule = async () => {
        if (!token) return
        setTimeScheduleSaving(true)
        try {
            await apiRequest('/api/devices/time/schedule', {
                method: 'POST',
                token,
                body: JSON.stringify({
                    autoEnabled: timeScheduleDraftEnabled,
                    dailyTimeLocal: timeScheduleDraftTime,
                    timeZone: selectedTimeZone,
                }),
            })
            await loadTimeSchedule()
        } catch (e) {
            alert(e instanceof Error ? e.message : t('systemSettings.errors.saveScheduleFailed'))
        } finally {
            setTimeScheduleSaving(false)
        }
    }

    const syncTimeToAllDevices = async () => {
        if (!token) return
        setTimeSyncing(true)
        setTimeSyncResults(null)
        try {
            const res = await apiRequest<{ total: number; successCount: number; results: TimeSyncResult[] }>(
                '/api/devices/time/sync-all',
                { method: 'POST', token, body: JSON.stringify({ timeZone: selectedTimeZone }) },
            )
            setTimeSyncResults(res.results)
            await loadTimeSchedule()
        } catch (e) {
            alert(e instanceof Error ? e.message : t('systemSettings.errors.timeSyncFailed'))
        } finally {
            setTimeSyncing(false)
        }
    }

    const [logSyncSettings, setLogSyncSettings] = useState<{
        autoEnabled: boolean
        dailyTimeLocal: string
        lastRunUtc?: string | null
        lastRecordsAdded?: number | null
        lastRunKind?: string | null
    } | null>(null)
    const [logSyncManualFrom, setLogSyncManualFrom] = useState(() => formatLocalDate(new Date()))
    const [logSyncManualTo, setLogSyncManualTo] = useState(() => formatLocalDate(new Date()))
    const [logSyncDraftAuto, setLogSyncDraftAuto] = useState(false)
    const [logSyncDraftTime, setLogSyncDraftTime] = useState('03:00')
    const [logSyncLoading, setLogSyncLoading] = useState(false)
    const [logSyncSaving, setLogSyncSaving] = useState(false)
    const [logSyncManualRunning, setLogSyncManualRunning] = useState(false)

    const loadLogSyncSettings = useCallback(async () => {
        if (!token) return
        setLogSyncLoading(true)
        try {
            const s = await apiRequest<{
                autoEnabled: boolean
                dailyTimeLocal: string
                lastRunUtc?: string | null
                lastRecordsAdded?: number | null
                lastRunKind?: string | null
            }>('/api/attendance/log-sync-settings', { token })
            setLogSyncSettings(s)
            setLogSyncDraftAuto(s.autoEnabled)
            setLogSyncDraftTime(s.dailyTimeLocal || '03:00')
            const today = formatLocalDate(new Date())
            setLogSyncManualFrom((prev) => (prev || today))
            setLogSyncManualTo((prev) => (prev || today))
        } catch (e) {
            console.error(e)
        } finally {
            setLogSyncLoading(false)
        }
    }, [token])

    useEffect(() => {
        if (!token || activeTab !== 'logSync') return
        void loadLogSyncSettings()
    }, [token, activeTab, loadLogSyncSettings])

    const saveLogSyncSchedule = async () => {
        if (!token) return
        setLogSyncSaving(true)
        try {
            await apiRequest('/api/attendance/log-sync-settings', {
                method: 'POST',
                token,
                body: JSON.stringify({ autoEnabled: logSyncDraftAuto, dailyTimeLocal: logSyncDraftTime }),
            })
            await loadLogSyncSettings()
        } catch (e) {
            alert(e instanceof Error ? e.message : t('systemSettings.errors.saveFailed'))
        } finally {
            setLogSyncSaving(false)
        }
    }

    const runManualLogSync = async () => {
        if (!token || !logSyncManualFrom || !logSyncManualTo) return
        setLogSyncManualRunning(true)
        try {
            const res = await apiRequest<{
                recordsAdded: number
                devicesProcessed: number
                warnings: string[]
            }>('/api/attendance/sync-logs', {
                method: 'POST',
                token,
                body: JSON.stringify({ fromDate: logSyncManualFrom, toDate: logSyncManualTo }),
            })
            const w = res.warnings?.length ? `\n${res.warnings.join('\n')}` : ''
            alert(t('systemSettings.alerts.recordsAdded', { added: res.recordsAdded, devices: res.devicesProcessed }) + w)
            await loadLogSyncSettings()
        } catch (e) {
            alert(e instanceof Error ? e.message : t('systemSettings.errors.syncFailed'))
        } finally {
            setLogSyncManualRunning(false)
        }
    }

    useEffect(() => {
        if (!token || activeTab !== 'global') return
        
        const loadSettings = async () => {
            startLoading()
            try {
                const [settings, companyList] = await Promise.all([
                    apiRequest<any[]>('/api/system-settings', { token }),
                    apiRequest<{ id: string; name: string }[]>('/api/companies', { token })
                ])
                const mode = settings.find(s => s.key === 'CompanyMode')?.value || 'None'
                setCompanyMode(mode)
                setCompanies(companyList)
            } catch (e) {
                console.error('Failed to load settings', e)
            } finally {
                stopLoading()
            }
        }
        loadSettings()
    }, [token, activeTab, startLoading, stopLoading])

    const handleUpdateMode = async (newMode: 'Single' | 'Multiple', companyName?: string) => {
        if (!token) return
        if (newMode === 'Single' && companies.length === 0 && !companyName?.trim()) return
        setIsSavingMode(true)
        try {
            if (newMode === 'Single' && companies.length === 0 && companyName?.trim()) {
                await apiRequest('/api/companies', {
                    method: 'POST',
                    token,
                    body: JSON.stringify({ name: companyName.trim() })
                })
            }
            await apiRequest('/api/system-settings', {
                method: 'POST',
                token,
                body: JSON.stringify({ key: 'CompanyMode', value: newMode })
            })
            setCompanyMode(newMode)
            setShowCompanyNameModal(null)
            setCompanyNameInput('')
        } catch (e) {
            alert(e instanceof Error ? e.message : t('systemSettings.errors.updateModeFailed'))
        } finally {
            setIsSavingMode(false)
        }
    }

    const handleSingleModeClick = () => {
        if (companies.length > 0) {
            handleUpdateMode('Single')
        } else {
            setShowCompanyNameModal('Single')
        }
    }

    const handleConfirmModeWithName = () => {
        const name = companyNameInput.trim()
        if (!name) return
        handleUpdateMode('Single', name)
    }

    // ─── Vault ────────────────────────────────────────────────────────────────
    interface BackupFile { filename: string; sizeBytes: number; createdAt: string }

    const [backups, setBackups] = useState<BackupFile[]>([])
    const [backupsLoading, setBackupsLoading] = useState(false)
    const [backingUp, setBackingUp] = useState(false)
    const [backupError, setBackupError] = useState<string | null>(null)
    const [restoring, setRestoring] = useState<string | null>(null)
    const [restoreError, setRestoreError] = useState<string | null>(null)
    const [restoreSuccess, setRestoreSuccess] = useState<string | null>(null)
    const [uploadingRestore, setUploadingRestore] = useState(false)
    const restoreFileRef = useRef<HTMLInputElement>(null)
    const [secondaryDb, setSecondaryDb] = useState('')
    const [secondaryDbSaving, setSecondaryDbSaving] = useState(false)
    const [secondaryDbTesting, setSecondaryDbTesting] = useState(false)
    const [secondaryDbTestResult, setSecondaryDbTestResult] = useState<{ success: boolean; message: string } | null>(null)

    // ─── Davamiyyət kriteriyaları (Tabel qaydaları) ───
    const [attCrit, setAttCrit] = useState<AttCriterion[]>([])
    const [attCritLoading, setAttCritLoading] = useState(false)
    const [attCritSaving, setAttCritSaving] = useState(false)
    const [attCritSaved, setAttCritSaved] = useState(false)
    const [attCritError, setAttCritError] = useState<string | null>(null)

    const loadAttCrit = useCallback(async () => {
        if (!token) return
        setAttCritLoading(true); setAttCritError(null)
        try {
            const res = await apiRequest<AttCriterion[]>('/api/attendance-criteria', { token })
            setAttCrit(Array.isArray(res) ? [...res].sort((a, b) => a.sortOrder - b.sortOrder) : [])
        } catch { setAttCritError(t('systemSettings.criteria.loadError')) } finally { setAttCritLoading(false) }
    }, [token, t])

    const updateAttCrit = (key: string, patch: Partial<AttCriterion>) => {
        setAttCrit((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c)))
        setAttCritSaved(false)
    }

    const saveAttCrit = useCallback(async () => {
        if (!token) return
        setAttCritSaving(true); setAttCritError(null)
        try {
            const body = attCrit.map((c) => ({ Key: c.key, Label: c.label, Letter: c.letter, Color: c.color, Enabled: c.enabled, SortOrder: c.sortOrder, DisplayMode: c.displayMode }))
            const res = await apiRequest<AttCriterion[]>('/api/attendance-criteria', { method: 'PUT', token, body: JSON.stringify(body) })
            const next = Array.isArray(res) ? [...res].sort((a, b) => a.sortOrder - b.sortOrder) : attCrit
            setAttCrit(next)
            try { localStorage.setItem('projectx.attCriteria', JSON.stringify(next)) } catch { /* noop */ }
            setAttCritSaved(true); setTimeout(() => setAttCritSaved(false), 2500)
        } catch { setAttCritError(t('systemSettings.criteria.saveError')) } finally { setAttCritSaving(false) }
    }, [attCrit, token, t])

    const loadBackups = useCallback(async () => {
        if (!token) return
        setBackupsLoading(true)
        try {
            const data = await apiRequest<BackupFile[]>('/api/vault/backups', { token })
            setBackups(data)
        } catch { setBackups([]) } finally { setBackupsLoading(false) }
    }, [token])

    const loadSecondaryDb = useCallback(async () => {
        if (!token) return
        try {
            const data = await apiRequest<{ connectionString: string | null }>('/api/vault/secondary-db', { token })
            setSecondaryDb(data.connectionString ?? '')
        } catch { /* ignore */ }
    }, [token])

    useEffect(() => {
        if (!token || activeTab !== 'global') return
        void loadBackups()
        void loadSecondaryDb()
    }, [token, activeTab, loadBackups, loadSecondaryDb])

    const triggerBackup = async () => {
        if (!token) return
        setBackingUp(true)
        setBackupError(null)
        try {
            await apiRequest('/api/vault/backup', { method: 'POST', token })
            await loadBackups()
        } catch (e) {
            setBackupError(e instanceof Error ? e.message : t('systemSettings.errors.backupFailed'))
        } finally { setBackingUp(false) }
    }

    const deleteBackup = async (filename: string) => {
        if (!token) return
        await apiRequest(`/api/vault/backups/${encodeURIComponent(filename)}`, { method: 'DELETE', token })
        await loadBackups()
    }

    const downloadBackup = async (filename: string) => {
        if (!token) return
        const res = await fetch(`${getApiBaseUrl()}/api/vault/backups/${encodeURIComponent(filename)}/download`, {
            headers: { Authorization: `Bearer ${token}` }
        })
        if (!res.ok) return
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = filename
        document.body.appendChild(a); a.click()
        document.body.removeChild(a); URL.revokeObjectURL(url)
    }

    const restoreBackup = async (filename: string) => {
        if (!token) return
        if (!window.confirm(t('systemSettings.vault.restoreConfirm'))) return
        setRestoring(filename)
        setRestoreError(null)
        setRestoreSuccess(null)
        try {
            const res = await apiRequest<{ message: string }>(
                `/api/vault/backups/${encodeURIComponent(filename)}/restore`,
                { method: 'POST', token }
            )
            setRestoreSuccess(res.message)
        } catch (e) {
            setRestoreError(e instanceof Error ? e.message : t('systemSettings.errors.restoreFailed'))
        } finally { setRestoring(null) }
    }

    const uploadAndRestore = async (file: File) => {
        if (!token) return
        if (!window.confirm(t('systemSettings.vault.restoreConfirm'))) return
        setUploadingRestore(true)
        setRestoreError(null)
        setRestoreSuccess(null)
        const formData = new FormData()
        formData.append('file', file)
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/vault/upload-restore`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                body: formData,
            })
            if (!res.ok) {
                const err = await res.json().catch(() => ({ message: 'Upload failed' })) as { message?: string }
                throw new Error(err.message ?? 'Upload failed')
            }
            const data = await res.json() as { message: string }
            setRestoreSuccess(data.message)
            await loadBackups()
        } catch (e) {
            setRestoreError(e instanceof Error ? e.message : t('systemSettings.errors.restoreFailed'))
        } finally { setUploadingRestore(false) }
    }

    const saveSecondaryDb = async () => {
        if (!token) return
        setSecondaryDbSaving(true)
        try {
            await apiRequest('/api/vault/secondary-db', { method: 'POST', token, body: JSON.stringify({ connectionString: secondaryDb }) })
        } finally { setSecondaryDbSaving(false) }
    }

    const testSecondaryDb = async () => {
        if (!token) return
        setSecondaryDbTesting(true)
        setSecondaryDbTestResult(null)
        try {
            const res = await apiRequest<{ success: boolean; message: string }>('/api/vault/secondary-db/test', {
                method: 'POST', token, body: JSON.stringify({ connectionString: secondaryDb })
            })
            setSecondaryDbTestResult(res)
        } catch (e) {
            setSecondaryDbTestResult({ success: false, message: e instanceof Error ? e.message : t('systemSettings.errors.testFailed') })
        } finally { setSecondaryDbTesting(false) }
    }

    function fmtSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
        return `${(bytes / 1024 / 1024).toFixed(2)} MB`
    }

    // ─── SMTP Settings ────────────────────────────────────────────────────────
    // Пароль сервер наружу не отдаёт: приходит пустая строка и признак hasPassword.
    // Пока поле не тронули, отправляем password: null — «оставить сохранённый».
    const [smtp, setSmtp] = useState({
        enabled: false,
        host: '',
        port: 587,
        username: '',
        password: '',
        hasPassword: false,
        fromAddress: '',
        fromName: '',
        enableSsl: true,
    })
    const [smtpPasswordTouched, setSmtpPasswordTouched] = useState(false)
    const smtpPayload = () => ({ ...smtp, password: smtpPasswordTouched ? smtp.password : null })
    const [smtpLoading, setSmtpLoading] = useState(false)
    const [smtpSaving, setSmtpSaving] = useState(false)
    const [smtpTesting, setSmtpTesting] = useState(false)
    const [smtpTestResult, setSmtpTestResult] = useState<{ ok: boolean; message: string } | null>(null)
    const [smtpTestTo, setSmtpTestTo] = useState('')

    const loadSmtp = useCallback(async () => {
        if (!token) return
        setSmtpLoading(true)
        try {
            const data = await apiRequest<typeof smtp>('/api/settings/smtp', { token })
            setSmtp(data)
            setSmtpPasswordTouched(false)
        } catch { /* ignore */ } finally { setSmtpLoading(false) }
    }, [token])

    useEffect(() => {
        if (!token || activeTab !== 'email') return
        void loadSmtp()
    }, [token, activeTab, loadSmtp])

    const saveSmtp = async () => {
        if (!token) return
        setSmtpSaving(true)
        setSmtpTestResult(null)
        try {
            await apiRequest('/api/settings/smtp', { method: 'PUT', token, body: JSON.stringify(smtpPayload()) })
            alert(t('systemSettings.alerts.smtpSaved'))
            // Перечитываем: поле пароля снова пустое, hasPassword — актуальный.
            await loadSmtp()
        } catch (e) {
            alert(e instanceof Error ? e.message : t('systemSettings.errors.saveFailed'))
        } finally { setSmtpSaving(false) }
    }

    const testSmtp = async () => {
        if (!token) return
        setSmtpTesting(true)
        setSmtpTestResult(null)
        try {
            const res = await apiRequest<{ message: string }>('/api/settings/smtp/test', {
                method: 'POST',
                token,
                body: JSON.stringify({ ...smtpPayload(), to: smtpTestTo }),
            })
            setSmtpTestResult({ ok: true, message: res.message })
        } catch (e) {
            setSmtpTestResult({ ok: false, message: e instanceof Error ? e.message : t('systemSettings.errors.testFailed') })
        } finally { setSmtpTesting(false) }
    }

    // ─── AI Assistant Settings ────────────────────────────────────────────────
    // Ключ, как и пароль SMTP, наружу не отдаётся: приходит пустая строка + hasApiKey,
    // а нетронутое поле уходит как null («оставить сохранённый»).
    const [assistant, setAssistant] = useState({
        enabled: false,
        apiKey: '',
        hasApiKey: false,
        model: '',
        baseUrl: '',
    })
    const [assistantKeyTouched, setAssistantKeyTouched] = useState(false)
    const assistantPayload = () => ({ ...assistant, apiKey: assistantKeyTouched ? assistant.apiKey : null })
    const [assistantLoading, setAssistantLoading] = useState(false)
    const [assistantSaving, setAssistantSaving] = useState(false)
    const [assistantTesting, setAssistantTesting] = useState(false)
    const [assistantTestResult, setAssistantTestResult] = useState<{ ok: boolean; message: string } | null>(null)

    const loadAssistant = useCallback(async () => {
        if (!token) return
        setAssistantLoading(true)
        try {
            const data = await apiRequest<typeof assistant>('/api/settings/assistant', { token })
            setAssistant(data)
            setAssistantKeyTouched(false)
        } catch { /* ignore */ } finally { setAssistantLoading(false) }
    }, [token])

    useEffect(() => {
        if (!token || activeTab !== 'assistant') return
        void loadAssistant()
    }, [token, activeTab, loadAssistant])

    const saveAssistant = async () => {
        if (!token) return
        setAssistantSaving(true)
        setAssistantTestResult(null)
        try {
            await apiRequest('/api/settings/assistant', { method: 'PUT', token, body: JSON.stringify(assistantPayload()) })
            setAssistantTestResult({ ok: true, message: t('settingsAssistant.saved') })
            // Перечитываем: поле ключа снова пустое, hasApiKey — актуальный.
            await loadAssistant()
        } catch (e) {
            setAssistantTestResult({ ok: false, message: e instanceof Error ? e.message : t('systemSettings.errors.saveFailed') })
        } finally { setAssistantSaving(false) }
    }

    const testAssistant = async () => {
        if (!token) return
        setAssistantTesting(true)
        setAssistantTestResult(null)
        try {
            const res = await apiRequest<{ message: string }>('/api/settings/assistant/test', { method: 'POST', token, body: JSON.stringify(assistantPayload()) })
            setAssistantTestResult({ ok: true, message: res.message })
        } catch (e) {
            setAssistantTestResult({ ok: false, message: e instanceof Error ? e.message : t('systemSettings.errors.testFailed') })
        } finally { setAssistantTesting(false) }
    }

    // ─── Email Templates ──────────────────────────────────────────────────────
    interface EmailTemplate {
        key: string
        name: string
        description: string
        subject: string
        htmlBody: string
        variables: string[]
        isCustomized: boolean
    }

    const [templates, setTemplates] = useState<EmailTemplate[]>([])
    const [tplLoading, setTplLoading] = useState(false)
    const [selectedTplKey, setSelectedTplKey] = useState<string | null>(null)
    const [tplDraft, setTplDraft] = useState<{ subject: string; htmlBody: string } | null>(null)
    const [tplSaving, setTplSaving] = useState(false)
    const [tplResetting, setTplResetting] = useState(false)
    const [tplPreviewHtml, setTplPreviewHtml] = useState<string | null>(null)
    const [tplPreviewLoading, setTplPreviewLoading] = useState(false)
    const [tplView, setTplView] = useState<'edit' | 'preview'>('edit')

    const loadTemplates = useCallback(async () => {
        if (!token) return
        setTplLoading(true)
        try {
            const data = await apiRequest<EmailTemplate[]>('/api/email-templates', { token })
            setTemplates(data)
            if (!selectedTplKey && data.length > 0) {
                setSelectedTplKey(data[0].key)
                setTplDraft({ subject: data[0].subject, htmlBody: data[0].htmlBody })
            }
        } catch { /* ignore */ } finally { setTplLoading(false) }
    }, [token, selectedTplKey])

    useEffect(() => {
        if (!token || activeTab !== 'templates') return
        void loadTemplates()
    }, [token, activeTab, loadTemplates])

    const selectTemplate = (t: EmailTemplate) => {
        setSelectedTplKey(t.key)
        setTplDraft({ subject: t.subject, htmlBody: t.htmlBody })
        setTplPreviewHtml(null)
        setTplView('edit')
    }

    const saveTpl = async () => {
        if (!token || !selectedTplKey || !tplDraft) return
        setTplSaving(true)
        try {
            const updated = await apiRequest<EmailTemplate>(`/api/email-templates/${selectedTplKey}`, {
                method: 'PUT', token,
                body: JSON.stringify({ subject: tplDraft.subject, htmlBody: tplDraft.htmlBody }),
            })
            setTemplates(ts => ts.map(t => t.key === selectedTplKey ? updated : t))
            setTplDraft({ subject: updated.subject, htmlBody: updated.htmlBody })
        } catch (e) { alert(e instanceof Error ? e.message : t('systemSettings.errors.saveFailed')) }
        setTplSaving(false)
    }

    const resetTpl = async () => {
        if (!token || !selectedTplKey) return
        if (!confirm(t('systemSettings.confirms.resetTemplate'))) return
        setTplResetting(true)
        try {
            const updated = await apiRequest<EmailTemplate>(`/api/email-templates/${selectedTplKey}/reset`, {
                method: 'POST', token,
            })
            setTemplates(ts => ts.map(t => t.key === selectedTplKey ? updated : t))
            setTplDraft({ subject: updated.subject, htmlBody: updated.htmlBody })
            setTplPreviewHtml(null)
        } catch (e) { alert(e instanceof Error ? e.message : t('systemSettings.errors.resetFailed')) }
        setTplResetting(false)
    }

    const previewTpl = async () => {
        if (!token || !selectedTplKey || !tplDraft) return
        setTplPreviewLoading(true)
        try {
            const res = await apiRequest<{ subject: string; body: string }>(`/api/email-templates/${selectedTplKey}/preview`, {
                method: 'POST', token,
                body: JSON.stringify({ subject: tplDraft.subject, htmlBody: tplDraft.htmlBody }),
            })
            setTplPreviewHtml(res.body)
            setTplView('preview')
        } catch (e) { alert(e instanceof Error ? e.message : t('systemSettings.errors.previewFailed')) }
        setTplPreviewLoading(false)
    }

    // ─── Users & Roles management ─────────────────────────────────────────────
    interface SystemUser {
        id: string
        email: string
        firstName: string
        lastName: string
        roles: string[]
        requiresPasswordSetup: boolean
    }
    interface RoleRow { name: string; isSystem: boolean; userCount: number }

    const isAdmin = (currentUser?.roles ?? []).includes('Admin')

    const [users, setUsers] = useState<SystemUser[]>([])
    const [usersLoading, setUsersLoading] = useState(false)
    const [roles, setRoles] = useState<RoleRow[]>([])
    const [rolesLoading, setRolesLoading] = useState(false)

    const [userModal, setUserModal] = useState<'create' | 'edit' | null>(null)
    const [editingUser, setEditingUser] = useState<SystemUser | null>(null)
    const [userForm, setUserForm] = useState({
        email: '',
        password: '',
        firstName: '',
        lastName: '',
        roles: [] as string[],
    })
    const [userSaving, setUserSaving] = useState(false)

    const [passwordModal, setPasswordModal] = useState<SystemUser | null>(null)
    const [passwordForm, setPasswordForm] = useState({ newPassword: '', confirm: '' })
    const [passwordSaving, setPasswordSaving] = useState(false)

    const [deleteUserModal, setDeleteUserModal] = useState<SystemUser | null>(null)
    const [deletingUser, setDeletingUser] = useState(false)

    const [roleModal, setRoleModal] = useState<'create' | null>(null)
    const [roleForm, setRoleForm] = useState({ name: '' })
    const [roleSaving, setRoleSaving] = useState(false)
    const [deleteRoleModal, setDeleteRoleModal] = useState<RoleRow | null>(null)
    const [deletingRole, setDeletingRole] = useState(false)

    // ─── Permission matrix ──────────────────────────────────────────────────
    interface PermissionDescriptor { key: string; label: string; description: string }
    interface PermissionGroup { group: string; items: PermissionDescriptor[] }
    interface RolePermissionsResponse { name: string; isSystem: boolean; isAdmin: boolean; permissions: string[] }

    const [permissionsCatalog, setPermissionsCatalog] = useState<PermissionGroup[]>([])
    const [permsModal, setPermsModal] = useState<{ name: string; isAdmin: boolean } | null>(null)
    const [permsSelection, setPermsSelection] = useState<Set<string>>(new Set())
    const [permsLoading, setPermsLoading] = useState(false)
    const [permsSaving, setPermsSaving] = useState(false)

    const loadPermissionsCatalog = useCallback(async () => {
        if (!token || permissionsCatalog.length > 0) return
        try {
            const data = await apiRequest<PermissionGroup[]>('/api/permissions', { token })
            setPermissionsCatalog(data)
        } catch (e) { console.error(e) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token])

    const openPermissionsEditor = async (role: RoleRow) => {
        if (!token) return
        setPermsModal({ name: role.name, isAdmin: role.name === 'Admin' })
        setPermsSelection(new Set())
        setPermsLoading(true)
        try {
            await loadPermissionsCatalog()
            const data = await apiRequest<RolePermissionsResponse>(`/api/roles/${encodeURIComponent(role.name)}/permissions`, { token })
            setPermsSelection(new Set(data.permissions))
        } catch (e) {
            console.error(e)
            alert(e instanceof Error ? e.message : t('systemSettings.errors.loadPermissionsFailed'))
            setPermsModal(null)
        } finally { setPermsLoading(false) }
    }

    const togglePermission = (key: string) => {
        setPermsSelection(prev => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key); else next.add(key)
            return next
        })
    }

    const toggleGroup = (group: PermissionGroup, allOn: boolean) => {
        setPermsSelection(prev => {
            const next = new Set(prev)
            if (allOn) group.items.forEach(i => next.delete(i.key))
            else group.items.forEach(i => next.add(i.key))
            return next
        })
    }

    const savePermissions = async () => {
        if (!token || !permsModal || permsModal.isAdmin) return
        setPermsSaving(true)
        try {
            await apiRequest(`/api/roles/${encodeURIComponent(permsModal.name)}/permissions`, {
                method: 'PUT', token,
                body: JSON.stringify({ permissions: Array.from(permsSelection) }),
            })
            setPermsModal(null)
        } catch (e) {
            alert(e instanceof Error ? e.message : t('systemSettings.errors.saveFailed'))
        } finally { setPermsSaving(false) }
    }

    const loadUsers = useCallback(async () => {
        if (!token) return
        setUsersLoading(true)
        try {
            const data = await apiRequest<SystemUser[]>('/api/users', { token })
            setUsers(data)
        } catch (e) { console.error(e) } finally { setUsersLoading(false) }
    }, [token])

    const loadRoles = useCallback(async () => {
        if (!token) return
        setRolesLoading(true)
        try {
            const data = await apiRequest<RoleRow[]>('/api/roles', { token })
            setRoles(data)
        } catch (e) { console.error(e) } finally { setRolesLoading(false) }
    }, [token])

    useEffect(() => {
        if (!token || !isAdmin) return
        if (activeTab === 'users') { void loadUsers(); void loadRoles() }
        if (activeTab === 'roles') { void loadRoles() }
    }, [token, isAdmin, activeTab, loadUsers, loadRoles])

    useEffect(() => {
        if (activeTab === 'criteria') void loadAttCrit()
    }, [activeTab, loadAttCrit])

    const openCreateUser = () => {
        setEditingUser(null)
        setUserForm({ email: '', password: '', firstName: '', lastName: '', roles: [] })
        setUserModal('create')
    }
    const openEditUser = (u: SystemUser) => {
        setEditingUser(u)
        setUserForm({ email: u.email, password: '', firstName: u.firstName, lastName: u.lastName, roles: [...u.roles] })
        setUserModal('edit')
    }
    const toggleUserRole = (roleName: string) => {
        setUserForm(f => f.roles.includes(roleName)
            ? { ...f, roles: f.roles.filter(r => r !== roleName) }
            : { ...f, roles: [...f.roles, roleName] })
    }

    const saveUser = async () => {
        if (!token) return
        if (!userForm.email.trim()) { alert(t('systemSettings.alerts.emailRequired')); return }
        if (userModal === 'create' && (!userForm.password || userForm.password.length < 8)) {
            alert(t('systemSettings.alerts.passwordMinLength')); return
        }
        setUserSaving(true)
        try {
            if (userModal === 'create') {
                await apiRequest('/api/users', {
                    method: 'POST', token,
                    body: JSON.stringify({
                        email: userForm.email.trim(),
                        password: userForm.password,
                        firstName: userForm.firstName.trim(),
                        lastName: userForm.lastName.trim(),
                        roles: userForm.roles,
                    }),
                })
            } else if (editingUser) {
                await apiRequest(`/api/users/${editingUser.id}`, {
                    method: 'PUT', token,
                    body: JSON.stringify({
                        email: userForm.email.trim(),
                        firstName: userForm.firstName.trim(),
                        lastName: userForm.lastName.trim(),
                        roles: userForm.roles,
                    }),
                })
            }
            setUserModal(null)
            await loadUsers()
            await loadRoles()
        } catch (e) {
            alert(e instanceof Error ? e.message : t('systemSettings.errors.saveFailed'))
        } finally { setUserSaving(false) }
    }

    const submitPasswordChange = async () => {
        if (!token || !passwordModal) return
        if (passwordForm.newPassword.length < 8) { alert(t('systemSettings.alerts.passwordMinLength')); return }
        if (passwordForm.newPassword !== passwordForm.confirm) { alert(t('systemSettings.alerts.passwordsDoNotMatch')); return }
        setPasswordSaving(true)
        try {
            await apiRequest(`/api/users/${passwordModal.id}/change-password`, {
                method: 'POST', token,
                body: JSON.stringify({ newPassword: passwordForm.newPassword }),
            })
            setPasswordModal(null)
            setPasswordForm({ newPassword: '', confirm: '' })
            alert(t('systemSettings.alerts.passwordChanged'))
        } catch (e) {
            alert(e instanceof Error ? e.message : t('systemSettings.errors.changePasswordFailed'))
        } finally { setPasswordSaving(false) }
    }

    const confirmDeleteUser = async () => {
        if (!token || !deleteUserModal) return
        setDeletingUser(true)
        try {
            await apiRequest(`/api/users/${deleteUserModal.id}`, { method: 'DELETE', token })
            setDeleteUserModal(null)
            await loadUsers()
            await loadRoles()
        } catch (e) {
            alert(e instanceof Error ? e.message : t('systemSettings.errors.deleteFailed'))
        } finally { setDeletingUser(false) }
    }

    const saveRole = async () => {
        if (!token) return
        const name = roleForm.name.trim()
        if (!name) { alert(t('systemSettings.alerts.roleNameRequired')); return }
        setRoleSaving(true)
        try {
            await apiRequest('/api/roles', { method: 'POST', token, body: JSON.stringify({ name }) })
            setRoleModal(null)
            setRoleForm({ name: '' })
            await loadRoles()
        } catch (e) {
            alert(e instanceof Error ? e.message : t('systemSettings.errors.saveFailed'))
        } finally { setRoleSaving(false) }
    }

    const confirmDeleteRole = async () => {
        if (!token || !deleteRoleModal) return
        setDeletingRole(true)
        try {
            await apiRequest(`/api/roles/${encodeURIComponent(deleteRoleModal.name)}`, { method: 'DELETE', token })
            setDeleteRoleModal(null)
            await loadRoles()
        } catch (e) {
            alert(e instanceof Error ? e.message : t('systemSettings.errors.deleteFailed'))
        } finally { setDeletingRole(false) }
    }

    // ─── Audit Logs (Debug Logs tab) ──────────────────────────────────────────
    interface AuditLogRow {
        id: string
        timestampUtc: string
        userId: string | null
        userEmail: string
        category: string
        action: string
        method: string
        path: string
        statusCode: number | null
        ipAddress: string | null
        description: string | null
        success: boolean
    }

    const [auditLogs, setAuditLogs] = useState<AuditLogRow[]>([])
    const [auditTotal, setAuditTotal] = useState(0)
    const [auditLoading, setAuditLoading] = useState(false)
    const [auditCategory, setAuditCategory] = useState<string>('')
    const [auditSearch, setAuditSearch] = useState('')
    const [auditOffset, setAuditOffset] = useState(0)
    const AUDIT_LIMIT = 100

    const loadAuditLogs = useCallback(async () => {
        if (!token) return
        setAuditLoading(true)
        try {
            const params = new URLSearchParams()
            params.set('limit', String(AUDIT_LIMIT))
            params.set('offset', String(auditOffset))
            if (auditCategory) params.set('category', auditCategory)
            if (auditSearch.trim()) params.set('search', auditSearch.trim())
            const data = await apiRequest<{ total: number; items: AuditLogRow[] }>(`/api/audit-logs?${params.toString()}`, { token })
            setAuditLogs(data.items)
            setAuditTotal(data.total)
        } catch (e) { console.error(e) } finally { setAuditLoading(false) }
    }, [token, auditOffset, auditCategory, auditSearch])

    useEffect(() => {
        if (!token || !isAdmin || activeTab !== 'debugLogs') return
        void loadAuditLogs()
    }, [token, isAdmin, activeTab, loadAuditLogs])

    const AUDIT_CATEGORIES = ['Auth', 'Users', 'Roles', 'Employees', 'Visitors', 'Devices', 'AccessLevels', 'WorkSchedules', 'GeoZones', 'Backup', 'System']
    const CATEGORY_COLORS: Record<string, string> = {
        Auth: 'bg-blue-50 text-blue-700',
        Users: 'bg-indigo-50 text-indigo-700',
        Roles: 'bg-amber-50 text-amber-700',
        Employees: 'bg-emerald-50 text-emerald-700',
        Visitors: 'bg-teal-50 text-teal-700',
        Devices: 'bg-violet-50 text-violet-700',
        AccessLevels: 'bg-rose-50 text-rose-700',
        WorkSchedules: 'bg-cyan-50 text-cyan-700',
        GeoZones: 'bg-lime-50 text-lime-700',
        Backup: 'bg-orange-50 text-orange-700',
        System: 'bg-slate-100 text-slate-700',
    }

    const handleAction = () => {
        if (activeTab === 'devices' && devicesRef.current) {
            devicesRef.current.triggerAction()
        }
    }

    // Вкладки одним списком: их много, лента прокручивается горизонтально,
    // а активная вкладка подтягивается в видимую часть (в т.ч. при заходе по ?tab=…).
    const tabItems: { key: SettingsTab; label: string }[] = [
        { key: 'global', label: t('systemSettings.tabs.global') },
        { key: 'criteria', label: t('systemSettings.tabs.criteria') },
        { key: 'company', label: t('systemSettings.tabs.company') },
        ...(isHousing ? [{ key: 'housing' as const, label: t('systemSettings.tabs.housing') }] : []),
        { key: 'devices', label: t('systemSettings.tabs.devices') },
        { key: 'logSync', label: t('systemSettings.tabs.logSync') },
        { key: 'email', label: t('systemSettings.tabs.email') },
        { key: 'assistant', label: t('settingsAssistant.tab') },
        { key: 'templates', label: t('systemSettings.tabs.templates') },
        ...(isAdmin ? [
            { key: 'users' as const, label: t('systemSettings.tabs.users') },
            { key: 'roles' as const, label: t('systemSettings.tabs.roles') },
            { key: 'debugLogs' as const, label: t('systemSettings.tabs.debugLogs') },
        ] : []),
    ]

    return (
        <AppLayout onAction={handleAction}>
            <style>{STG_RESTYLE}</style>
            <div className="stg-page flex-1 overflow-y-auto bg-background-light pb-20 md:pb-0">
                <div className="p-6 md:p-10 space-y-8">
                    <PageHeader
                        className="hidden md:flex"
                        title={t('systemSettings.pageTitle')}
                        description={t('systemSettings.pageDescription')}
                    />

                    {/* Tab Navigation — лента скроллится сама, страница вбок не едет */}
                    <div ref={tabsRef} className="stg-tabs flex gap-8 border-b border-divider-light">
                        {tabItems.map((tb) => (
                            <button
                                key={tb.key}
                                type="button"
                                data-active={activeTab === tb.key}
                                onClick={() => setActiveTab(tb.key)}
                                className={`shrink-0 whitespace-nowrap pb-4 text-[11px] font-black uppercase tracking-[0.2em] border-b-2 transition-all ${activeTab === tb.key ? 'border-primary text-primary' : 'border-transparent text-text-light hover:text-text-muted'
                                    }`}
                            >
                                {tb.label}
                            </button>
                        ))}
                    </div>

                    {activeTab === 'global' ? (
                        <div className="grid grid-cols-1 xl:grid-cols-2 gap-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                            {/* Localization & Runtime */}
                            <div className="space-y-6">
                                <div className="flex items-center gap-3 px-2">
                                    <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                                        <span className="material-symbols-outlined text-lg">settings_suggest</span>
                                    </div>
                                    <h3 className="text-[10px] font-black text-text-light uppercase tracking-widest leading-none">{t('systemSettings.localization.title')}</h3>
                                </div>

                                <div className="bg-surface rounded-3xl shadow-md p-8 space-y-6 border-none text-text-light">
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                        <div className="space-y-3">
                                            <label className="text-[10px] font-black text-text-light uppercase tracking-widest pl-1">{t('systemSettings.localization.systemLanguage')}</label>
                                            <div className="relative">
                                                <select
                                                    value={i18n.resolvedLanguage ?? i18n.language?.split('-')[0] ?? 'en'}
                                                    onChange={(e) => { void i18n.changeLanguage(e.target.value) }}
                                                    className="w-full bg-slate-50 border border-border-light rounded-2xl px-4 py-3.5 text-sm font-bold text-text-dark appearance-none focus:ring-2 focus:ring-primary/20 outline-none transition-all cursor-pointer shadow-sm"
                                                >
                                                    {SUPPORTED_LANGUAGES.map((lang) => (
                                                        <option key={lang.code} value={lang.code}>{lang.flag} {lang.label}</option>
                                                    ))}
                                                </select>
                                                <span className="material-symbols-outlined absolute right-4 top-1/2 -translate-y-1/2 text-text-light pointer-events-none">expand_content</span>
                                            </div>
                                        </div>
                                        <div className="space-y-3">
                                            <label className="text-[10px] font-black text-text-light uppercase tracking-widest pl-1">{t('systemSettings.localization.timeZone')}</label>
                                            <div className="relative">
                                                <select
                                                    value={selectedTimeZone}
                                                    onChange={(e) => setSelectedTimeZone(e.target.value)}
                                                    className="w-full bg-slate-50 border border-border-light rounded-2xl px-4 py-3.5 text-sm font-bold text-text-dark appearance-none focus:ring-2 focus:ring-primary/20 outline-none transition-all cursor-pointer shadow-sm"
                                                >
                                                    {TIMEZONE_OPTIONS.map((tz) => (
                                                        <option key={tz.posix} value={tz.posix}>{tz.label}</option>
                                                    ))}
                                                </select>
                                                <span className="material-symbols-outlined absolute right-4 top-1/2 -translate-y-1/2 text-text-light pointer-events-none">schedule</span>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
                                        <div className="space-y-1.5">
                                            <p className="text-[10px] font-black text-text-light uppercase tracking-widest pl-1">{t('systemSettings.localization.serverTimeUtc')}</p>
                                            <p className="font-mono text-sm font-bold text-text-dark tabular-nums">
                                                {serverNow.toISOString().replace('T', ' ').slice(0, 19)}
                                            </p>
                                        </div>
                                        <div className="space-y-1.5">
                                            <p className="text-[10px] font-black text-text-light uppercase tracking-widest pl-1">{t('systemSettings.localization.serverTimeLocal')}</p>
                                            <p className="font-mono text-sm font-bold text-text-dark tabular-nums">
                                                {serverNow.toLocaleString()}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="pt-2">
                                        <Button
                                            icon="sync"
                                            onClick={syncTimeToAllDevices}
                                            isLoading={timeSyncing}
                                            disabled={timeSyncing}
                                        >
                                            {timeSyncing ? t('systemSettings.localization.syncing') : t('systemSettings.localization.syncTimeAll')}
                                        </Button>
                                        <p className="text-[10px] font-bold text-text-light uppercase tracking-widest mt-2 pl-1">
                                            {t('systemSettings.localization.syncDescription')}
                                        </p>
                                    </div>

                                    {timeSyncResults && timeSyncResults.length > 0 && (
                                        <div className="rounded-2xl border border-border-light overflow-hidden">
                                            <div className="px-4 py-2 bg-slate-50 border-b border-border-light">
                                                <p className="text-[10px] font-black text-text-light uppercase tracking-widest">
                                                    {t('systemSettings.localization.syncResults', { success: timeSyncResults.filter(r => r.success).length, total: timeSyncResults.length })}
                                                </p>
                                            </div>
                                            <ul className="divide-y divide-border-light max-h-56 overflow-y-auto">
                                                {timeSyncResults.map((r) => (
                                                    <li key={r.deviceId} className="flex items-start gap-3 px-4 py-2.5">
                                                        <span className={`material-symbols-outlined text-base shrink-0 mt-0.5 ${r.success ? 'text-green-600' : 'text-red-500'}`}>
                                                            {r.success ? 'check_circle' : 'error'}
                                                        </span>
                                                        <div className="min-w-0 flex-1">
                                                            <p className="text-sm font-bold text-text-dark truncate">{r.deviceName}</p>
                                                            {!r.success && r.message && (
                                                                <p className="text-[11px] text-text-light truncate">{r.message}</p>
                                                            )}
                                                        </div>
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}

                                    {/* Daily auto-sync schedule */}
                                    <div className="border-t border-border-light pt-6 space-y-4">
                                        <div className="flex items-center justify-between gap-4">
                                            <div className="min-w-0">
                                                <p className="text-xs font-black text-text-dark">{t('systemSettings.localization.dailyAutoSync')}</p>
                                                <p className="text-[10px] font-bold text-text-light uppercase tracking-widest">
                                                    {t('systemSettings.localization.dailyAutoSyncDesc')}
                                                </p>
                                            </div>
                                            <label className="flex items-center gap-2 cursor-pointer shrink-0">
                                                <input
                                                    type="checkbox"
                                                    checked={timeScheduleDraftEnabled}
                                                    onChange={(e) => setTimeScheduleDraftEnabled(e.target.checked)}
                                                    className="w-4 h-4 rounded border-border-light text-primary focus:ring-primary/30"
                                                />
                                                <span className="text-xs font-black text-text-dark uppercase tracking-widest">
                                                    {timeScheduleDraftEnabled ? t('common.enabled') : t('common.disabled')}
                                                </span>
                                            </label>
                                        </div>

                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                            <div className="space-y-2">
                                                <label className="text-[10px] font-black text-text-light uppercase tracking-widest pl-1">{t('systemSettings.localization.dailyRunTime')}</label>
                                                <input
                                                    type="time"
                                                    value={timeScheduleDraftTime}
                                                    onChange={(e) => setTimeScheduleDraftTime(e.target.value)}
                                                    className="w-full bg-slate-50 border border-border-light rounded-2xl px-4 py-3 text-sm font-bold text-text-dark"
                                                />
                                            </div>
                                            <div className="flex items-end">
                                                <Button
                                                    icon="save"
                                                    onClick={saveTimeSchedule}
                                                    isLoading={timeScheduleSaving}
                                                    disabled={timeScheduleSaving}
                                                    fullWidth
                                                >
                                                    {timeScheduleSaving ? t('common.saving') : t('systemSettings.localization.saveSchedule')}
                                                </Button>
                                            </div>
                                        </div>

                                        {timeSchedule?.lastRunUtc && (
                                            <div className="rounded-2xl bg-slate-50 px-4 py-3 flex items-center gap-3">
                                                <span className="material-symbols-outlined text-text-light">history</span>
                                                <div className="min-w-0 flex-1">
                                                    <p className="text-[10px] font-black text-text-light uppercase tracking-widest">
                                                        {t('systemSettings.localization.lastRun', { kind: timeSchedule.lastRunKind ?? t('systemSettings.localization.run') })}
                                                    </p>
                                                    <p className="text-sm font-bold text-text-dark">
                                                        {new Date(timeSchedule.lastRunUtc).toLocaleString()}
                                                        {timeSchedule.lastTotal != null && (
                                                            <span className="ml-2 text-text-light">
                                                                {t('systemSettings.localization.devicesCount', { success: timeSchedule.lastSuccessCount ?? 0, total: timeSchedule.lastTotal })}
                                                            </span>
                                                        )}
                                                    </p>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Vault & Data Ops */}
                            <div className="space-y-6">
                                <div className="flex items-center gap-3 px-2">
                                    <div className="w-8 h-8 rounded-xl bg-emerald-500/10 flex items-center justify-center text-emerald-600">
                                        <span className="material-symbols-outlined text-lg">database</span>
                                    </div>
                                    <h3 className="text-[10px] font-black text-text-light uppercase tracking-widest leading-none">{t('systemSettings.vault.title')}</h3>
                                </div>

                                <div className="bg-surface rounded-3xl shadow-md p-8 space-y-6 border-none">
                                    {/* Backup section */}
                                    <div className="space-y-4">
                                        <div className="flex items-center justify-between gap-4">
                                            <div>
                                                <p className="text-xs font-black text-text-dark">{t('systemSettings.vault.databaseBackup')}</p>
                                                <p className="text-[10px] font-bold text-text-light uppercase tracking-widest">{t('systemSettings.vault.databaseBackupDesc')}</p>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <Button variant="outline" icon="upload" onClick={() => restoreFileRef.current?.click()} isLoading={uploadingRestore} disabled={uploadingRestore || !!restoring} size="sm">
                                                    {t('systemSettings.vault.uploadRestore')}
                                                </Button>
                                                <input
                                                    ref={restoreFileRef}
                                                    type="file"
                                                    accept=".sql"
                                                    className="hidden"
                                                    onChange={e => { const f = e.target.files?.[0]; if (f) { void uploadAndRestore(f); e.target.value = '' } }}
                                                />
                                                <Button icon="backup" onClick={triggerBackup} isLoading={backingUp} disabled={backingUp} size="sm">
                                                    {t('systemSettings.vault.backupNow')}
                                                </Button>
                                            </div>
                                        </div>

                                        {backupError && (
                                            <div className="rounded-2xl bg-red-50 border border-red-200 px-4 py-3 text-xs text-red-700 font-bold">
                                                {backupError}
                                            </div>
                                        )}
                                        {restoreError && (
                                            <div className="rounded-2xl bg-red-50 border border-red-200 px-4 py-3 text-xs text-red-700 font-bold flex items-center gap-2">
                                                <span className="material-symbols-outlined text-base">error</span>
                                                {restoreError}
                                            </div>
                                        )}
                                        {restoreSuccess && (
                                            <div className="rounded-2xl bg-green-50 border border-green-200 px-4 py-3 text-xs text-green-700 font-bold flex items-center gap-2">
                                                <span className="material-symbols-outlined text-base">check_circle</span>
                                                {restoreSuccess}
                                            </div>
                                        )}

                                        <div className="rounded-2xl border border-border-light overflow-hidden">
                                            <div className="px-4 py-2.5 bg-slate-50 border-b border-border-light flex items-center justify-between">
                                                <p className="text-[10px] font-black text-text-light uppercase tracking-widest">
                                                    {backupsLoading ? t('common.loading') : t('systemSettings.vault.snapshotCount', { count: backups.length })}
                                                </p>
                                                <button type="button" onClick={loadBackups} className="text-text-muted hover:text-primary transition-colors">
                                                    <span className="material-symbols-outlined text-base">refresh</span>
                                                </button>
                                            </div>

                                            {backupsLoading ? (
                                                <div className="flex justify-center py-8">
                                                    <span className="spinner-ring text-2xl text-primary" aria-hidden="true" />
                                                </div>
                                            ) : backups.length === 0 ? (
                                                <div className="flex flex-col items-center justify-center py-8 gap-2 text-text-light">
                                                    <span className="material-symbols-outlined text-3xl">cloud_off</span>
                                                    <p className="text-xs">{t('systemSettings.vault.noBackups')}</p>
                                                </div>
                                            ) : (
                                                <ul className="divide-y divide-border-light max-h-48 overflow-y-auto">
                                                    {backups.map(b => (
                                                        <li key={b.filename} className="flex items-center gap-3 px-4 py-2.5 hover:bg-background-light transition-colors">
                                                            <span className="material-symbols-outlined text-base text-emerald-600 shrink-0">archive</span>
                                                            <div className="flex-1 min-w-0">
                                                                <p className="text-xs font-bold text-text-dark truncate font-mono">{b.filename}</p>
                                                                <p className="text-[10px] text-text-muted">
                                                                    {fmtSize(b.sizeBytes)} · {new Date(b.createdAt).toLocaleString()}
                                                                </p>
                                                            </div>
                                                            <button type="button" onClick={() => downloadBackup(b.filename)} title={t('common.download')} className="text-text-muted hover:text-primary transition-colors shrink-0">
                                                                <span className="material-symbols-outlined text-base">download</span>
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onClick={() => void restoreBackup(b.filename)}
                                                                title={t('systemSettings.vault.restoreNow')}
                                                                disabled={restoring === b.filename || uploadingRestore}
                                                                className="text-text-muted hover:text-amber-600 transition-colors shrink-0 disabled:opacity-40"
                                                            >
                                                                {restoring === b.filename
                                                                    ? <span className="spinner-ring text-base" aria-hidden="true" />
                                                                    : <span className="material-symbols-outlined text-base">settings_backup_restore</span>
                                                                }
                                                            </button>
                                                            <button type="button" onClick={() => deleteBackup(b.filename)} title={t('common.delete')} className="text-text-muted hover:text-error-text transition-colors shrink-0">
                                                                <span className="material-symbols-outlined text-base">delete</span>
                                                            </button>
                                                        </li>
                                                    ))}
                                                </ul>
                                            )}
                                        </div>
                                    </div>

                                    {/* Secondary DB */}
                                    <div className="border-t border-border-light pt-6 space-y-4">
                                        <div>
                                            <p className="text-xs font-black text-text-dark">{t('systemSettings.vault.secondaryDb')}</p>
                                            <p className="text-[10px] font-bold text-text-light uppercase tracking-widest">{t('systemSettings.vault.secondaryDbDesc')}</p>
                                        </div>
                                        <Input
                                            placeholder="Host=host;Port=5432;Database=db;Username=user;Password=pass"
                                            value={secondaryDb}
                                            onChange={e => { setSecondaryDb(e.target.value); setSecondaryDbTestResult(null) }}
                                        />
                                        <div className="flex gap-2">
                                            <Button variant="outline" size="sm" icon="lan" onClick={testSecondaryDb} isLoading={secondaryDbTesting} disabled={!secondaryDb.trim() || secondaryDbTesting}>
                                                {t('systemSettings.vault.testConnection')}
                                            </Button>
                                            <Button size="sm" icon="save" onClick={saveSecondaryDb} isLoading={secondaryDbSaving} disabled={secondaryDbSaving}>
                                                {t('common.save')}
                                            </Button>
                                        </div>
                                        {secondaryDbTestResult && (
                                            <div className={`rounded-2xl px-4 py-3 text-xs font-bold flex items-center gap-2 ${secondaryDbTestResult.success ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                                                <span className="material-symbols-outlined text-base">{secondaryDbTestResult.success ? 'check_circle' : 'error'}</span>
                                                {secondaryDbTestResult.message}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Organizational Structure */}
                            <div className="space-y-6">
                                <div className="flex items-center gap-3 px-2">
                                    <div className="w-8 h-8 rounded-xl bg-sky-500/10 flex items-center justify-center text-sky-600">
                                        <span className="material-symbols-outlined text-lg">corporate_fare</span>
                                    </div>
                                    <h3 className="text-[10px] font-black text-text-light uppercase tracking-widest leading-none">{t('systemSettings.org.title')}</h3>
                                </div>

                                <div className="bg-surface rounded-3xl shadow-md p-8 space-y-6 border-none text-text-light">
                                    <div className="space-y-4">
                                        <div>
                                            <p className="text-xs font-black text-text-dark">{t('systemSettings.org.companyMode')}</p>
                                            <p className="text-[9px] font-bold text-text-light uppercase tracking-widest">{t('systemSettings.org.companyModeDesc')}</p>
                                        </div>
                                        
                                        <div className="grid grid-cols-2 gap-3">
                                            <button
                                                onClick={handleSingleModeClick}
                                                disabled={isSavingMode}
                                                className={`p-4 rounded-2xl shadow-md transition-all flex flex-col items-center gap-2 border-none ${
                                                    companyMode === 'Single' 
                                                    ? 'bg-sky-50 text-sky-700 shadow-lg' 
                                                    : 'bg-surface hover:bg-slate-50 text-text-light hover:text-text-dark hover:shadow-lg'
                                                }`}
                                            >
                                                <span className="material-symbols-outlined">business</span>
                                                <span className="text-[10px] font-black uppercase tracking-widest">{t('systemSettings.org.singleCompany')}</span>
                                            </button>

                                            <button
                                                onClick={() => handleUpdateMode('Multiple')}
                                                disabled={isSavingMode}
                                                className={`p-4 rounded-2xl shadow-md transition-all flex flex-col items-center gap-2 border-none ${
                                                    companyMode === 'Multiple'
                                                    ? 'bg-sky-50 text-sky-700 shadow-lg'
                                                    : 'bg-surface hover:bg-slate-50 text-text-light hover:text-text-dark hover:shadow-lg'
                                                }`}
                                            >
                                                <span className="material-symbols-outlined">hub</span>
                                                <span className="text-[10px] font-black uppercase tracking-widest">{t('systemSettings.org.groupOfCompanies')}</span>
                                            </button>
                                        </div>

                                        {companyMode === 'None' && (
                                            <p className="text-[9px] text-amber-600 font-bold uppercase tracking-widest flex items-center gap-1">
                                                <span className="material-symbols-outlined text-xs">warning</span>
                                                {t('systemSettings.org.modeNotSelected')}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    ) : activeTab === 'criteria' ? (
                        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-2 duration-300">
                            {/* Tabel qaydaları / Davamiyyət kriteriyaları */}
                            <div className="space-y-6">
                                <div className="flex items-center gap-3 px-2">
                                    <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                                        <span className="material-symbols-outlined text-lg">event_available</span>
                                    </div>
                                    <h3 className="text-[10px] font-black text-text-light uppercase tracking-widest leading-none">{t('systemSettings.criteria.heading')}</h3>
                                </div>

                                <div className="bg-surface rounded-3xl shadow-md p-8 space-y-5 border-none text-text-light">
                                    <p className="text-[11px] font-bold text-text-light">{t('systemSettings.criteria.intro')}</p>

                                    {attCritLoading ? (
                                        <p className="text-xs font-bold text-text-light py-4">{t('systemSettings.criteria.loading')}</p>
                                    ) : attCrit.length === 0 ? (
                                        <p className="text-xs font-bold text-text-light py-4">{attCritError || t('systemSettings.criteria.noData')}</p>
                                    ) : (
                                        <div className="space-y-2">
                                            {attCrit.map((c) => (
                                                <div key={c.key} className="flex items-center gap-3 rounded-2xl bg-slate-50 border border-border-light px-4 py-3">
                                                    <span className="w-6 h-6 rounded-lg shrink-0 border border-black/10" style={{ background: c.color }} />
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-xs font-black text-text-dark truncate">{t(`workHours.tabel.crit.${c.key}`, { defaultValue: c.label })}</p>
                                                        <p className="text-[9px] font-bold text-text-light uppercase tracking-widest">{c.key}</p>
                                                    </div>
                                                    <label className="flex items-center gap-1.5 text-[9px] font-bold text-text-light uppercase tracking-widest cursor-pointer" title={t('systemSettings.criteria.active')}>
                                                        <input type="checkbox" checked={c.enabled} onChange={(e) => updateAttCrit(c.key, { enabled: e.target.checked })} className="w-4 h-4 accent-primary" />
                                                        {t('systemSettings.criteria.active')}
                                                    </label>
                                                    <input
                                                        type="text"
                                                        value={c.letter}
                                                        maxLength={8}
                                                        onChange={(e) => updateAttCrit(c.key, { letter: e.target.value })}
                                                        placeholder={t('systemSettings.criteria.letter')}
                                                        title={t('systemSettings.criteria.letterTitle')}
                                                        className="w-16 bg-white border border-border-light rounded-xl px-2 py-2 text-center text-sm font-bold text-text-dark outline-none focus:ring-2 focus:ring-primary/20"
                                                    />
                                                    <select
                                                        value={c.displayMode === 'hours' ? 'hours' : 'letter'}
                                                        onChange={(e) => updateAttCrit(c.key, { displayMode: e.target.value })}
                                                        title={t('systemSettings.criteria.displayTitle')}
                                                        className="shrink-0 bg-white border border-border-light rounded-xl px-2 py-2 text-xs font-bold text-text-dark outline-none focus:ring-2 focus:ring-primary/20 cursor-pointer"
                                                    >
                                                        <option value="letter">{t('systemSettings.criteria.displayLetter')}</option>
                                                        <option value="hours">{t('systemSettings.criteria.displayHours')}</option>
                                                    </select>
                                                    <input
                                                        type="color"
                                                        value={/^#[0-9a-fA-F]{6}$/.test(c.color) ? c.color : '#94A3B8'}
                                                        onChange={(e) => updateAttCrit(c.key, { color: e.target.value })}
                                                        title={t('systemSettings.criteria.color')}
                                                        className="w-10 h-10 shrink-0 rounded-xl border border-border-light cursor-pointer bg-white p-0.5"
                                                    />
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    <div className="flex items-center gap-3 pt-1">
                                        <button
                                            onClick={() => void saveAttCrit()}
                                            disabled={attCritSaving || attCritLoading || attCrit.length === 0}
                                            className="px-5 py-2.5 rounded-2xl bg-primary text-white text-[11px] font-black uppercase tracking-widest shadow-primary disabled:opacity-50 transition-all"
                                        >
                                            {attCritSaving ? t('systemSettings.criteria.saving') : t('systemSettings.criteria.save')}
                                        </button>
                                        {attCritSaved && (
                                            <span className="text-[11px] font-black text-green-600 flex items-center gap-1">
                                                <span className="material-symbols-outlined text-sm">check_circle</span> {t('systemSettings.criteria.saved')}
                                            </span>
                                        )}
                                        {attCritError && !attCritLoading && (
                                            <span className="text-[11px] font-black text-red-600">{attCritError}</span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    ) : activeTab === 'company' ? (
                        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                            <CompanyTab />
                        </div>
                    ) : activeTab === 'housing' ? (
                        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                            <HousingTab />
                        </div>
                    ) : activeTab === 'devices' ? (
                        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                            <DevicesTab ref={devicesRef} />
                        </div>
                    ) : activeTab === 'email' ? (
                        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 max-w-2xl space-y-8">
                            <div className="flex items-center gap-3 px-2">
                                <div className="w-8 h-8 rounded-xl bg-sky-500/10 flex items-center justify-center text-sky-600">
                                    <span className="material-symbols-outlined text-lg">mail</span>
                                </div>
                                <div>
                                    <h3 className="text-[10px] font-black text-text-light uppercase tracking-widest leading-none">{t('systemSettings.smtp.title')}</h3>
                                    <p className="text-xs text-text-muted mt-1">{t('systemSettings.smtp.subtitle')}</p>
                                </div>
                            </div>

                            {smtpLoading ? (
                                <p className="text-sm text-text-light px-2">{t('common.loading')}</p>
                            ) : (
                                <div className="bg-surface rounded-3xl shadow-md p-8 space-y-6 border-none">
                                    {/* Enable toggle */}
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <p className="text-xs font-black text-text-dark">{t('systemSettings.smtp.enable')}</p>
                                            <p className="text-[9px] text-text-light uppercase tracking-widest mt-0.5">{t('systemSettings.smtp.enableDesc')}</p>
                                        </div>
                                        <Toggle
                                            checked={smtp.enabled}
                                            onChange={(v) => setSmtp(s => ({ ...s, enabled: v }))}
                                            aria-label={t('systemSettings.smtp.enable')}
                                        />
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.smtp.host')}</label>
                                            <Input placeholder="smtp.gmail.com" value={smtp.host} onChange={e => setSmtp(s => ({ ...s, host: e.target.value }))} />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.smtp.port')}</label>
                                            <Input placeholder="587" value={String(smtp.port)} onChange={e => setSmtp(s => ({ ...s, port: parseInt(e.target.value) || 587 }))} />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.smtp.username')}</label>
                                            <Input placeholder="your@email.com" value={smtp.username} onChange={e => setSmtp(s => ({ ...s, username: e.target.value }))} />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('common.password')}</label>
                                            <Input
                                                type="password"
                                                placeholder={smtp.hasPassword && !smtpPasswordTouched ? t('systemSettings.smtp.passwordSaved') : '••••••••'}
                                                value={smtp.password}
                                                onChange={e => { setSmtpPasswordTouched(true); setSmtp(s => ({ ...s, password: e.target.value })) }}
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.smtp.fromAddress')}</label>
                                            <Input placeholder="noreply@yourcompany.com" value={smtp.fromAddress} onChange={e => setSmtp(s => ({ ...s, fromAddress: e.target.value }))} />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.smtp.fromName')}</label>
                                            <Input placeholder="Attendance" value={smtp.fromName} onChange={e => setSmtp(s => ({ ...s, fromName: e.target.value }))} />
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-3">
                                        <Toggle
                                            size="sm"
                                            checked={smtp.enableSsl}
                                            onChange={(v) => setSmtp(s => ({ ...s, enableSsl: v }))}
                                            aria-label={t('systemSettings.smtp.enableSsl')}
                                        />
                                        <span className="text-xs font-bold text-text-dark">{t('systemSettings.smtp.enableSsl')}</span>
                                    </div>

                                    {smtpTestResult && (
                                        <div className={`rounded-2xl px-4 py-3 text-xs font-bold flex items-center gap-2 ${smtpTestResult.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
                                            <span className="material-symbols-outlined text-sm">{smtpTestResult.ok ? 'check_circle' : 'error'}</span>
                                            {smtpTestResult.message}
                                        </div>
                                    )}

                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.smtp.testRecipient')}</label>
                                        <Input
                                            type="email"
                                            placeholder="test@example.com"
                                            value={smtpTestTo}
                                            onChange={e => setSmtpTestTo(e.target.value)}
                                        />
                                    </div>
                                    <div className="flex gap-3">
                                        <Button onClick={saveSmtp} isLoading={smtpSaving}>
                                            {t('systemSettings.smtp.saveSettings')}
                                        </Button>
                                        <Button variant="outline" onClick={testSmtp} isLoading={smtpTesting} disabled={!smtpTestTo.trim()}>
                                            {t('systemSettings.smtp.sendTestEmail')}
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : activeTab === 'assistant' ? (
                        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 max-w-2xl space-y-8">
                            <div className="flex items-center gap-3 px-2">
                                <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                                    <span className="material-symbols-outlined text-lg">auto_awesome</span>
                                </div>
                                <div>
                                    <h3 className="text-[10px] font-black text-text-light uppercase tracking-widest leading-none">{t('settingsAssistant.tab')}</h3>
                                </div>
                            </div>

                            {assistantLoading ? (
                                <p className="text-sm text-text-light px-2">{t('common.loading')}</p>
                            ) : (
                                <div className="bg-surface rounded-3xl shadow-md p-8 space-y-6 border-none">
                                    {/* Enable toggle */}
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <p className="text-xs font-black text-text-dark">{t('settingsAssistant.enabled')}</p>
                                        </div>
                                        <Toggle
                                            checked={assistant.enabled}
                                            onChange={(v) => setAssistant(s => ({ ...s, enabled: v }))}
                                            aria-label={t('settingsAssistant.enabled')}
                                        />
                                    </div>

                                    <div className="grid grid-cols-1 gap-5">
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('settingsAssistant.apiKey')}</label>
                                            <Input
                                                type="password"
                                                placeholder={assistant.hasApiKey && !assistantKeyTouched ? t('settingsAssistant.apiKeySaved') : 'sk-or-...'}
                                                value={assistant.apiKey}
                                                onChange={e => { setAssistantKeyTouched(true); setAssistant(s => ({ ...s, apiKey: e.target.value })) }}
                                            />
                                            <p className="text-[10px] text-text-muted">{t('settingsAssistant.apiKeyHint')}</p>
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('settingsAssistant.model')}</label>
                                            <Input placeholder="anthropic/claude-sonnet-4.5" list="assistant-model-suggestions" value={assistant.model} onChange={e => setAssistant(s => ({ ...s, model: e.target.value }))} />
                                            <datalist id="assistant-model-suggestions">
                                                <option value="anthropic/claude-sonnet-4.5" />
                                                <option value="anthropic/claude-opus-4.5" />
                                                <option value="anthropic/claude-haiku-4.5" />
                                                <option value="openai/gpt-4o-mini" />
                                                <option value="google/gemini-2.5-flash" />
                                            </datalist>
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('settingsAssistant.baseUrl')}</label>
                                            <Input placeholder="https://openrouter.ai/api/v1" value={assistant.baseUrl} onChange={e => setAssistant(s => ({ ...s, baseUrl: e.target.value }))} />
                                        </div>
                                    </div>

                                    {assistantTestResult && (
                                        <div className={`rounded-2xl px-4 py-3 text-xs font-bold flex items-center gap-2 ${assistantTestResult.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
                                            <span className="material-symbols-outlined text-sm">{assistantTestResult.ok ? 'check_circle' : 'error'}</span>
                                            {assistantTestResult.message}
                                        </div>
                                    )}

                                    <div className="flex gap-3">
                                        <Button onClick={saveAssistant} isLoading={assistantSaving}>
                                            {t('common.save')}
                                        </Button>
                                        <Button variant="outline" onClick={testAssistant} isLoading={assistantTesting}>
                                            {t('settingsAssistant.test')}
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : activeTab === 'templates' ? (
                        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                            <div className="flex items-center gap-3 px-2 mb-6">
                                <div className="w-8 h-8 rounded-xl bg-violet-500/10 flex items-center justify-center text-violet-600">
                                    <span className="material-symbols-outlined text-lg">edit_note</span>
                                </div>
                                <div>
                                    <h3 className="text-[10px] font-black text-text-light uppercase tracking-widest leading-none">{t('systemSettings.templates.title')}</h3>
                                    <p className="text-xs text-text-muted mt-1">{t('systemSettings.templates.subtitlePrefix')} <code className="bg-slate-100 px-1 rounded text-[11px] font-mono">{'{{variable}}'}</code> {t('systemSettings.templates.subtitleSuffix')}</p>
                                </div>
                            </div>

                            {tplLoading ? (
                                <p className="text-sm text-text-light px-2">{t('common.loading')}</p>
                            ) : (
                                <div className="flex gap-6" style={{ minHeight: '600px' }}>
                                    {/* ── Left sidebar: template list ── */}
                                    <div className="w-56 shrink-0 space-y-1">
                                        {templates.map(tplItem => (
                                            <button
                                                key={tplItem.key}
                                                onClick={() => selectTemplate(tplItem)}
                                                className={`w-full text-left px-4 py-3 rounded-2xl transition-all ${selectedTplKey === tplItem.key ? 'bg-primary/10 text-primary' : 'hover:bg-slate-100 text-text-dark'}`}
                                            >
                                                <div className="flex items-center gap-2">
                                                    <span className="material-symbols-outlined text-base">
                                                        {tplItem.key === 'password_reset' ? 'lock_reset' : tplItem.key === 'selfservice_created' ? 'person_add' : tplItem.key === 'attendance_report' ? 'calendar_month' : 'payments'}
                                                    </span>
                                                    <div className="min-w-0">
                                                        <p className="text-[11px] font-black uppercase tracking-wide truncate">{tplItem.name}</p>
                                                        {tplItem.isCustomized && <span className="text-[9px] text-primary font-bold uppercase tracking-widest">{t('systemSettings.templates.customized')}</span>}
                                                    </div>
                                                </div>
                                            </button>
                                        ))}
                                    </div>

                                    {/* ── Right: editor panel ── */}
                                    {tplDraft && selectedTplKey && (() => {
                                        const tpl = templates.find(tt => tt.key === selectedTplKey)
                                        if (!tpl) return null
                                        return (
                                            <div className="flex-1 min-w-0 space-y-4">
                                                {/* Description */}
                                                <p className="text-xs text-text-muted">{tpl.description}</p>

                                                {/* Variable chips */}
                                                <div className="flex flex-wrap gap-1.5">
                                                    {tpl.variables.map(v => (
                                                        <button
                                                            key={v}
                                                            title={t('systemSettings.templates.clickToCopy')}
                                                            onClick={() => { void copyToClipboard(v) }}
                                                            className="font-mono text-[10px] px-2 py-0.5 bg-violet-50 text-violet-700 rounded-lg border border-violet-200 hover:bg-violet-100 transition-colors cursor-copy"
                                                        >
                                                            {v}
                                                        </button>
                                                    ))}
                                                    <span className="text-[10px] text-text-muted self-center ml-1">{t('systemSettings.templates.clickToCopy')}</span>
                                                </div>

                                                {/* Subject */}
                                                <div className="space-y-1.5">
                                                    <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.templates.subject')}</label>
                                                    <Input
                                                        value={tplDraft.subject}
                                                        onChange={e => setTplDraft(d => d ? { ...d, subject: e.target.value } : d)}
                                                        placeholder={t('systemSettings.templates.subjectPlaceholder')}
                                                    />
                                                </div>

                                                {/* Edit / Preview toggle */}
                                                <div className="flex items-center gap-2">
                                                    <div className="flex bg-slate-100 rounded-xl p-0.5 gap-0.5">
                                                        <button
                                                            onClick={() => setTplView('edit')}
                                                            className={`px-4 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${tplView === 'edit' ? 'bg-white shadow-sm text-text-dark' : 'text-text-light hover:text-text-dark'}`}
                                                        >
                                                            {t('systemSettings.templates.htmlEditor')}
                                                        </button>
                                                        <button
                                                            onClick={previewTpl}
                                                            disabled={tplPreviewLoading}
                                                            className={`px-4 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-1 ${tplView === 'preview' ? 'bg-white shadow-sm text-text-dark' : 'text-text-light hover:text-text-dark'}`}
                                                        >
                                                            {tplPreviewLoading && <span className="spinner-ring text-xs" aria-hidden="true" />}
                                                            {t('systemSettings.templates.preview')}
                                                        </button>
                                                    </div>
                                                    <span className="text-[9px] text-text-muted uppercase tracking-widest">{t('systemSettings.templates.sampleDataInPreview')}</span>
                                                </div>

                                                {/* Editor area */}
                                                {tplView === 'edit' ? (
                                                    <textarea
                                                        value={tplDraft.htmlBody}
                                                        onChange={e => setTplDraft(d => d ? { ...d, htmlBody: e.target.value } : d)}
                                                        spellCheck={false}
                                                        className="w-full font-mono text-[12px] leading-relaxed bg-slate-950 text-green-300 rounded-2xl p-5 resize-none focus:outline-none focus:ring-2 focus:ring-primary/30 border-none"
                                                        style={{ minHeight: '420px', tabSize: 2 }}
                                                        onKeyDown={e => {
                                                            if (e.key === 'Tab') {
                                                                e.preventDefault()
                                                                const el = e.currentTarget
                                                                const start = el.selectionStart
                                                                const end = el.selectionEnd
                                                                const val = el.value
                                                                el.value = val.substring(0, start) + '  ' + val.substring(end)
                                                                el.selectionStart = el.selectionEnd = start + 2
                                                                setTplDraft(d => d ? { ...d, htmlBody: el.value } : d)
                                                            }
                                                        }}
                                                    />
                                                ) : (
                                                    <div className="rounded-2xl border border-border-light overflow-hidden bg-white" style={{ minHeight: '420px' }}>
                                                        {tplPreviewHtml ? (
                                                            <iframe
                                                                srcDoc={tplPreviewHtml}
                                                                title={t('systemSettings.templates.emailPreview')}
                                                                className="w-full border-none"
                                                                style={{ minHeight: '420px' }}
                                                                sandbox="allow-same-origin"
                                                            />
                                                        ) : (
                                                            <div className="flex items-center justify-center h-64 text-text-muted text-sm">
                                                                {t('systemSettings.templates.clickPreview')}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}

                                                {/* Actions */}
                                                <div className="flex gap-3">
                                                    <Button onClick={saveTpl} isLoading={tplSaving}>
                                                        {t('systemSettings.templates.saveTemplate')}
                                                    </Button>
                                                    {tpl.isCustomized && (
                                                        <Button variant="outline" onClick={resetTpl} isLoading={tplResetting}>
                                                            {t('systemSettings.templates.resetToDefault')}
                                                        </Button>
                                                    )}
                                                </div>
                                            </div>
                                        )
                                    })()}
                                </div>
                            )}
                        </div>
                    ) : activeTab === 'users' ? (
                        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 space-y-6">
                            <div className="flex items-center justify-between gap-3 px-2">
                                <div className="flex items-center gap-3">
                                    <div className="w-8 h-8 rounded-xl bg-indigo-500/10 flex items-center justify-center text-indigo-600">
                                        <span className="material-symbols-outlined text-lg">group</span>
                                    </div>
                                    <div>
                                        <h3 className="text-[10px] font-black text-text-light uppercase tracking-widest leading-none">{t('systemSettings.users.title')}</h3>
                                        <p className="text-xs text-text-muted mt-1">{t('systemSettings.users.subtitle')}</p>
                                    </div>
                                </div>
                                <Button icon="person_add" onClick={openCreateUser}>{t('systemSettings.users.newUser')}</Button>
                            </div>

                            <div className="bg-surface rounded-3xl shadow-md overflow-hidden border-none">
                                {usersLoading ? (
                                    <div className="flex items-center justify-center py-16">
                                        <span className="spinner-ring text-3xl text-primary" aria-hidden="true" />
                                    </div>
                                ) : users.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center py-16 gap-2 text-text-light">
                                        <span className="material-symbols-outlined text-4xl">person_off</span>
                                        <p className="text-sm">{t('systemSettings.users.noUsers')}</p>
                                    </div>
                                ) : (
                                    <table className="w-full">
                                        <thead>
                                            <tr className="bg-slate-50 border-b border-border-light">
                                                <th className="px-5 py-3 text-left text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.users.user')}</th>
                                                <th className="px-5 py-3 text-left text-[10px] font-black text-text-light uppercase tracking-widest">{t('common.email')}</th>
                                                <th className="px-5 py-3 text-left text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.users.roles')}</th>
                                                <th className="px-5 py-3 text-right text-[10px] font-black text-text-light uppercase tracking-widest">{t('common.actions')}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {users.map(u => {
                                                const isSelf = currentUser?.id === u.id
                                                return (
                                                    <tr key={u.id} className="border-b border-border last:border-none hover:bg-background-light">
                                                        <td className="px-5 py-3">
                                                            <div className="font-bold text-text-dark">{u.firstName || u.lastName ? `${u.firstName} ${u.lastName}`.trim() : '—'}</div>
                                                            {isSelf && <span className="text-[9px] font-black text-primary uppercase tracking-widest">{t('systemSettings.users.you')}</span>}
                                                        </td>
                                                        <td className="px-5 py-3 text-sm text-text-dark font-mono">{u.email}</td>
                                                        <td className="px-5 py-3">
                                                            <div className="flex flex-wrap gap-1">
                                                                {u.roles.length === 0 && <span className="text-text-light text-xs">—</span>}
                                                                {u.roles.map(r => (
                                                                    <span key={r} className="text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-lg bg-indigo-50 text-indigo-700">{r}</span>
                                                                ))}
                                                            </div>
                                                        </td>
                                                        <td className="px-5 py-3 text-right">
                                                            <div className="inline-flex gap-2">
                                                                <button type="button" onClick={() => openEditUser(u)} title={t('common.edit')} className="text-text-muted hover:text-primary transition-colors">
                                                                    <span className="material-symbols-outlined text-base">edit</span>
                                                                </button>
                                                                <button type="button" onClick={() => { setPasswordForm({ newPassword: '', confirm: '' }); setPasswordModal(u) }} title={t('systemSettings.users.changePassword')} className="text-text-muted hover:text-primary transition-colors">
                                                                    <span className="material-symbols-outlined text-base">key</span>
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => setDeleteUserModal(u)}
                                                                    disabled={isSelf}
                                                                    title={isSelf ? t('systemSettings.users.cantDeleteSelf') : t('common.delete')}
                                                                    className="text-text-muted hover:text-error-text transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                                                >
                                                                    <span className="material-symbols-outlined text-base">delete</span>
                                                                </button>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                )
                                            })}
                                        </tbody>
                                    </table>
                                )}
                            </div>
                        </div>
                    ) : activeTab === 'debugLogs' ? (
                        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 space-y-6">
                            <div className="flex items-center justify-between gap-3 px-2">
                                <div className="flex items-center gap-3">
                                    <div className="w-8 h-8 rounded-xl bg-slate-500/10 flex items-center justify-center text-slate-600">
                                        <span className="material-symbols-outlined text-lg">terminal</span>
                                    </div>
                                    <div>
                                        <h3 className="text-[10px] font-black text-text-light uppercase tracking-widest leading-none">{t('systemSettings.audit.title')}</h3>
                                        <p className="text-xs text-text-muted mt-1">{t('systemSettings.audit.subtitle')}</p>
                                    </div>
                                </div>
                                <Button variant="outline" size="sm" icon="refresh" onClick={() => { setAuditOffset(0); void loadAuditLogs() }}>{t('common.refresh')}</Button>
                            </div>

                            <div className="bg-surface rounded-3xl shadow-md p-5 border-none flex flex-wrap items-end gap-3">
                                <div className="space-y-1.5">
                                    <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.audit.category')}</label>
                                    <select
                                        value={auditCategory}
                                        onChange={(e) => { setAuditCategory(e.target.value); setAuditOffset(0) }}
                                        className="bg-slate-50 border border-border-light rounded-2xl px-4 py-2.5 text-sm font-bold text-text-dark min-w-[180px]"
                                    >
                                        <option value="">{t('systemSettings.audit.allCategories')}</option>
                                        {AUDIT_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                </div>
                                <div className="flex-1 min-w-[200px] space-y-1.5">
                                    <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.audit.searchLabel')}</label>
                                    <Input
                                        placeholder={t('systemSettings.audit.searchPlaceholder')}
                                        value={auditSearch}
                                        onChange={e => setAuditSearch(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') { setAuditOffset(0); void loadAuditLogs() } }}
                                    />
                                </div>
                                <Button size="md" onClick={() => { setAuditOffset(0); void loadAuditLogs() }}>{t('common.apply')}</Button>
                            </div>

                            <div className="bg-surface rounded-3xl shadow-md overflow-hidden border-none">
                                <div className="px-5 py-3 bg-slate-50 border-b border-border-light flex items-center justify-between">
                                    <p className="text-[10px] font-black text-text-light uppercase tracking-widest">
                                        {auditLoading ? t('common.loading') : t('systemSettings.audit.entriesShowing', { total: auditTotal, from: auditOffset + 1, to: Math.min(auditOffset + AUDIT_LIMIT, auditTotal) })}
                                    </p>
                                    <div className="flex gap-1">
                                        <button
                                            type="button"
                                            disabled={auditOffset === 0 || auditLoading}
                                            onClick={() => setAuditOffset(o => Math.max(0, o - AUDIT_LIMIT))}
                                            className="text-text-muted hover:text-primary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                            title={t('systemSettings.audit.previousPage')}
                                        >
                                            <span className="material-symbols-outlined text-base">chevron_left</span>
                                        </button>
                                        <button
                                            type="button"
                                            disabled={auditOffset + AUDIT_LIMIT >= auditTotal || auditLoading}
                                            onClick={() => setAuditOffset(o => o + AUDIT_LIMIT)}
                                            className="text-text-muted hover:text-primary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                            title={t('systemSettings.audit.nextPage')}
                                        >
                                            <span className="material-symbols-outlined text-base">chevron_right</span>
                                        </button>
                                    </div>
                                </div>

                                {auditLoading ? (
                                    <div className="flex items-center justify-center py-16">
                                        <span className="spinner-ring text-3xl text-primary" aria-hidden="true" />
                                    </div>
                                ) : auditLogs.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center py-16 gap-2 text-text-light">
                                        <span className="material-symbols-outlined text-4xl">inbox</span>
                                        <p className="text-sm">{t('systemSettings.audit.noEntries')}</p>
                                    </div>
                                ) : (
                                    <table className="w-full text-xs">
                                        <thead>
                                            <tr className="bg-slate-50/60 border-b border-border-light">
                                                <th className="px-4 py-2 text-left text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.audit.whenUtc')}</th>
                                                <th className="px-4 py-2 text-left text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.audit.who')}</th>
                                                <th className="px-4 py-2 text-left text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.audit.category')}</th>
                                                <th className="px-4 py-2 text-left text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.audit.action')}</th>
                                                <th className="px-4 py-2 text-left text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.audit.path')}</th>
                                                <th className="px-4 py-2 text-right text-[10px] font-black text-text-light uppercase tracking-widest">{t('common.status')}</th>
                                                <th className="px-4 py-2 text-left text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.audit.ip')}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {auditLogs.map(row => (
                                                <tr key={row.id} className={`border-b border-border last:border-none hover:bg-background-light ${!row.success ? 'bg-red-50/40' : ''}`}>
                                                    <td className="px-4 py-2 font-mono text-text-dark whitespace-nowrap">{row.timestampUtc.replace('T', ' ').slice(0, 19)}</td>
                                                    <td className="px-4 py-2 text-text-dark">{row.userEmail || <span className="text-text-light italic">{t('systemSettings.audit.anonymous')}</span>}</td>
                                                    <td className="px-4 py-2">
                                                        <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-lg ${CATEGORY_COLORS[row.category] ?? 'bg-slate-100 text-slate-700'}`}>{row.category}</span>
                                                    </td>
                                                    <td className="px-4 py-2 text-text-dark">
                                                        {row.action}
                                                        {row.description && <span className="block text-[10px] text-text-light">{row.description}</span>}
                                                    </td>
                                                    <td className="px-4 py-2 font-mono text-text-light truncate max-w-[280px]">
                                                        <span className="text-text-muted">{row.method}</span> {row.path}
                                                    </td>
                                                    <td className="px-4 py-2 text-right font-mono">
                                                        {row.statusCode == null ? '—' : (
                                                            <span className={row.success ? 'text-emerald-600' : 'text-red-600'}>{row.statusCode}</span>
                                                        )}
                                                    </td>
                                                    <td className="px-4 py-2 font-mono text-text-light">{row.ipAddress ?? '—'}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                )}
                            </div>
                        </div>
                    ) : activeTab === 'roles' ? (
                        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 space-y-6 max-w-3xl">
                            <div className="flex items-center justify-between gap-3 px-2">
                                <div className="flex items-center gap-3">
                                    <div className="w-8 h-8 rounded-xl bg-amber-500/10 flex items-center justify-center text-amber-600">
                                        <span className="material-symbols-outlined text-lg">badge</span>
                                    </div>
                                    <div>
                                        <h3 className="text-[10px] font-black text-text-light uppercase tracking-widest leading-none">{t('systemSettings.roles.title')}</h3>
                                        <p className="text-xs text-text-muted mt-1">{t('systemSettings.roles.subtitlePrefix')} <strong>{t('systemSettings.roles.permissions')}</strong> {t('systemSettings.roles.subtitleSuffix')}</p>
                                    </div>
                                </div>
                                <Button icon="add" onClick={() => { setRoleForm({ name: '' }); setRoleModal('create') }}>{t('systemSettings.roles.newRole')}</Button>
                            </div>

                            <div className="bg-surface rounded-3xl shadow-md overflow-hidden border-none">
                                {rolesLoading ? (
                                    <div className="flex items-center justify-center py-16">
                                        <span className="spinner-ring text-3xl text-primary" aria-hidden="true" />
                                    </div>
                                ) : (
                                    <ul className="divide-y divide-border-light">
                                        {roles.map(r => (
                                            <li key={r.name} className="flex items-center gap-3 px-5 py-3 hover:bg-background-light">
                                                <span className="material-symbols-outlined text-base text-amber-600">badge</span>
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        <p className="font-bold text-text-dark">{r.name}</p>
                                                        {r.isSystem && <span className="text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-md bg-emerald-50 text-emerald-700">{t('systemSettings.roles.system')}</span>}
                                                        {r.name === 'Admin' && <span className="text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-md bg-indigo-50 text-indigo-700">{t('systemSettings.roles.fullAccess')}</span>}
                                                    </div>
                                                    <p className="text-[10px] text-text-light uppercase tracking-widest">{t('systemSettings.roles.userCount', { count: r.userCount })}</p>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => void openPermissionsEditor(r)}
                                                    title={r.name === 'Admin' ? t('systemSettings.roles.adminReadOnly') : t('systemSettings.roles.editPermissions')}
                                                    className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors"
                                                >
                                                    <span className="material-symbols-outlined text-sm">tune</span>
                                                    {t('systemSettings.roles.permissions')}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setDeleteRoleModal(r)}
                                                    disabled={r.isSystem || r.userCount > 0}
                                                    title={r.isSystem ? t('systemSettings.roles.systemRoleCantDelete') : r.userCount > 0 ? t('systemSettings.roles.roleHasUsers') : t('systemSettings.roles.deleteRole')}
                                                    className="text-text-muted hover:text-error-text transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                                >
                                                    <span className="material-symbols-outlined text-base">delete</span>
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 max-w-4xl space-y-8">
                            <div className="flex items-center gap-3 px-2">
                                <div className="w-8 h-8 rounded-xl bg-violet-500/10 flex items-center justify-center text-violet-600">
                                    <span className="material-symbols-outlined text-lg">sync</span>
                                </div>
                                <div>
                                    <h3 className="text-[10px] font-black text-text-light uppercase tracking-widest leading-none">{t('systemSettings.logSync.title')}</h3>
                                    <p className="text-xs text-text-muted mt-1">
                                        {t('systemSettings.logSync.subtitle')}
                                    </p>
                                </div>
                            </div>

                            {logSyncLoading && !logSyncSettings ? (
                                <p className="text-sm text-text-light px-2">{t('common.loading')}</p>
                            ) : (
                                <>
                                    <div className="bg-surface rounded-3xl shadow-md p-8 space-y-6 border-none">
                                        <p className="text-xs font-black text-text-dark">{t('systemSettings.logSync.manualSync')}</p>
                                        <p className="text-[11px] text-text-light">{t('systemSettings.logSync.manualSyncDesc')}</p>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                            <div className="space-y-2">
                                                <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('common.from')}</label>
                                                <input
                                                    type="date"
                                                    value={logSyncManualFrom}
                                                    onChange={(e) => setLogSyncManualFrom(e.target.value)}
                                                    className="w-full bg-slate-50 border border-border-light rounded-2xl px-4 py-3 text-sm font-bold text-text-dark"
                                                />
                                            </div>
                                            <div className="space-y-2">
                                                <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('common.to')}</label>
                                                <input
                                                    type="date"
                                                    value={logSyncManualTo}
                                                    onChange={(e) => setLogSyncManualTo(e.target.value)}
                                                    className="w-full bg-slate-50 border border-border-light rounded-2xl px-4 py-3 text-sm font-bold text-text-dark"
                                                />
                                            </div>
                                        </div>
                                        <Button
                                            type="button"
                                            icon="sync"
                                            onClick={() => void runManualLogSync()}
                                            isLoading={logSyncManualRunning}
                                            disabled={!logSyncManualFrom || !logSyncManualTo}
                                        >
                                            {t('systemSettings.logSync.syncNow')}
                                        </Button>
                                    </div>

                                    <div className="bg-surface rounded-3xl shadow-md p-8 space-y-6 border-none">
                                        <p className="text-xs font-black text-text-dark">{t('systemSettings.logSync.autoSync')}</p>
                                        <p className="text-[11px] text-text-light">
                                            {t('systemSettings.logSync.autoSyncDesc')}
                                        </p>
                                        <label className="flex items-center gap-3 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={logSyncDraftAuto}
                                                onChange={(e) => setLogSyncDraftAuto(e.target.checked)}
                                                className="w-4 h-4 rounded border-border-light text-primary focus:ring-primary/30"
                                            />
                                            <span className="text-sm font-bold text-text-dark">{t('systemSettings.logSync.enableDailyRun')}</span>
                                        </label>
                                        <div className="space-y-2 max-w-xs">
                                            <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.logSync.timeLocal')}</label>
                                            <input
                                                type="text"
                                                inputMode="numeric"
                                                placeholder="HH:MM"
                                                maxLength={5}
                                                value={logSyncDraftTime}
                                                onChange={(e) => {
                                                  const digits = e.target.value.replace(/\D/g, '').slice(0, 4)
                                                  setLogSyncDraftTime(digits.length <= 2 ? digits : `${digits.slice(0, 2)}:${digits.slice(2)}`)
                                                }}
                                                className="w-full bg-slate-50 border border-border-light rounded-2xl px-4 py-3 text-sm font-bold font-mono text-text-dark"
                                            />
                                        </div>
                                        <Button type="button" icon="save" onClick={() => void saveLogSyncSchedule()} isLoading={logSyncSaving}>
                                            {t('systemSettings.logSync.saveSchedule')}
                                        </Button>
                                    </div>

                                    {logSyncSettings && (
                                        <div className="rounded-2xl border border-border-light bg-slate-50/80 px-4 py-3 text-[11px] text-text-light">
                                            <p className="font-black text-text-dark text-[10px] uppercase tracking-widest mb-2">{t('systemSettings.logSync.lastRun')}</p>
                                            {logSyncSettings.lastRunUtc ? (
                                                <>
                                                    <p>
                                                        {new Date(logSyncSettings.lastRunUtc).toLocaleString('en-GB', { hour12: false })} — {t('systemSettings.logSync.recordsAddedLabel')}:{' '}
                                                        {logSyncSettings.lastRecordsAdded ?? '—'}
                                                        {logSyncSettings.lastRunKind ? ` (${logSyncSettings.lastRunKind === 'auto' ? t('systemSettings.logSync.auto') : t('systemSettings.logSync.manual')})` : ''}
                                                    </p>
                                                </>
                                            ) : (
                                                <p>{t('systemSettings.logSync.neverRun')}</p>
                                            )}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {userModal && (
                <Modal
                    isOpen
                    title={userModal === 'create' ? t('systemSettings.users.newUser') : t('systemSettings.users.editUser', { email: editingUser?.email ?? '' })}
                    onClose={() => setUserModal(null)}
                >
                    <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                                <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.users.firstName')}</label>
                                <Input value={userForm.firstName} onChange={e => setUserForm(f => ({ ...f, firstName: e.target.value }))} />
                            </div>
                            <div className="space-y-1.5">
                                <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.users.lastName')}</label>
                                <Input value={userForm.lastName} onChange={e => setUserForm(f => ({ ...f, lastName: e.target.value }))} />
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('common.email')}</label>
                            <Input type="email" value={userForm.email} onChange={e => setUserForm(f => ({ ...f, email: e.target.value }))} />
                        </div>
                        {userModal === 'create' && (
                            <div className="space-y-1.5">
                                <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.users.passwordMin')}</label>
                                <Input type="password" value={userForm.password} onChange={e => setUserForm(f => ({ ...f, password: e.target.value }))} />
                            </div>
                        )}
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.users.roles')}</label>
                            <div className="flex flex-wrap gap-2">
                                {roles.length === 0 && <span className="text-xs text-text-light">{t('systemSettings.users.loadingRoles')}</span>}
                                {roles.map(r => {
                                    const checked = userForm.roles.includes(r.name)
                                    return (
                                        <label key={r.name} className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-xl cursor-pointer border transition-colors ${checked ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-slate-50 border-border-light text-text-light hover:text-text-dark'}`}>
                                            <input
                                                type="checkbox"
                                                checked={checked}
                                                onChange={() => toggleUserRole(r.name)}
                                                className="w-3.5 h-3.5 rounded border-border-light text-primary focus:ring-primary/30"
                                            />
                                            <span className="text-[11px] font-black uppercase tracking-widest">{r.name}</span>
                                        </label>
                                    )
                                })}
                            </div>
                        </div>
                        <div className="flex gap-2 pt-2">
                            <Button fullWidth onClick={saveUser} isLoading={userSaving}>{userModal === 'create' ? t('systemSettings.users.createUser') : t('common.saveChanges')}</Button>
                            <Button fullWidth variant="outline" onClick={() => setUserModal(null)} disabled={userSaving}>{t('common.cancel')}</Button>
                        </div>
                    </div>
                </Modal>
            )}

            {passwordModal && (
                <Modal isOpen title={t('systemSettings.users.changePasswordTitle', { email: passwordModal.email })} onClose={() => { setPasswordModal(null); setPasswordForm({ newPassword: '', confirm: '' }) }}>
                    <div className="space-y-4">
                        <p className="text-xs text-text-light">{t('systemSettings.users.changePasswordDesc')}</p>
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.users.newPasswordMin')}</label>
                            <Input type="password" value={passwordForm.newPassword} onChange={e => setPasswordForm(f => ({ ...f, newPassword: e.target.value }))} autoFocus />
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.users.confirmNewPassword')}</label>
                            <Input type="password" value={passwordForm.confirm} onChange={e => setPasswordForm(f => ({ ...f, confirm: e.target.value }))} />
                        </div>
                        <div className="flex gap-2 pt-2">
                            <Button fullWidth onClick={submitPasswordChange} isLoading={passwordSaving}>{t('systemSettings.users.changePassword')}</Button>
                            <Button fullWidth variant="outline" onClick={() => { setPasswordModal(null); setPasswordForm({ newPassword: '', confirm: '' }) }} disabled={passwordSaving}>{t('common.cancel')}</Button>
                        </div>
                    </div>
                </Modal>
            )}

            {deleteUserModal && (
                <Modal isOpen title={t('systemSettings.users.deleteUserTitle')} onClose={() => setDeleteUserModal(null)}>
                    <div className="space-y-4">
                        <p className="text-sm text-text-dark">
                            {t('systemSettings.users.deleteUserConfirmPrefix')} <strong>{deleteUserModal.email}</strong> {t('systemSettings.users.deleteUserConfirmSuffix')}
                        </p>
                        <div className="flex gap-2">
                            <Button fullWidth variant="danger" onClick={confirmDeleteUser} isLoading={deletingUser}>{t('systemSettings.users.deleteUser')}</Button>
                            <Button fullWidth variant="outline" onClick={() => setDeleteUserModal(null)} disabled={deletingUser}>{t('common.cancel')}</Button>
                        </div>
                    </div>
                </Modal>
            )}

            {roleModal === 'create' && (
                <Modal isOpen title={t('systemSettings.roles.newRole')} onClose={() => { setRoleModal(null); setRoleForm({ name: '' }) }}>
                    <div className="space-y-4">
                        <p className="text-xs text-text-light">{t('systemSettings.roles.newRoleDesc')}</p>
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('systemSettings.roles.roleName')}</label>
                            <Input placeholder={t('systemSettings.roles.roleNamePlaceholder')} value={roleForm.name} onChange={e => setRoleForm({ name: e.target.value })} autoFocus />
                        </div>
                        <div className="flex gap-2 pt-2">
                            <Button fullWidth onClick={saveRole} isLoading={roleSaving} disabled={!roleForm.name.trim()}>{t('systemSettings.roles.createRole')}</Button>
                            <Button fullWidth variant="outline" onClick={() => { setRoleModal(null); setRoleForm({ name: '' }) }} disabled={roleSaving}>{t('common.cancel')}</Button>
                        </div>
                    </div>
                </Modal>
            )}

            {deleteRoleModal && (
                <Modal isOpen title={t('systemSettings.roles.deleteRoleTitle')} onClose={() => setDeleteRoleModal(null)}>
                    <div className="space-y-4">
                        <p className="text-sm text-text-dark">{t('systemSettings.roles.deleteRoleConfirmPrefix')} <strong>{deleteRoleModal.name}</strong> {t('systemSettings.roles.deleteRoleConfirmSuffix')}</p>
                        <div className="flex gap-2">
                            <Button fullWidth variant="danger" onClick={confirmDeleteRole} isLoading={deletingRole}>{t('systemSettings.roles.deleteRole')}</Button>
                            <Button fullWidth variant="outline" onClick={() => setDeleteRoleModal(null)} disabled={deletingRole}>{t('common.cancel')}</Button>
                        </div>
                    </div>
                </Modal>
            )}

            {permsModal && (
                <Modal isOpen title={t('systemSettings.permissions.title', { name: permsModal.name })} onClose={() => setPermsModal(null)}>
                    {permsLoading ? (
                        <div className="flex items-center justify-center py-12">
                            <span className="spinner-ring text-3xl text-primary" aria-hidden="true" />
                        </div>
                    ) : (
                        <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
                            {permsModal.isAdmin && (
                                <div className="bg-indigo-50 border border-indigo-200 rounded-2xl px-4 py-3 text-xs text-indigo-800">
                                    {t('systemSettings.permissions.adminNoticePrefix')} <strong>Admin</strong> {t('systemSettings.permissions.adminNoticeSuffix')}
                                </div>
                            )}
                            {!permsModal.isAdmin && (
                                <p className="text-xs text-text-light">
                                    {t('systemSettings.permissions.pickPrefix')} <strong>{permsModal.name}</strong> {t('systemSettings.permissions.pickSuffix')}
                                </p>
                            )}
                            {permissionsCatalog.map(group => {
                                const allOn = group.items.every(i => permsSelection.has(i.key))
                                const someOn = group.items.some(i => permsSelection.has(i.key))
                                return (
                                    <div key={group.group} className="border border-border-light rounded-2xl p-4 space-y-2">
                                        <div className="flex items-center justify-between gap-2">
                                            <p className="text-[11px] font-black uppercase tracking-widest text-text-dark">{group.group}</p>
                                            {!permsModal.isAdmin && (
                                                <button
                                                    type="button"
                                                    onClick={() => toggleGroup(group, allOn)}
                                                    className="text-[10px] font-black uppercase tracking-widest text-indigo-700 hover:text-indigo-900"
                                                >
                                                    {allOn ? t('systemSettings.permissions.clearAll') : someOn ? t('systemSettings.permissions.selectAll') : t('systemSettings.permissions.selectAll')}
                                                </button>
                                            )}
                                        </div>
                                        <ul className="space-y-1.5">
                                            {group.items.map(p => {
                                                const checked = permsModal.isAdmin || permsSelection.has(p.key)
                                                return (
                                                    <li key={p.key}>
                                                        <label className={`flex items-start gap-2.5 px-2 py-1.5 rounded-xl ${permsModal.isAdmin ? 'cursor-default opacity-70' : 'cursor-pointer hover:bg-slate-50'}`}>
                                                            <input
                                                                type="checkbox"
                                                                checked={checked}
                                                                disabled={permsModal.isAdmin}
                                                                onChange={() => togglePermission(p.key)}
                                                                className="mt-0.5 w-4 h-4 rounded border-border-light text-primary focus:ring-primary/30 cursor-pointer disabled:cursor-default"
                                                            />
                                                            <div className="flex-1 min-w-0">
                                                                <p className="text-sm font-bold text-text-dark">{p.label}</p>
                                                                <p className="text-[11px] text-text-light leading-snug">{p.description}</p>
                                                                <p className="text-[10px] font-mono text-text-muted">{p.key}</p>
                                                            </div>
                                                        </label>
                                                    </li>
                                                )
                                            })}
                                        </ul>
                                    </div>
                                )
                            })}
                            <div className="flex gap-2 pt-2 sticky bottom-0 bg-surface pb-1">
                                {!permsModal.isAdmin && (
                                    <Button fullWidth onClick={savePermissions} isLoading={permsSaving}>
                                        {t('systemSettings.permissions.savePermissions', { count: permsSelection.size })}
                                    </Button>
                                )}
                                <Button fullWidth variant="outline" onClick={() => setPermsModal(null)} disabled={permsSaving}>
                                    {permsModal.isAdmin ? t('common.close') : t('common.cancel')}
                                </Button>
                            </div>
                        </div>
                    )}
                </Modal>
            )}

            {showCompanyNameModal === 'Single' && (
                <Modal isOpen title={t('systemSettings.org.companyNameModalTitle')} onClose={() => { setShowCompanyNameModal(null); setCompanyNameInput('') }}>
                    <div className="space-y-4">
                        <p className="text-xs text-text-light">{t('systemSettings.org.companyNameModalDesc')}</p>
                        <Input
                            placeholder={t('systemSettings.org.companyNamePlaceholder')}
                            value={companyNameInput}
                            onChange={(e) => setCompanyNameInput(e.target.value)}
                            autoFocus
                        />
                        <div className="flex gap-2">
                            <Button fullWidth onClick={handleConfirmModeWithName} isLoading={isSavingMode} disabled={!companyNameInput.trim()}>
                                {t('common.save')}
                            </Button>
                            <Button fullWidth variant="outline" onClick={() => { setShowCompanyNameModal(null); setCompanyNameInput('') }} disabled={isSavingMode}>
                                {t('common.cancel')}
                            </Button>
                        </div>
                    </div>
                </Modal>
            )}
        </AppLayout>
    )
}
