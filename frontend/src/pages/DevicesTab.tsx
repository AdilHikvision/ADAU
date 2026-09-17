import { HubConnection, HubConnectionBuilder, HttpTransportType, LogLevel } from '@microsoft/signalr'
import { useCallback, useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/AuthContext'
import { Badge, Button, Input } from '../components/atoms'
import { PageHeader, Modal } from '../components/organisms'
import { useLoading } from '../context/LoadingContext'
import { apiRequest, getHubUrl } from '../lib/api'

type DeviceStatus = 'Online' | 'Offline'

const DEVICE_TYPES = [
  { value: 'all', labelKey: 'common.all' as const },
  { value: 'AccessController', labelKey: 'devicesTab.types.accessControllers' as const },
  { value: 'Intercom', labelKey: 'devicesTab.types.intercoms' as const },
  { value: 'ElevatorController', labelKey: 'devicesTab.types.elevators' as const },
] as const

interface Device {
  id: string
  deviceIdentifier: string
  name: string
  ipAddress: string
  port: number
  location?: string | null
  deviceType: string
  status: DeviceStatus
  lastSeenUtc?: string | null
  username?: string | null
  statusMessage?: string | null
  macAddress?: string | null
  /** Что проход через устройство означает для табеля: Both | In | Out. */
  attendanceDirection?: string | null
  parkingDirection?: string | null
  parkingZoneId?: string | null
  /** Реле шлагбаума на камере; null/0 — шлагбаумом управляет сама камера. */
  barrierOutput?: number | null
}

interface ParkingZoneOption {
  id: string
  name: string
}

interface DeviceStatusResponse {
  deviceId: string
  deviceIdentifier: string
  status: DeviceStatus
  lastSeenUtc?: string | null
  statusMessage?: string | null
}

interface DiscoveredDevice {
  deviceIdentifier: string
  name: string
  ipAddress: string
  port: number
  model?: string | null
  deviceType?: string | null
  macAddress?: string | null
  firmwareVersion?: string | null
  isActivated?: boolean | null
}

interface DeviceFormData {
  deviceIdentifier: string
  name: string
  ipAddress: string
  port: number
  location: string
  deviceType: number
  username: string
  password: string
  /** Что проход означает для табеля. Both — прежнее поведение: первый проход за день приход, последний уход. */
  attendanceDirection: 'Both' | 'In' | 'Out'
  /** Только для ANPR-камеры: '' — определять по открытой сессии, иначе Entry/Exit. */
  parkingDirection: '' | 'Entry' | 'Exit'
  parkingZoneId: string
  /** Номер релейного выхода камеры; пусто или 0 — сервер шлагбаумом не управляет. */
  barrierOutput: string
}

const emptyForm: DeviceFormData = {
  deviceIdentifier: '',
  name: '',
  ipAddress: '',
  port: 8000,
  location: '',
  deviceType: 1,
  username: 'admin',
  password: '',
  attendanceDirection: 'Both',
  parkingDirection: '',
  parkingZoneId: '',
  barrierOutput: '',
}

/** Тип устройства 6 = ANPR-камера: только у неё есть настройки парковки. */
const ANPR_DEVICE_TYPE = 6

function mergeStatus(device: Device, status?: DeviceStatusResponse): Device {
  if (!status) return device
  return {
    ...device,
    status: status.status,
    lastSeenUtc: status.lastSeenUtc ?? device.lastSeenUtc,
    statusMessage: status.statusMessage ?? device.statusMessage,
  }
}

function applyStatusUpdate(
  device: Device,
  status: DeviceStatusResponse | undefined
): Device {
  if (!status) return device
  return {
    ...device,
    status: status.status,
    lastSeenUtc: status.lastSeenUtc ?? device.lastSeenUtc,
    statusMessage: status.statusMessage ?? device.statusMessage,
  }
}

function getDeviceIcon(deviceType: string): string {
  if (deviceType === 'AccessController') return 'hub'
  if (deviceType === 'Intercom') return 'videocam'
  if (deviceType === 'ElevatorController') return 'elevator'
  if (deviceType === 'EnrollerStation') return 'how_to_reg'
  if (deviceType === 'AnprCamera') return 'photo_camera'
  return 'devices'
}

function getDeviceTypeLabel(deviceType: string, t: (k: string) => string): string {
  if (deviceType === 'AccessController') return t('devicesTab.deviceTypeLabels.AccessController')
  if (deviceType === 'Intercom') return t('devicesTab.deviceTypeLabels.Intercom')
  if (deviceType === 'AttendanceTerminal') return t('devicesTab.deviceTypeLabels.AttendanceTerminal')
  if (deviceType === 'ElevatorController') return t('devicesTab.deviceTypeLabels.ElevatorController')
  if (deviceType === 'EnrollerStation') return t('devicesTab.deviceTypeLabels.EnrollerStation')
  if (deviceType === 'AnprCamera') return 'ANPR Camera'
  return deviceType
}

function deviceTypeStringToNumber(deviceType: string | null | undefined): number {
  switch (deviceType) {
    case 'AccessController':
      return 1
    case 'Intercom':
      return 2
    case 'AttendanceTerminal':
      return 3
    case 'ElevatorController':
      return 4
    case 'EnrollerStation':
      return 5
    case 'AnprCamera':
      return ANPR_DEVICE_TYPE
    default:
      return 1
  }
}

const DISCOVER_TYPE_TABS = [
  { value: 'all', labelKey: 'common.all' as const },
  { value: 'camera', labelKey: 'devicesTab.discoverTypes.cameras' as const },
  { value: 'access', labelKey: 'devicesTab.discoverTypes.access' as const },
  { value: 'intercom', labelKey: 'devicesTab.discoverTypes.intercoms' as const },
  { value: 'nvr', labelKey: 'devicesTab.discoverTypes.nvr' as const },
  { value: 'switch', labelKey: 'devicesTab.discoverTypes.switches' as const },
  { value: 'other', labelKey: 'devicesTab.discoverTypes.other' as const },
] as const

/** Семейства ANPR-камер Hikvision (распознавание номеров): DS-TCG / iDS-TCM / iDS-TCV. */
const ANPR_MODEL_PREFIXES = ['DS-TCG', 'IDS-TCG', 'DS-TCM', 'IDS-TCM', 'DS-TCV', 'IDS-TCV']

function isAnprModel(model: string | null | undefined, serial?: string | null): boolean {
  const src = (model || serial || '').toUpperCase()
  return ANPR_MODEL_PREFIXES.some((prefix) => src.startsWith(prefix))
}

/** Станция регистрации DS-K1F…: заводим её типом EnrollerStation (5), иначе захват пойдёт по сценарию терминала. */
const ENROLLER_DEVICE_TYPE = 5
function isEnrollerModel(model: string | null | undefined, serial?: string | null): boolean {
  return (model || serial || '').toUpperCase().startsWith('DS-K1F')
}

function inferDeviceTypeFromModel(model: string | null | undefined, serial?: string | null): string {
  const src = (model || serial || '').toUpperCase()
  if (!src) return 'other'
  // Раньше проверки не было, и DS-TCG406-E попадала в «Другое», а iDS-TCM — в NVR по правилу 'IDS-'.
  if (isAnprModel(model, serial)) return 'camera'
  if (src.startsWith('DS-2CD') || src.startsWith('DS-2DE') || src.startsWith('DS-2PT')) return 'camera'
  if (src.startsWith('DS-K') || src.startsWith('DS-KD') || src.startsWith('DS-KH')) return 'access'
  if (src.startsWith('CS-H') || src.startsWith('DS-2TD')) return 'intercom'
  if (src.startsWith('DS-77') || src.startsWith('IDS-72') || src.startsWith('DS-96') || src.startsWith('IDS-')) return 'nvr'
  if (src.startsWith('DS-3E')) return 'switch'
  return 'other'
}

export const DevicesTab = forwardRef((_props, ref) => {
  const { t } = useTranslation()
  const { token } = useAuth()
  const { startLoading, stopLoading, isLoading } = useLoading()

  const [devices, setDevices] = useState<Device[]>([])
  const [isDiscovering, setIsDiscovering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [modalMode, setModalMode] = useState<'create' | 'edit' | 'discover' | 'delete' | 'activate' | null>(null)
  const [editingDevice, setEditingDevice] = useState<Device | null>(null)
  const [deletingDevice, setDeletingDevice] = useState<Device | null>(null)
  const [activatingDevice, setActivatingDevice] = useState<(DiscoveredDevice & { inferredType: string; isActive: boolean }) | null>(null)
  const [activatePassword, setActivatePassword] = useState('')
  const [activateConfirm, setActivateConfirm] = useState('')
  const [activateError, setActivateError] = useState<string | null>(null)
  const [discovered, setDiscovered] = useState<DiscoveredDevice[]>([])
  const [discoverTypeTab, setDiscoverTypeTab] = useState<string>('all')
  const [discoverIpSort, setDiscoverIpSort] = useState<'asc' | 'desc'>('asc')
  const [showAddedDevices, setShowAddedDevices] = useState(false)
  const [formData, setFormData] = useState<DeviceFormData>(emptyForm)
  const [parkingZones, setParkingZones] = useState<ParkingZoneOption[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [addFromDevice, setAddFromDevice] = useState<DiscoveredDevice | null>(null)
  const [addDeviceName, setAddDeviceName] = useState('')
  const [addDeviceUsername, setAddDeviceUsername] = useState('admin')
  const [addDevicePassword, setAddDevicePassword] = useState('')
  const [discoverSearchQuery, setDiscoverSearchQuery] = useState('')
  const [networkWarningMessage, setNetworkWarningMessage] = useState<string | null>(null)
  // Проверка реле шлагбаума при пусконаладке: результат показываем прямо в карточке камеры.
  const [barrierTest, setBarrierTest] = useState<{ ok: boolean; text: string } | null>(null)
  const [barrierTesting, setBarrierTesting] = useState(false)

  const loadData = useCallback(async () => {
    if (!token) return
    setError(null)
    startLoading()
    try {
      const [devicesResult, statusesResult] = await Promise.all([
        apiRequest<Device[]>('/api/devices', { token }),
        apiRequest<DeviceStatusResponse[]>('/api/devices/statuses', { token }),
      ])
      const statusesById = new Map(statusesResult.map((s) => [s.deviceId, s]))
      setDevices(devicesResult.map((d) => mergeStatus(d, statusesById.get(d.id))))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('devicesTab.failedLoadDevices'))
    } finally {
      stopLoading()
    }
  }, [token, startLoading, stopLoading, t])

  const fetchStatuses = useCallback(async () => {
    if (!token) return
    try {
      const statuses = await apiRequest<DeviceStatusResponse[]>('/api/devices/statuses', { token })
      const byId = new Map(statuses.map((s) => [s.deviceId, s]))
      const byIdent = new Map(statuses.map((s) => [s.deviceIdentifier, s]))
      setDevices((prev) => prev.map((d) => {
        const s = byId.get(d.id) || byIdent.get(d.deviceIdentifier)
        return applyStatusUpdate(d, s)
      }))
    } catch { /* ignore */ }
  }, [token])

  const fetchStatusesRef = useRef(fetchStatuses)
  fetchStatusesRef.current = fetchStatuses
  const hubRef = useRef<HubConnection | null>(null)

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    if (modalMode === 'discover') {
      setDiscoverTypeTab('all')
      setDiscoverIpSort('asc')
      setDiscoverSearchQuery('')
    }
  }, [modalMode])

  // Зоны парковки нужны только чтобы привязать к ним ANPR-камеру.
  useEffect(() => {
    if (!token) return
    apiRequest<ParkingZoneOption[]>('/api/parking/zones', { token })
      .then(setParkingZones)
      .catch(() => setParkingZones([]))
  }, [token])

  useEffect(() => {
    if (!token) return
    let isDisposed = false
    let hub: HubConnection | null = null
    let pollTimer: number | null = null

    async function startConnection() {
      try {
        hub = new HubConnectionBuilder()
          .withUrl(`${getHubUrl()}/hubs/devices`, {
            accessTokenFactory: () => token!,
            skipNegotiation: true,
            transport: HttpTransportType.WebSockets,
          })
          .withAutomaticReconnect({
            nextRetryDelayInMilliseconds: (retryContext) =>
              Math.min(1000 * 2 ** retryContext.previousRetryCount, 30000),
          })
          .configureLogging(LogLevel.Error)
          .build()

        hub.onreconnecting(() => {
          setInfo(t('devicesTab.reconnectingToServer'))
        })
        hub.onreconnected(() => {
          setInfo(null)
          fetchStatusesRef.current()
        })
        hub.onclose((err) => {
          if (err) setInfo(t('devicesTab.connectionLost'))
        })

        hub.on('DeviceStatusChanged', (payload: DeviceStatusResponse) => {
          setDevices((prev) =>
            prev.map((d) =>
              d.id === payload.deviceId || d.deviceIdentifier === payload.deviceIdentifier
                ? applyStatusUpdate(d, payload)
                : d
            )
          )
        })

        hub.on('DeviceFound', (device: DiscoveredDevice) => {
          setDiscovered((prev) => {
            // По ip:port схлопывать нельзя: на заводском 192.168.1.64:8000 сидит сразу
            // несколько неактивированных устройств, и в списке оставалось только одно.
            const idx = prev.findIndex((x) => x.deviceIdentifier === device.deviceIdentifier)
            const next = { ...device }
            if (idx >= 0) return prev.map((x, i) => (i === idx ? next : x))
            return [...prev, next]
          })
        })

        hub.on('DiscoveryComplete', (count: number) => {
          setIsDiscovering(false)
          setInfo(count > 0 ? t('devicesTab.foundDevices', { count }) : t('devicesTab.noDevicesFound'))
        })

        await hub.start()
        hubRef.current = hub
      } catch { /* fallback */ }

      if (!isDisposed) {
        pollTimer = window.setInterval(() => fetchStatusesRef.current(), 3000)
      }
    }

    startConnection()

    return () => {
      isDisposed = true
      hubRef.current = null
      if (pollTimer) window.clearInterval(pollTimer)
      hub?.stop().catch(() => { /* ignore — cleanup */ })
    }
  }, [token])

  const filteredDevices = useMemo(() => {
    let result = devices

    if (typeFilter !== 'all') {
      result = result.filter((d) => d.deviceType === typeFilter)
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim().replace(/\s+/g, ' ')
      const terms = q.split(' ').filter(Boolean)
      result = result.filter((d) => {
        const name = (d.name ?? '').toLowerCase()
        const identifier = (d.deviceIdentifier ?? '').toLowerCase()
        const ip = (d.ipAddress ?? '').toLowerCase()
        const location = (d.location ?? '').toLowerCase()
        const typeLabel = getDeviceTypeLabel(d.deviceType ?? '', t).toLowerCase()
        const portStr = String(d.port ?? '')
        const searchable = `${name} ${identifier} ${ip} ${location} ${typeLabel} ${portStr}`
        return terms.every((term) => searchable.includes(term))
      })
    }

    return result
  }, [devices, typeFilter, searchQuery, t])

  function openDiscoverModal() {
    setError(null)
    setInfo(null)
    setModalMode('discover')
  }

  async function startDiscovery() {
    if (!token) return
    setDiscovered([])
    setIsDiscovering(true)
    setError(null)

    const hub = hubRef.current
    if (hub?.state !== 'Connected') {
      setError(t('devicesTab.realtimeNotReady'))
      setIsDiscovering(false)
      return
    }

    try {
      await hub.invoke('StartDiscovery')
    } catch (e) {
      setError(e instanceof Error ? e.message : t('devicesTab.discoveryFailed'))
      setIsDiscovering(false)
    }
  }

  async function handleDiscover() {
    openDiscoverModal()
    await startDiscovery()
  }

  async function handleDiscoverRefresh() {
    await startDiscovery()
  }

  const openCreateModal = useCallback(() => {
    setFormData(emptyForm)
    setModalMode('create')
  }, [])

  useImperativeHandle(ref, () => ({
    triggerAction: openCreateModal
  }))

  function openEditModal(device: Device) {
    setEditingDevice(device)
    setFormData({
      deviceIdentifier: device.deviceIdentifier,
      name: device.name,
      ipAddress: device.ipAddress,
      port: device.port,
      location: device.location ?? '',
      deviceType: deviceTypeStringToNumber(device.deviceType),
      username: device.username ?? 'admin',
      password: '',
      attendanceDirection: (device.attendanceDirection === 'In' || device.attendanceDirection === 'Out') ? device.attendanceDirection : 'Both',
      parkingDirection: (device.parkingDirection === 'Entry' || device.parkingDirection === 'Exit') ? device.parkingDirection : '',
      parkingZoneId: device.parkingZoneId ?? '',
      barrierOutput: device.barrierOutput ? String(device.barrierOutput) : '',
    })
    setBarrierTest(null)
    setModalMode('edit')
  }

  function openDeleteModal(device: Device) {
    setDeletingDevice(device)
    setModalMode('delete')
  }

  function closeModals() {
    setModalMode(null)
    setEditingDevice(null)
    setDeletingDevice(null)
    setActivatingDevice(null)
    setActivatePassword('')
    setActivateConfirm('')
    setDiscovered([])
    closeAddFromDiscoveredModal()
  }

  function closeActivateModal() {
    setModalMode('discover')
    setActivatingDevice(null)
    setActivatePassword('')
    setActivateConfirm('')
    setActivateError(null)
  }

  async function openActivateModal(d: DiscoveredDevice & { inferredType: string; isActive: boolean }) {
    try {
      const res = await apiRequest<{ inSameSubnet: boolean; message?: string }>(
        `/api/devices/check-network?ipAddress=${encodeURIComponent(d.ipAddress)}`,
        { token: token ?? undefined }
      )
      if (!res.inSameSubnet && res.message) {
        setNetworkWarningMessage(res.message)
        return
      }
    } catch {
      // On API error allow to continue
    }
    setActivatingDevice(d)
    setActivatePassword('')
    setActivateConfirm('')
    setActivateError(null)
    setModalMode('activate')
  }

  async function handleCreate() {
    if (!token) return
    setIsSubmitting(true)
    setError(null)
    try {
      const created = await apiRequest<Device>('/api/devices', {
        method: 'POST',
        token,
        body: JSON.stringify({
          deviceIdentifier: `${formData.ipAddress.trim()}:${formData.port}`,
          name: formData.name.trim(),
          ipAddress: formData.ipAddress.trim(),
          port: formData.port,
          location: formData.location.trim() || null,
          deviceType: formData.deviceType,
          username: formData.username.trim() || null,
          password: formData.password || null,
          attendanceDirection: formData.attendanceDirection,
          parkingDirection: formData.deviceType === ANPR_DEVICE_TYPE ? (formData.parkingDirection || null) : null,
          parkingZoneId: formData.deviceType === ANPR_DEVICE_TYPE ? (formData.parkingZoneId || null) : null,
          barrierOutput: formData.deviceType === ANPR_DEVICE_TYPE ? (parseInt(formData.barrierOutput, 10) || null) : null,
        }),
      })
      setDevices((prev) => [...prev, { ...created, status: 'Offline' }])
      closeModals()
      fetchStatusesRef.current()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('devicesTab.failedCreateDevice'))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleUpdate() {
    if (!token || !editingDevice) return
    setIsSubmitting(true)
    setError(null)
    try {
      const updated = await apiRequest<Device>(`/api/devices/${editingDevice.id}`, {
        method: 'PUT',
        token,
        body: JSON.stringify({
          deviceIdentifier: formData.deviceIdentifier.trim(),
          name: formData.name.trim(),
          ipAddress: formData.ipAddress.trim(),
          port: formData.port,
          location: formData.location.trim() || null,
          deviceType: formData.deviceType,
          username: formData.username.trim() || null,
          password: formData.password || null,
          attendanceDirection: formData.attendanceDirection,
          parkingDirection: formData.deviceType === ANPR_DEVICE_TYPE ? (formData.parkingDirection || null) : null,
          parkingZoneId: formData.deviceType === ANPR_DEVICE_TYPE ? (formData.parkingZoneId || null) : null,
          barrierOutput: formData.deviceType === ANPR_DEVICE_TYPE ? (parseInt(formData.barrierOutput, 10) || null) : null,
        }),
      })
      setDevices((prev) => prev.map((d) => (d.id === updated.id ? updated : d)))
      closeModals()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('devicesTab.failedUpdateDevice'))
    } finally {
      setIsSubmitting(false)
    }
  }

  /**
   * Импульс на реле выбранной камеры. Проверять имеет смысл только у сохранённой камеры:
   * сервер берёт номер выхода из базы, а не из формы.
   */
  async function handleBarrierTest() {
    if (!token || !editingDevice) return
    setBarrierTesting(true)
    setBarrierTest(null)
    try {
      const res = await apiRequest<{ triggered: boolean; skipped: boolean; output?: number | null; method?: string | null; error?: string | null }>(
        `/api/devices/${editingDevice.id}/barrier-test`,
        { method: 'POST', token }
      )
      if (res.triggered) setBarrierTest({
        ok: true,
        // Какой способ сработал — важно при пусконаладке: от него зависит, нужен ли номер реле.
        text: res.method === 'gate' ? t('devicesTab.anpr.testOkGate') : t('devicesTab.anpr.testOk', { output: res.output ?? 0 }),
      })
      else if (res.skipped) setBarrierTest({ ok: false, text: t('devicesTab.anpr.testSkipped') })
      else setBarrierTest({ ok: false, text: res.error || t('devicesTab.anpr.testFailed') })
    } catch (e) {
      setBarrierTest({ ok: false, text: e instanceof Error ? e.message : t('devicesTab.anpr.testFailed') })
    } finally {
      setBarrierTesting(false)
    }
  }

  async function handleDelete() {
    if (!token || !deletingDevice) return
    setIsSubmitting(true)
    setError(null)
    try {
      await apiRequest(`/api/devices/${deletingDevice.id}`, { method: 'DELETE', token })
      setDevices((prev) => prev.filter((d) => d.id !== deletingDevice.id))
      closeModals()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('devicesTab.failedDeleteDevice'))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleActivate() {
    if (!activatingDevice || !activatingDevice.macAddress) {
      setError(t('devicesTab.macRequired'))
      return
    }
    if (activatePassword !== activateConfirm) {
      setError(t('devicesTab.passwordsDoNotMatch'))
      return
    }
    if (activatePassword.length < 8) {
      setError(t('devicesTab.passwordMin8'))
      return
    }
    setIsSubmitting(true)
    setError(null)
    setActivateError(null)
    try {
      await apiRequest('/api/devices/activate', {
        method: 'POST',
        token: token ?? undefined,
        body: JSON.stringify({
          ipAddress: activatingDevice.ipAddress,
          port: activatingDevice.port,
          macAddress: activatingDevice.macAddress,
          password: activatePassword,
        }),
      })
      setInfo(t('devicesTab.deviceActivated', { ip: activatingDevice.ipAddress }))
      closeActivateModal()
      await startDiscovery()
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('devicesTab.activationFailed')
      setActivateError(msg)
    } finally {
      setIsSubmitting(false)
    }
  }

  async function openAddFromDiscoveredModal(d: DiscoveredDevice) {
    try {
      const res = await apiRequest<{ inSameSubnet: boolean; message?: string }>(
        `/api/devices/check-network?ipAddress=${encodeURIComponent(d.ipAddress)}`,
        { token: token ?? undefined }
      )
      if (!res.inSameSubnet && res.message) {
        setNetworkWarningMessage(res.message)
        return
      }
    } catch {
      // On API error allow to continue
    }
    setAddFromDevice(d)
    setAddDeviceName(d.ipAddress)
    setAddDeviceUsername('admin')
    setAddDevicePassword('')
  }

  function closeAddFromDiscoveredModal() {
    setAddFromDevice(null)
    setAddDeviceName('')
    setAddDeviceUsername('admin')
    setAddDevicePassword('')
  }

  async function handleAddFromDiscoveredSubmit() {
    if (!token || !addFromDevice) return
    if (!addDeviceName.trim()) {
      setError(t('devicesTab.pleaseEnterDeviceName'))
      return
    }
    if (!addDevicePassword) {
      setError(t('devicesTab.pleaseEnterDevicePassword'))
      return
    }
    setError(null)
    setIsSubmitting(true)
    try {
      const created = await apiRequest<Device>('/api/devices', {
        method: 'POST',
        token,
        body: JSON.stringify({
          deviceIdentifier: addFromDevice.deviceIdentifier,
          name: addDeviceName.trim(),
          ipAddress: addFromDevice.ipAddress,
          port: addFromDevice.port,
          location: null,
          // ANPR-камеру нельзя заводить как контроллер: иначе парковочная логика её не подхватит.
          deviceType: isAnprModel(addFromDevice.model, addFromDevice.deviceIdentifier)
            ? ANPR_DEVICE_TYPE
            : isEnrollerModel(addFromDevice.model, addFromDevice.deviceIdentifier) ? ENROLLER_DEVICE_TYPE : 1,
          username: addDeviceUsername.trim() || null,
          password: addDevicePassword || null,
        }),
      })
      const deviceWithStatus: Device = {
        ...created,
        status: 'Offline',
      }
      setDevices((prev) => [...prev, deviceWithStatus])
      setDiscovered((prev) => prev.filter((x) => x.deviceIdentifier !== addFromDevice.deviceIdentifier))
      fetchStatusesRef.current()
      setInfo(t('devicesTab.deviceAdded', { name: addDeviceName.trim() }))
      closeAddFromDiscoveredModal()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('devicesTab.failedAddDevice'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const onlineCount = devices.filter((d) => d.status === 'Online').length
  const canCreateOrUpdate = formData.name.trim() && formData.ipAddress.trim() && formData.port > 0

  return (
    <div className="space-y-6">
      <PageHeader
        className="hidden md:flex"
        title={t('devicesTab.devicesFleet')}
        description={t('devicesTab.devicesFleetDescription')}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="md" icon="sync" onClick={loadData} isLoading={isLoading}>
              {t('common.refresh')}
            </Button>
            <Button variant="outline" size="md" icon="search" onClick={handleDiscover}>
              {t('devicesTab.discover')}
            </Button>
            <Button size="md" icon="add" onClick={openCreateModal}>
              {t('devicesTab.addManually')}
            </Button>
          </div>
        }
      />

      {error && (
        <div className="p-4 bg-error-bg text-error-text rounded-xl text-xs font-bold border border-error-text/10 max-h-40 overflow-y-auto whitespace-pre-wrap">
          {error}
        </div>
      )}
      {info && (
        <div className="p-4 bg-primary/5 text-primary rounded-xl text-xs font-bold border border-primary/20 max-h-40 overflow-y-auto">
          {info}
        </div>
      )}

      {/* Mobile Quick Actions */}
      <div className="flex md:hidden gap-2">
        <Button fullWidth variant="outline" size="sm" icon="sync" onClick={loadData} isLoading={isLoading}>{t('common.refresh')}</Button>
        <Button fullWidth variant="outline" size="sm" icon="search" onClick={handleDiscover}>{t('devicesTab.discover')}</Button>
      </div>

      {/* Stats Tier */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 lg:grid-cols-6">
        <div className="bg-surface p-4 rounded-2xl shadow-md flex flex-col items-center md:items-start text-center md:text-left">
          <p className="text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('devicesTab.total')}</p>
          <p className="text-2xl font-black text-primary leading-none">{devices.length}</p>
        </div>
        <div className="bg-surface p-4 rounded-2xl shadow-md flex flex-col items-center md:items-start text-center md:text-left">
          <p className="text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('devicesTab.online')}</p>
          <p className="text-2xl font-black text-emerald-500 leading-none">{onlineCount}</p>
        </div>
        <div className="bg-surface p-4 rounded-2xl shadow-md flex flex-col items-center md:items-start text-center md:text-left">
          <p className="text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('devicesTab.offline')}</p>
          <p className="text-2xl font-black text-error-text leading-none">{devices.length - onlineCount}</p>
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-4 md:items-center justify-between">
        <div className="relative flex-1 max-w-md">
          <Input
            placeholder={t('devicesTab.searchDevices')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            icon="search"
            className="bg-white border-divider-light shadow-sm-bottom"
          />
        </div>
        <div className="flex overflow-x-auto no-scrollbar gap-8 border-b border-divider-light md:border-none">
          {DEVICE_TYPES.map((dt) => (
            <button
              key={dt.value}
              onClick={() => setTypeFilter(dt.value)}
              className={`pb-2.5 text-[10px] font-black uppercase tracking-widest border-b-2 transition-colors whitespace-nowrap ${typeFilter === dt.value ? 'border-primary text-primary' : 'border-transparent text-text-light'
                }`}
            >
              {t(dt.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* List Layout */}
      <div className="space-y-3">
        {filteredDevices.length === 0 ? (
          <div className="py-20 text-center bg-surface rounded-2xl shadow-md">
            <span className="material-symbols-outlined text-text-light text-5xl mb-3">router</span>
            <p className="text-sm font-bold text-text-muted uppercase tracking-widest">{t('devicesTab.noDevicesFoundShort')}</p>
          </div>
        ) : (
          filteredDevices.map((device) => (
            <div
              key={device.id}
              onClick={() => openEditModal(device)}
              className="flex items-center justify-between p-4 bg-surface rounded-2xl shadow-md hover:shadow-xl active:scale-[0.99] transition-all cursor-pointer group"
            >
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 flex items-center justify-center bg-primary/10 rounded-2xl text-primary shadow-inner">
                  <span className="material-symbols-outlined text-2xl">{getDeviceIcon(device.deviceType)}</span>
                </div>
                <div>
                  <h4 className="text-base font-black text-text-dark leading-tight">{device.name}</h4>
                  <div className="mt-1 space-y-0.5">
                    <p className="text-[10px] font-bold text-text-light uppercase tracking-widest">
                      {device.ipAddress}:{device.port} • {getDeviceTypeLabel(device.deviceType, t)}
                    </p>
                    <div className="flex gap-3 text-[9px] font-bold text-text-muted/60 uppercase tracking-tight">
                      <span>SN: {device.deviceIdentifier}</span>
                      {device.macAddress && <span>MAC: {device.macAddress}</span>}
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <Badge
                  variant={device.status === 'Online' ? 'success' : 'error'}
                  dot
                  title={device.status === 'Offline' ? (device.statusMessage || t('devicesTab.connectionLostTimeout')) : undefined}
                >
                  {device.status === 'Online' ? t('devicesTab.online') : t('devicesTab.offline')}
                </Badge>
                <span className="material-symbols-outlined text-text-light group-hover:text-text-muted transition-colors">chevron_right</span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Create/Edit Modal */}
      <Modal
        isOpen={modalMode === 'create' || modalMode === 'edit'}
        onClose={closeModals}
        title={modalMode === 'create' ? t('devicesTab.addAccessDevice') : t('devicesTab.deviceConfiguration')}
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('devicesTab.labelName')}</label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData((p) => ({ ...p, name: e.target.value }))}
                placeholder={t('devicesTab.namePlaceholder')}
              />
            </div>
            <div>
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('devicesTab.ipAddress')}</label>
              <Input
                value={formData.ipAddress}
                onChange={(e) => setFormData((p) => ({ ...p, ipAddress: e.target.value }))}
                placeholder="192.168.1.50"
              />
            </div>
            <div>
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('devicesTab.servicePort')}</label>
              <Input
                type="number"
                value={formData.port}
                onChange={(e) => setFormData((p) => ({ ...p, port: parseInt(e.target.value, 10) || 8000 }))}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('devicesTab.physicalLocation')}</label>
              <Input
                value={formData.location}
                onChange={(e) => setFormData((p) => ({ ...p, location: e.target.value }))}
                placeholder={t('devicesTab.locationPlaceholder')}
              />
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('devicesTab.deviceType')}</label>
            <select
              value={formData.deviceType}
              onChange={(e) => setFormData((p) => ({ ...p, deviceType: parseInt(e.target.value, 10) }))}
              className="w-full h-9 px-3 bg-slate-75 border border-border-base rounded-md text-xs outline-none"
            >
              <option value={1}>{t('devicesTab.deviceTypeLabels.AccessController')}</option>
              <option value={2}>{t('devicesTab.deviceTypeLabels.Intercom')}</option>
              <option value={3}>{t('devicesTab.deviceTypeLabels.AttendanceTerminal')}</option>
              <option value={4}>{t('devicesTab.deviceTypeLabels.ElevatorController')}</option>
              <option value={5}>{t('devicesTab.deviceTypeLabels.EnrollerStation')}</option>
              <option value={6}>ANPR Camera</option>
            </select>
          </div>

          {/* Что проход через это устройство значит для табеля. Пока стоит «и приход,
              и уход», день считается по первому и последнему событию — и повторный
              проход утром выглядит как уход. Разведя вход и выход по устройствам,
              этого не происходит. У ANPR-камеры своё направление (парковка). */}
          {formData.deviceType !== ANPR_DEVICE_TYPE && (
            <div>
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('devicesTab.attendanceDirection.label')}</label>
              <select
                value={formData.attendanceDirection}
                onChange={(e) => setFormData((p) => ({ ...p, attendanceDirection: e.target.value as DeviceFormData['attendanceDirection'] }))}
                className="w-full h-9 px-3 bg-slate-75 border border-border-base rounded-md text-xs outline-none"
              >
                <option value="Both">{t('devicesTab.attendanceDirection.both')}</option>
                <option value="In">{t('devicesTab.attendanceDirection.in')}</option>
                <option value="Out">{t('devicesTab.attendanceDirection.out')}</option>
              </select>
              <p className="mt-1 text-[10px] text-text-light">{t('devicesTab.attendanceDirection.hint')}</p>
            </div>
          )}

          {/* Камера парковки: куда относить проезд и в какую зону писать сессию. */}
          {formData.deviceType === ANPR_DEVICE_TYPE && (
            <div className="grid grid-cols-2 gap-3 p-3 rounded-xl bg-slate-75 border border-border-base">
              <div>
                <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('devicesTab.anpr.direction')}</label>
                <select
                  value={formData.parkingDirection}
                  onChange={(e) => setFormData((p) => ({ ...p, parkingDirection: e.target.value as DeviceFormData['parkingDirection'] }))}
                  className="w-full h-9 px-3 bg-white border border-border-base rounded-md text-xs outline-none"
                >
                  <option value="">{t('devicesTab.anpr.directionAuto')}</option>
                  <option value="Entry">{t('devicesTab.anpr.entry')}</option>
                  <option value="Exit">{t('devicesTab.anpr.exit')}</option>
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('devicesTab.anpr.zone')}</label>
                <select
                  value={formData.parkingZoneId}
                  onChange={(e) => setFormData((p) => ({ ...p, parkingZoneId: e.target.value }))}
                  className="w-full h-9 px-3 bg-white border border-border-base rounded-md text-xs outline-none"
                >
                  <option value="">{t('devicesTab.anpr.zoneAny')}</option>
                  {parkingZones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
                </select>
              </div>
              {/* Реле шлагбаума: пока номер не задан, камера открывает шлагбаум сама,
                  и решения сервера (чёрный список, режим «по пропускам») на железо не влияют. */}
              <div>
                <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('devicesTab.anpr.barrierOutput')}</label>
                <Input
                  type="number"
                  min={0}
                  value={formData.barrierOutput}
                  onChange={(e) => setFormData((p) => ({ ...p, barrierOutput: e.target.value }))}
                  placeholder="0"
                />
              </div>
              {modalMode === 'edit' && (
                <div className="flex items-end">
                  <Button
                    type="button"
                    variant="outline"
                    icon="bolt"
                    fullWidth
                    isLoading={barrierTesting}
                    onClick={() => void handleBarrierTest()}
                  >
                    {t('devicesTab.anpr.testBarrier')}
                  </Button>
                </div>
              )}
              {barrierTest && (
                <p className={`col-span-2 text-[11px] font-bold ${barrierTest.ok ? 'text-green-700' : 'text-error-text'}`}>
                  {barrierTest.text}
                </p>
              )}
              <p className="col-span-2 text-[10px] text-text-light leading-relaxed">{t('devicesTab.anpr.hint')}</p>
              <p className="col-span-2 text-[10px] text-text-light leading-relaxed">{t('devicesTab.anpr.barrierHint')}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('devicesTab.username')}</label>
              <Input
                value={formData.username}
                onChange={(e) => setFormData((p) => ({ ...p, username: e.target.value }))}
                placeholder="admin"
              />
            </div>
            <div>
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('devicesTab.secretKeyPassword')}</label>
              <Input
                type="password"
                value={formData.password}
                onChange={(e) => setFormData((p) => ({ ...p, password: e.target.value }))}
                placeholder="••••••••"
              />
            </div>
          </div>

          <div className="flex gap-2 pt-4">
            <Button fullWidth onClick={modalMode === 'create' ? handleCreate : handleUpdate} isLoading={isSubmitting} disabled={!canCreateOrUpdate || isSubmitting}>
              {modalMode === 'create' ? t('devicesTab.registerDevice') : t('common.saveChanges')}
            </Button>
            <Button fullWidth variant="outline" onClick={closeModals}>{t('common.cancel')}</Button>
          </div>

          {modalMode === 'edit' && (
            <div className="pt-4 border-t border-divider-light">
              <Button fullWidth variant="danger" icon="delete" onClick={() => openDeleteModal(editingDevice!)}>{t('devicesTab.removeDevice')}</Button>
            </div>
          )}
        </div>
      </Modal>

      {/* Discover Modal */}
      <Modal
        isOpen={modalMode === 'discover' || modalMode === 'activate'}
        onClose={closeModals}
        title={t('devicesTab.networkDiscovery')}
        fullScreen
        className="bg-background-light"
      >
        <div className="h-full flex flex-col space-y-4">
          <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <p className="text-xs font-bold text-text-muted uppercase tracking-widest min-w-[100px]">
                {isDiscovering ? t('devicesTab.scanning') : t('devicesTab.foundCount', { count: discovered.length })}
              </p>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showAddedDevices}
                  onChange={(e) => setShowAddedDevices(e.target.checked)}
                  className="w-4 h-4 rounded border-divider-light text-primary focus:ring-primary/20 transition-all"
                />
                <span className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('devicesTab.showRegistered')}</span>
              </label>
            </div>
            <div className="flex-1 max-w-md relative">
              <Input
                size="sm"
                placeholder={t('devicesTab.searchByIpSerialModel')}
                value={discoverSearchQuery}
                onChange={(e) => setDiscoverSearchQuery(e.target.value)}
                icon="search"
                className="bg-white border-divider-light"
              />
            </div>
            <Button size="sm" variant="outline" icon="sync" onClick={handleDiscoverRefresh} isLoading={isDiscovering}>
              {isDiscovering ? t('devicesTab.scanningShort') : t('devicesTab.rescan')}
            </Button>
          </div>

          {/* Discovery Filter Tabs */}
          <div className="flex overflow-x-auto no-scrollbar gap-6 border-b border-divider-light">
            {DISCOVER_TYPE_TABS.map((tab) => (
              <button
                key={tab.value}
                onClick={() => setDiscoverTypeTab(tab.value)}
                className={`pb-2 text-[10px] font-black uppercase tracking-widest border-b-2 transition-colors whitespace-nowrap ${discoverTypeTab === tab.value ? 'border-primary text-primary' : 'border-transparent text-text-light'
                  }`}
              >
                {t(tab.labelKey)}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto space-y-3 pb-4">
            {(() => {
              const addedKeys = new Set(devices.flatMap((dev) => [dev.deviceIdentifier, `${dev.ipAddress}:${dev.port}`]))
              const isAdded = (d: { deviceIdentifier: string; ipAddress: string; port: number }) =>
                addedKeys.has(d.deviceIdentifier) || addedKeys.has(`${d.ipAddress}:${d.port}`)

              const filtered = discovered
                .map((d) => ({
                  ...d,
                  inferredType: inferDeviceTypeFromModel(d.model, d.deviceIdentifier),
                  isActive: d.isActivated ?? !!(d.macAddress && d.firmwareVersion),
                }))
                .filter((d) => showAddedDevices || !isAdded(d))
                .filter((d) => discoverTypeTab === 'all' || d.inferredType === discoverTypeTab)
                .filter((d) => {
                  if (!discoverSearchQuery.trim()) return true
                  const q = discoverSearchQuery.toLowerCase().trim()
                  const searchable = `${d.ipAddress} ${d.deviceIdentifier} ${d.model || ''} ${d.macAddress || ''}`.toLowerCase()
                  return searchable.includes(q)
                })
                .sort((a, b) => {
                  const cmp = a.ipAddress.localeCompare(b.ipAddress)
                  return discoverIpSort === 'asc' ? cmp : -cmp
                })

              if (filtered.length === 0) {
                return (
                  <div className="py-20 text-center">
                    <span className="material-symbols-outlined text-4xl text-text-light mb-2">radar</span>
                    <p className="text-xs font-bold text-text-muted uppercase tracking-widest">{t('devicesTab.noMatchingDevices')}</p>
                  </div>
                )
              }

              return filtered.map((d) => {
                const added = isAdded(d)
                return (
                  <div
                    key={d.deviceIdentifier}
                    className={`p-4 rounded-2xl border-none transition-all duration-300 ${added
                      ? 'bg-emerald-50 shadow-sm opacity-80'
                      : 'bg-surface shadow-md hover:shadow-xl hover:-translate-y-0.5 cursor-pointer'
                      }`}
                  >
                    <div className="flex justify-between items-start mb-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-black text-text-dark leading-none">{d.model || t('devicesTab.unknownModel')}</p>
                          {added ? (
                            <Badge variant="success" className="text-[8px] px-1.5 py-0">{t('devicesTab.added')}</Badge>
                          ) : (
                            <Badge variant={d.isActive ? 'neutral' : 'error'} className="text-[8px] px-1.5 py-0">{d.isActive ? t('devicesTab.activated') : t('devicesTab.inactive')}</Badge>
                          )}
                        </div>
                        <p className="text-[10px] font-bold text-primary uppercase tracking-widest">{d.ipAddress}:{d.port}</p>
                        <div className="flex flex-wrap gap-x-4 gap-y-1">
                          <div className="flex items-center gap-1.5 opacity-60">
                            <span className="text-[9px] font-mono font-bold uppercase tracking-wider">MAC: {d.macAddress || t('devicesTab.noMac')}</span>
                          </div>
                          <div className="flex items-center gap-1.5 opacity-60">
                            <span className="text-[9px] font-mono font-bold uppercase tracking-wider">SN: {d.deviceIdentifier}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-2 justify-end">
                      {added ? null : d.isActive ? (
                        <Button className="w-full md:w-fit md:px-6" size="sm" icon="add" onClick={() => openAddFromDiscoveredModal(d)}>{t('devicesTab.addDevice')}</Button>
                      ) : (
                        <Button className="w-full md:w-fit md:px-6" variant="outline" icon="lock_open" onClick={() => openActivateModal(d)}>{t('devicesTab.activate')}</Button>
                      )}
                    </div>
                  </div>
                )
              })
            })()}
          </div>

          <div className="flex justify-end">
            <Button className="w-full md:w-fit md:px-12" variant="outline" onClick={closeModals}>{t('devicesTab.closeExplorer')}</Button>
          </div>
        </div>
      </Modal>

      {/* Activation Sub-Modal */}
      <Modal isOpen={modalMode === 'activate'} onClose={closeActivateModal} title={t('devicesTab.securityActivation')}>
        <div className="space-y-4 p-2">
          <p className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('devicesTab.setActivationPassword', { ip: activatingDevice?.ipAddress })}</p>
          <div className="space-y-4">
            <div className="bg-slate-50 p-4 rounded-2xl shadow-inner border-none">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-2 px-1">{t('devicesTab.newPasswordMin8')}</label>
              <Input type="password" value={activatePassword} onChange={e => setActivatePassword(e.target.value)} placeholder={t('devicesTab.minimum8Characters')} className="bg-white" />
            </div>
            <div className="bg-slate-50 p-4 rounded-2xl shadow-inner border-none">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-2 px-1">{t('devicesTab.confirmIdentity')}</label>
              <Input type="password" value={activateConfirm} onChange={e => setActivateConfirm(e.target.value)} placeholder={t('devicesTab.repeatPassword')} className="bg-white" />
            </div>
          </div>
          {activateError && <div className="p-3 bg-error-bg text-error-text rounded-xl text-xs font-bold border border-error-text/10">{activateError}</div>}
          <div className="flex gap-2 pt-4">
            <Button fullWidth onClick={handleActivate} isLoading={isSubmitting} disabled={activatePassword.length < 8 || activatePassword !== activateConfirm || isSubmitting}>{t('devicesTab.activate')}</Button>
            <Button fullWidth variant="outline" onClick={closeActivateModal}>{t('devicesTab.abort')}</Button>
          </div>
        </div>
      </Modal>

      {/* Add from Discovery Shortcut Modal */}
      <Modal isOpen={!!addFromDevice} onClose={closeAddFromDiscoveredModal} title={t('devicesTab.registerDiscovered')}>
        <div className="space-y-4">
          <p className="text-xs font-bold text-text-muted uppercase tracking-widest">{t('devicesTab.addToFleet', { ip: addFromDevice?.ipAddress })}</p>
          <div className="space-y-3">
            <div>
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('devicesTab.friendlyName')}</label>
              <Input value={addDeviceName} onChange={e => setAddDeviceName(e.target.value)} placeholder={t('devicesTab.friendlyNamePlaceholder')} />
            </div>
            <div>
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('devicesTab.credentialsUsername')}</label>
              <Input value={addDeviceUsername} onChange={e => setAddDeviceUsername(e.target.value)} placeholder="admin" />
            </div>
            <div>
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('devicesTab.secretKeyPassword')}</label>
              <Input type="password" value={addDevicePassword} onChange={e => setAddDevicePassword(e.target.value)} placeholder={t('devicesTab.required')} />
            </div>
          </div>
          <div className="flex gap-2 pt-4">
            <Button fullWidth onClick={handleAddFromDiscoveredSubmit} isLoading={isSubmitting} disabled={!addDeviceName || !addDevicePassword || isSubmitting}>{t('devicesTab.addDevice')}</Button>
            <Button fullWidth variant="outline" onClick={closeAddFromDiscoveredModal}>{t('common.cancel')}</Button>
          </div>
        </div>
      </Modal>

      {/* Network warning dialog */}
      <Modal
        isOpen={!!networkWarningMessage}
        onClose={() => setNetworkWarningMessage(null)}
        title={t('devicesTab.networkConfigurationAlert')}
      >
        <div className="space-y-4">
          <div className="w-12 h-12 bg-amber-50 rounded-2xl flex items-center justify-center text-amber-500 mb-2">
            <span className="material-symbols-outlined text-2xl">router</span>
          </div>
          <p className="text-sm font-black text-text-dark leading-tight">{networkWarningMessage ?? t('devicesTab.subnetMismatch')}</p>
          <p className="text-xs text-text-light leading-relaxed">
            {t('devicesTab.subnetMismatchExplanation')}
          </p>
          <Button fullWidth variant="outline" onClick={() => setNetworkWarningMessage(null)}>{t('devicesTab.acknowledge')}</Button>
        </div>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal isOpen={modalMode === 'delete'} onClose={closeModals} title={t('devicesTab.systemDeletion')}>
        <div className="space-y-4">
          <p className="text-sm font-bold text-text-dark">{t('devicesTab.removeFromFleetQuestion', { name: deletingDevice?.name })}</p>
          <p className="text-xs text-text-light leading-relaxed">{t('devicesTab.deletionWarning')}</p>
          <div className="flex gap-2 pt-4">
            <Button variant="danger" fullWidth onClick={handleDelete} isLoading={isSubmitting}>{t('devicesTab.confirmDeletion')}</Button>
            <Button variant="outline" fullWidth onClick={closeModals} disabled={isSubmitting}>{t('common.cancel')}</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
})
