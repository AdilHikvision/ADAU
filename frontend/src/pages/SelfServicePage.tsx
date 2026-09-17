import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, Logo } from '../components/atoms'
import { Modal } from '../components/organisms'
import { apiRequest } from '../lib/api'
import { SelfServiceCalendar } from './SelfServiceCalendar'
import { SelfServiceSummary, SelfServiceNotifications, SelfServicePayslips } from './SelfServiceExtras'
import { SUPPORTED_LANGUAGES } from '../i18n'

const SS_TOKEN_KEY = 'projectx.ss.token'

interface SelfServiceMe {
  id: string
  firstName: string
  lastName: string
  employeeNo: string | null
  department: string | null
  workSchedule: { id: string; name: string; type: string } | null
  todayRecords: AttendanceRecord[]
}

interface AttendanceRecord {
  id: string
  eventTimeUtc: string
  eventType: string
  source: string
}

interface AttendanceRequest {
  id: string
  type: string
  requestedTimeUtc: string
  requestedEndTimeUtc: string | null
  comment: string | null
  status: string
  createdUtc: string
}

interface SelfServiceLeave {
  id: string
  leaveType: string // 'Vacation' | 'DayOff'
  isPaid: boolean
  startDate: string
  endDate: string
  reason: string | null
  status: string
  approvedAt: string | null
  createdUtc: string
}

const MY_REQUESTS_PAGE_SIZE = 5

// HourlyAbsence — только тип карточки в UI. На бэкенд уходит как Absence с
// requestedEndTimeUtc: одобрение такой заявки создаёт AttendancePermission (почасовая
// отлучка), тогда как Absence без конца интервала — отгул на целый день (EmployeeLeave).
type RequestType = 'CheckIn' | 'CheckOut' | 'Absence' | 'HourlyAbsence' | 'Vacation'

const REQUEST_TYPE_CONFIG: { type: RequestType; icon: string; color: string }[] = [
  { type: 'CheckIn', icon: 'login', color: 'bg-green-500/10 text-green-600' },
  { type: 'CheckOut', icon: 'logout', color: 'bg-blue-500/10 text-blue-600' },
  { type: 'Absence', icon: 'person_off', color: 'bg-amber-500/10 text-amber-600' },
  { type: 'HourlyAbsence', icon: 'more_time', color: 'bg-sky-500/10 text-sky-600' },
  { type: 'Vacation', icon: 'beach_access', color: 'bg-purple-500/10 text-purple-600' },
]

const STATUS_COLORS: Record<string, string> = {
  Pending: 'text-amber-600 bg-amber-50',
  Approved: 'text-green-600 bg-green-50',
  Rejected: 'text-red-600 bg-red-50',
}

function maskHHMM(input: string): string {
  const digits = input.replace(/\D/g, '').slice(0, 4)
  if (digits.length <= 2) return digits
  return `${digits.slice(0, 2)}:${digits.slice(2)}`
}

function ssApiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem(SS_TOKEN_KEY)
  return apiRequest<T>(path, { ...options, token })
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

function formatDateOnly(iso: string) {
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}.${m}.${y}`
}

// Календарная дата UTC-момента в местном времени: у отлучки рано утром / поздно вечером
// UTC-дата в ISO-строке может отличаться от той, на которую подана заявка.
function formatLocalDateOnly(iso: string) {
  const dt = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(dt.getDate())}.${pad(dt.getMonth() + 1)}.${dt.getFullYear()}`
}

export function SelfServicePage() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const [me, setMe] = useState<SelfServiceMe | null>(null)
  const [requests, setRequests] = useState<AttendanceRequest[]>([])
  const [leaves, setLeaves] = useState<SelfServiceLeave[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [modalOpen, setModalOpen] = useState(false)
  const [selectedType, setSelectedType] = useState<RequestType>('CheckIn')
  const [reqDateTime, setReqDateTime] = useState(new Date().toISOString().slice(0, 16))
  const [reqEndDateTime, setReqEndDateTime] = useState('')
  const [reqIsPaid, setReqIsPaid] = useState(true)
  const [reqComment, setReqComment] = useState('')
  const [myReqPage, setMyReqPage] = useState(0)
  // Поля корректировки (только для type === 'Correction').
  const [corrDate, setCorrDate] = useState(new Date().toISOString().slice(0, 10))
  const [corrCheckIn, setCorrCheckIn] = useState('')
  const [, setCorrCheckOut] = useState('')
  // Интервал почасовой отлучки (type === 'HourlyAbsence'), HH:MM локального времени.
  const [permFrom, setPermFrom] = useState('')
  const [permTo, setPermTo] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitSuccess, setSubmitSuccess] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Принудительная смена сгенерированного пароля при первом входе.
  const [pwModal, setPwModal] = useState(false)
  const [pwCurrent, setPwCurrent] = useState('')
  const [pwNew, setPwNew] = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [pwSubmitting, setPwSubmitting] = useState(false)
  const [pwError, setPwError] = useState<string | null>(null)

  const token = localStorage.getItem(SS_TOKEN_KEY)

  useEffect(() => {
    if (!token) {
      navigate('/login')
      return
    }
    // Если admin создал учётку с генерированным паролем — заставляем сменить.
    try {
      const userData = JSON.parse(localStorage.getItem('projectx.ss.user') ?? '{}')
      if (userData.requiresPasswordSetup) {
        setPwCurrent(userData.currentPassword ?? '')
        setPwModal(true)
      }
    } catch { /* ignore parse errors */ }
    loadData()
  }, [token])

  const submitPasswordChange = async (e: React.FormEvent) => {
    e.preventDefault()
    setPwError(null)
    if (pwNew.length < 6) { setPwError(t('selfService.passwordMinLength')); return }
    if (pwNew !== pwConfirm) { setPwError(t('selfService.passwordsDoNotMatch')); return }
    setPwSubmitting(true)
    try {
      await ssApiRequest('/api/self-service/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: pwCurrent, newPassword: pwNew }),
      })
      // Снимаем флаг локально, чтобы при следующем mount модалка не открывалась.
      try {
        const userData = JSON.parse(localStorage.getItem('projectx.ss.user') ?? '{}')
        userData.requiresPasswordSetup = false
        delete userData.currentPassword
        localStorage.setItem('projectx.ss.user', JSON.stringify(userData))
      } catch { /* ignore */ }
      setPwModal(false)
      setPwCurrent(''); setPwNew(''); setPwConfirm('')
    } catch (err) {
      setPwError(err instanceof Error ? err.message : t('selfService.failedChangePassword'))
    } finally {
      setPwSubmitting(false)
    }
  }

  const loadData = async () => {
    try {
      const [meData, reqData, leaveData] = await Promise.all([
        ssApiRequest<SelfServiceMe>('/api/self-service/me'),
        ssApiRequest<AttendanceRequest[]>('/api/self-service/requests'),
        ssApiRequest<SelfServiceLeave[]>('/api/self-service/leaves'),
      ])
      setMe(meData)
      setRequests(reqData)
      setLeaves(leaveData)
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      if (msg.includes('401') || msg.toLowerCase().includes('unauthorized')) {
        localStorage.removeItem(SS_TOKEN_KEY)
        navigate('/login')
        return
      }
      setError(t('selfService.failedLoadData'))
    } finally {
      setLoading(false)
    }
  }

  const handleOpenModal = (type: RequestType) => {
    setSelectedType(type)
    setReqDateTime(new Date().toISOString().slice(0, 16))
    setReqEndDateTime('')
    setReqIsPaid(true)
    setReqComment('')
    setCorrDate(new Date().toISOString().slice(0, 10))
    setCorrCheckIn('')
    setCorrCheckOut('')
    setPermFrom('')
    setPermTo('')
    setSubmitSuccess(false)
    setSubmitError(null)
    setModalOpen(true)
  }

  const handleSubmitRequest = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setSubmitError(null)
    try {
      if (selectedType === 'CheckIn' || selectedType === 'CheckOut') {
        const m = corrCheckIn.match(/^([01][0-9]|2[0-3]):([0-5][0-9])$/)
        if (!m) {
          setSubmitError(t('selfService.enterTimeHHMM'))
          setSubmitting(false)
          return
        }
        const d = new Date(corrDate + 'T00:00:00')
        d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0)

        // Запрос геолокации. Если разрешена — отправим вместе с запросом, на бэке проверится
        // GeoZone и при попадании запрос авто-аппрувится (минуя админа).
        let latitude: number | null = null
        let longitude: number | null = null
        if ('geolocation' in navigator) {
          try {
            const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
              navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000, enableHighAccuracy: true })
            )
            latitude = pos.coords.latitude
            longitude = pos.coords.longitude
          } catch { /* пользователь отказал — отправим без координат, уйдёт в Pending */ }
        }
        await ssApiRequest('/api/self-service/requests', {
          method: 'POST',
          body: JSON.stringify({
            type: selectedType,
            requestedTimeUtc: d.toISOString(),
            requestedEndTimeUtc: null,
            comment: reqComment || null,
            latitude,
            longitude,
          }),
        })
      } else if (selectedType === 'HourlyAbsence') {
        // Почасовая отлучка: дата + интервал HH:MM. Уходит как Absence с обоими временами,
        // после одобрения бэкенд создаёт AttendancePermission и вычитает часы из отчёта.
        const day = reqDateTime.slice(0, 10)
        const mFrom = permFrom.match(/^([01][0-9]|2[0-3]):([0-5][0-9])$/)
        const mTo = permTo.match(/^([01][0-9]|2[0-3]):([0-5][0-9])$/)
        if (!day || !mFrom || !mTo) {
          setSubmitError(t('selfService.enterTimeHHMM'))
          setSubmitting(false)
          return
        }
        const start = new Date(`${day}T00:00:00`)
        start.setHours(parseInt(mFrom[1], 10), parseInt(mFrom[2], 10), 0, 0)
        const end = new Date(`${day}T00:00:00`)
        end.setHours(parseInt(mTo[1], 10), parseInt(mTo[2], 10), 0, 0)
        if (end <= start) {
          setSubmitError(t('selfService.permissionEndBeforeStart'))
          setSubmitting(false)
          return
        }
        await ssApiRequest('/api/self-service/requests', {
          method: 'POST',
          body: JSON.stringify({
            type: 'Absence',
            requestedTimeUtc: start.toISOString(),
            requestedEndTimeUtc: end.toISOString(),
            comment: reqComment || null,
          }),
        })
      } else {
        // Отпуск (Vacation) / отгул (Absence → DayOff) — это leave (EmployeeLeave),
        // чтобы после одобрения он отображался в отчётах как "в отпуске"/"отгул".
        const startDate = reqDateTime.slice(0, 10)
        if (!startDate) { setSubmitError(t('selfService.failedSubmitRequest')); setSubmitting(false); return }
        // Отгул/отсутствие — всегда одна дата; отпуск — диапазон.
        const endDate = selectedType === 'Vacation' ? (reqEndDateTime.slice(0, 10) || startDate) : startDate
        if (endDate < startDate) { setSubmitError(t('selfService.endBeforeStart')); setSubmitting(false); return }
        await ssApiRequest('/api/self-service/leaves', {
          method: 'POST',
          body: JSON.stringify({
            leaveType: selectedType === 'Vacation' ? 'Vacation' : 'DayOff',
            isPaid: reqIsPaid,
            startDate,
            endDate,
            reason: reqComment || null,
          }),
        })
      }
      setSubmitSuccess(true)
      await loadData()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : t('selfService.failedSubmitRequest'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleLogout = () => {
    localStorage.removeItem(SS_TOKEN_KEY)
    localStorage.removeItem('projectx.ss.user')
    navigate('/login')
  }

  // Quick action: Check-in/Check-out at current time with current location.
  // Если координаты в зоне — бэк auto-approved; иначе уйдёт в Pending.
  const [quickBusy, setQuickBusy] = useState<'CheckIn' | 'CheckOut' | null>(null)
  const [quickResult, setQuickResult] = useState<string | null>(null)

  const quickCheck = async (type: 'CheckIn' | 'CheckOut') => {
    if (quickBusy) return
    setQuickBusy(type)
    setQuickResult(null)
    try {
      let latitude: number | null = null
      let longitude: number | null = null
      if ('geolocation' in navigator) {
        try {
          const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
            navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000, enableHighAccuracy: true })
          )
          latitude = pos.coords.latitude
          longitude = pos.coords.longitude
        } catch {
          setQuickResult(t('selfService.locationDenied'))
        }
      }
      const res = await ssApiRequest<{ status: string; autoApproved?: boolean; matchedZone?: string | null }>(
        '/api/self-service/requests',
        {
          method: 'POST',
          body: JSON.stringify({
            type,
            requestedTimeUtc: new Date().toISOString(),
            requestedEndTimeUtc: null,
            comment: null,
            latitude,
            longitude,
          }),
        }
      )
      if (res.autoApproved) {
        const action = type === 'CheckIn' ? t('selfService.checkedIn') : t('selfService.checkedOut')
        const zone = res.matchedZone ?? t('selfService.verified')
        setQuickResult(`✓ ${action} (${t('selfService.zone')}: ${zone})`)
      } else {
        setQuickResult(t('selfService.sentPending'))
      }
      await loadData()
    } catch {
      setQuickResult(t('selfService.failedSendTryAgain'))
    } finally {
      setQuickBusy(null)
    }
  }

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background-light">
        <span className="spinner-ring text-5xl text-primary" aria-hidden="true" />
      </div>
    )
  }

  if (error || !me) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center bg-background-light gap-4">
        <p className="text-error-text font-bold">{error ?? t('selfService.failedToLoad')}</p>
        <Button onClick={handleLogout}>{t('selfService.signOut')}</Button>
      </div>
    )
  }

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const isLeaveType = selectedType === 'Vacation' || selectedType === 'Absence'
  const needsEndDate = selectedType === 'Vacation' // отпуск — диапазон; отгул/отсутствие — одна дата

  // "My requests" = leaves + attendance requests, newest first, paginated (5/page).
  const myItems = [
    ...leaves.map((lv) => ({ id: lv.id, kind: 'leave' as const, sort: new Date(lv.createdUtc).getTime(), leave: lv })),
    ...requests.map((r) => ({ id: r.id, kind: 'request' as const, sort: new Date(r.createdUtc).getTime(), request: r })),
  ].sort((a, b) => b.sort - a.sort)
  const myTotalPages = Math.max(1, Math.ceil(myItems.length / MY_REQUESTS_PAGE_SIZE))
  const myCurPage = Math.min(myReqPage, myTotalPages - 1)
  const myPageItems = myItems.slice(myCurPage * MY_REQUESTS_PAGE_SIZE, myCurPage * MY_REQUESTS_PAGE_SIZE + MY_REQUESTS_PAGE_SIZE)

  return (
    <div className="min-h-screen bg-background-light font-sans antialiased">
      {/* Header */}
      <div className="bg-surface border-b border-border sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Logo size={36} />
            <div>
              <p className="font-black text-text-dark text-sm">{me.firstName} {me.lastName}</p>
              <p className="text-text-light text-xs">{me.department ?? t('selfService.noDepartment')}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <select
              value={i18n.resolvedLanguage ?? i18n.language?.split('-')[0] ?? 'en'}
              onChange={(e) => { void i18n.changeLanguage(e.target.value) }}
              aria-label="Language"
              className="bg-background-light border-none rounded-lg px-2 py-1.5 text-xs font-bold text-text-dark appearance-none outline-none focus:ring-2 focus:ring-primary/20 cursor-pointer"
            >
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>{lang.flag} {lang.code.toUpperCase()}</option>
              ))}
            </select>
            <button
              onClick={() => { setPwCurrent(''); setPwNew(''); setPwConfirm(''); setPwError(null); setPwModal(true) }}
              className="flex items-center gap-1 text-text-light hover:text-primary text-xs font-bold uppercase tracking-widest transition-colors"
              title={t('selfService.changePassword')}
            >
              <span className="material-symbols-outlined text-base">key</span>
              {t('selfService.password')}
            </button>
            <button
              onClick={handleLogout}
              className="flex items-center gap-1 text-text-light hover:text-error-text text-xs font-bold uppercase tracking-widest transition-colors"
            >
              <span className="material-symbols-outlined text-base">logout</span>
              {t('selfService.signOut')}
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
        {/* Date & Schedule */}
        <div className="bg-surface rounded-2xl p-5 shadow-sm">
          <p className="text-text-light text-xs font-bold uppercase tracking-widest capitalize">{today}</p>
          {me.workSchedule && (
            <p className="text-text-dark text-sm mt-1">
              <span className="material-symbols-outlined text-sm align-middle mr-1 text-primary">schedule</span>
              {me.workSchedule.name}
            </p>
          )}
          {me.todayRecords.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {me.todayRecords.map((r) => (
                <span
                  key={r.id}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold ${
                    r.eventType === 'In' ? 'bg-green-50 text-green-700' : 'bg-blue-50 text-blue-700'
                  }`}
                >
                  <span className="material-symbols-outlined text-sm">{r.eventType === 'In' ? 'login' : 'logout'}</span>
                  {formatTime(r.eventTimeUtc)}
                </span>
              ))}
            </div>
          )}
          {me.todayRecords.length === 0 && (
            <p className="text-text-light text-xs mt-2">{t('selfService.noEventsToday')}</p>
          )}
        </div>

        {/* Quick check-in / check-out by location */}
        <div className="bg-surface rounded-2xl p-5 shadow-sm space-y-3">
          <p className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('selfService.checkByLocation')}</p>
          <p className="text-[12px] text-text-light">
            {t('selfService.checkByLocationDescription')}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Button
              type="button"
              size="lg"
              icon="login"
              isLoading={quickBusy === 'CheckIn'}
              disabled={quickBusy !== null}
              onClick={() => quickCheck('CheckIn')}
              className="rounded-2xl"
            >
              {t('selfService.checkInNow')}
            </Button>
            <Button
              type="button"
              size="lg"
              variant="outline"
              icon="logout"
              isLoading={quickBusy === 'CheckOut'}
              disabled={quickBusy !== null}
              onClick={() => quickCheck('CheckOut')}
              className="rounded-2xl"
            >
              {t('selfService.checkOutNow')}
            </Button>
          </div>
          {quickResult && (
            <p className={`text-[12px] font-bold ${quickResult.startsWith('✓') ? 'text-green-700' : 'text-amber-700'}`}>
              {quickResult}
            </p>
          )}
        </div>

        {/* Сводка за месяц: сколько отработано, отпуск, что в ожидании */}
        <SelfServiceSummary />

        {/* Уведомления сотруднику (одобрения, напоминания) */}
        <SelfServiceNotifications />

        {/* Attendance calendar (check-in/out, day-offs, vacations, absences) */}
        <SelfServiceCalendar />

        {/* Расчётные листы по утверждённым периодам */}
        <SelfServicePayslips />

        {/* Action Buttons */}
        <div>
          <p className="text-[10px] font-black text-text-light uppercase tracking-widest mb-3">{t('selfService.submitARequest')}</p>
          <div className="grid grid-cols-2 gap-3">
            {REQUEST_TYPE_CONFIG.map(({ type, icon, color }) => (
              <button
                key={type}
                onClick={() => handleOpenModal(type)}
                className={`flex flex-col items-center justify-center gap-2 p-4 rounded-2xl ${color} font-bold text-sm transition-all active:scale-95 hover:shadow-md`}
              >
                <span className="material-symbols-outlined text-3xl">{icon}</span>
                {t(`selfService.requestTypes.${type}`)}
              </button>
            ))}
          </div>
        </div>

        {/* Recent Requests */}
        <div>
          <p className="text-[10px] font-black text-text-light uppercase tracking-widest mb-3">{t('selfService.myRequests')}</p>
          {myItems.length === 0 ? (
            <div className="bg-surface rounded-2xl p-6 text-center text-text-light text-sm">
              {t('selfService.noRequestsYet')}
            </div>
          ) : (
            <>
              <div className="space-y-2">
                {myPageItems.map((it) => {
                  if (it.kind === 'leave') {
                    const lv = it.leave
                    const statusColor = STATUS_COLORS[lv.status] ?? 'text-text-light bg-background-light'
                    const statusLabel = STATUS_COLORS[lv.status] ? t(`selfService.statuses.${lv.status}`) : lv.status
                    const typeLabel = t(`selfService.requestTypes.${lv.leaveType === 'DayOff' ? 'Absence' : 'Vacation'}`)
                    const dates = lv.startDate === lv.endDate ? formatDateOnly(lv.startDate) : `${formatDateOnly(lv.startDate)} – ${formatDateOnly(lv.endDate)}`
                    return (
                      <div key={lv.id} className="bg-surface rounded-2xl p-4 shadow-sm flex items-start justify-between gap-3">
                        <div className="space-y-0.5">
                          <p className="font-bold text-text-dark text-sm">{typeLabel} · {t(lv.isPaid ? 'selfService.paid' : 'selfService.unpaid')}</p>
                          <p className="text-text-light text-xs">{dates}</p>
                          {lv.reason && <p className="text-text-light text-xs italic">"{lv.reason}"</p>}
                        </div>
                        <span className={`shrink-0 text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full ${statusColor}`}>
                          {statusLabel}
                        </span>
                      </div>
                    )
                  }
                  const r = it.request
                  const statusColor = STATUS_COLORS[r.status] ?? 'text-text-light bg-background-light'
                  const statusLabel = STATUS_COLORS[r.status] ? t(`selfService.statuses.${r.status}`) : r.status
                  // Absence с концом интервала — почасовая отлучка: показываем «дата, с–до».
                  const isHourly = r.type === 'Absence' && !!r.requestedEndTimeUtc
                  const uiType = isHourly ? 'HourlyAbsence' : r.type
                  const typeLabel = REQUEST_TYPE_CONFIG.find((c) => c.type === uiType) ? t(`selfService.requestTypes.${uiType}`) : r.type
                  return (
                    <div key={r.id} className="bg-surface rounded-2xl p-4 shadow-sm flex items-start justify-between gap-3">
                      <div className="space-y-0.5">
                        <p className="font-bold text-text-dark text-sm">{typeLabel}</p>
                        <p className="text-text-light text-xs">
                          {isHourly
                            ? `${formatLocalDateOnly(r.requestedTimeUtc)} · ${formatTime(r.requestedTimeUtc)}–${formatTime(r.requestedEndTimeUtc!)}`
                            : formatDateTime(r.requestedTimeUtc)}
                        </p>
                        {r.comment && <p className="text-text-light text-xs italic">"{r.comment}"</p>}
                      </div>
                      <span className={`shrink-0 text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full ${statusColor}`}>
                        {statusLabel}
                      </span>
                    </div>
                  )
                })}
              </div>
              {myTotalPages > 1 && (
                <div className="flex items-center justify-between gap-2 mt-3">
                  <button
                    type="button" disabled={myCurPage === 0} onClick={() => setMyReqPage(myCurPage - 1)}
                    className="flex items-center justify-center w-9 h-9 rounded-xl bg-surface shadow-sm text-text-dark disabled:opacity-40 disabled:cursor-not-allowed hover:bg-background-light transition-colors"
                  >
                    <span className="material-symbols-outlined text-xl">chevron_left</span>
                  </button>
                  <span className="text-xs font-bold text-text-light">{myCurPage + 1} / {myTotalPages}</span>
                  <button
                    type="button" disabled={myCurPage >= myTotalPages - 1} onClick={() => setMyReqPage(myCurPage + 1)}
                    className="flex items-center justify-center w-9 h-9 rounded-xl bg-surface shadow-sm text-text-dark disabled:opacity-40 disabled:cursor-not-allowed hover:bg-background-light transition-colors"
                  >
                    <span className="material-symbols-outlined text-xl">chevron_right</span>
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Request Modal */}
      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={t('selfService.requestPrefix', { type: t(`selfService.requestTypes.${selectedType}`) })}
      >
        {submitSuccess ? (
          <div className="py-6 flex flex-col items-center gap-4 text-center">
            <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-green-500 text-4xl">check_circle</span>
            </div>
            <p className="font-bold text-text-dark">{t('selfService.requestSubmittedForReview')}</p>
            <Button onClick={() => setModalOpen(false)}>{t('common.close')}</Button>
          </div>
        ) : (
          <form onSubmit={handleSubmitRequest} className="space-y-4 pt-2">
            {selectedType === 'CheckIn' || selectedType === 'CheckOut' ? (
              <>
                <div className="space-y-1.5">
                  <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('common.date')}</label>
                  <input
                    type="date"
                    value={corrDate}
                    onChange={(e) => setCorrDate(e.target.value)}
                    required
                    className="w-full rounded-xl bg-background-light border-none px-4 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">
                    {selectedType === 'CheckIn' ? t('selfService.checkInTimeLabel') : t('selfService.checkOutTimeLabel')}
                  </label>
                  <input
                    type="text" inputMode="numeric" placeholder="HH:MM" maxLength={5}
                    value={corrCheckIn}
                    onChange={(e) => setCorrCheckIn(maskHHMM(e.target.value))}
                    required
                    className="w-full rounded-xl bg-background-light border-none px-4 py-2.5 text-sm font-bold font-mono text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                  />
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">
                    {needsEndDate ? t('selfService.startDate') : t('common.date')}
                  </label>
                  <input
                    type="date"
                    value={reqDateTime.slice(0, 10)}
                    onChange={(e) => setReqDateTime(`${e.target.value}T09:00`)}
                    required
                    className="w-full rounded-xl bg-background-light border-none px-4 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                  />
                </div>
                {needsEndDate && (
                  <div className="space-y-1.5">
                    <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('selfService.endDate')}</label>
                    <input
                      type="date"
                      value={reqEndDateTime.slice(0, 10)}
                      onChange={(e) => setReqEndDateTime(`${e.target.value}T18:00`)}
                      required
                      className="w-full rounded-xl bg-background-light border-none px-4 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                    />
                  </div>
                )}
                {selectedType === 'HourlyAbsence' && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('selfService.permissionFromTime')}</label>
                      <input
                        type="text" inputMode="numeric" placeholder="HH:MM" maxLength={5}
                        value={permFrom}
                        onChange={(e) => setPermFrom(maskHHMM(e.target.value))}
                        required
                        className="w-full rounded-xl bg-background-light border-none px-4 py-2.5 text-sm font-bold font-mono text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('selfService.permissionToTime')}</label>
                      <input
                        type="text" inputMode="numeric" placeholder="HH:MM" maxLength={5}
                        value={permTo}
                        onChange={(e) => setPermTo(maskHHMM(e.target.value))}
                        required
                        className="w-full rounded-xl bg-background-light border-none px-4 py-2.5 text-sm font-bold font-mono text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                      />
                    </div>
                  </div>
                )}
                {isLeaveType && (
                  <div className="space-y-1.5">
                    <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('selfService.paidLeave')}</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button" onClick={() => setReqIsPaid(true)}
                        className={`rounded-xl px-4 py-2.5 text-sm font-bold transition-colors ${reqIsPaid ? 'bg-primary text-white' : 'bg-background-light text-text-light'}`}
                      >{t('selfService.paid')}</button>
                      <button
                        type="button" onClick={() => setReqIsPaid(false)}
                        className={`rounded-xl px-4 py-2.5 text-sm font-bold transition-colors ${!reqIsPaid ? 'bg-primary text-white' : 'bg-background-light text-text-light'}`}
                      >{t('selfService.unpaid')}</button>
                    </div>
                  </div>
                )}
              </>
            )}
            <div className="space-y-1.5">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('selfService.commentOptional')}</label>
              <textarea
                value={reqComment}
                onChange={(e) => setReqComment(e.target.value)}
                rows={3}
                placeholder={t('selfService.reasonOrDetails')}
                className="w-full rounded-xl bg-background-light border-none px-4 py-2.5 text-sm text-text-dark focus:ring-2 focus:ring-primary/20 outline-none resize-none"
              />
            </div>
            {submitError && (
              <p className="text-red-600 text-xs font-bold bg-red-50 rounded-xl px-3 py-2">{submitError}</p>
            )}
            <Button type="submit" isLoading={submitting} fullWidth size="lg" className="rounded-2xl">
              {t('selfService.submitRequest')}
            </Button>
          </form>
        )}
      </Modal>

      <Modal
        isOpen={pwModal}
        onClose={() => {
          // При обязательной первой смене (requiresPasswordSetup=true) запрещаем закрывать.
          try {
            const u = JSON.parse(localStorage.getItem('projectx.ss.user') ?? '{}')
            if (u.requiresPasswordSetup) return
          } catch { /* ignore */ }
          setPwModal(false)
        }}
        title={(() => {
          try {
            const u = JSON.parse(localStorage.getItem('projectx.ss.user') ?? '{}')
            return u.requiresPasswordSetup ? t('selfService.setYourPassword') : t('selfService.changePassword')
          } catch { return t('selfService.changePassword') }
        })()}
      >
        <form onSubmit={submitPasswordChange} className="space-y-4 pt-2">
          {(() => {
            let mustSetup = false
            try {
              const u = JSON.parse(localStorage.getItem('projectx.ss.user') ?? '{}')
              mustSetup = !!u.requiresPasswordSetup
            } catch { /* ignore */ }
            return mustSetup ? (
              <p className="text-[12px] text-text-light">
                {t('selfService.tempPasswordNotice')}
              </p>
            ) : (
              <p className="text-[12px] text-text-light">
                {t('selfService.enterCurrentAndNew')}
              </p>
            )
          })()}
          <div className="space-y-1.5">
            <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('selfService.currentPassword')}</label>
            <input
              type="password"
              value={pwCurrent}
              onChange={(e) => setPwCurrent(e.target.value)}
              required
              className="w-full rounded-xl bg-background-light border-none px-4 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('selfService.newPassword')}</label>
            <input
              type="password"
              value={pwNew}
              onChange={(e) => setPwNew(e.target.value)}
              minLength={6}
              required
              className="w-full rounded-xl bg-background-light border-none px-4 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('selfService.confirmNewPassword')}</label>
            <input
              type="password"
              value={pwConfirm}
              onChange={(e) => setPwConfirm(e.target.value)}
              required
              className="w-full rounded-xl bg-background-light border-none px-4 py-2.5 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
            />
          </div>
          {pwError && <p className="text-error-text text-[12px] font-bold">{pwError}</p>}
          <div className="flex gap-3">
            {(() => {
              let mustSetup = false
              try {
                const u = JSON.parse(localStorage.getItem('projectx.ss.user') ?? '{}')
                mustSetup = !!u.requiresPasswordSetup
              } catch { /* ignore */ }
              return !mustSetup
                ? <Button type="button" variant="outline" fullWidth onClick={() => setPwModal(false)}>{t('common.cancel')}</Button>
                : null
            })()}
            <Button type="submit" isLoading={pwSubmitting} fullWidth size="lg" className="rounded-2xl">
              {(() => {
                let mustSetup = false
                try {
                  const u = JSON.parse(localStorage.getItem('projectx.ss.user') ?? '{}')
                  mustSetup = !!u.requiresPasswordSetup
                } catch { /* ignore */ }
                return mustSetup ? t('selfService.setPassword') : t('selfService.updatePassword')
              })()}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
