import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AppLayout } from '../../components/templates'
import { Button, Input } from '../../components/atoms'
import { PageHeader, Modal } from '../../components/organisms'
import { apiRequest, getApiBaseUrl } from '../../lib/api'
import { copyToClipboard } from '../../lib/clipboard'
import { useAuth } from '../../auth/AuthContext'
import { useModule } from '../../context/ModuleContext'

// ─── Domain types (mirror backend DTOs) ─────────────────────────────────────────
type SpaceType = 'Regular' | 'Vip' | 'Disabled'

interface Zone {
    id: string
    name: string
    code: string | null
    description: string | null
    isActive: boolean
    sortOrder: number
    floorCount: number
    spaceCount: number
}
interface Floor {
    id: string
    zoneId: string
    name: string
    level: number
    isActive: boolean
    sortOrder: number
    rowCount: number
    spaceCount: number
}
interface Row {
    id: string
    floorId: string
    name: string
    sortOrder: number
    spaceCount: number
}
interface Space {
    id: string
    rowId: string
    code: string
    type: SpaceType
    isActive: boolean
    sortOrder: number
    notes: string | null
}
interface Scheme {
    id: string
    name: string
    code: string | null
    isActive: boolean
    floors: {
        id: string
        name: string
        level: number
        isActive: boolean
        rows: { id: string; name: string; spaces: Space[] }[]
    }[]
}

/** Машина, стоящая на парковке прямо сейчас (/api/parking/live). */
interface LiveInsideRow {
    id: string
    plate: string
    enteredUtc: string
    minutes: number
    zoneName: string | null
    spaceId: string | null
    spaceCode: string | null
    spaceType: SpaceType
    cameraName: string | null
    photoUrl: string | null
    isPaid: boolean
    brand: string | null
    color: string | null
    ownerName: string | null
    holderName: string | null
    category: string | null
}
/** Событие ленты: въезд, выезд, отказ на въезде или тревога чёрного списка. */
interface LiveFeedRow {
    id: string
    kind: 'entry' | 'exit' | 'denied' | 'alarm' | 'recognition_error' | 'camera_error'
    plate: string
    atUtc: string
    zoneName: string | null
    spaceCode: string | null
    source: string | null
    /** У выезда — сколько минут простояла машина; у отказа/тревоги — текст из журнала. */
    message: string | null
}
interface Occupancy {
    commonCapacity: number
    vipCapacity: number
    commonUsed: number
    vipUsed: number
    commonFree: number
    vipFree: number
    insideTotal: number
}
interface LiveData {
    serverUtc: string
    inside: LiveInsideRow[]
    feed: LiveFeedRow[]
    occupiedSpaces: { spaceId: string; sessionId: string; plate: string; enteredUtc: string }[]
    occupancy: Occupancy
    entriesToday: number
    exitsToday: number
}
/** Кто стоит на месте: схема красит такие места и подписывает номером. */
type OccupiedMap = Map<string, { plate: string; enteredUtc: string }>

/** ANPR-камера парковки: показываем её живой картинкой в своей зоне. */
interface ParkingCamera {
    id: string
    name: string
    ipAddress: string
    zoneId: string | null
    zoneName: string | null
    direction: 'Entry' | 'Exit' | null
    barrierOutput: number | null
    status: 'Online' | 'Offline'
    /** Адрес для VLC — без логина и пароля. */
    rtspUrl: string
}

const SPACE_TYPES: SpaceType[] = ['Regular', 'Vip', 'Disabled']

// ─── AktivParking scoped restyle (page-only, prefixed .pk-*) ────────────────────
const PK_RESTYLE = `
.pk-page{--ap-acc:#6C5CE7;--ap-acc-d:#5a4bd4;--ap-acc-soft:#EEECFB;--ap-acc-softer:#F3F1FC;--ap-bg:#F6F6FB;--ap-panel:#fff;--ap-line:#ECECF3;--ap-ink:#252641;--ap-ink2:#4A4B6B;--ap-muted:#8B8CA7;--ap-shadow:0 1px 2px rgba(37,38,65,.04),0 8px 24px rgba(37,38,65,.05);background:var(--ap-bg)}
.pk-page .rounded-3xl{border-radius:16px!important}
.pk-page .rounded-2xl{border-radius:12px!important}
.pk-page .rounded-xl{border-radius:12px!important}
.pk-page .shadow-md,.pk-page .shadow-sm,.pk-page .shadow{box-shadow:var(--ap-shadow)!important}
.pk-page h2,.pk-page h3{letter-spacing:-.3px}
.pk-page table thead th{font-size:12px;letter-spacing:.4px;color:var(--ap-muted)!important}
.pk-page table tbody tr:hover{background:var(--ap-acc-softer)!important}
.pk-page input:focus,.pk-page select:focus,.pk-page textarea:focus{border-color:var(--ap-acc)!important;box-shadow:0 0 0 3px var(--ap-acc-soft)!important}
.pk-page .shadow-primary{box-shadow:0 6px 16px rgba(108,92,231,.28)!important}
/* AktivParking panel: soft shadow + hairline top accent feel */
.pk-page .ap-panel{box-shadow:var(--ap-shadow)!important;border-color:var(--ap-line)!important}
.pk-page .ap-panel:hover{box-shadow:0 2px 6px rgba(37,38,65,.05),0 12px 30px rgba(37,38,65,.07)!important}
/* Живая лента: новое событие подсвечивается, точка LIVE дышит */
@keyframes pk-flash{0%{background:#EEF2FF}100%{background:transparent}}
.pk-flash{animation:pk-flash 3.5s ease-out}
@keyframes pk-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}
.pk-live-dot{animation:pk-pulse 1.6s ease-in-out infinite}
`


const TYPE_STYLE: Record<SpaceType, { icon: string; chip: string; dot: string }> = {
    Regular: { icon: 'local_parking', chip: 'bg-slate-100 text-slate-700 border-slate-200', dot: 'bg-slate-400' },
    Vip: { icon: 'star', chip: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-400' },
    Disabled: { icon: 'accessible', chip: 'bg-blue-50 text-blue-700 border-blue-200', dot: 'bg-blue-400' },
}

/** Занятое место выбивается из цветов типа — оно должно бросаться в глаза на схеме. */
const OCCUPIED_CHIP = 'bg-rose-500 text-white border-rose-500'

const FEED_STYLE: Record<LiveFeedRow['kind'], { icon: string; chip: string }> = {
    entry: { icon: 'login', chip: 'bg-emerald-50 text-emerald-700' },
    exit: { icon: 'logout', chip: 'bg-sky-50 text-sky-700' },
    denied: { icon: 'block', chip: 'bg-orange-50 text-orange-700' },
    alarm: { icon: 'warning', chip: 'bg-red-50 text-red-700' },
    // Плохо прочитанный номер и незакрывшийся шлагбаум — не отказы, а проблемы железа.
    recognition_error: { icon: 'image_not_supported', chip: 'bg-amber-50 text-amber-700' },
    camera_error: { icon: 'videocam_off', chip: 'bg-red-50 text-red-700' },
}

const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const fmtDateTime = (iso: string) =>
    new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const fmtDur = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${Math.round(m)}m`)

/** Как часто обновляем живую картину: достаточно быстро для шлагбаума, не грузит сервер. */
const LIVE_INTERVAL_MS = 5000

/** Кадр в секунду в плитке камеры и три — в развёрнутом окне: RTSP браузер не играет,
 *  «видео» собирается из снимков, а каждый снимок — запрос к камере. */
const CAMERA_TILE_MS = 1000
const CAMERA_FULL_MS = 350

const DIRECTION_STYLE: Record<'Entry' | 'Exit', { icon: string; chip: string }> = {
    Entry: { icon: 'login', chip: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    Exit: { icon: 'logout', chip: 'bg-sky-50 text-sky-700 border-sky-200' },
}

/** Уровни распознавания: готовый список процентов вместо поля ввода — порог выбирают
 *  на глаз по журналу отбраковок, а не подбирают дробью. 0 — проверку не делать. */
const CONFIDENCE_LEVELS = [0, 50, 60, 70, 75, 80, 85, 90, 95]

/** Настройка хранится долей 0..1, но переживает и запись процентом — читаем оба вида. */
const toPercent = (raw: string | null) => {
    const v = Number(raw)
    if (!Number.isFinite(v) || v <= 0) return 0
    return Math.min(100, Math.round(v > 1 ? v : v * 100))
}

export function ParkingManagementPage() {
    const { t } = useTranslation()
    const { token } = useAuth()

    // Схема всегда на виду; настройки и структура открываются шестерёнкой.
    const [manageOpen, setManageOpen] = useState(false)
    // Режим работы (платный/бесплатный) берём из общего контекста — он же питает сайдбар,
    // поэтому страница и меню всегда показывают одно и то же. Меняется в служебном окне.
    const { parkingPaid } = useModule()
    const parkingMode: 'Paid' | 'Free' = parkingPaid ? 'Paid' : 'Free'
    // Pulsuz alt-rejim: List (İcazə siyahısı) / Capacity (Tutum)
    const [freeSubMode, setFreeSubMode] = useState<'List' | 'Capacity'>('Capacity')
    // Подрежим выезда внутри «по белому списку»: Session — выпускаем только тех, кто числится
    // внутри; List — выпускаем по списку, факт въезда не проверяется.
    const [listExitMode, setListExitMode] = useState<'Session' | 'List'>('Session')
    // Режим проезда: обе стороны на камерах или только въезд, а выезд закрывает оператор.
    const [flowMode, setFlowMode] = useState<'EntryExit' | 'EntryOnly'>('EntryExit')
    // Платный режим: сколько минут даётся на выезд после оплаты (parking.exitGraceMinutes).
    const [exitGraceMinutes, setExitGraceMinutes] = useState('15')
    // Фильтр качества распознавания: по обрывку номера шлагбаум открываться не должен.
    // Порог показываем процентами (сервер хранит долю 0..1) — оператору «80%» понятнее, чем «0.8».
    const [minConfidencePct, setMinConfidencePct] = useState(0)
    const [requireConfidence, setRequireConfidence] = useState(false)
    const [minPlateLength, setMinPlateLength] = useState('5')
    const [platePattern, setPlatePattern] = useState('')
    const [allowReentry, setAllowReentry] = useState(false)
    // Живая картина парковки: опрашиваем раз в LIVE_INTERVAL, отсюда же берём занятость мест.
    const [live, setLive] = useState<LiveData | null>(null)
    const [liveOffline, setLiveOffline] = useState(false)
    const occupancy = live?.occupancy ?? null
    const [cameras, setCameras] = useState<ParkingCamera[]>([])
    const [zones, setZones] = useState<Zone[]>([])
    const [floors, setFloors] = useState<Floor[]>([])
    const [rows, setRows] = useState<Row[]>([])
    const [spacesByRow, setSpacesByRow] = useState<Record<string, Space[]>>({})
    const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null)
    const [selectedFloorId, setSelectedFloorId] = useState<string | null>(null)
    const [loadingZones, setLoadingZones] = useState(false)
    const [scheme, setScheme] = useState<Scheme | null>(null)
    const [loadingScheme, setLoadingScheme] = useState(false)

    const selectedZone = zones.find((z) => z.id === selectedZoneId) ?? null
    const selectedFloor = floors.find((f) => f.id === selectedFloorId) ?? null

    // ─── Loaders ───
    const loadZones = async () => {
        if (!token) return
        setLoadingZones(true)
        try {
            const z = await apiRequest<Zone[]>('/api/parking/zones', { token })
            setZones(z)
            setSelectedZoneId((cur) => cur && z.some((x) => x.id === cur) ? cur : (z[0]?.id ?? null))
        } finally { setLoadingZones(false) }
    }
    const loadFloors = async (zoneId: string) => {
        if (!token) return
        const f = await apiRequest<Floor[]>(`/api/parking/zones/${zoneId}/floors`, { token })
        setFloors(f)
        setSelectedFloorId((cur) => cur && f.some((x) => x.id === cur) ? cur : (f[0]?.id ?? null))
    }
    const loadRows = async (floorId: string) => {
        if (!token) return
        const r = await apiRequest<Row[]>(`/api/parking/floors/${floorId}/rows`, { token })
        setRows(r)
        const entries = await Promise.all(
            r.map(async (row) => [row.id, await apiRequest<Space[]>(`/api/parking/rows/${row.id}/spaces`, { token })] as const),
        )
        setSpacesByRow(Object.fromEntries(entries))
    }
    const loadScheme = async (zoneId: string) => {
        if (!token) return
        setLoadingScheme(true)
        try { setScheme(await apiRequest<Scheme>(`/api/parking/zones/${zoneId}/scheme`, { token })) }
        finally { setLoadingScheme(false) }
    }

    useEffect(() => { void loadZones() }, [token])
    // Alt-rejim + tanınma parametrləri + kameralar
    useEffect(() => {
        if (!token) return
        apiRequest<{ key: string; value: string }>('/api/system-settings/parking.freeSubMode', { token })
            .then((r) => { if (r?.value === 'List' || r?.value === 'Capacity') setFreeSubMode(r.value) })
            .catch(() => { })
        apiRequest<{ key: string; value: string }>('/api/system-settings/parking.exitGraceMinutes', { token })
            .then((r) => { if (r?.value) setExitGraceMinutes(r.value) }).catch(() => { /* нет ключа — остаётся 15 */ })
        // Настройки распознавания читаем одним списком: ключей несколько, а запрос дешевле.
        apiRequest<{ key: string; value: string | null }[]>('/api/system-settings', { token })
            .then((all) => {
                const get = (k: string) => all.find((x) => x.key === k)?.value ?? null
                setMinConfidencePct(toPercent(get('parking.minPlateConfidence')))
                const len = get('parking.minPlateLength'); if (len) setMinPlateLength(len)
                const pat = get('parking.platePattern'); if (pat) setPlatePattern(pat)
                setAllowReentry(get('parking.allowReentryWhileInside') === 'true')
                setRequireConfidence(get('parking.requireConfidence') === 'true')
                setFlowMode(get('parking.flowMode') === 'EntryOnly' ? 'EntryOnly' : 'EntryExit')
                setListExitMode(get('parking.listExitMode') === 'List' ? 'List' : 'Session')
            })
            .catch(() => { /* значения по умолчанию совпадают с серверными */ })
        // Камеры меняются редко — читаем один раз, статус онлайн приходит вместе со списком.
        apiRequest<ParkingCamera[]>('/api/parking/cameras', { token }).then(setCameras).catch(() => { })
    }, [token])

    // ─── Живой мониторинг ───
    // Опрос вместо push: страница смотрит на парковку, пока открыта, и не держит соединение,
    // когда вкладка спрятана.
    const refreshLive = () => apiRequest<LiveData>('/api/parking/live', { token })
        .then((d) => { setLive(d); setLiveOffline(false) })
        .catch(() => { /* следующий тик покажет состояние */ })

    useEffect(() => {
        if (!token) return
        let stopped = false
        const tick = async () => {
            if (document.hidden) return
            try {
                const d = await apiRequest<LiveData>('/api/parking/live', { token })
                if (!stopped) { setLive(d); setLiveOffline(false) }
            } catch {
                if (!stopped) setLiveOffline(true)
            }
        }
        void tick()
        const timer = window.setInterval(() => void tick(), LIVE_INTERVAL_MS)
        const onVisibility = () => { if (!document.hidden) void tick() }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
            stopped = true
            window.clearInterval(timer)
            document.removeEventListener('visibilitychange', onVisibility)
        }
    }, [token])

    const occupiedSpaces: OccupiedMap = useMemo(() => {
        const map: OccupiedMap = new Map()
        for (const o of live?.occupiedSpaces ?? []) map.set(o.spaceId, { plate: o.plate, enteredUtc: o.enteredUtc })
        return map
    }, [live])

    const saveFreeSetting = async (key: string, value: string) => {
        try { await apiRequest('/api/system-settings', { method: 'POST', token, body: JSON.stringify({ key, value: value.trim() }) }) }
        catch { /* ignore */ }
    }
    const changeFreeSubMode = async (m: 'List' | 'Capacity') => {
        if (m === freeSubMode) return
        const prev = freeSubMode
        setFreeSubMode(m)
        try { await apiRequest('/api/system-settings', { method: 'POST', token, body: JSON.stringify({ key: 'parking.freeSubMode', value: m }) }) }
        catch { setFreeSubMode(prev) }
    }
    const changeListExitMode = async (m: 'Session' | 'List') => {
        if (m === listExitMode) return
        const prev = listExitMode
        setListExitMode(m)
        try { await apiRequest('/api/system-settings', { method: 'POST', token, body: JSON.stringify({ key: 'parking.listExitMode', value: m }) }) }
        catch { setListExitMode(prev) }
    }
    useEffect(() => {
        if (!selectedZoneId) { setFloors([]); setSelectedFloorId(null); return }
        void loadFloors(selectedZoneId)
    }, [selectedZoneId, token])
    useEffect(() => {
        if (!selectedFloorId) { setRows([]); setSpacesByRow({}); return }
        void loadRows(selectedFloorId)
    }, [selectedFloorId, token])
    useEffect(() => {
        if (selectedZoneId) void loadScheme(selectedZoneId)
    }, [selectedZoneId, token])

    // ─── Modal state ───
    const [zoneModal, setZoneModal] = useState<{ mode: 'create' | 'edit'; data: Zone | null } | null>(null)
    const [floorModal, setFloorModal] = useState<{ mode: 'create' | 'edit'; data: Floor | null } | null>(null)
    const [rowModal, setRowModal] = useState<{ mode: 'create' | 'edit'; data: Row | null } | null>(null)
    const [spaceModal, setSpaceModal] = useState<{ rowId: string; data: Space | null } | null>(null)
    const [bulkRowId, setBulkRowId] = useState<string | null>(null)
    const [confirm, setConfirm] = useState<{ label: string; onConfirm: () => Promise<void> } | null>(null)

    const refreshAfterChange = async () => {
        await loadZones()
        if (selectedZoneId) await loadFloors(selectedZoneId)
        if (selectedFloorId) await loadRows(selectedFloorId)
        if (selectedZoneId) await loadScheme(selectedZoneId)
    }

    const del = (label: string, path: string) => setConfirm({
        label,
        onConfirm: async () => {
            await apiRequest(path, { method: 'DELETE', token })
            await refreshAfterChange()
        },
    })

    return (
        <AppLayout>
            <style>{PK_RESTYLE}</style>
            <div className="pk-page flex-1 overflow-y-auto bg-background-light pb-20 md:pb-0">
                <div className="p-6 md:p-10 space-y-6">
                    <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
                        <PageHeader
                            className="p-0 border-none shadow-none bg-transparent"
                            title={t('parking.nav.management')}
                            description={t('parking.subtitle')}
                        />
                        {/* Настройки и структура парковки живут под шестерёнкой — на странице только схема. */}
                        <Button icon="settings" variant="outline" onClick={() => setManageOpen(true)}>
                            {t('parking.manageTitle')}
                        </Button>
                    </div>

                    {/* Живой мониторинг: кто внутри и кто только что проехал. */}
                    <LiveMonitor live={live} offline={liveOffline} token={token} onChanged={refreshLive} />

                    {loadingZones ? (
                        <Spinner />
                    ) : zones.length === 0 ? (
                        <EmptyState icon="local_parking" text={t('parking.zones.empty')}
                            action={<Button icon="add" variant="outline" onClick={() => setZoneModal({ mode: 'create', data: null })}>{t('parking.zones.new')}</Button>} />
                    ) : (
                        <>
                            <SchemeView
                                zones={zones}
                                selectedZoneId={selectedZoneId}
                                onSelectZone={setSelectedZoneId}
                                scheme={scheme}
                                loading={loadingScheme}
                                occupied={occupiedSpaces}
                            />
                            {/* Камеры выбранной зоны: въезд и выезд рядом со схемой этой же зоны. */}
                            <CameraWall cameras={cameras} zoneId={selectedZoneId} token={token} />
                        </>
                    )}

                    <TypeLegend />
                </div>
            </div>

            {/* ─── Управление парковкой: настройки и структура ─── */}
            {manageOpen && (
                <Modal isOpen size="xl" title={t('parking.manageTitle')} onClose={() => setManageOpen(false)}
                    actions={<Button icon="add" size="sm" onClick={() => setZoneModal({ mode: 'create', data: null })}>{t('parking.zones.new')}</Button>}>
                    <div className="pk-page space-y-6 bg-transparent">
                    {/* Режим работы (платный/бесплатный) переключается в служебном меню
                        активации модулей — здесь только показываем текущий. */}
                    <div className="ap-panel flex items-start gap-3 rounded-2xl border border-border-base bg-surface p-5">
                        <span className="material-symbols-outlined text-2xl text-primary">{parkingMode === 'Paid' ? 'paid' : 'money_off'}</span>
                        <div>
                            <div className="text-sm font-bold text-text-dark">
                                {t('parking.modeTitle')}: {t(parkingMode === 'Paid' ? 'moduleActivation.parkingPaid' : 'moduleActivation.parkingFree')}
                            </div>
                            <div className="mt-0.5 text-xs text-text-muted">
                                {t(parkingMode === 'Paid' ? 'moduleActivation.parkingPaidHint' : 'moduleActivation.parkingFreeHint')}
                            </div>
                        </div>
                    </div>

                    {/* Giriş məntiqi: alt-rejim + tutum + nömrə siyahıları */}
                    <div className="ap-panel space-y-5 rounded-2xl border border-border-base bg-surface p-5">
                        {/* Режим проезда не зависит от платности: он про то, кто закрывает сессию —
                            выездная камера или оператор. */}
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                                <div className="text-sm font-bold text-text-dark">{t('parking.cfg.flowMode')}</div>
                                <div className="mt-0.5 text-xs text-text-muted">
                                    {t(flowMode === 'EntryOnly' ? 'parking.cfg.flowEntryOnlyHint' : 'parking.cfg.flowEntryExitHint')}
                                </div>
                            </div>
                            <div className="inline-flex shrink-0 rounded-xl border border-border-base bg-slate-75 p-1">
                                {(['EntryExit', 'EntryOnly'] as const).map((m) => (
                                    <button key={m} type="button"
                                        onClick={() => {
                                            if (m === flowMode) return
                                            const prev = flowMode
                                            setFlowMode(m)
                                            void saveFreeSetting('parking.flowMode', m).catch(() => setFlowMode(prev))
                                        }}
                                        className={`rounded-lg px-4 py-2 text-xs font-bold transition-colors ${flowMode === m ? 'bg-primary text-white shadow-primary' : 'text-text-muted hover:text-text-dark'}`}>
                                        {t(m === 'EntryExit' ? 'parking.cfg.flowEntryExit' : 'parking.cfg.flowEntryOnly')}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {parkingMode === 'Free' && (
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                    <div className="text-sm font-bold text-text-dark">{t('parking.cfg.freeSubMode')}</div>
                                    <div className="mt-0.5 text-xs text-text-muted">
                                        {freeSubMode === 'List'
                                            ? t('parking.cfg.subModeListHint')
                                            : t('parking.cfg.subModeCapacityHint')}
                                    </div>
                                </div>
                                <div className="inline-flex shrink-0 rounded-xl border border-border-base bg-slate-75 p-1">
                                    {(['List', 'Capacity'] as const).map((m) => (
                                        <button key={m} type="button" onClick={() => changeFreeSubMode(m)}
                                            className={`rounded-lg px-4 py-2 text-xs font-bold transition-colors ${freeSubMode === m ? 'bg-primary text-white shadow-primary' : 'text-text-muted hover:text-text-dark'}`}>
                                            {t(m === 'List' ? 'parking.cfg.subModeList' : 'parking.cfg.subModeCapacity')}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Подрежим выезда живёт только внутри «по белому списку»: в режиме
                            «по местам» выпускать без сессии нельзя — иначе счётчик занятости поедет. */}
                        {parkingMode === 'Free' && freeSubMode === 'List' && (
                            <div className="flex flex-col gap-3 rounded-xl border border-border-base p-3 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                    <div className="text-sm font-bold text-text-dark">{t('parking.cfg.listExitMode')}</div>
                                    <div className="mt-0.5 text-xs text-text-muted">
                                        {listExitMode === 'List'
                                            ? t('parking.cfg.listExitListHint')
                                            : t('parking.cfg.listExitSessionHint')}
                                    </div>
                                </div>
                                <div className="inline-flex shrink-0 rounded-xl border border-border-base bg-slate-75 p-1">
                                    {(['Session', 'List'] as const).map((m) => (
                                        <button key={m} type="button" onClick={() => void changeListExitMode(m)}
                                            className={`rounded-lg px-4 py-2 text-xs font-bold transition-colors ${listExitMode === m ? 'bg-primary text-white shadow-primary' : 'text-text-muted hover:text-text-dark'}`}>
                                            {t(m === 'Session' ? 'parking.cfg.listExitSession' : 'parking.cfg.listExitList')}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Общих числовых настроек у бесплатного режима нет: лимит стоянки
                            задаётся точечно у номера в белом списке (поле «Лимит, мин»). */}

                        {/* Платный режим: сколько минут даётся на выезд после оплаты. */}
                        {parkingMode === 'Paid' && (
                            <div className="rounded-xl border border-border-base p-3 sm:max-w-md">
                                <div className="text-xs text-text-muted mb-1.5">{t('parking.cfg.exitGrace')}</div>
                                <input type="number" min={0}
                                    className="w-full rounded-lg border border-border-base bg-surface px-3 py-2 text-sm text-text-dark"
                                    value={exitGraceMinutes}
                                    onChange={(e) => setExitGraceMinutes(e.target.value)}
                                    onBlur={() => void saveFreeSetting('parking.exitGraceMinutes', exitGraceMinutes || '0')} />
                                <div className="mt-1.5 text-[11px] leading-relaxed text-text-light">{t('parking.cfg.exitGraceHint')}</div>
                            </div>
                        )}

                        {/* Фильтр распознавания: что считать пригодным номером, прежде чем
                            открывать шлагбаум. Отбракованные кадры видны в ленте и в журнале. */}
                        <div className="rounded-xl border border-border-base p-3 space-y-3">
                            <div>
                                <div className="text-sm font-bold text-text-dark">{t('parking.cfg.recognition')}</div>
                                <div className="mt-0.5 text-xs text-text-muted">{t('parking.cfg.recognitionHint')}</div>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-3">
                                <div>
                                    <div className="text-xs text-text-muted mb-1.5">{t('parking.cfg.minConfidence')}</div>
                                    <select
                                        className="w-full rounded-lg border border-border-base bg-surface px-3 py-2 text-sm text-text-dark"
                                        value={minConfidencePct}
                                        onChange={(e) => {
                                            const pct = Number(e.target.value)
                                            setMinConfidencePct(pct)
                                            // Сервер ждёт долю 0..1: 80% → 0.8, «выкл» → 0.
                                            void saveFreeSetting('parking.minPlateConfidence', String(pct / 100))
                                        }}>
                                        {CONFIDENCE_LEVELS.map((pct) => (
                                            <option key={pct} value={pct}>
                                                {pct === 0 ? t('parking.cfg.confidenceOff') : `${pct}%`}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <div className="text-xs text-text-muted mb-1.5">{t('parking.cfg.minPlateLength')}</div>
                                    <input type="number" min={0} max={16}
                                        className="w-full rounded-lg border border-border-base bg-surface px-3 py-2 text-sm text-text-dark"
                                        value={minPlateLength}
                                        onChange={(e) => setMinPlateLength(e.target.value)}
                                        onBlur={() => void saveFreeSetting('parking.minPlateLength', minPlateLength || '0')} />
                                </div>
                                <div>
                                    <div className="text-xs text-text-muted mb-1.5">{t('parking.cfg.platePattern')}</div>
                                    <input type="text" placeholder="^\d{2}[A-Z]{2}\d{3}$"
                                        className="w-full rounded-lg border border-border-base bg-surface px-3 py-2 font-mono text-sm text-text-dark"
                                        value={platePattern}
                                        onChange={(e) => setPlatePattern(e.target.value)}
                                        onBlur={() => void saveFreeSetting('parking.platePattern', platePattern)} />
                                </div>
                            </div>
                            <div className="text-[11px] leading-relaxed text-text-light">{t('parking.cfg.minConfidenceHint')}</div>
                            <div className="text-[11px] leading-relaxed text-text-light">{t('parking.cfg.platePatternHint')}</div>
                            {/* Правило имеет смысл только при включённом пороге: без порога процент
                                камеры вообще не смотрится. */}
                            {minConfidencePct > 0 && (
                                <label className="flex cursor-pointer items-start gap-2">
                                    <input type="checkbox" checked={requireConfidence}
                                        onChange={(e) => {
                                            setRequireConfidence(e.target.checked)
                                            void saveFreeSetting('parking.requireConfidence', String(e.target.checked))
                                        }}
                                        className="mt-0.5 h-4 w-4 rounded border-border-light text-primary focus:ring-primary/30" />
                                    <span>
                                        <span className="block text-sm font-bold text-text-dark">{t('parking.cfg.requireConfidence')}</span>
                                        <span className="block text-[11px] text-text-muted">{t('parking.cfg.requireConfidenceHint')}</span>
                                    </span>
                                </label>
                            )}
                            <label className="flex cursor-pointer items-start gap-2">
                                <input type="checkbox" checked={allowReentry}
                                    onChange={(e) => {
                                        setAllowReentry(e.target.checked)
                                        void saveFreeSetting('parking.allowReentryWhileInside', String(e.target.checked))
                                    }}
                                    className="mt-0.5 h-4 w-4 rounded border-border-light text-primary focus:ring-primary/30" />
                                <span>
                                    <span className="block text-sm font-bold text-text-dark">{t('parking.cfg.allowReentry')}</span>
                                    <span className="block text-[11px] text-text-muted">{t('parking.cfg.allowReentryHint')}</span>
                                </span>
                            </label>
                        </div>

                        {occupancy && (
                            <div className="grid grid-cols-2 gap-3">
                                <div className="rounded-xl border border-border-base p-3">
                                    <div className="text-xs text-text-muted">{t('parking.cfg.commonSpaces')}</div>
                                    <div className="text-lg font-extrabold text-text-dark">{occupancy.commonFree}<span className="text-sm font-medium text-text-muted"> / {occupancy.commonCapacity}</span></div>
                                </div>
                                <div className="rounded-xl border border-border-base p-3">
                                    <div className="text-xs text-text-muted">{t('parking.cfg.vipSpaces')}</div>
                                    <div className="text-lg font-extrabold text-text-dark">{occupancy.vipFree}<span className="text-sm font-medium text-text-muted"> / {occupancy.vipCapacity}</span></div>
                                </div>
                            </div>
                        )}

                        {/* Чёрный список и владельцы мест живут на своих страницах: в служебном
                            окне остаются только настройки парковки и её структура. */}
                    </div>

                    {/* Структура: зоны → этажи → ряды → места */}
                    {loadingZones ? (
                        <Spinner />
                    ) : zones.length === 0 ? (
                        <EmptyState icon="local_parking" text={t('parking.zones.empty')}
                            action={<Button icon="add" variant="outline" onClick={() => setZoneModal({ mode: 'create', data: null })}>{t('parking.zones.new')}</Button>} />
                    ) : (
                        <div className="grid gap-5 lg:grid-cols-[260px_260px_1fr]">
                            {/* Column 1 — Zones */}
                            <Panel title={t('parking.zones.title')} count={zones.length}>
                                {zones.map((z) => (
                                    <ListRow key={z.id} active={z.id === selectedZoneId} onClick={() => setSelectedZoneId(z.id)}
                                        title={z.name} subtitle={`${z.code ? z.code + ' · ' : ''}${t('parking.zones.spaceCount', { count: z.spaceCount })}`}
                                        inactive={!z.isActive}
                                        onEdit={() => setZoneModal({ mode: 'edit', data: z })}
                                        onDelete={() => del(z.name, `/api/parking/zones/${z.id}`)} />
                                ))}
                            </Panel>

                            {/* Column 2 — Floors */}
                            <Panel
                                title={t('parking.floors.title')}
                                count={floors.length}
                                action={selectedZone && (
                                    <IconButton icon="add" title={t('parking.floors.new')} onClick={() => setFloorModal({ mode: 'create', data: null })} />
                                )}
                            >
                                {!selectedZone ? (
                                    <Hint text={t('parking.floors.selectZone')} />
                                ) : floors.length === 0 ? (
                                    <Hint text={t('parking.floors.empty')} />
                                ) : floors.map((f) => (
                                    <ListRow key={f.id} active={f.id === selectedFloorId} onClick={() => setSelectedFloorId(f.id)}
                                        title={`${t('parking.floors.level')} ${f.level}`} subtitle={t('parking.zones.spaceCount', { count: f.spaceCount })}
                                        inactive={!f.isActive}
                                        onEdit={() => setFloorModal({ mode: 'edit', data: f })}
                                        onDelete={() => del(f.name, `/api/parking/floors/${f.id}`)} />
                                ))}
                            </Panel>

                            {/* Column 3 — Rows + spaces */}
                            <Panel
                                title={t('parking.rows.title')}
                                count={rows.length}
                                action={selectedFloor && (
                                    <IconButton icon="add" title={t('parking.rows.new')} onClick={() => setRowModal({ mode: 'create', data: null })} />
                                )}
                            >
                                {!selectedFloor ? (
                                    <Hint text={t('parking.rows.selectFloor')} />
                                ) : rows.length === 0 ? (
                                    <Hint text={t('parking.rows.empty')} />
                                ) : (
                                    <div className="space-y-4">
                                        {rows.map((row) => (
                                            <div key={row.id} className="rounded-2xl border border-border-light bg-surface p-4">
                                                <div className="flex items-center justify-between gap-2">
                                                    <div className="flex items-center gap-2 min-w-0">
                                                        <span className="material-symbols-outlined text-[18px] text-text-light">table_rows</span>
                                                        <span className="truncate text-sm font-black text-text-dark">{row.name}</span>
                                                        <span className="text-[10px] font-bold text-text-light">· {t('parking.zones.spaceCount', { count: spacesByRow[row.id]?.length ?? 0 })}</span>
                                                    </div>
                                                    <div className="flex shrink-0 items-center gap-1">
                                                        {/* Места заводятся только пачкой: по одному добавлять неудобно и незачем. */}
                                                        <IconButton icon="grid_on" title={t('parking.spaces.bulk')} onClick={() => setBulkRowId(row.id)} />
                                                        <IconButton icon="edit" title={t('common.edit')} onClick={() => setRowModal({ mode: 'edit', data: row })} />
                                                        <IconButton icon="delete" title={t('common.delete')} danger onClick={() => del(row.name, `/api/parking/rows/${row.id}`)} />
                                                    </div>
                                                </div>
                                                <div className="mt-3 flex flex-wrap gap-2">
                                                    {(spacesByRow[row.id] ?? []).map((s) => {
                                                        const busy = occupiedSpaces.get(s.id)
                                                        return (
                                                            <button key={s.id} type="button"
                                                                title={busy
                                                                    ? `${s.code} · ${busy.plate} · ${fmtDateTime(busy.enteredUtc)}`
                                                                    : t(`parking.types.${s.type}`)}
                                                                onClick={() => setSpaceModal({ rowId: row.id, data: s })}
                                                                className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-bold transition-transform hover:scale-105 ${busy ? OCCUPIED_CHIP : TYPE_STYLE[s.type].chip} ${s.isActive ? '' : 'opacity-50'}`}>
                                                                <span className="material-symbols-outlined text-[15px]">
                                                                    {busy ? 'directions_car' : TYPE_STYLE[s.type].icon}
                                                                </span>
                                                                {s.code}
                                                                {busy && <span className="font-mono text-[10px] opacity-90">{busy.plate}</span>}
                                                            </button>
                                                        )
                                                    })}
                                                    {(spacesByRow[row.id]?.length ?? 0) === 0 && (
                                                        <span className="text-xs text-text-light">{t('parking.spaces.empty')}</span>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </Panel>
                        </div>
                    )}
                    </div>
                </Modal>
            )}

            {/* ─── Modals ─── */}
            {zoneModal && (
                <ZoneModal modal={zoneModal} token={token} onClose={() => setZoneModal(null)} onSaved={async () => { setZoneModal(null); await refreshAfterChange() }} />
            )}
            {floorModal && selectedZoneId && (
                <FloorModal modal={floorModal} zoneId={selectedZoneId} token={token} onClose={() => setFloorModal(null)} onSaved={async () => { setFloorModal(null); await refreshAfterChange() }} />
            )}
            {rowModal && selectedFloorId && (
                <RowModal modal={rowModal} floorId={selectedFloorId} token={token} onClose={() => setRowModal(null)} onSaved={async () => { setRowModal(null); await refreshAfterChange() }} />
            )}
            {spaceModal && (
                <SpaceModal modal={spaceModal} token={token} onClose={() => setSpaceModal(null)} onSaved={async () => { setSpaceModal(null); await refreshAfterChange() }} />
            )}
            {bulkRowId && (
                <BulkSpaceModal rowId={bulkRowId} token={token} onClose={() => setBulkRowId(null)} onSaved={async () => { setBulkRowId(null); await refreshAfterChange() }} />
            )}

            <Modal isOpen={!!confirm} onClose={() => setConfirm(null)} title={t('parking.deleteTitle')}>
                <div className="space-y-4 pt-2">
                    <p className="text-sm text-text-dark">{t('parking.deletePrefix')} <strong>{confirm?.label}</strong>? {t('parking.deleteCascade')}</p>
                    <div className="flex gap-3">
                        <Button variant="outline" fullWidth onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
                        <Button variant="danger" fullWidth onClick={async () => { const c = confirm; setConfirm(null); await c?.onConfirm() }}>{t('common.delete')}</Button>
                    </div>
                </div>
            </Modal>
        </AppLayout>
    )
}

// ─── Scheme view ────────────────────────────────────────────────────────────────
function SchemeView({ zones, selectedZoneId, onSelectZone, scheme, loading, occupied }: {
    zones: Zone[]
    selectedZoneId: string | null
    onSelectZone: (id: string) => void
    scheme: Scheme | null
    loading: boolean
    occupied: OccupiedMap
}) {
    const { t } = useTranslation()
    // Сколько мест этого этажа занято — видно, не пересчитывая плитки глазами.
    const floorBusy = (rows: { spaces: Space[] }[]) =>
        rows.reduce((n, r) => n + r.spaces.filter((s) => occupied.has(s.id)).length, 0)
    return (
        <div className="space-y-5">
            <div className="flex flex-wrap gap-2">
                {zones.map((z) => (
                    <button key={z.id} type="button" onClick={() => onSelectZone(z.id)}
                        className={`rounded-xl border px-4 py-2 text-xs font-bold transition-colors ${z.id === selectedZoneId ? 'border-primary bg-primary/10 text-primary' : 'border-border-base text-text-muted hover:bg-slate-75'}`}>
                        {z.name}
                    </button>
                ))}
            </div>

            {loading ? (
                <Spinner />
            ) : !scheme || scheme.floors.length === 0 ? (
                <EmptyState icon="grid_view" text={t('parking.scheme.empty')} />
            ) : (
                <div className="space-y-6">
                    {scheme.floors.map((f) => {
                        const total = f.rows.reduce((n, r) => n + r.spaces.length, 0)
                        const busy = floorBusy(f.rows)
                        return (
                        <div key={f.id} className="ap-panel rounded-3xl border border-border-base bg-surface p-6 shadow-sm transition-shadow">
                            <div className="mb-4 flex items-center gap-2">
                                <span className="material-symbols-outlined text-text-light">layers</span>
                                <h3 className="text-base font-black text-text-dark">{t('parking.floors.level')} {f.level}</h3>
                                {total > 0 && (
                                    <span className="ml-auto rounded-lg bg-slate-75 px-2.5 py-1 text-[11px] font-black text-text-muted">
                                        {t('parking.live.occupied')}: <span className={busy > 0 ? 'text-rose-600' : ''}>{busy}</span> / {total}
                                    </span>
                                )}
                            </div>
                            {f.rows.length === 0 ? (
                                <p className="text-xs text-text-light">{t('parking.rows.empty')}</p>
                            ) : (
                                <div className="space-y-3">
                                    {f.rows.map((row) => (
                                        <div key={row.id} className="flex items-start gap-3">
                                            <div className="w-16 shrink-0 pt-2 text-[10px] font-black uppercase tracking-widest text-text-light">{row.name}</div>
                                            <div className="flex flex-wrap gap-1.5">
                                                {row.spaces.map((s) => {
                                                    const busySpace = occupied.get(s.id)
                                                    return (
                                                        <span key={s.id}
                                                            title={busySpace
                                                                ? `${s.code} · ${busySpace.plate} · ${t('parking.ap.entered')}: ${fmtDateTime(busySpace.enteredUtc)}`
                                                                : `${s.code} · ${t(`parking.types.${s.type}`)} · ${t('parking.live.free')}`}
                                                            className={`flex h-12 w-16 flex-col items-center justify-center rounded-lg border text-[10px] font-bold transition-colors ${busySpace ? OCCUPIED_CHIP : TYPE_STYLE[s.type].chip} ${s.isActive ? '' : 'opacity-40 line-through'}`}>
                                                            {busySpace ? (
                                                                <>
                                                                    <span className="truncate max-w-[56px] font-mono text-[9px] leading-tight">{busySpace.plate}</span>
                                                                    <span className="truncate max-w-[56px] text-[9px] opacity-80">{s.code}</span>
                                                                </>
                                                            ) : (
                                                                <>
                                                                    <span className="material-symbols-outlined text-[16px]">{TYPE_STYLE[s.type].icon}</span>
                                                                    <span className="truncate max-w-[56px]">{s.code}</span>
                                                                </>
                                                            )}
                                                        </span>
                                                    )
                                                })}
                                                {row.spaces.length === 0 && <span className="py-2 text-xs text-text-light">{t('parking.spaces.empty')}</span>}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                        )
                    })}
                </div>
            )}
        </div>
    )
}

// ─── Камеры зоны ────────────────────────────────────────────────────────────────
/**
 * Стена камер выбранной зоны: въезд слева, выезд справа, камеры без зоны — в конце
 * (обычно так и остаётся единственная камера на маленькой парковке).
 */
function CameraWall({ cameras, zoneId, token }: { cameras: ParkingCamera[]; zoneId: string | null; token: string | null }) {
    const { t } = useTranslation()
    const [full, setFull] = useState<ParkingCamera | null>(null)

    const shown = useMemo(() => {
        const mine = cameras.filter((c) => (zoneId ? c.zoneId === zoneId : true) || c.zoneId === null)
        const order = (c: ParkingCamera) => (c.direction === 'Entry' ? 0 : c.direction === 'Exit' ? 1 : 2)
        return [...mine].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
    }, [cameras, zoneId])

    if (cameras.length === 0) return null

    return (
        <div className="ap-panel rounded-3xl border border-border-base bg-surface p-5 shadow-sm sm:p-6">
            <div className="mb-4 flex flex-wrap items-center gap-2">
                <span className="material-symbols-outlined text-text-light">videocam</span>
                <h3 className="text-base font-black text-text-dark">{t('parking.cameras.title')}</h3>
                <span className="text-xs font-bold text-text-light">{t('parking.cameras.subtitle')}</span>
            </div>

            {shown.length === 0 ? (
                <p className="py-8 text-center text-xs text-text-light">{t('parking.cameras.emptyZone')}</p>
            ) : (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {shown.map((c) => (
                        <CameraTile key={c.id} camera={c} token={token} intervalMs={CAMERA_TILE_MS} onExpand={() => setFull(c)} />
                    ))}
                </div>
            )}

            {full && <CameraModal camera={full} token={token} onClose={() => setFull(null)} />}
        </div>
    )
}

/**
 * Живая картинка одной камеры. RTSP в браузере не играется, поэтому кадры тянем
 * по одному: запрос с токеном → blob → <img>. Прошлый blob обязательно отзываем,
 * иначе за час наблюдения вкладка съест сотни мегабайт.
 */
function CameraSnapshot({ cameraId, token, intervalMs, className }: {
    cameraId: string; token: string | null; intervalMs: number; className?: string
}) {
    const { t } = useTranslation()
    const [src, setSrc] = useState<string | null>(null)
    const [offline, setOffline] = useState(false)
    const urlRef = useRef<string | null>(null)

    useEffect(() => {
        if (!token) return
        let stopped = false
        let timer = 0

        const revoke = () => { if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null } }

        const tick = async () => {
            if (document.hidden) { schedule(); return }
            // Молчащая камера не должна подвешивать плитку: ждём кадр ограниченное время.
            const abort = new AbortController()
            const guard = window.setTimeout(() => abort.abort(), 10_000)
            try {
                const res = await fetch(`${getApiBaseUrl()}/api/parking/cameras/${cameraId}/snapshot`, {
                    headers: { Authorization: `Bearer ${token}` },
                    signal: abort.signal,
                })
                if (!res.ok) throw new Error(String(res.status))
                const blob = await res.blob()
                if (stopped) return
                const url = URL.createObjectURL(blob)
                revoke()
                urlRef.current = url
                setSrc(url)
                setOffline(false)
            } catch {
                if (!stopped) setOffline(true)
            } finally {
                window.clearTimeout(guard)
                schedule()
            }
        }
        // Следующий кадр запрашиваем только после предыдущего: медленная камера
        // не должна копить очередь запросов.
        const schedule = () => { if (!stopped) timer = window.setTimeout(() => void tick(), intervalMs) }

        void tick()
        return () => { stopped = true; window.clearTimeout(timer); revoke() }
    }, [cameraId, token, intervalMs])

    return (
        <div className={`relative flex items-center justify-center overflow-hidden bg-slate-900 ${className ?? ''}`}>
            {src ? (
                <img src={src} alt="" className="h-full w-full object-contain" />
            ) : (
                <span className="spinner-ring text-2xl text-white/60" aria-hidden="true" />
            )}
            {offline && (
                <span className="absolute inset-x-0 bottom-0 bg-red-600/90 py-1 text-center text-[10px] font-black uppercase tracking-widest text-white">
                    {t('parking.cameras.noSignal')}
                </span>
            )}
        </div>
    )
}

function CameraTile({ camera, token, intervalMs, onExpand }: {
    camera: ParkingCamera; token: string | null; intervalMs: number; onExpand: () => void
}) {
    const { t } = useTranslation()
    const dir = camera.direction ? DIRECTION_STYLE[camera.direction] : null
    return (
        <div className="overflow-hidden rounded-2xl border border-border-light">
            <button type="button" onClick={onExpand} className="block w-full cursor-pointer" title={t('parking.cameras.expand')}>
                <CameraSnapshot cameraId={camera.id} token={token} intervalMs={intervalMs} className="aspect-video w-full" />
            </button>
            <div className="flex items-center gap-2 px-3 py-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${camera.status === 'Online' ? 'bg-emerald-500' : 'bg-red-500'}`}
                    title={t(camera.status === 'Online' ? 'devicesTab.online' : 'devicesTab.offline')} />
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-text-dark">{camera.name}</span>
                    <span className="block truncate text-[11px] text-text-light">{camera.zoneName ?? t('parking.cameras.noZone')} · {camera.ipAddress}</span>
                </span>
                {dir && (
                    <span className={`shrink-0 rounded-lg border px-2 py-1 text-[10px] font-black uppercase tracking-wider ${dir.chip}`}>
                        <span className="material-symbols-outlined mr-0.5 align-middle text-[13px]">{dir.icon}</span>
                        {t(camera.direction === 'Entry' ? 'devicesTab.anpr.entry' : 'devicesTab.anpr.exit')}
                    </span>
                )}
                <BarrierOpenButton camera={camera} token={token} />
            </div>
        </div>
    )
}

/** Открыть шлагбаум этой камеры руками — машина без номера, сбой распознавания, эвакуатор. */
function BarrierOpenButton({ camera, token, wide }: { camera: ParkingCamera; token: string | null; wide?: boolean }) {
    const { t } = useTranslation()
    const [busy, setBusy] = useState(false)
    const [result, setResult] = useState<'ok' | 'skipped' | 'error' | null>(null)

    const open = async () => {
        if (!token) return
        setBusy(true); setResult(null)
        try {
            const r = await apiRequest<{ triggered: boolean; skipped: boolean }>(
                `/api/parking/cameras/${camera.id}/open`, { method: 'POST', token })
            setResult(r.triggered ? 'ok' : r.skipped ? 'skipped' : 'error')
        } catch { setResult('error') }
        finally {
            setBusy(false)
            window.setTimeout(() => setResult(null), 3000)
        }
    }

    const title = result === 'ok' ? t('parking.cameras.opened')
        : result === 'skipped' ? t('parking.pos.barrierByCamera')
            : result === 'error' ? t('parking.cameras.openFailed')
                : t('parking.cameras.open')

    return (
        <button type="button" title={title} disabled={busy} onClick={() => void open()}
            className={`flex shrink-0 items-center justify-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-black uppercase tracking-wider transition-colors disabled:opacity-50 ${
                result === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : result === 'error' ? 'border-red-200 bg-red-50 text-red-700'
                        : 'border-border-base text-text-muted hover:bg-slate-75'} ${wide ? 'px-3 py-2' : ''}`}>
            <span className="material-symbols-outlined text-[14px]">
                {busy ? 'hourglass_top' : result === 'ok' ? 'check' : 'door_open'}
            </span>
            {wide && t('parking.cameras.open')}
        </button>
    )
}

/** Развёрнутая камера: кадры чаще + адрес RTSP, чтобы открыть поток в VLC. */
function CameraModal({ camera, token, onClose }: { camera: ParkingCamera; token: string | null; onClose: () => void }) {
    const { t } = useTranslation()
    const [copied, setCopied] = useState(false)
    return (
        <Modal isOpen size="xl" title={camera.name} onClose={onClose}>
            <div className="space-y-3">
                <CameraSnapshot cameraId={camera.id} token={token} intervalMs={CAMERA_FULL_MS} className="aspect-video w-full rounded-2xl" />
                <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                    <span className={`h-2 w-2 rounded-full ${camera.status === 'Online' ? 'bg-emerald-500' : 'bg-red-500'}`} />
                    {camera.zoneName ?? t('parking.cameras.noZone')}
                    {camera.direction && <> · {t(camera.direction === 'Entry' ? 'devicesTab.anpr.entry' : 'devicesTab.anpr.exit')}</>}
                    <> · {camera.ipAddress}</>
                    <span className="ml-auto"><BarrierOpenButton camera={camera} token={token} wide /></span>
                </div>
                <div>
                    <div className="mb-1.5 text-xs text-text-muted">{t('parking.cameras.rtspHint')}</div>
                    <div className="flex gap-2">
                        <input readOnly value={camera.rtspUrl}
                            onFocus={(e) => e.currentTarget.select()}
                            className="min-w-0 flex-1 rounded-lg border border-border-base bg-slate-75 px-3 py-2 font-mono text-xs text-text-dark" />
                        <Button variant="outline" icon={copied ? 'check' : 'content_copy'}
                            onClick={() => {
                                void copyToClipboard(camera.rtspUrl).then((ok) => {
                                    if (!ok) return
                                    setCopied(true)
                                    window.setTimeout(() => setCopied(false), 2000)
                                })
                            }}>
                            {t(copied ? 'parking.cameras.copied' : 'parking.cameras.copy')}
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    )
}

// ─── Live monitor: кто внутри + лента въездов/выездов ───────────────────────────
function LiveMonitor({ live, offline, token, onChanged }: {
    live: LiveData | null; offline: boolean; token: string | null; onChanged: () => void
}) {
    const { t } = useTranslation()
    // Свежие события подсвечиваем один раз: при первой загрузке подсвечивать нечего.
    const seenRef = useRef<Set<string> | null>(null)
    const [fresh, setFresh] = useState<Set<string>>(new Set())
    // Ручное снятие машины с парковки: подтверждаем — оно закрывает сессию и считает долг.
    const [closing, setClosing] = useState<LiveInsideRow | null>(null)
    const [busy, setBusy] = useState(false)
    const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

    const closeSession = async (row: LiveInsideRow, openBarrier: boolean) => {
        if (!token) return
        setBusy(true)
        try {
            const r = await apiRequest<{ debt: number; barrierTriggered: boolean; barrierSkipped: boolean; barrierError: string | null }>(
                `/api/parking/sessions/${row.id}/close`,
                { method: 'POST', token, body: JSON.stringify({ openBarrier }) },
            )
            setNote(openBarrier && !r.barrierTriggered && !r.barrierSkipped
                ? { ok: false, text: t('parking.pos.barrierFailed', { error: r.barrierError ?? '' }) }
                : { ok: true, text: t('parking.live.removed', { plate: row.plate }) })
            setClosing(null)
            onChanged()
        } catch (e) {
            setNote({ ok: false, text: e instanceof Error ? e.message : 'error' })
        } finally { setBusy(false) }
    }

    useEffect(() => {
        if (!live) return
        const ids = live.feed.map((f) => f.id)
        if (seenRef.current === null) { seenRef.current = new Set(ids); return }
        const seen = seenRef.current
        const added = ids.filter((id) => !seen.has(id))
        // Список ленты и есть память: старые события уходят вниз и не возвращаются.
        seenRef.current = new Set(ids)
        if (added.length === 0) return
        setFresh(new Set(added))
        const timer = window.setTimeout(() => setFresh(new Set()), 3500)
        return () => window.clearTimeout(timer)
    }, [live])

    const inside = live?.inside ?? []
    const feed = live?.feed ?? []
    const occ = live?.occupancy

    /** У отказа сервер шлёт код причины — показываем его словами, если перевод есть. */
    const feedNote = (e: LiveFeedRow) =>
        e.kind === 'denied' && e.message
            ? t(`parking.pos.reason.${e.message}`, { defaultValue: e.message })
            : e.message

    return (
        <div className="ap-panel rounded-3xl border border-border-base bg-surface p-5 shadow-sm sm:p-6">
            <div className="mb-4 flex flex-wrap items-center gap-3">
                <span className="material-symbols-outlined text-text-light">sensors</span>
                <h3 className="text-base font-black text-text-dark">{t('parking.live.title')}</h3>
                <span className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[10px] font-black uppercase tracking-widest ${offline ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${offline ? 'bg-red-500' : 'pk-live-dot bg-emerald-500'}`} />
                    {offline ? t('parking.live.offline') : t('parking.live.badge')}
                </span>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                    <Stat label={t('parking.live.insideCount')} value={occ?.insideTotal ?? inside.length} />
                    <Stat label={t('parking.live.entriesToday')} value={live?.entriesToday ?? 0} />
                    <Stat label={t('parking.live.exitsToday')} value={live?.exitsToday ?? 0} />
                    {occ && <Stat label={t('parking.live.freeSpaces')} value={occ.commonFree + occ.vipFree} />}
                </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
                {/* Машины внутри — с номерами, местом и временем стоянки. */}
                <div className="rounded-2xl border border-border-light">
                    <div className="flex items-center justify-between border-b border-border-light px-4 py-2.5">
                        <p className="text-[10px] font-black uppercase tracking-widest text-text-light">{t('parking.live.insideTitle')}</p>
                        <span className="rounded-md bg-slate-75 px-2 py-0.5 text-[11px] font-black text-text-muted">{inside.length}</span>
                    </div>
                    <div className="max-h-80 divide-y divide-border-light overflow-y-auto">
                        {inside.length === 0 && <p className="px-4 py-10 text-center text-xs text-text-light">{t('parking.live.noInside')}</p>}
                        {inside.map((v) => (
                            <div key={v.id} className="flex items-center gap-3 px-4 py-2.5">
                                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-75 text-text-muted">
                                    <span className="material-symbols-outlined text-[18px]">directions_car</span>
                                </span>
                                <div className="min-w-0 flex-1">
                                    <p className="flex items-center gap-2 truncate">
                                        <span className="font-mono text-sm font-black text-text-dark">{v.plate}</span>
                                        {v.spaceCode ? (
                                            <span className="rounded-md bg-rose-50 px-1.5 py-0.5 font-mono text-[10px] font-black text-rose-600">{v.spaceCode}</span>
                                        ) : (
                                            <span className="rounded-md bg-slate-75 px-1.5 py-0.5 text-[10px] font-bold text-text-light">{t('parking.live.noSpace')}</span>
                                        )}
                                    </p>
                                    <p className="truncate text-[11px] text-text-muted">
                                        {[v.brand, v.color, v.ownerName ?? v.holderName, v.zoneName].filter(Boolean).join(' · ') || '—'}
                                    </p>
                                </div>
                                <div className="shrink-0 text-right">
                                    <p className="font-mono text-xs font-bold text-text-dark">{fmtDur(v.minutes)}</p>
                                    <p className="font-mono text-[10px] text-text-light">{fmtTime(v.enteredUtc)}</p>
                                </div>
                                {/* Снять машину руками: в режиме «только вход» это штатный способ
                                    закрыть сессию, в обычном — на случай пропущенного выезда. */}
                                <button type="button" title={t('parking.live.remove')}
                                    onClick={() => { setNote(null); setClosing(v) }}
                                    className="material-symbols-outlined shrink-0 text-[18px] text-text-light hover:text-error-text">
                                    logout
                                </button>
                            </div>
                        ))}
                    </div>
                    {note && (
                        <p className={`px-4 py-2 text-[11px] font-bold ${note.ok ? 'text-green-700' : 'text-error-text'}`}>{note.text}</p>
                    )}
                </div>

                {/* Лента: въезды, выезды и отказы по мере поступления. */}
                <div className="rounded-2xl border border-border-light">
                    <div className="flex items-center justify-between border-b border-border-light px-4 py-2.5">
                        <p className="text-[10px] font-black uppercase tracking-widest text-text-light">{t('parking.live.feedTitle')}</p>
                        <span className="text-[10px] font-bold text-text-light">{t('parking.live.last24h')}</span>
                    </div>
                    <div className="max-h-80 divide-y divide-border-light overflow-y-auto">
                        {feed.length === 0 && <p className="px-4 py-10 text-center text-xs text-text-light">{t('parking.live.noFeed')}</p>}
                        {feed.map((e) => {
                            const st = FEED_STYLE[e.kind] ?? FEED_STYLE.entry
                            return (
                                <div key={e.id} className={`flex items-center gap-3 px-4 py-2.5 ${fresh.has(e.id) ? 'pk-flash' : ''}`}>
                                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${st.chip}`}>
                                        <span className="material-symbols-outlined text-[18px]">{st.icon}</span>
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <p className="flex items-center gap-2 truncate">
                                            <span className="font-mono text-sm font-black text-text-dark">{e.plate}</span>
                                            <span className="text-[10px] font-black uppercase tracking-widest text-text-light">{t(`parking.live.kind.${e.kind}`)}</span>
                                            {e.spaceCode && <span className="font-mono text-[10px] font-bold text-text-muted">{e.spaceCode}</span>}
                                        </p>
                                        <p className="truncate text-[11px] text-text-muted">
                                            {e.kind === 'exit' && e.message
                                                ? `${t('parking.ap.duration')}: ${fmtDur(Number(e.message))}${e.source ? ` · ${e.source}` : ''}`
                                                : [e.source, e.zoneName, e.kind !== 'exit' ? feedNote(e) : null].filter(Boolean).join(' · ') || '—'}
                                        </p>
                                    </div>
                                    <span className="shrink-0 font-mono text-[11px] text-text-light">{fmtTime(e.atUtc)}</span>
                                </div>
                            )
                        })}
                    </div>
                </div>
            </div>

            {/* Снятие с парковки: два исхода — просто убрать номер или ещё и открыть шлагбаум. */}
            {closing && (
                <Modal isOpen title={t('parking.live.removeTitle', { plate: closing.plate })} onClose={() => setClosing(null)}>
                    <div className="space-y-4 pt-2">
                        <p className="text-sm text-text-dark">{t('parking.live.removeHint')}</p>
                        <div className="rounded-xl bg-slate-75 px-4 py-3 text-xs text-text-muted">
                            {t('parking.ap.entered')}: <span className="font-mono font-bold text-text-dark">{fmtDateTime(closing.enteredUtc)}</span>
                            {' · '}{t('parking.ap.duration')}: <span className="font-mono font-bold text-text-dark">{fmtDur(closing.minutes)}</span>
                            {closing.spaceCode && <> · {t('parking.live.space')}: <span className="font-mono font-bold text-text-dark">{closing.spaceCode}</span></>}
                        </div>
                        <div className="flex flex-col gap-2 sm:flex-row">
                            <Button fullWidth icon="door_open" isLoading={busy} onClick={() => void closeSession(closing, true)}>
                                {t('parking.live.removeAndOpen')}
                            </Button>
                            <Button fullWidth variant="outline" icon="delete" isLoading={busy} onClick={() => void closeSession(closing, false)}>
                                {t('parking.live.removeOnly')}
                            </Button>
                        </div>
                        <Button fullWidth variant="outline" onClick={() => setClosing(null)}>{t('common.cancel')}</Button>
                    </div>
                </Modal>
            )}
        </div>
    )
}

function Stat({ label, value }: { label: string; value: number }) {
    return (
        <span className="inline-flex items-baseline gap-1.5 rounded-xl border border-border-light px-3 py-1.5">
            <span className="text-sm font-black text-text-dark">{value}</span>
            <span className="text-[10px] font-bold uppercase tracking-wider text-text-light">{label}</span>
        </span>
    )
}

// ─── Entity modals ────────────────────────────────────────────────────────────
function ZoneModal({ modal, token, onClose, onSaved }: {
    modal: { mode: 'create' | 'edit'; data: Zone | null }; token: string | null; onClose: () => void; onSaved: () => void
}) {
    const { t } = useTranslation()
    const d = modal.data
    // Код и описание зоны не спрашиваем: на практике хватает названия.
    const [form, setForm] = useState({ name: d?.name ?? '', isActive: d?.isActive ?? true, sortOrder: d?.sortOrder ?? 0 })
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const save = async () => {
        if (!token || !form.name.trim()) return
        setSaving(true); setError(null)
        try {
            const body = JSON.stringify({ name: form.name.trim(), code: d?.code ?? null, description: d?.description ?? null, isActive: form.isActive, sortOrder: form.sortOrder })
            if (modal.mode === 'create') await apiRequest('/api/parking/zones', { method: 'POST', token, body })
            else if (d) await apiRequest(`/api/parking/zones/${d.id}`, { method: 'PUT', token, body })
            onSaved()
        } catch (e) { setError(e instanceof Error ? e.message : 'Save failed') }
        finally { setSaving(false) }
    }

    return (
        <Modal isOpen onClose={onClose} title={modal.mode === 'create' ? t('parking.zones.new') : t('parking.zones.edit')}>
            <div className="space-y-4 pt-2">
                <Field label={t('parking.zones.fields.name')}><Input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} /></Field>
                <Check label={t('parking.zones.fields.active')} checked={form.isActive} onChange={(v) => setForm((p) => ({ ...p, isActive: v }))} />
                {error && <p className="text-xs font-medium text-error-text">{error}</p>}
                <ModalActions saving={saving} disabled={!form.name.trim()} mode={modal.mode} onCancel={onClose} onSave={save} />
            </div>
        </Modal>
    )
}

function FloorModal({ modal, zoneId, token, onClose, onSaved }: {
    modal: { mode: 'create' | 'edit'; data: Floor | null }; zoneId: string; token: string | null; onClose: () => void; onSaved: () => void
}) {
    const { t } = useTranslation()
    const d = modal.data
    // Этаж определяется уровнем; название сервер проставит сам (номер уровня).
    const [form, setForm] = useState({ level: d?.level ?? 0, isActive: d?.isActive ?? true, sortOrder: d?.sortOrder ?? 0 })
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const save = async () => {
        if (!token) return
        setSaving(true); setError(null)
        try {
            const body = JSON.stringify({ name: null, level: form.level, isActive: form.isActive, sortOrder: form.sortOrder })
            if (modal.mode === 'create') await apiRequest(`/api/parking/zones/${zoneId}/floors`, { method: 'POST', token, body })
            else if (d) await apiRequest(`/api/parking/floors/${d.id}`, { method: 'PUT', token, body })
            onSaved()
        } catch (e) { setError(e instanceof Error ? e.message : 'Save failed') }
        finally { setSaving(false) }
    }

    return (
        <Modal isOpen onClose={onClose} title={modal.mode === 'create' ? t('parking.floors.new') : t('parking.floors.edit')}>
            <div className="space-y-4 pt-2">
                <Field label={t('parking.floors.fields.level')}><Input type="number" value={String(form.level)} onChange={(e) => setForm((p) => ({ ...p, level: parseInt(e.target.value, 10) || 0 }))} /></Field>
                <Check label={t('parking.floors.fields.active')} checked={form.isActive} onChange={(v) => setForm((p) => ({ ...p, isActive: v }))} />
                {error && <p className="text-xs font-medium text-error-text">{error}</p>}
                <ModalActions saving={saving} disabled={false} mode={modal.mode} onCancel={onClose} onSave={save} />
            </div>
        </Modal>
    )
}

function RowModal({ modal, floorId, token, onClose, onSaved }: {
    modal: { mode: 'create' | 'edit'; data: Row | null }; floorId: string; token: string | null; onClose: () => void; onSaved: () => void
}) {
    const { t } = useTranslation()
    const d = modal.data
    const [form, setForm] = useState({ name: d?.name ?? '', sortOrder: d?.sortOrder ?? 0 })
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const save = async () => {
        if (!token || !form.name.trim()) return
        setSaving(true); setError(null)
        try {
            const body = JSON.stringify({ name: form.name.trim(), sortOrder: form.sortOrder })
            if (modal.mode === 'create') await apiRequest(`/api/parking/floors/${floorId}/rows`, { method: 'POST', token, body })
            else if (d) await apiRequest(`/api/parking/rows/${d.id}`, { method: 'PUT', token, body })
            onSaved()
        } catch (e) { setError(e instanceof Error ? e.message : 'Save failed') }
        finally { setSaving(false) }
    }

    return (
        <Modal isOpen onClose={onClose} title={modal.mode === 'create' ? t('parking.rows.new') : t('parking.rows.edit')}>
            <div className="space-y-4 pt-2">
                <Field label={t('parking.rows.fields.name')}><Input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} /></Field>                {error && <p className="text-xs font-medium text-error-text">{error}</p>}
                <ModalActions saving={saving} disabled={!form.name.trim()} mode={modal.mode} onCancel={onClose} onSave={save} />
            </div>
        </Modal>
    )
}

// Места создаются только массово, поэтому окно осталось лишь для правки существующего.
function SpaceModal({ modal, token, onClose, onSaved }: {
    modal: { rowId: string; data: Space | null }; token: string | null; onClose: () => void; onSaved: () => void
}) {
    const { t } = useTranslation()
    const d = modal.data
    const [form, setForm] = useState({ code: d?.code ?? '', type: d?.type ?? 'Regular' as SpaceType, isActive: d?.isActive ?? true, sortOrder: d?.sortOrder ?? 0, notes: d?.notes ?? '' })
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const save = async () => {
        if (!token || !form.code.trim()) return
        setSaving(true); setError(null)
        try {
            const body = JSON.stringify({ code: form.code.trim(), type: form.type, isActive: form.isActive, sortOrder: form.sortOrder, notes: form.notes.trim() || null })
            if (d) await apiRequest(`/api/parking/spaces/${d.id}`, { method: 'PUT', token, body })
            onSaved()
        } catch (e) { setError(e instanceof Error ? e.message : 'Save failed') }
        finally { setSaving(false) }
    }

    return (
        <Modal isOpen onClose={onClose} title={t('parking.spaces.edit')}>
            <div className="space-y-4 pt-2">
                <Field label={t('parking.spaces.fields.code')}><Input value={form.code} onChange={(e) => setForm((p) => ({ ...p, code: e.target.value }))} maxLength={60} /></Field>
                <Field label={t('parking.spaces.fields.type')}>
                    <div className="grid grid-cols-1 gap-1.5">
                        {SPACE_TYPES.map((tp) => (
                            <button key={tp} type="button" onClick={() => setForm((p) => ({ ...p, type: tp }))}
                                className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold transition-colors ${form.type === tp ? 'border-primary bg-primary/10 text-primary' : 'border-border-base text-text-muted hover:bg-slate-75'}`}>
                                <span className={`flex h-6 w-6 items-center justify-center rounded-md border ${TYPE_STYLE[tp].chip}`}>
                                    <span className="material-symbols-outlined text-[16px]">{TYPE_STYLE[tp].icon}</span>
                                </span>
                                {t(`parking.types.${tp}`)}
                            </button>
                        ))}
                    </div>
                </Field>
                <Field label={t('parking.spaces.fields.notes')}><Input value={form.notes} onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))} /></Field>
                <Check label={t('parking.spaces.fields.active')} checked={form.isActive} onChange={(v) => setForm((p) => ({ ...p, isActive: v }))} />
                {error && <p className="text-xs font-medium text-error-text">{error}</p>}
                <ModalActions saving={saving} disabled={!form.code.trim()} mode="edit" onCancel={onClose} onSave={save} />
            </div>
        </Modal>
    )
}

function BulkSpaceModal({ rowId, token, onClose, onSaved }: { rowId: string; token: string | null; onClose: () => void; onSaved: () => void }) {
    const { t } = useTranslation()
    const [form, setForm] = useState({ prefix: '', startNumber: 1, count: 10, pad: 2, type: 'Regular' as SpaceType })
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const preview = Array.from({ length: Math.min(form.count, 3) }, (_, i) => form.prefix + String(form.startNumber + i).padStart(form.pad, '0')).join(', ')

    const save = async () => {
        if (!token) return
        setSaving(true); setError(null)
        try {
            await apiRequest(`/api/parking/rows/${rowId}/spaces/bulk`, {
                method: 'POST', token,
                body: JSON.stringify({ prefix: form.prefix.trim() || null, startNumber: form.startNumber, count: form.count, pad: form.pad, type: form.type }),
            })
            onSaved()
        } catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
        finally { setSaving(false) }
    }

    return (
        <Modal isOpen onClose={onClose} title={t('parking.spaces.bulkTitle')}>
            <div className="space-y-4 pt-2">
                <div className="grid grid-cols-2 gap-3">
                    <Field label={t('parking.spaces.bulkFields.prefix')}><Input value={form.prefix} onChange={(e) => setForm((p) => ({ ...p, prefix: e.target.value }))} placeholder="A-" /></Field>
                    <Field label={t('parking.spaces.bulkFields.count')}><Input type="number" min={1} max={500} value={String(form.count)} onChange={(e) => setForm((p) => ({ ...p, count: parseInt(e.target.value, 10) || 1 }))} /></Field>
                    <Field label={t('parking.spaces.bulkFields.startNumber')}><Input type="number" min={0} value={String(form.startNumber)} onChange={(e) => setForm((p) => ({ ...p, startNumber: parseInt(e.target.value, 10) || 0 }))} /></Field>
                    <Field label={t('parking.spaces.bulkFields.pad')}><Input type="number" min={1} max={6} value={String(form.pad)} onChange={(e) => setForm((p) => ({ ...p, pad: parseInt(e.target.value, 10) || 1 }))} /></Field>
                </div>
                <Field label={t('parking.spaces.fields.type')}>
                    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                        {SPACE_TYPES.map((tp) => (
                            <button key={tp} type="button" onClick={() => setForm((p) => ({ ...p, type: tp }))}
                                className={`flex items-center gap-1.5 rounded-xl border px-2.5 py-2 text-[11px] font-bold transition-colors ${form.type === tp ? 'border-primary bg-primary/10 text-primary' : 'border-border-base text-text-muted hover:bg-slate-75'}`}>
                                <span className="material-symbols-outlined text-[15px]">{TYPE_STYLE[tp].icon}</span>
                                {t(`parking.types.${tp}`)}
                            </button>
                        ))}
                    </div>
                </Field>
                <p className="rounded-lg bg-slate-75 px-3 py-2 text-xs text-text-muted">{t('parking.spaces.bulkPreview')}: <span className="font-mono font-bold text-text-dark">{preview}{form.count > 3 ? ' …' : ''}</span></p>
                {error && <p className="text-xs font-medium text-error-text">{error}</p>}
                <div className="flex gap-3 pt-1">
                    <Button variant="outline" fullWidth onClick={onClose}>{t('common.cancel')}</Button>
                    <Button fullWidth isLoading={saving} onClick={save}>{t('parking.spaces.bulkCreate')}</Button>
                </div>
            </div>
        </Modal>
    )
}

// ─── Small presentational helpers ───────────────────────────────────────────────
function Panel({ title, count, action, children }: { title: string; count: number; action?: ReactNode; children: ReactNode }) {
    return (
        <div className="ap-panel rounded-3xl border border-border-base bg-surface p-4 shadow-sm transition-shadow">
            <div className="mb-3 flex items-center justify-between">
                <p className="text-[10px] font-black uppercase tracking-widest text-text-light">{title} · {count}</p>
                {action}
            </div>
            <div className="space-y-1.5">{children}</div>
        </div>
    )
}

function ListRow({ active, onClick, title, subtitle, inactive, onEdit, onDelete }: {
    active: boolean; onClick: () => void; title: string; subtitle: string; inactive?: boolean; onEdit: () => void; onDelete: () => void
}) {
    return (
        <div className={`group flex items-center gap-2 rounded-xl border px-3 py-2.5 transition-colors ${active ? 'border-primary bg-primary/5' : 'border-transparent hover:bg-slate-75'}`}>
            <button type="button" onClick={onClick} className="min-w-0 flex-1 text-left">
                <span className={`block truncate text-sm font-bold ${inactive ? 'text-text-light line-through' : 'text-text-dark'}`}>{title}</span>
                <span className="block truncate text-[11px] text-text-light">{subtitle}</span>
            </button>
            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <IconButton icon="edit" onClick={onEdit} />
                <IconButton icon="delete" danger onClick={onDelete} />
            </div>
        </div>
    )
}

function IconButton({ icon, title, onClick, danger }: { icon: string; title?: string; onClick: () => void; danger?: boolean }) {
    return (
        <button type="button" title={title} onClick={onClick}
            className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-slate-100 ${danger ? 'text-error-text' : 'text-text-light hover:text-primary'}`}>
            <span className="material-symbols-outlined text-[18px]">{icon}</span>
        </button>
    )
}

function ModalActions({ saving, disabled, mode, onCancel, onSave }: { saving: boolean; disabled: boolean; mode: 'create' | 'edit'; onCancel: () => void; onSave: () => void }) {
    const { t } = useTranslation()
    return (
        <div className="flex gap-3 pt-1">
            <Button variant="outline" fullWidth onClick={onCancel}>{t('common.cancel')}</Button>
            <Button fullWidth isLoading={saving} disabled={disabled} onClick={onSave}>{mode === 'create' ? t('common.create') : t('common.save')}</Button>
        </div>
    )
}

function TypeLegend() {
    const { t } = useTranslation()
    return (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border-light bg-surface px-4 py-3">
            <span className="text-[10px] font-black uppercase tracking-widest text-text-light">{t('parking.legend')}</span>
            {SPACE_TYPES.map((tp) => (
                <span key={tp} className="inline-flex items-center gap-1.5 text-xs font-bold text-text-muted">
                    <span className={`h-3 w-3 rounded-full ${TYPE_STYLE[tp].dot}`} />
                    {t(`parking.types.${tp}`)}
                </span>
            ))}
            {/* Занятость важнее типа: её цвет объясняем отдельно. */}
            <span className="mx-1 h-4 w-px bg-border-base" />
            <span className="inline-flex items-center gap-1.5 text-xs font-bold text-text-muted">
                <span className="h-3 w-3 rounded-full bg-rose-500" />
                {t('parking.live.occupied')}
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs font-bold text-text-muted">
                <span className="h-3 w-3 rounded-full border border-border-base bg-white" />
                {t('parking.live.free')}
            </span>
        </div>
    )
}

function Spinner() {
    return (
        <div className="flex items-center justify-center py-20">
            <span className="spinner-ring text-3xl text-primary" aria-hidden="true" />
        </div>
    )
}

function EmptyState({ icon, text, action }: { icon: string; text: string; action?: ReactNode }) {
    return (
        <div className="flex flex-col items-center justify-center gap-3 rounded-3xl border border-dashed border-border-base bg-surface py-20 text-center text-text-light">
            <span className="material-symbols-outlined text-5xl">{icon}</span>
            <p className="text-sm font-medium">{text}</p>
            {action}
        </div>
    )
}

function Hint({ text }: { text: string }) {
    return <p className="px-1 py-6 text-center text-xs text-text-light">{text}</p>
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="space-y-1.5">
            <label className="block text-[10px] font-black uppercase tracking-widest text-text-light">{label}</label>
            {children}
        </div>
    )
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
    return (
        <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-border-light text-primary focus:ring-primary/30" />
            <span className="text-sm font-bold text-text-dark">{label}</span>
        </label>
    )
}
