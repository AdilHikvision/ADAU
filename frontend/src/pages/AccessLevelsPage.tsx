import { useCallback, useEffect, useMemo, useState } from 'react'
import { HubConnectionBuilder, HttpTransportType, LogLevel } from '@microsoft/signalr'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/AuthContext'
import { AppLayout } from '../components/templates'
import { Badge, Button, Input } from '../components/atoms'
import { PageHeader, Modal, PeoplePicker, type PickerGroup, type PickerPerson } from '../components/organisms'
import { useLoading } from '../context/LoadingContext'
import { useModule } from '../context/ModuleContext'
import { apiRequest, getHubUrl } from '../lib/api'
import { loadHousingBlocks } from './housingBlocks'
import { newId } from '../lib/id'

interface AccessLevelDoor {
  deviceId: string
  deviceName: string
  doorIndex: number
  /** true — elevator controller (doorIndex = floor, 0-based → ISAPI doorID = +1) */
  isElevator?: boolean
}

interface AccessLevel {
  id: string
  name: string
  description?: string | null
  createdUtc: string
  updatedUtc?: string | null
  doors?: AccessLevelDoor[]
  /** Считаются раздельно: в «Компании» показываем только работников, в ADAU/ЖКХ — вместе со студентами. */
  employeeCount?: number
  residentCount?: number
}

/** Человек, назначенный на уровень доступа. */
interface AccessLevelPerson {
  id: string
  firstName: string
  lastName: string
  employeeNo?: string | null
  kind: 'employee' | 'resident'
  departmentName?: string | null
  housingBlockName?: string | null
}

/** Человек из справочника — для окна выбора. */
interface DirectoryPerson {
  id: string
  firstName: string
  lastName: string
  employeeNo?: string | null
  department?: { id: string; name: string } | null
  housingBlockId?: string | null
  housingBlockName?: string | null
}

interface Device {
  id: string
  name: string
  deviceIdentifier: string
  deviceType?: string
}

interface DeviceDoor {
  deviceId: string
  deviceName: string
  doorIndex: number
  doorName?: string | null
  status?: string | null
  isElevator?: boolean
}

interface AccessLevelFormData {
  name: string
  description: string
}

const emptyForm: AccessLevelFormData = {
  name: '',
  description: '',
}

const ACCESS_TABS = [
  { value: 'access-level', labelKey: 'accessLevels.tabAccessLevel' },
  { value: 'doors', labelKey: 'accessLevels.tabDoorsFloors' },
] as const

export function AccessLevelsPage() {
  const { t } = useTranslation()
  const { token } = useAuth()
  const { startLoading, stopLoading, isLoading } = useLoading()

  const floorOrDoorLabel = useCallback((doorIndex: number, doorName: string | null | undefined, isElevator?: boolean) => {
    const n = doorName?.trim()
    if (n) return n
    const no = doorIndex + 1
    return isElevator ? t('accessLevels.floorN', { n: no }) : t('accessLevels.doorN', { n: no })
  }, [t])
  const [accessLevels, setAccessLevels] = useState<AccessLevel[]>([])
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [tabFilter, setTabFilter] = useState<(typeof ACCESS_TABS)[number]['value']>('access-level')
  const [modalMode, setModalMode] = useState<'create' | 'edit' | 'delete' | 'doors' | null>(null)
  const [editingItem, setEditingItem] = useState<AccessLevel | null>(null)
  const [deletingItem, setDeletingItem] = useState<AccessLevel | null>(null)
  const [doorsItem, setDoorsItem] = useState<AccessLevel | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [addDoorDeviceId, setAddDoorDeviceId] = useState('')
  const [addDoorIndex, setAddDoorIndex] = useState(0)
  const [formData, setFormData] = useState<AccessLevelFormData>(emptyForm)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [doorsList, setDoorsList] = useState<DeviceDoor[]>([])
  const [doorsLoading, setDoorsLoading] = useState(false)
  const [doorsError, setDoorsError] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    if (!token) return
    setError(null)
    startLoading()
    try {
      const list = await apiRequest<AccessLevel[]>('/api/access-levels', { token })
      setAccessLevels(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('accessLevels.errors.loadFailed'))
    } finally {
      stopLoading()
    }
  }, [token, startLoading, stopLoading, t])

  useEffect(() => {
    loadData()
  }, [loadData])

  const loadDoors = useCallback(async () => {
    if (!token) return
    setDoorsError(null)
    setDoorsLoading(true)
    try {
      const list = await apiRequest<DeviceDoor[]>('/api/devices/doors', { token })
      setDoorsList(list)
    } catch (e) {
      setDoorsError(e instanceof Error ? e.message : t('accessLevels.errors.loadDoorsFailed'))
      setDoorsList([])
    } finally {
      setDoorsLoading(false)
    }
  }, [token, t])

  useEffect(() => {
    if (token) {
      loadDoors()
    }
  }, [token, loadDoors])

  const filteredLevels = useMemo(() => {
    if (!searchQuery.trim()) return accessLevels
    const q = searchQuery.toLowerCase().trim().replace(/\s+/g, ' ')
    const terms = q.split(' ').filter(Boolean)
    return accessLevels.filter((item) => {
      const name = (item.name ?? '').toLowerCase()
      const desc = (item.description ?? '').toLowerCase()
      const searchable = `${name} ${desc}`
      return terms.every((term) => searchable.includes(term))
    })
  }, [accessLevels, searchQuery])

  // ── Люди на уровне доступа ──────────────────────────────────────────────────
  // В модуле ADAU/ЖКХ на уровень назначают и работников, и студентов (жильцов);
  // в «Компании» студентов нет вовсе, поэтому там только работники.
  const { activeModule } = useModule()
  const withResidents = activeModule === 'housing'
  const [peopleItem, setPeopleItem] = useState<AccessLevel | null>(null)
  const [levelPeople, setLevelPeople] = useState<AccessLevelPerson[]>([])
  const [peopleLoading, setPeopleLoading] = useState(false)
  const [peopleError, setPeopleError] = useState<string | null>(null)
  const [peoplePickerOpen, setPeoplePickerOpen] = useState(false)
  const [directory, setDirectory] = useState<DirectoryPerson[]>([])
  const [departments, setDepartments] = useState<PickerGroup[]>([])
  const [blocks, setBlocks] = useState<PickerGroup[]>([])
  // Запись на устройства идёт не мгновенно: пока она длится, показываем окно
  // прогресса, а по завершении — окно с итогом (в нём же предупреждения синхронизации).
  // Итог показываем разбивкой по устройствам: видно, куда записалось, а куда нет.
  type DeviceOutcome = { name: string; done: number; skipped: number; errors: number }
  const [peopleProgress, setPeopleProgress] = useState<{ kind: 'assign' | 'remove' | 'repush'; count: number; name?: string; done?: number; device?: string } | null>(null)
  // Снятие уровня и перезапись работают с выбранными в списке людьми.
  const [selectedPeople, setSelectedPeople] = useState<Set<string>>(new Set())
  const [peopleResult, setPeopleResult] = useState<{ kind: 'assign' | 'remove' | 'repush'; added: number; alreadyAssigned: number; name?: string; warnings: string[]; devices?: DeviceOutcome[] } | null>(null)
  const assignSaving = peopleProgress !== null

  /** Сколько людей показывать на карточке уровня — по правилам модуля. */
  const peopleCountOf = (item: AccessLevel) =>
    (item.employeeCount ?? 0) + (withResidents ? item.residentCount ?? 0 : 0)

  // В окно выбора отдаём только тех, кого на уровне ещё нет: добавлять повторно некуда,
  // а в длинном списке уже назначенные только мешают искать.
  const assignedPersonIds = useMemo(() => new Set(levelPeople.map((p) => p.id)), [levelPeople])
  const assignableDirectory = useMemo(
    () => directory.filter((p) => !assignedPersonIds.has(p.id)),
    [directory, assignedPersonIds],
  )

  const loadLevelPeople = useCallback(async (levelId: string) => {
    if (!token) return
    setPeopleLoading(true)
    setPeopleError(null)
    try {
      // Без kind сервер вернёт оба типа — это и нужно в ADAU/ЖКХ.
      const query = withResidents ? '' : '?kind=employee'
      const list = await apiRequest<AccessLevelPerson[]>(`/api/access-levels/${levelId}/people${query}`, { token })
      setLevelPeople(list)
    } catch (e) {
      setLevelPeople([])
      setPeopleError(e instanceof Error ? e.message : t('accessLevelPeople.loadFailed'))
    } finally {
      setPeopleLoading(false)
    }
  }, [token, withResidents, t])

  async function openPeopleModal(item: AccessLevel) {
    setPeopleItem(item)
    setLevelPeople([])
    // Выбор относится к составу конкретного уровня — начинаем с чистого.
    setSelectedPeople(new Set())
    await loadLevelPeople(item.id)
  }

  /** Справочник для окна выбора грузим один раз при первом открытии. */
  async function openPeoplePicker() {
    if (!token) return
    setPeoplePickerOpen(true)
    if (directory.length > 0) return
    try {
      const employees = await apiRequest<DirectoryPerson[]>('/api/employees?isActive=true', { token })
      const depts = await apiRequest<PickerGroup[]>('/api/departments/tree', { token }).catch(() => [])
      setDepartments(depts)
      if (withResidents) {
        const [residents, housing] = await Promise.all([
          apiRequest<DirectoryPerson[]>('/api/employees?isActive=true&kind=resident', { token }).catch(() => []),
          loadHousingBlocks(token).catch(() => []),
        ])
        setDirectory([...employees, ...residents])
        setBlocks(housing)
      } else {
        setDirectory(employees)
      }
    } catch (e) {
      setPeopleError(e instanceof Error ? e.message : t('accessLevelPeople.loadFailed'))
    }
  }

  /**
   * Ждёт, пока сервер допишет людей на устройства. Запись идёт в фоне и докладывает о себе
   * событиями PersonSyncProgress: на каждого человека приходит своё «complete», поэтому
   * считаем их. Если события перестали приходить, выходим по тишине — лучше показать итог
   * с оговоркой, чем держать окно вечно.
   */
  async function waitForDeviceSync(syncId: string, people: number, silenceMs = 120000) {
    const warnings: string[] = []
    const devices = new Map<string, DeviceOutcome>()
    const bump = (name: string, field: 'done' | 'skipped' | 'errors') => {
      if (!name) return
      const row = devices.get(name) ?? { name, done: 0, skipped: 0, errors: 0 }
      row[field] += 1
      devices.set(name, row)
    }
    const hub = new HubConnectionBuilder()
      .withUrl(`${getHubUrl()}/hubs/devices`, {
        accessTokenFactory: () => token!,
        skipNegotiation: true,
        transport: HttpTransportType.WebSockets,
      })
      .configureLogging(LogLevel.Error)
      .build()

    let done = 0
    let finished = false
    try {
      await new Promise<void>((resolve) => {
        let silence: ReturnType<typeof setTimeout>
        const stop = () => { if (!finished) { finished = true; clearTimeout(silence); resolve() } }
        const restartSilence = () => {
          clearTimeout(silence)
          silence = setTimeout(stop, silenceMs)
        }

        hub.on('PersonSyncProgress', (evt: { syncId: string; stage: string; deviceName?: string; message?: string | null }) => {
          if (!evt || evt.syncId !== syncId) return
          restartSilence()
          if (evt.stage === 'done') bump(evt.deviceName ?? '', 'done')
          if (evt.stage === 'skipped' || evt.stage === 'error') {
            bump(evt.deviceName ?? '', evt.stage === 'skipped' ? 'skipped' : 'errors')
            const text = evt.deviceName ? `${evt.deviceName}: ${evt.message ?? evt.stage}` : (evt.message ?? evt.stage)
            if (!warnings.includes(text)) warnings.push(text)
          }
          if (evt.stage === 'complete') {
            done += 1
            setPeopleProgress((prev) => (prev ? { ...prev, done, device: '' } : prev))
            if (done >= people) stop()
            return
          }
          setPeopleProgress((prev) => (prev ? { ...prev, done, device: evt.deviceName ?? undefined } : prev))
        })

        restartSilence()
        hub.start().catch(() => stop())
      })
    } finally {
      await hub.stop().catch(() => undefined)
    }
    return { warnings, done, devices: [...devices.values()].sort((a, b) => a.name.localeCompare(b.name)) }
  }

  async function assignPeople(personIds: string[]) {
    if (!token || !peopleItem || personIds.length === 0) return
    // syncId придумывает клиент: подписка должна начаться раньше, чем сервер зашлёт
    // первые события, иначе часть прогресса пройдёт мимо окна.
    const syncId = newId('sync').replace(/-/g, '')
    setPeopleProgress({ kind: 'assign', count: personIds.length, done: 0 })
    setPeopleError(null)
    try {
      const res = await apiRequest<{ added: number; alreadyAssigned: number; syncId?: string; warnings?: string[] }>(
        `/api/access-levels/${peopleItem.id}/people`,
        { method: 'POST', token, body: JSON.stringify({ personIds, syncId }) },
      )
      const added = res.added ?? 0
      const synced = added > 0
        ? await waitForDeviceSync(res.syncId ?? syncId, added)
        : { warnings: [] as string[], done: 0, devices: [] as DeviceOutcome[] }
      await loadLevelPeople(peopleItem.id)
      await loadData()
      setPeopleResult({
        kind: 'assign',
        added,
        alreadyAssigned: res.alreadyAssigned ?? 0,
        devices: synced.devices,
        // Если фоновая запись не доложила обо всех, честно пишем это в итог:
        // уровень в базе стоит, но на турникете он может ещё не появиться.
        warnings: [
          ...(res.warnings ?? []),
          ...synced.warnings,
          ...(added > synced.done
            ? [t('accessLevelPeople.syncIncomplete', { done: synced.done, total: added })]
            : []),
        ],
      })
    } catch (e) {
      setPeopleError(e instanceof Error ? e.message : t('accessLevelPeople.saveFailed'))
    } finally {
      setPeopleProgress(null)
    }
  }

  const togglePersonSelected = (id: string) =>
    setSelectedPeople((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const allPeopleSelected = levelPeople.length > 0 && levelPeople.every((p) => selectedPeople.has(p.id))
  const toggleAllPeople = () =>
    setSelectedPeople(allPeopleSelected ? new Set() : new Set(levelPeople.map((p) => p.id)))

  /** Снимает уровень с выбранных: доступ каждого пересчитывается по остальным его уровням. */
  async function removeSelectedPeople() {
    if (!token || !peopleItem || selectedPeople.size === 0) return
    const ids = [...selectedPeople]
    if (!window.confirm(t('accessLevelPeople.removeSelectedConfirm', { count: ids.length }))) return
    const syncId = newId('sync').replace(/-/g, '')
    setPeopleProgress({ kind: 'remove', count: ids.length, done: 0 })
    setPeopleError(null)
    try {
      const res = await apiRequest<{ removed: number; syncId?: string; warnings?: string[] }>(
        `/api/access-levels/${peopleItem.id}/people/remove`,
        { method: 'POST', token, body: JSON.stringify({ personIds: ids, syncId }) },
      )
      const removed = res.removed ?? ids.length
      const synced = await waitForDeviceSync(res.syncId ?? syncId, removed)
      setSelectedPeople(new Set())
      await loadLevelPeople(peopleItem.id)
      await loadData()
      setPeopleResult({
        kind: 'remove',
        added: removed,
        alreadyAssigned: 0,
        warnings: [...(res.warnings ?? []), ...synced.warnings],
        devices: synced.devices,
      })
    } catch (e) {
      setPeopleError(e instanceof Error ? e.message : t('accessLevelPeople.saveFailed'))
    } finally {
      setPeopleProgress(null)
    }
  }

  /** Перезапись: сперва стирает людей с их устройств, потом пишет заново. */
  async function repushPeople() {
    if (!token || !peopleItem || levelPeople.length === 0) return
    const ids = selectedPeople.size > 0 ? [...selectedPeople] : levelPeople.map((p) => p.id)
    if (!window.confirm(t('accessLevelPeople.repushConfirm', { count: ids.length }))) return
    const syncId = newId('sync').replace(/-/g, '')
    setPeopleProgress({ kind: 'repush', count: ids.length, done: 0 })
    setPeopleError(null)
    try {
      const res = await apiRequest<{ count: number; syncId?: string; warnings?: string[] }>(
        `/api/access-levels/${peopleItem.id}/people/repush`,
        { method: 'POST', token, body: JSON.stringify({ personIds: ids, syncId }) },
      )
      const count = res.count ?? ids.length
      const synced = await waitForDeviceSync(res.syncId ?? syncId, count)
      await loadLevelPeople(peopleItem.id)
      setPeopleResult({
        kind: 'repush',
        added: count,
        alreadyAssigned: 0,
        warnings: [
          ...(res.warnings ?? []),
          ...synced.warnings,
          ...(count > synced.done ? [t('accessLevelPeople.syncIncomplete', { done: synced.done, total: count })] : []),
        ],
        devices: synced.devices,
      })
    } catch (e) {
      setPeopleError(e instanceof Error ? e.message : t('accessLevelPeople.saveFailed'))
    } finally {
      setPeopleProgress(null)
    }
  }

  async function removePerson(person: AccessLevelPerson) {
    if (!token || !peopleItem) return
    const name = `${person.firstName} ${person.lastName}`
    if (!window.confirm(t('accessLevelPeople.removeConfirm', { name }))) return
    setPeopleProgress({ kind: 'remove', count: 1, name })
    setPeopleError(null)
    try {
      const res = await apiRequest<{ removed: number; warnings: string[] }>(
        `/api/access-levels/${peopleItem.id}/people/${person.id}`,
        { method: 'DELETE', token },
      )
      await loadLevelPeople(peopleItem.id)
      await loadData()
      setPeopleResult({ kind: 'remove', added: 0, alreadyAssigned: 0, name, warnings: res?.warnings ?? [] })
    } catch (e) {
      setPeopleError(e instanceof Error ? e.message : t('accessLevelPeople.saveFailed'))
    } finally {
      setPeopleProgress(null)
    }
  }

  function openCreateModal() {
    setFormData(emptyForm)
    setModalMode('create')
  }

  function openEditModal(item: AccessLevel) {
    setEditingItem(item)
    setFormData({
      name: item.name,
      description: item.description ?? '',
    })
    setModalMode('edit')
  }

  function openDeleteModal(item: AccessLevel) {
    setDeletingItem(item)
    setModalMode('delete')
  }

  async function openDoorsModal(item: AccessLevel) {
    setDoorsItem(item)
    setAddDoorDeviceId('')
    setAddDoorIndex(0)
    setModalMode('doors')
    if (token) {
      try {
        const [devList, doorsListRes] = await Promise.all([
          apiRequest<Device[]>('/api/devices', { token }),
          apiRequest<DeviceDoor[]>('/api/devices/doors', { token }),
        ])
        setDevices(devList)
        setDoorsList(doorsListRes)
      } catch {
        setDevices([])
        setDoorsList([])
      }
    }
  }

  function closeModals() {
    setModalMode(null)
    setEditingItem(null)
    setDeletingItem(null)
    setDoorsItem(null)
    setFormData(emptyForm)
  }

  const canCreateOrUpdate = formData.name.trim().length > 0

  async function handleCreate() {
    if (!token) return
    setIsSubmitting(true)
    setError(null)
    try {
      const created = await apiRequest<AccessLevel>('/api/access-levels', {
        method: 'POST',
        token,
        body: JSON.stringify({
          name: formData.name.trim(),
          description: formData.description.trim() || null,
        }),
      })
      setAccessLevels((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)))
      closeModals()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('accessLevels.errors.createFailed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleUpdate() {
    if (!token || !editingItem) return
    setIsSubmitting(true)
    setError(null)
    try {
      const updated = await apiRequest<AccessLevel>(`/api/access-levels/${editingItem.id}`, {
        method: 'PUT',
        token,
        body: JSON.stringify({
          name: formData.name.trim(),
          description: formData.description.trim() || null,
        }),
      })
      setAccessLevels((prev) =>
        prev
          .map((x) => (x.id === updated.id ? updated : x))
          .sort((a, b) => a.name.localeCompare(b.name))
      )
      closeModals()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('accessLevels.errors.updateFailed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleDelete() {
    if (!token || !deletingItem) return
    setIsSubmitting(true)
    setError(null)
    try {
      await apiRequest(`/api/access-levels/${deletingItem.id}`, { method: 'DELETE', token })
      setAccessLevels((prev) => prev.filter((x) => x.id !== deletingItem.id))
      closeModals()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('accessLevels.errors.deleteFailed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleAddDoor() {
    if (!token || !doorsItem || !addDoorDeviceId) return
    setIsSubmitting(true)
    setError(null)
    try {
      await apiRequest(`/api/access-levels/${doorsItem.id}/doors`, {
        method: 'POST',
        token,
        body: JSON.stringify({ deviceId: addDoorDeviceId, doorIndex: addDoorIndex }),
      })
      const device = devices.find((d) => d.id === addDoorDeviceId)
      const isElev = device?.deviceType === 'ElevatorController'
      setAccessLevels((prev) =>
        prev.map((x) =>
          x.id === doorsItem.id
            ? {
              ...x,
              doors: [...(x.doors ?? []), { deviceId: addDoorDeviceId, deviceName: device?.name ?? '', doorIndex: addDoorIndex, isElevator: isElev }],
            }
            : x
        )
      )
      setDoorsItem((prev) =>
        prev
          ? {
            ...prev,
            doors: [...(prev.doors ?? []), { deviceId: addDoorDeviceId, deviceName: device?.name ?? '', doorIndex: addDoorIndex, isElevator: isElev }],
          }
          : null
      )
      setAddDoorDeviceId('')
      setAddDoorIndex(0)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('accessLevels.errors.addDoorFailed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleRemoveDoor(deviceId: string, doorIndex: number) {
    if (!token || !doorsItem) return
    setIsSubmitting(true)
    setError(null)
    try {
      await apiRequest(`/api/access-levels/${doorsItem.id}/doors/${deviceId}/${doorIndex}`, { method: 'DELETE', token })
      setAccessLevels((prev) =>
        prev.map((x) =>
          x.id === doorsItem.id ? { ...x, doors: (x.doors ?? []).filter((d) => d.deviceId !== deviceId || d.doorIndex !== doorIndex) } : x
        )
      )
      setDoorsItem((prev) =>
        prev ? { ...prev, doors: (prev.doors ?? []).filter((d) => d.deviceId !== deviceId || d.doorIndex !== doorIndex) } : null
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : t('accessLevels.errors.removeDoorFailed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <AppLayout onAction={openCreateModal}>
      <div className="flex-1 overflow-y-auto bg-background-light">
        <div className="p-6 md:p-8 space-y-6">
          <PageHeader
            className="hidden md:flex"
            title={t('accessLevels.pageTitle')}
            description={t('accessLevels.pageDescription')}
            actions={
              <Button icon="add_moderator" size="md" onClick={openCreateModal}>
                {t('accessLevels.createNewPolicy')}
              </Button>
            }
          />

          {error && (
            <div className="p-4 bg-error-bg text-error-text rounded-xl text-xs font-bold border border-error-text/10 max-h-40 overflow-y-auto whitespace-pre-wrap">
              {error}
            </div>
          )}

          {/* Top Stats Tier */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6 mb-2">
            <div className="bg-surface p-4 rounded-2xl shadow-md flex flex-col items-center md:items-start text-center md:text-left">
              <p className="text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('accessLevels.totalPolicies')}</p>
              <p className="text-2xl font-black text-primary leading-none">{accessLevels.length}</p>
            </div>
            <div className="bg-surface p-4 rounded-2xl shadow-md flex flex-col items-center md:items-start text-center md:text-left">
              <p className="text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('accessLevels.systemZones')}</p>
              <p className="text-2xl font-black text-primary leading-none">{doorsLoading ? '...' : doorsList.length}</p>
            </div>
          </div>

          {/* Search + Tabs Section */}
          <div className="space-y-4">
            <h2 className="text-sm font-black text-text-dark uppercase tracking-widest pt-4">{t('accessLevels.definedLevels')}</h2>

            <div className="flex flex-col sm:flex-row gap-4 items-stretch sm:items-center">
              <div className="flex-1 relative">
                <Input
                  placeholder={t('accessLevels.searchPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  icon="search"
                  className="bg-white border-divider-light"
                />
              </div>
            </div>

            <div className="flex overflow-x-auto no-scrollbar gap-8">
              {ACCESS_TABS.map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  onClick={() => setTabFilter(tab.value)}
                  className={`pb-2.5 text-xs font-black whitespace-nowrap uppercase tracking-widest border-b-2 transition-colors ${tabFilter === tab.value
                    ? 'border-primary text-primary'
                    : 'border-transparent text-text-light hover:text-text-muted'
                    }`}
                >
                  {t(tab.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {tabFilter === 'access-level' && (
            <div className="space-y-3">
              {filteredLevels.length === 0 ? (
                <div className="p-12 text-center text-text-light italic text-sm bg-surface rounded-2xl shadow-md border-none">
                  {accessLevels.length === 0 && !isLoading
                    ? t('accessLevels.noLevelsYet')
                    : t('accessLevels.noResultsFound')}
                </div>
              ) : (
                filteredLevels.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-wrap justify-between items-center gap-3 p-4 bg-surface rounded-2xl shadow-md hover:shadow-xl transition-all group border-none"
                  >
                    <div className="flex items-center gap-4 min-w-0">
                      <div className="w-12 h-12 flex items-center justify-center bg-primary/10 rounded-2xl text-primary-dark group-hover:bg-primary/20 transition-colors shrink-0">
                        <span className="material-symbols-outlined text-2xl !fill-1">
                          {item.id === 'admin' ? 'shield' : item.name.toLowerCase().includes('staff') ? 'badge' : 'key'}
                        </span>
                      </div>
                      <div className="min-w-0">
                        <h4 className="text-base font-black text-text-dark leading-tight truncate">{item.name}</h4>
                        <p className="text-xs font-bold text-text-light mt-1">
                          {t('accessLevels.assignedZonesProtocol', { count: (item.doors ?? []).length })}
                          {' · '}
                          {t('accessLevelPeople.count', { count: peopleCountOf(item) })}
                        </p>
                      </div>
                    </div>
                    {/* Раньше клик по карточке открывал редактирование. Теперь два действия:
                        настройки уровня и состав людей на нём. */}
                    <div className="flex items-center gap-2 shrink-0">
                      <Button type="button" variant="outline" icon="group" onClick={() => openPeopleModal(item)}>
                        {t('accessLevelPeople.open')}
                      </Button>
                      <Button type="button" variant="outline" icon="edit" onClick={() => openEditModal(item)}>
                        {t('accessLevelPeople.edit')}
                      </Button>
                    </div>
                  </div>
                )))}
            </div>
          )}

          {tabFilter === 'doors' && (
            <div className="grid gap-3">
              {doorsLoading ? (
                <div className="p-12 text-center text-sm font-bold text-text-light uppercase tracking-widest">{t('accessLevels.loadingDoors')}</div>
              ) : doorsError ? (
                <div className="p-4 bg-error-bg text-error-text rounded-xl text-sm font-bold shadow-sm">{doorsError}</div>
              ) : (
                doorsList.map((door) => (
                  <div key={`${door.deviceId}-${door.doorIndex}`} className="p-4 bg-surface rounded-2xl shadow-md flex justify-between items-center border-none">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 flex items-center justify-center bg-slate-75 rounded-xl text-text-muted">
                        <span className="material-symbols-outlined">door_front</span>
                      </div>
                      <div>
                        <p className="text-sm font-black text-text-dark leading-tight">{door.deviceName}</p>
                        <p className="text-[10px] font-bold text-text-light uppercase tracking-widest mt-0.5">{floorOrDoorLabel(door.doorIndex, door.doorName, door.isElevator)}</p>
                      </div>
                    </div>
                    <Badge variant={door.status === 'Online' ? 'success' : 'neutral'}>{door.status === 'Online' ? t('accessLevels.online') : (door.status || t('accessLevels.offline'))}</Badge>
                  </div>
                ))
              )}
            </div>
          )}

        </div>
      </div>

      {/* Modals */}
      <Modal
        isOpen={modalMode === 'create' || modalMode === 'edit'}
        onClose={closeModals}
        title={modalMode === 'create' ? t('accessLevels.createPolicy') : t('accessLevels.editPolicy')}
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (modalMode === 'create') handleCreate()
            else handleUpdate()
          }}
        >
          <div>
            <label className="block text-xs font-bold text-text-muted mb-1">{t('common.name')}</label>
            <Input
              value={formData.name}
              onChange={(e) => setFormData((p) => ({ ...p, name: e.target.value }))}
              placeholder={t('accessLevels.namePlaceholder')}
              required
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-text-muted mb-1">{t('accessLevels.descriptionOptional')}</label>
            <Input
              value={formData.description}
              onChange={(e) => setFormData((p) => ({ ...p, description: e.target.value }))}
              placeholder={t('accessLevels.descriptionPlaceholder')}
            />
          </div>
          <div className="flex flex-wrap gap-2 pt-4">
            <Button type="submit" disabled={!canCreateOrUpdate || isSubmitting} isLoading={isSubmitting}>
              {modalMode === 'create' ? t('accessLevels.createPolicy') : t('common.save')}
            </Button>
            {modalMode === 'edit' && editingItem && (
              <Button type="button" variant="outline" icon="door_front" onClick={() => {
                closeModals();
                openDoorsModal(editingItem);
              }}>
                {t('accessLevels.doorsFloors')}
              </Button>
            )}
            <Button type="button" variant="outline" onClick={closeModals} disabled={isSubmitting}>
              {t('common.cancel')}
            </Button>
            {modalMode === 'edit' && editingItem && (
              <Button
                type="button"
                variant="ghost"
                icon="delete"
                className="ml-auto text-error-text hover:bg-error-bg"
                onClick={() => {
                  closeModals();
                  openDeleteModal(editingItem);
                }}
              >
                {t('common.delete')}
              </Button>
            )}
          </div>
        </form>
      </Modal>

      <Modal isOpen={modalMode === 'delete'} onClose={closeModals} title={t('accessLevels.deletePolicy')}>
        {deletingItem && (
          <div className="space-y-4">
            <p className="text-sm text-text-dark">
              {t('accessLevels.confirmDeletePrefix')} <strong>{deletingItem.name}</strong>{t('accessLevels.confirmDeleteSuffix')}
            </p>
            <div className="flex gap-2">
              <Button variant="danger" onClick={handleDelete} isLoading={isSubmitting}>
                {t('common.delete')}
              </Button>
              <Button variant="outline" onClick={closeModals} disabled={isSubmitting}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal isOpen={modalMode === 'doors'} onClose={closeModals} title={doorsItem ? t('accessLevels.accessTitle', { name: doorsItem.name }) : t('accessLevels.manageAccessPoints')}>
        {doorsItem && (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="block text-xs font-bold text-text-muted">{t('accessLevels.assignedDoorsFloors')}</label>
              {(doorsItem.doors ?? []).length === 0 ? (
                <p className="text-sm text-text-light italic py-2">{t('accessLevels.noDoorsAssigned')}</p>
              ) : (
                <ul className="space-y-1">
                  {(doorsItem.doors ?? []).map((d) => (
                    <li key={`${d.deviceId}-${d.doorIndex}`} className="flex items-center justify-between py-2 px-3 bg-slate-75 rounded-md">
                      <span className="text-sm font-medium text-text-dark">
                        {d.deviceName} — {floorOrDoorLabel(d.doorIndex, null, d.isElevator)}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        icon="close"
                        className="text-text-muted hover:text-error-text"
                        onClick={() => handleRemoveDoor(d.deviceId, d.doorIndex)}
                        disabled={isSubmitting}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="border-t border-border-base pt-4 space-y-3">
              <label className="block text-xs font-bold text-text-muted">{t('accessLevels.addDoorOrFloor')}</label>
              <div className="flex gap-2">
                <select
                  value={addDoorDeviceId ? `${addDoorDeviceId}:${addDoorIndex}` : ''}
                  onChange={(e) => {
                    const v = e.target.value
                    if (v) {
                      const [did, idx] = v.split(':')
                      setAddDoorDeviceId(did)
                      setAddDoorIndex(parseInt(idx, 10))
                    } else {
                      setAddDoorDeviceId('')
                      setAddDoorIndex(0)
                    }
                  }}
                  className="flex-1 h-9 px-3 bg-slate-75 border border-border-base rounded-md text-xs outline-none"
                >
                  <option value="">{t('accessLevels.selectDoorFloor')}</option>
                  {doorsList.map((d) => (
                    <option key={`${d.deviceId}-${d.doorIndex}`} value={`${d.deviceId}:${d.doorIndex}`}>
                      {d.deviceName} — {floorOrDoorLabel(d.doorIndex, d.doorName, d.isElevator)}
                    </option>
                  ))}
                </select>
                <Button onClick={handleAddDoor} disabled={!addDoorDeviceId || isSubmitting} isLoading={isSubmitting} icon="add">
                  {t('common.add')}
                </Button>
              </div>
            </div>
            <div className="flex justify-end pt-2">
              <Button variant="outline" onClick={closeModals}>{t('common.close')}</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Состав уровня доступа: кто на нём сейчас и добавление новых людей. */}
      <Modal
        isOpen={peopleItem !== null}
        onClose={() => setPeopleItem(null)}
        title={t('accessLevelPeople.title', { name: peopleItem?.name ?? '' })}
        size="lg"
      >
        <div className="space-y-4">
          {peopleError && (
            <div className="p-3 bg-error-bg text-error-text rounded-xl text-sm font-bold">{peopleError}</div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              {levelPeople.length > 0 && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allPeopleSelected}
                    onChange={toggleAllPeople}
                    className="h-4 w-4 accent-primary cursor-pointer"
                  />
                  <span className="text-xs font-bold text-text-light uppercase tracking-widest">{t('accessLevelPeople.selectAll')}</span>
                </label>
              )}
              <p className="text-xs font-bold text-text-light uppercase tracking-widest">
                {selectedPeople.size > 0
                  ? t('accessLevelPeople.selectedCount', { count: selectedPeople.size })
                  : t('accessLevelPeople.count', { count: levelPeople.length })}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {selectedPeople.size > 0 && (
                <Button type="button" variant="danger" icon="person_remove" onClick={removeSelectedPeople} disabled={assignSaving}>
                  {t('accessLevelPeople.removeSelected')}
                </Button>
              )}
              {levelPeople.length > 0 && (
                <Button type="button" variant="outline" icon="sync" onClick={repushPeople} disabled={assignSaving}>
                  {selectedPeople.size > 0 ? t('accessLevelPeople.repushSelected') : t('accessLevelPeople.repushAll')}
                </Button>
              )}
              <Button type="button" icon="person_add" onClick={openPeoplePicker} disabled={assignSaving}>
                {t('accessLevelPeople.add')}
              </Button>
            </div>
          </div>

          {peopleLoading ? (
            <div className="py-10 text-center text-sm font-bold text-text-light uppercase tracking-widest">{t('common.loading')}</div>
          ) : levelPeople.length === 0 ? (
            <div className="py-10 text-center text-sm text-text-light">{t('accessLevelPeople.empty')}</div>
          ) : (
            <div className="max-h-96 overflow-y-auto rounded-xl border border-border-light divide-y divide-border-light">
              {levelPeople.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selectedPeople.has(p.id)}
                    onChange={() => togglePersonSelected(p.id)}
                    aria-label={`${p.firstName} ${p.lastName}`}
                    className="h-4 w-4 shrink-0 accent-primary cursor-pointer"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-text-dark truncate">
                      {p.firstName} {p.lastName}
                      {p.employeeNo && <span className="ml-2 text-[10px] font-bold text-text-light">#{p.employeeNo}</span>}
                    </p>
                    <p className="text-[10px] text-text-light truncate">
                      {t(p.kind === 'resident' ? 'accessLevelPeople.kindResident' : 'accessLevelPeople.kindEmployee')}
                      {(p.departmentName ?? p.housingBlockName) ? ` · ${p.departmentName ?? p.housingBlockName}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removePerson(p)}
                    disabled={assignSaving}
                    title={t('accessLevelPeople.remove')}
                    aria-label={t('accessLevelPeople.remove')}
                    className="shrink-0 p-2 rounded-lg text-text-light hover:text-error-text hover:bg-error-bg transition-colors disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-lg">person_remove</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>

      {/* Пока уровень пишется на устройства: закрыть окно нельзя, чтобы не терять итог. */}
      <Modal
        isOpen={peopleProgress !== null}
        onClose={() => { /* закрытие запрещено: идёт запись на устройства */ }}
        hideClose
        title={t(peopleProgress?.kind === 'remove'
          ? 'accessLevelPeople.removingTitle'
          : peopleProgress?.kind === 'repush'
            ? 'accessLevelPeople.repushTitle'
            : 'accessLevelPeople.addingTitle')}
      >
        <div className="flex items-center gap-4 py-2">
          <div className="w-10 h-10 shrink-0 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
          <div className="min-w-0">
            <p className="text-sm font-bold text-text-dark">
              {peopleProgress?.kind === 'remove'
                ? (peopleProgress.name
                  ? t('accessLevelPeople.removingBody', { name: peopleProgress.name })
                  : t('accessLevelPeople.removingSelectedBody', { count: peopleProgress.count }))
                : peopleProgress?.kind === 'repush'
                  ? t('accessLevelPeople.repushBody', { count: peopleProgress.count })
                  : t('accessLevelPeople.addingBody', { count: peopleProgress?.count ?? 0 })}
            </p>
            {peopleProgress?.kind !== 'remove' && peopleProgress?.done !== undefined && (
              <p className="mt-1 text-xs text-text-light truncate">
                {t('accessLevelPeople.addingProgress', { done: peopleProgress.done, total: peopleProgress.count })}
                {peopleProgress.device ? ` · ${peopleProgress.device}` : ''}
              </p>
            )}
          </div>
        </div>
      </Modal>

      {/* Итог операции: сколько добавлено и что не доехало до устройств. */}
      <Modal
        isOpen={peopleResult !== null}
        onClose={() => setPeopleResult(null)}
        title={t('accessLevelPeople.doneTitle')}
      >
        <div className="space-y-4">
          <div className="space-y-1 text-sm font-bold text-text-dark">
            {peopleResult?.kind === 'repush' ? (
              <p>{t('accessLevelPeople.repushed', { count: peopleResult?.added ?? 0 })}</p>
            ) : peopleResult?.kind === 'remove' ? (
              <p>
                {peopleResult.name
                  ? t('accessLevelPeople.removedFrom', { name: peopleResult.name })
                  : t('accessLevelPeople.removedCount', { count: peopleResult.added })}
              </p>
            ) : (
              <>
                <p>{t('accessLevelPeople.added', { count: peopleResult?.added ?? 0 })}</p>
                {(peopleResult?.alreadyAssigned ?? 0) > 0 && (
                  <p className="text-text-light">{t('accessLevelPeople.alreadyAssigned', { count: peopleResult?.alreadyAssigned ?? 0 })}</p>
                )}
              </>
            )}
          </div>
          {/* Куда записалось, а куда нет — по устройствам. */}
          {peopleResult?.devices && peopleResult.devices.length > 0 && (
            <ul className="rounded-xl border border-border-light divide-y divide-border-light">
              {peopleResult.devices.map((d) => (
                <li key={d.name} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                  <span className="font-bold text-text-dark truncate">{d.name}</span>
                  <span className="shrink-0 flex items-center gap-3">
                    {d.done > 0 && <span className="text-success-text">{t('accessLevelPeople.deviceWritten', { count: d.done })}</span>}
                    {d.skipped > 0 && <span className="text-text-light">{t('accessLevelPeople.deviceSkipped', { count: d.skipped })}</span>}
                    {d.errors > 0 && <span className="text-error-text">{t('accessLevelPeople.deviceFailed', { count: d.errors })}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {peopleResult && peopleResult.warnings.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-black uppercase tracking-widest text-error-text">{t('accessLevelPeople.syncWarnings')}</p>
              <ul className="max-h-48 overflow-y-auto rounded-xl bg-error-bg p-3 space-y-1">
                {peopleResult.warnings.map((w, i) => (
                  <li key={i} className="text-xs text-error-text">{w}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-text-light">{t('accessLevelPeople.allSynced')}</p>
          )}
          <div className="flex justify-end">
            <Button type="button" onClick={() => setPeopleResult(null)}>{t('common.ok')}</Button>
          </div>
        </div>
      </Modal>

      {/* Выбор людей — тот же попап, что и «Выбор сотрудника» в отчётах. Группы здесь
          разворачиваем в людей: уровень назначается конкретным людям, не отделу. */}
      {peoplePickerOpen && (
      <PeoplePicker
        onClose={() => setPeoplePickerOpen(false)}
        title={t('accessLevelPeople.addTitle')}
        /* У жильцов и студентов своя структура, у работников — отделы: показываем их
           отдельными разделами, иначе два дерева сливаются в один список. */
        groups={withResidents ? undefined : departments}
        sections={withResidents ? [
          { label: t('accessLevelPeople.structureHousing'), groups: blocks },
          { label: t('accessLevelPeople.structureCompany'), groups: departments },
        ] : undefined}
        people={assignableDirectory.map((p): PickerPerson => ({
          id: p.id,
          firstName: p.firstName,
          lastName: p.lastName,
          employeeNo: p.employeeNo,
          groupId: p.department?.id ?? p.housingBlockId ?? null,
          groupName: p.department?.name ?? p.housingBlockName ?? null,
        }))}
        selection={{ personIds: [], groupIds: [] }}
        allowEmpty={false}
        onApply={({ personIds, groupIds }) => {
          const fromGroups = groupIds.length === 0 ? [] : assignableDirectory
            .filter((p) => {
              const g = p.department?.id ?? p.housingBlockId ?? null
              return g != null && groupIds.includes(g)
            })
            .map((p) => p.id)
          const all = Array.from(new Set([...personIds, ...fromGroups]))
          void assignPeople(all)
        }}
      />
      )}
    </AppLayout>
  )
}
