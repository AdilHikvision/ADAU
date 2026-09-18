import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import QRCode from 'qrcode'
import { Button } from '../components/atoms'
import { ErrorDialog } from '../components/organisms'
import { FaceThumbnail } from '../components/FaceThumbnail'
import { apiRequest, getApiBaseUrl } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { PM_CARD, PM_TITLE, PM_SUB, PM_SOFT_BTN, PmPill } from './personFormUi'

/* ═══ Единственное место работы с биометрией: и на странице добавления, и на карточке
   человека. Здесь и запись (фото/лицо/карта/отпечаток), и список уже записанного с
   удалением. Вёрстка — по референс-дизайну: карточка «Фото» с рамкой и плавающей
   кнопкой, карточка «Биометрические данные» со статус-пилюлями, карточка «Карта». ═══ */

interface PersonBio {
  firstName: string
  lastName: string
  faces: { id: string; fdid: number }[]
  cards: { id: string; cardNo: string; cardType?: string }[]
  fingerprints: { id: string; fingerIndex: number }[]
  irises?: { id: string; irisIndex: number }[]
  accessLevels: { id: string; name: string }[]
}

interface DeviceRow {
  id: string
  name: string
  deviceType: string
  deviceIdentifier: string
}

interface DeviceCapabilities {
  isSupportFingerPrintCfg: boolean
  isSupportFDLib: boolean
  isSupportCaptureFace?: boolean
  isSupportIrisInfo: boolean
  isSupportEventCardLinkageCfg: boolean
  isSupportCardInfo?: boolean
  /** Сервер узнал станцию регистрации по модели устройства (deviceInfo), даже если в базе она заведена контроллером. */
  isEnroller?: boolean
}

/** Для записи биометрии годятся только терминалы и станции регистрации. */
const ENROLL_DEVICE_TYPES = new Set(['AccessController', 'AttendanceTerminal', 'EnrollerStation'])

/** Энроллер определяем как на бэкенде: по типу либо по серийнику/имени DS-K1F… */
function looksLikeEnroller(identifier: string, name: string): boolean {
  const s = `${identifier} ${name}`.toUpperCase()
  return s.includes('DS-K1F') || s.includes('K1F100') || s.includes('K1F600') || s.includes('K1F510') || s.includes('K1F800')
}

/** Что считываем с устройства; у каждого вида своё выбранное устройство. */
type CaptureKind = 'faces' | 'fingerprints' | 'cards'
function isEnroller(d: DeviceRow): boolean {
  return d.deviceType === 'EnrollerStation' || looksLikeEnroller(d.deviceIdentifier, d.name)
}

/** Терминалы Hikvision держат 10 слотов отпечатков — отдаём первый свободный. */
function nextFingerprintSlot(fingerprints: { fingerIndex: number }[]): number | null {
  const used = new Set(fingerprints.map((f) => f.fingerIndex))
  for (let i = 1; i <= 10; i++) if (!used.has(i)) return i
  return null
}

const CARD = PM_CARD
const TITLE = PM_TITLE
const SUB = PM_SUB
const SOFT_BTN = PM_SOFT_BTN
const Pill = PmPill

/** QR-пропуск посетителя: показываем картинку, даём скачать и удалить. */
function QrCardChip({ cardNo, onDelete }: { cardNo: string; onDelete: () => void }) {
  const [dataUrl, setDataUrl] = useState('')
  useEffect(() => {
    QRCode.toDataURL(cardNo, { width: 256, margin: 2, errorCorrectionLevel: 'M' })
      .then(setDataUrl)
      .catch(() => setDataUrl(''))
  }, [cardNo])
  return (
    <div className="w-full flex items-center gap-3 p-2.5 rounded-[11px] bg-[#F8F8FC]">
      {dataUrl && <img src={dataUrl} alt={cardNo} className="w-14 h-14 rounded-lg bg-white" />}
      <span className="flex-1 min-w-0 text-[11px] font-mono font-bold text-text-dark truncate">{cardNo}</span>
      <a
        href={dataUrl || undefined}
        download={`visitor-qr-${cardNo}.png`}
        className="w-7 h-7 grid place-items-center rounded-lg text-primary hover:bg-white"
      >
        <span className="material-symbols-outlined text-[16px]">download</span>
      </a>
      <button type="button" onClick={onDelete} className="w-7 h-7 grid place-items-center rounded-lg text-error-text hover:bg-white">
        <span className="material-symbols-outlined text-[16px]">delete</span>
      </button>
    </div>
  )
}

/** Работает и до создания человека: любое действие сначала просит страницу создать
 *  запись (ensurePerson) и только потом обращается к API — всё живёт на одном экране. */
export function PersonBiometricsStep({
  personId,
  personType,
  ensurePerson,
  onChanged,
}: {
  personId: string | null
  personType: 'employee' | 'visitor'
  ensurePerson: () => Promise<string | null>
  onChanged?: () => void
}) {
  const { t } = useTranslation()
  const { token } = useAuth()
  const isEmployee = personType === 'employee'

  /**
   * Текст хода захвата. Сервер отдаёт messageCode (ключ перевода) и message (текст по-русски,
   * для логов и старых клиентов). Берём перевод по коду; если кода нет или перевода под него
   * ещё не завели — показываем текст сервера, в крайнем случае сам статус.
   */
  const captureMessage = (prog: { messageCode?: string; message?: string }, status: string): string => {
    if (prog.messageCode) {
      return t(`people.bio.capture.${prog.messageCode}`, { defaultValue: prog.message ?? status })
    }
    if (prog.message) return prog.message
    return t(`people.bio.capture.status.${status}`, { defaultValue: status })
  }

  const [person, setPerson] = useState<PersonBio | null>(null)
  const [devices, setDevices] = useState<DeviceRow[]>([])
  const [caps, setCaps] = useState<Record<string, DeviceCapabilities>>({})
  const [busy, setBusy] = useState(false)
  /** Всё, что пошло не так, показываем одним окном ErrorDialog — без красных строк по карточкам. */
  const [dialog, setDialog] = useState<{
    variant: 'error' | 'warning'
    title?: string
    message: string
    details?: string[]
    hint?: string
    retry?: () => void
  } | null>(null)
  const [mode, setMode] = useState<'file' | 'webcam' | 'device'>('file')
  /** Лицо, отпечаток и карту можно снимать с разных устройств — например, лицо с терминала, отпечаток со станции регистрации. */
  const [captureDevice, setCaptureDevice] = useState<Record<CaptureKind, string>>({ faces: '', fingerprints: '', cards: '' })
  /** Прогресс показываем в той карточке, из которой запущен захват. */
  const [progress, setProgress] = useState<{ kind: CaptureKind; text: string } | null>(null)
  const [cardNo, setCardNo] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const apiPath = isEmployee ? '/api/employees' : '/api/visitors'

  // Через ref, чтобы новый инлайн-колбэк родителя не пересоздавал reload на каждый рендер.
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged

  const reload = useCallback(async (id?: string | null) => {
    const pid = id ?? personId
    if (!token || !pid) return
    try {
      setPerson(await apiRequest<PersonBio>(`${apiPath}/${pid}`, { token }))
      onChangedRef.current?.()
    } catch { /* ignore */ }
  }, [token, apiPath, personId])

  useEffect(() => { void reload() }, [reload])

  // Список устройств + их возможности (ISAPI capabilities) — по ним фильтруем, чем можно снимать.
  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    const base = getApiBaseUrl()
    ;(async () => {
      let list: DeviceRow[] = []
      try {
        const raw = await apiRequest<{ id: string; name?: string; deviceType?: string; deviceIdentifier?: string }[]>(
          '/api/devices', { token },
        )
        list = raw
          .map((d) => ({
            id: d.id,
            name: d.name?.trim() || d.id,
            deviceType: d.deviceType ?? 'AccessController',
            deviceIdentifier: (d.deviceIdentifier ?? '').trim(),
          }))
          .filter((d) => ENROLL_DEVICE_TYPES.has(d.deviceType) || looksLikeEnroller(d.deviceIdentifier, d.name))
        setDevices(list)
      } catch { setDevices([]); return }

      const next: Record<string, DeviceCapabilities> = {}
      for (const dev of list) {
        try {
          const res = await fetch(`${base}/api/devices/${dev.id}/access-control/capabilities`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          })
          // Ошибка запроса — возможности неизвестны; не записываем их как «ничего не умеет».
          if (!res.ok) continue
          const data = await res.json().catch(() => null)
          if (data && typeof data === 'object') {
            next[dev.id] = {
              isSupportFingerPrintCfg: Boolean(data.isSupportFingerPrintCfg),
              isSupportFDLib: Boolean(data.isSupportFDLib),
              isSupportCaptureFace: Boolean(data.isSupportCaptureFace),
              isSupportIrisInfo: Boolean(data.isSupportIrisInfo),
              isSupportEventCardLinkageCfg: Boolean(data.isSupportEventCardLinkageCfg),
              isSupportCardInfo: Boolean(data.isSupportCardInfo),
              isEnroller: Boolean(data.isEnroller),
            }
          }
        } catch { /* устройство офлайн — считаем, что умеет всё */ }
      }
      if (!controller.signal.aborted) setCaps((prev) => ({ ...prev, ...next }))
    })()
    return () => controller.abort()
  }, [token])

  // Веб-камера включается только когда выбран этот режим.
  useEffect(() => {
    if (mode !== 'webcam') {
      streamRef.current?.getTracks().forEach((tr) => tr.stop())
      streamRef.current = null
      return
    }
    // Вне защищённого контекста (http://<ip> по локальной сети) navigator.mediaDevices нет
    // вовсе: цепочка через ?. давала undefined, и следующий .then падал с TypeError.
    // Объясняем причину вместо пустого экрана.
    const media = navigator.mediaDevices
    if (!media?.getUserMedia) {
      setDialog({
        variant: 'error',
        title: t('personDetail.errors.cameraAccess'),
        message: t('personDetail.errors.cameraInsecureContext'),
      })
      return
    }
    media.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 } })
      .then((stream) => {
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
      })
      .catch((e) => setDialog({
        variant: 'error',
        message: e instanceof Error ? e.message : t('personDetail.errors.cameraAccess'),
        title: t('personDetail.errors.cameraAccess'),
      }))
    return () => {
      streamRef.current?.getTracks().forEach((tr) => tr.stop())
      streamRef.current = null
    }
  }, [mode])

  const terminals = useMemo(() => devices.filter((d) => !isEnroller(d) && !caps[d.id]?.isEnroller), [devices, caps])
  const enrollers = useMemo(() => devices.filter((d) => isEnroller(d) || caps[d.id]?.isEnroller), [devices, caps])

  /** Ошибка действия: заголовок по смыслу, имя устройства строкой подробностей, кнопка «Повторить». */
  function fail(e: unknown, opts?: { title?: string; hint?: string; retry?: () => void; kind?: CaptureKind }) {
    const message = e instanceof Error ? e.message : String(e ?? t('errorDialog.title'))
    const deviceName = opts?.kind ? devices.find((d) => d.id === captureDevice[opts.kind!])?.name : undefined
    setDialog({
      variant: 'error',
      title: opts?.title,
      message,
      details: deviceName ? [`${t('people.bio.device')}: ${deviceName}`] : undefined,
      hint: opts?.hint,
      retry: opts?.retry,
    })
  }

  /** Проверка возможностей терминала. У энроллеров ISAPI часто отдаёт все флаги false — их не проверяем. */
  function assertSupports(kind: CaptureKind): boolean {
    const deviceId = captureDevice[kind]
    if (enrollers.some((d) => d.id === deviceId)) return true
    const cap = caps[deviceId]
    if (cap == null) return true
    const key = kind === 'faces' ? 'deviceNoFaceSupport' : kind === 'fingerprints' ? 'deviceNoFingerprintSupport' : 'deviceNoCardSupport'
    const unsupported =
      (kind === 'faces' && !cap.isSupportFDLib && !cap.isSupportCaptureFace) ||
      (kind === 'fingerprints' && !cap.isSupportFingerPrintCfg) ||
      (kind === 'cards' && !cap.isSupportEventCardLinkageCfg && !cap.isSupportCardInfo)
    if (unsupported) {
      fail(t(`personDetail.errors.${key}`), {
        title: t('errorDialog.captureTitle'),
        hint: t('people.bio.selectDeviceHint'),
        kind,
      })
      return false
    }
    return true
  }

  /** Данные сохранены, но какие-то устройства ответили ошибкой — это предупреждение, не отказ. */
  function showWarnings(res: { syncWarnings?: string[] | null }) {
    const w = res?.syncWarnings
    if (!Array.isArray(w) || w.length === 0) return
    setDialog({
      variant: 'warning',
      title: t('errorDialog.deviceWarningTitle'),
      message: t('personDetail.errors.deviceSyncErrors'),
      details: w,
      hint: t('errorDialog.deviceHint'),
    })
  }

  const uploadFace = async (blob: Blob) => {
    if (!token) return
    setBusy(true); setDialog(null)
    try {
      const pid = personId ?? await ensurePerson()
      if (!pid) return
      const fd = new FormData()
      fd.append('EmployeeId', isEmployee ? pid : '')
      fd.append('VisitorId', isEmployee ? '' : pid)
      fd.append('FDID', '1')
      fd.append('Image', blob, 'face.jpg')
      const res = await fetch(`${getApiBaseUrl()}/api/faces`, {
        method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: fd,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || t('personDetail.errors.uploadFaceFailed'))
      showWarnings(data)
      await reload(pid)
    } catch (e) {
      fail(e, { title: t('errorDialog.captureTitle') })
    } finally { setBusy(false) }
  }

  const shootWebcam = () => {
    const video = videoRef.current, canvas = canvasRef.current
    if (!video || !canvas) return
    canvas.width = video.videoWidth; canvas.height = video.videoHeight
    canvas.getContext('2d')?.drawImage(video, 0, 0)
    canvas.toBlob((blob) => { if (blob) void uploadFace(blob) }, 'image/jpeg', 0.92)
  }

  /** Захват с терминала/энроллера: старт + опрос прогресса. Один контракт на лицо, палец и карту. */
  const captureFromDevice = async (kind: CaptureKind) => {
    const deviceId = captureDevice[kind]
    if (!token || !deviceId) return
    if (!assertSupports(kind)) return
    let slot: number | null = null
    if (kind === 'fingerprints') {
      slot = nextFingerprintSlot(person?.fingerprints ?? [])
      if (slot === null) {
        fail(t('personDetail.allSlotsFull'), { title: t('errorDialog.captureTitle'), kind })
        return
      }
    }
    setBusy(true); setDialog(null)
    setProgress({
      kind,
      text: kind === 'fingerprints'
        ? t('personDetail.capture.startingFingerSlot', { slot })
        : t('personDetail.capture.starting'),
    })
    try {
      const pid = personId ?? await ensurePerson()
      if (!pid) return
      const body: Record<string, unknown> = { personId: pid, personType }
      if (slot != null) body.fingerIndex = slot
      const start = await fetch(`${getApiBaseUrl()}/api/devices/${deviceId}/${kind}/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      if (!start.ok) {
        const err = await start.json().catch(() => ({}))
        throw new Error(captureMessage(err, '') || t('personDetail.errors.startCaptureFailed'))
      }
      for (;;) {
        const r = await fetch(`${getApiBaseUrl()}/api/devices/${deviceId}/${kind}/capture/progress`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        const prog = await r.json().catch(() => ({}))
        const status = String(prog.status ?? '').toLowerCase()
        // Сервер присылает сообщения только по-русски, поэтому показываем перевод по коду.
        // Сам текст остаётся запасным вариантом — на случай кода, для которого перевода ещё нет.
        const progressText = captureMessage(prog, status)
        setProgress({ kind, text: progressText })
        if (status === 'completed') {
          // Устройство может завершить захват без результата — тогда сообщение и есть причина.
          if (!prog.faceId && !prog.fingerprintId && !prog.cardId && (prog.messageCode || prog.message)) {
            fail(progressText, {
              title: t('errorDialog.captureTitle'),
              hint: t('errorDialog.deviceHint'),
              retry: () => void captureFromDevice(kind),
              kind,
            })
          }
          break
        }
        // idle — сессии на сервере уже нет (истекла или перезапущена): ждать дальше нечего.
        if (status === 'failed' || status === 'idle') throw new Error(progressText || t('personDetail.errors.captureFailed'))
        await new Promise((res) => setTimeout(res, 1500))
      }
      await reload(pid)
    } catch (e) {
      fail(e, {
        title: t('errorDialog.captureTitle'),
        hint: t('errorDialog.deviceHint'),
        retry: () => void captureFromDevice(kind),
        kind,
      })
    } finally { setBusy(false); setProgress(null) }
  }

  const addCard = async () => {
    if (!token || !cardNo.trim()) return
    setBusy(true); setDialog(null)
    try {
      const pid = personId ?? await ensurePerson()
      if (!pid) return
      const res = await apiRequest<{ syncWarnings?: string[] }>('/api/cards', {
        method: 'POST', token,
        body: JSON.stringify({
          cardNo: cardNo.trim(),
          cardNumber: null,
          employeeId: isEmployee ? pid : null,
          visitorId: isEmployee ? null : pid,
          deviceIds: [],
        }),
      })
      showWarnings(res)
      setCardNo('')
      await reload(pid)
    } catch (e) {
      fail(e, { title: t('personDetail.addCard'), retry: () => void addCard() })
    } finally { setBusy(false) }
  }

  const removeCredential = async (path: string, confirmKey: string) => {
    if (!token || !confirm(t(confirmKey))) return
    setBusy(true); setDialog(null)
    try {
      const res = await fetch(`${getApiBaseUrl()}${path}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      })
      if (res.status !== 204) {
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error((data as { message?: string }).message || t('personDetail.errors.deleteFailed'))
        showWarnings(data as { syncWarnings?: string[] | null })
      }
      await reload()
    } catch (e) {
      fail(e, { title: t('personDetail.errors.deleteFailed') })
    } finally { setBusy(false) }
  }

  const faceId = person?.faces[0]?.id ?? null
  const freeSlot = nextFingerprintSlot(person?.fingerprints ?? [])
  /* Захват доступен с любого устройства и без уровня доступа: данные сохраняются в базе,
     на терминал человек не пишется вовсе. Туда он попадёт только с уровнем доступа. */
  const hasAccessLevel = (person?.accessLevels.length ?? 0) > 0

  const deviceSelect = (kind: CaptureKind, className: string) => (
    <select
      value={captureDevice[kind]}
      disabled={busy}
      onChange={(e) => {
        const value = e.target.value
        setCaptureDevice((prev) => ({ ...prev, [kind]: value }))
      }}
      className={className}
    >
      <option value="">{t('people.bio.selectDevice')}</option>
      {terminals.length > 0 && (
        <optgroup label={t('people.bio.terminals')}>
          {terminals.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </optgroup>
      )}
      {enrollers.length > 0 && (
        <optgroup label={t('people.bio.enrollers')}>
          {enrollers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </optgroup>
      )}
    </select>
  )

  const progressLine = (kind: CaptureKind, className: string) => progress?.kind === kind && (
    <p className={`${className} flex items-center gap-2 text-[11.5px] font-semibold text-primary`}>
      <span className="spinner-ring text-[16px]" aria-hidden="true" />
      {progress.text}
    </p>
  )

  return (
    <div className="flex flex-col gap-[18px]">
      {/* ─── Фото ─── */}
      <div className={`${CARD} p-[22px] pb-6`}>
        <div className="flex items-center gap-[9px]">
          <span className={TITLE}>{t('people.bio.photoTitle')}</span>
          <span className="material-symbols-outlined text-primary text-[18px]">photo_camera</span>
        </div>
        <span className={SUB}>{t('people.bio.photoHint')}</span>

        {/* Переключатель источника */}
        <div className="mt-4 flex gap-1 bg-background-light rounded-xl p-1 w-fit">
          {(['file', 'webcam', 'device'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`px-3.5 py-1.5 rounded-lg text-[11.5px] font-bold transition-colors ${mode === m ? 'bg-primary text-white' : 'text-text-light hover:text-text-dark'}`}
            >
              {t(`people.bio.source.${m}`)}
            </button>
          ))}
        </div>

        {/* Рамка с фото. Высота не фиксирована: 186px — только минимум, чтобы пустое
            состояние и превью веб-камеры не схлопывались. Снимок задаёт высоту сам и
            вписывается целиком (object-contain) — вертикальные фото с терминалов больше
            не обрезаются по краям рамки, а горизонтальные не тонут в белых полях. */}
        <div className="mt-4 relative bg-[#F8F8FC] rounded-[14px] p-2.5">
          <div className="min-h-[186px] max-h-[420px] rounded-[11px] overflow-hidden bg-white grid place-items-center">
            {mode === 'webcam' ? (
              // Превью тоже вписываем: иначе кадрируешь лицо по одной картинке, а в файл
              // уходит полный кадр камеры — и снимок получается не тем, что видел оператор.
              <video ref={videoRef} autoPlay playsInline muted className="w-full h-[186px] object-contain" />
            ) : faceId && token ? (
              <FaceThumbnail faceId={faceId} token={token} className="max-w-full max-h-[420px] object-contain" alt="" />
            ) : (
              <div className="flex flex-col items-center gap-2 text-text-light">
                <span className="material-symbols-outlined text-4xl">face</span>
                <span className="text-[11.5px]">{t('people.bio.noFace')}</span>
              </div>
            )}
          </div>
          <canvas ref={canvasRef} className="hidden" />
          {faceId && mode !== 'webcam' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void removeCredential(`/api/faces/${faceId}`, 'personDetail.confirm.deleteFace')}
              title={t('common.delete')}
              className="absolute top-1 right-1 w-7 h-7 rounded-lg bg-white/90 grid place-items-center text-error-text shadow-sm hover:bg-white"
            >
              <span className="material-symbols-outlined text-[16px]">delete</span>
            </button>
          )}
          <button
            type="button"
            disabled={busy || (mode === 'device' && !captureDevice.faces)}
            onClick={() => {
              if (mode === 'file') fileRef.current?.click()
              else if (mode === 'webcam') shootWebcam()
              else void captureFromDevice('faces')
            }}
            title={t('people.bio.addFace')}
            className="absolute left-1/2 -bottom-3.5 -translate-x-1/2 w-9 h-9 rounded-[11px] bg-primary grid place-items-center border-[3px] border-white shadow-sm disabled:opacity-60"
          >
            <span className="material-symbols-outlined text-white text-[18px]">{mode === 'webcam' ? 'photo_camera' : 'add'}</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadFace(f); e.target.value = '' }}
          />
        </div>

        {mode === 'device' && (
          <>
            {deviceSelect('faces', 'mt-6 w-full h-11 px-3 rounded-[11px] border border-[#E6E6F0] bg-white text-[12.5px] font-semibold text-text-dark outline-none')}
            {!captureDevice.faces && (
              <p className="mt-2 text-[10.5px] text-[#A0A1B8] leading-relaxed">{t('people.bio.selectDeviceHint')}</p>
            )}
          </>
        )}

        {progressLine('faces', 'mt-4')}
      </div>

      {/* ─── Биометрические данные ─── */}
      <div className={`${CARD} p-[22px]`}>
        <span className={TITLE}>{t('people.bio.dataTitle')}</span>

        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-[11.5px] text-[#4A4B6B]">{t('people.bio.face')}</span>
          <Pill ok={(person?.faces.length ?? 0) > 0}>
            {(person?.faces.length ?? 0) > 0 ? t('people.bio.enrolled') : t('people.bio.notEnrolled')}
          </Pill>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[11.5px] text-[#4A4B6B]">{t('people.bio.card')}</span>
          <Pill ok={(person?.cards.length ?? 0) > 0}>{person?.cards.length ?? 0}</Pill>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[11.5px] text-[#4A4B6B]">{t('people.bio.fingerprint')}</span>
          <Pill ok={(person?.fingerprints.length ?? 0) > 0}>{person?.fingerprints.length ?? 0}</Pill>
        </div>

        <span className="block mt-[9px] text-[11px] text-[#A0A1B8]">
          {person ? `${person.firstName} ${person.lastName}`.trim() : ''}
        </span>

        <label className="block mt-4 text-[11px] font-semibold text-[#4A4B6B]">{t('people.bio.fingerprintDevice')}</label>
        {deviceSelect('fingerprints', 'mt-1.5 w-full h-10 px-3 rounded-[11px] border border-[#E6E6F0] bg-white text-[12px] font-semibold text-text-dark outline-none')}

        <button
          type="button"
          disabled={busy || !captureDevice.fingerprints || freeSlot === null}
          onClick={() => void captureFromDevice('fingerprints')}
          className={`${SOFT_BTN} mt-3`}
        >
          <span className="material-symbols-outlined text-[18px]">fingerprint</span>
          {t('people.bio.enrollFingerprint')}
        </button>

        {progressLine('fingerprints', 'mt-3')}

        {!captureDevice.fingerprints ? (
          <p className="mt-2 text-[10.5px] text-[#A0A1B8] leading-relaxed">{t('people.bio.selectDeviceHint')}</p>
        ) : freeSlot === null ? (
          <p className="mt-2 text-[10.5px] text-error-text leading-relaxed">{t('personDetail.allSlotsFull')}</p>
        ) : (
          <p className="mt-2 text-[10.5px] text-[#A0A1B8] leading-relaxed">
            {t('personDetail.nextFreeSlot')} <span className="font-bold text-text-dark">#{freeSlot}</span> {t('personDetail.maxTen')}
          </p>
        )}

        {/* Записанные отпечатки */}
        {(person?.fingerprints.length ?? 0) > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {person!.fingerprints.map((fp) => (
              <span key={fp.id} className="inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-lg bg-[#F4F3FD] text-[11px] font-semibold text-primary">
                <span className="material-symbols-outlined text-[14px]">fingerprint</span>
                #{fp.fingerIndex}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void removeCredential(`/api/fingerprints/${fp.id}`, 'personDetail.confirm.deleteFingerprint')}
                  className="w-5 h-5 grid place-items-center rounded text-error-text hover:bg-white"
                >
                  <span className="material-symbols-outlined text-[13px]">close</span>
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Радужка: записывается только импортом с устройства, здесь — просмотр и удаление. */}
        {(person?.irises?.length ?? 0) > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {person!.irises!.map((ir) => (
              <span key={ir.id} className="inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-lg bg-[#F1F0F7] text-[11px] font-semibold text-[#4A4B6B]">
                <span className="material-symbols-outlined text-[14px]">visibility</span>
                #{ir.irisIndex}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void removeCredential(`/api/irises/${ir.id}`, 'personDetail.confirm.deleteIris')}
                  className="w-5 h-5 grid place-items-center rounded text-error-text hover:bg-white"
                >
                  <span className="material-symbols-outlined text-[13px]">close</span>
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Пока нет уровня доступа — данные живут только в базе, на терминалы не уходят. */}
        {!hasAccessLevel && (
          <div className="mt-3 flex items-start gap-2 p-3 rounded-[11px] bg-[#F4F3FD]">
            <span className="material-symbols-outlined text-[16px] text-primary">info</span>
            <p className="text-[10.5px] text-[#5a4bc8] leading-relaxed">{t('people.bio.noAccessLevelNote')}</p>
          </div>
        )}
      </div>

      {/* ─── Карта ─── */}
      <div className={`${CARD} p-[22px]`}>
        <span className={TITLE}>{t('people.bio.cardTitle')}</span>
        <span className={SUB}>{t('people.bio.cardHint')}</span>
        <div className="mt-4 flex gap-2">
          <input
            type="text"
            value={cardNo}
            onChange={(e) => setCardNo(e.target.value)}
            placeholder="0012345678"
            className="flex-1 min-w-0 h-11 px-3 rounded-[11px] border border-[#E6E6F0] bg-white text-[12.5px] font-semibold text-text-dark outline-none focus:border-primary"
          />
          <Button onClick={addCard} isLoading={busy} disabled={!cardNo.trim() || busy}>+</Button>
        </div>

        <label className="block mt-4 text-[11px] font-semibold text-[#4A4B6B]">{t('people.bio.cardDevice')}</label>
        {deviceSelect('cards', 'mt-1.5 w-full h-10 px-3 rounded-[11px] border border-[#E6E6F0] bg-white text-[12px] font-semibold text-text-dark outline-none')}

        <button
          type="button"
          disabled={busy || !captureDevice.cards}
          onClick={() => void captureFromDevice('cards')}
          className={`${SOFT_BTN} mt-2.5`}
        >
          <span className="material-symbols-outlined text-[18px]">nfc</span>
          {t('people.bio.readCardFromDevice')}
        </button>

        {progressLine('cards', 'mt-3')}

        {(person?.cards.length ?? 0) > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {person!.cards.map((c) => (
              c.cardType === 'qrCode' ? (
                <QrCardChip
                  key={c.id}
                  cardNo={c.cardNo}
                  onDelete={() => void removeCredential(`/api/cards/${c.id}`, 'personDetail.confirm.deleteCard')}
                />
              ) : (
                <span key={c.id} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-lg bg-[#F4F3FD] text-[11px] font-mono font-bold text-primary">
                  {c.cardNo}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void removeCredential(`/api/cards/${c.id}`, 'personDetail.confirm.deleteCard')}
                    className="w-5 h-5 grid place-items-center rounded text-error-text hover:bg-white"
                  >
                    <span className="material-symbols-outlined text-[13px]">close</span>
                  </button>
                </span>
              )
            ))}
          </div>
        )}
      </div>

      <ErrorDialog
        open={dialog != null}
        onClose={() => setDialog(null)}
        variant={dialog?.variant}
        title={dialog?.title}
        message={dialog?.message ?? ''}
        details={dialog?.details}
        hint={dialog?.hint}
        onRetry={dialog?.retry}
      />
    </div>
  )
}
