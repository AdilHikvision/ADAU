import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HubConnection, HubConnectionBuilder, HttpTransportType, LogLevel } from '@microsoft/signalr'
import { useAuth } from '../auth/AuthContext'
import { AppLayout } from '../components/templates'
import { Badge, Button } from '../components/atoms'
import { PageHeader } from '../components/organisms'
import { apiRequest, getHubUrl } from '../lib/api'
import { newId } from '../lib/id'
import { FaceThumbnail } from '../components/FaceThumbnail'

// ─── Types ────────────────────────────────────────────────────────────────────

interface AccessLevelDoor {
  deviceId: string
  deviceName: string
  doorIndex: number
  isElevator?: boolean
}

interface AccessLevel {
  id: string
  name: string
  description?: string | null
  doors: AccessLevelDoor[]
}

interface DeviceDoor {
  deviceId: string
  deviceName: string
  doorIndex: number
  doorName?: string | null
  status?: string | null
  isElevator?: boolean
}

interface DeviceEvent {
  deviceIdentifier: string
  eventType: number
  occurredUtc: string
  payload: string
  summary?: string | null
  employeeNo?: string | null
  personName?: string | null
  primaryFaceId?: string | null
}

interface DeviceSummary {
  id: string
  deviceIdentifier: string
  name: string
  deviceType?: string | null
}

interface DoorGroup {
  id: string
  name: string
  doorKeys: string[]  // `${deviceId}:${doorIndex}`
  collapsed: boolean
  visible: boolean    // false → moves to hidden bar
}

// ─── Constants ────────────────────────────────────────────────────────────────

const GROUPS_KEY = 'monitoring_door_groups_v2'
const TIMELINE_PAGE_SIZE = 10

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDoorKey(d: { deviceId: string; doorIndex: number }) {
  return `${d.deviceId}:${d.doorIndex}`
}

function loadGroups(): DoorGroup[] {
  try {
    const raw = localStorage.getItem(GROUPS_KEY)
    if (raw) return JSON.parse(raw) as DoorGroup[]
  } catch { /* ignore */ }
  return []
}

function saveGroups(groups: DoorGroup[]) {
  try { localStorage.setItem(GROUPS_KEY, JSON.stringify(groups)) } catch { /* ignore */ }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MonitoringPage() {
  const { t } = useTranslation()
  const { token } = useAuth()

  const eventTypeLabel = useCallback((eventType: number): string => {
    switch (eventType) {
      case 0: return t('monitoring.eventTypes.unknown')
      case 1: return t('monitoring.eventTypes.doorOpened')
      case 2: return t('monitoring.eventTypes.accessGranted')
      case 3: return t('monitoring.eventTypes.accessDenied')
      case 4: return t('monitoring.eventTypes.heartbeat')
      case 5: return t('monitoring.eventTypes.doorClosed')
      case 6: return t('monitoring.eventTypes.authTimeout')
      case 7: return t('monitoring.eventTypes.deviceOperation')
      default: return t('monitoring.eventTypes.event')
    }
  }, [t])

  const buildActivityPresentation = useCallback((
    evt: DeviceEvent,
    deviceByIdentifier: Map<string, DeviceSummary>,
    accessLevelByDeviceId: Map<string, string>,
  ): { headline: string; category: string; lines: { label: string; value: string }[] } => {
    const category = eventTypeLabel(evt.eventType)
    const baseSummary = (evt.summary && evt.summary.trim()) || category
    const headline =
      evt.personName && baseSummary.toLowerCase().includes('face authentication')
        ? `${evt.personName} — ${baseSummary}`
        : baseSummary
    const lines: { label: string; value: string }[] = []
    if (evt.personName) lines.push({ label: t('monitoring.fields.person'), value: evt.personName })
    const device = deviceByIdentifier.get(evt.deviceIdentifier)
    lines.push({ label: t('monitoring.fields.device'), value: device?.name ?? evt.deviceIdentifier })
    const accessLevelName = device ? accessLevelByDeviceId.get(device.id) : undefined
    lines.push({ label: t('monitoring.fields.accessLevel'), value: accessLevelName ?? '—' })
    return { headline, category, lines }
  }, [t, eventTypeLabel])

  // Data
  const [accessLevels, setAccessLevels] = useState<AccessLevel[]>([])
  const [onlineDoors, setOnlineDoors] = useState<DeviceDoor[]>([])
  const [devices, setDevices] = useState<DeviceSummary[]>([])
  const [events, setEvents] = useState<DeviceEvent[]>([])
  const [doorControlLoading, setDoorControlLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Groups (persisted to localStorage)
  const [groups, setGroups] = useState<DoorGroup[]>(loadGroups)
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  // Drag state — key stored in ref to avoid re-renders during drag; dragOverId is UI state
  const dragKeyRef = useRef<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  // Timeline
  const [eventsFilter, setEventsFilter] = useState<'all' | 'doors' | 'access'>('all')
  const [eventsPage, setEventsPage] = useState(1)

  // Persist groups
  useEffect(() => { saveGroups(groups) }, [groups])

  // ── Data loading ─────────────────────────────────────────────────────────

  const loadAccessLevels = useCallback(async () => {
    if (!token) return
    try { setAccessLevels(await apiRequest<AccessLevel[]>('/api/access-levels', { token })) }
    catch { /* not critical for monitoring */ }
  }, [token])

  const loadOnlineDoors = useCallback(async () => {
    if (!token) return
    try { setOnlineDoors(await apiRequest<DeviceDoor[]>('/api/devices/doors', { token })) }
    catch { setOnlineDoors([]) }
  }, [token])

  const loadDevices = useCallback(async () => {
    if (!token) return
    try { setDevices(await apiRequest<DeviceSummary[]>('/api/devices', { token })) }
    catch { setDevices([]) }
  }, [token])

  useEffect(() => {
    loadAccessLevels()
    loadOnlineDoors()
    loadDevices()
  }, [loadAccessLevels, loadOnlineDoors, loadDevices])

  // Fallback poll every 30s if SignalR is down
  useEffect(() => {
    if (!token) return
    const id = window.setInterval(() => loadOnlineDoors(), 30_000)
    return () => window.clearInterval(id)
  }, [token, loadOnlineDoors])

  // ── Derived maps ─────────────────────────────────────────────────────────

  const deviceByIdentifier = useMemo(() => {
    const m = new Map<string, DeviceSummary>()
    for (const d of devices) m.set(d.deviceIdentifier, d)
    return m
  }, [devices])

  const accessLevelByDeviceId = useMemo(() => {
    const m = new Map<string, string>()
    for (const lvl of accessLevels)
      for (const door of lvl.doors ?? [])
        if (!m.has(door.deviceId)) m.set(door.deviceId, lvl.name)
    return m
  }, [accessLevels])

  const onlineDoorMap = useMemo(() => {
    const m = new Map<string, DeviceDoor>()
    for (const d of onlineDoors) m.set(getDoorKey(d), d)
    return m
  }, [onlineDoors])

  // ── Groups computed ───────────────────────────────────────────────────────

  const assignedKeys = useMemo(() => new Set(groups.flatMap(g => g.doorKeys)), [groups])

  const ungroupedDoors = useMemo(
    () => onlineDoors.filter(d => !assignedKeys.has(getDoorKey(d))),
    [onlineDoors, assignedKeys],
  )

  const visibleGroups = groups.filter(g => g.visible !== false)
  const hiddenGroups = groups.filter(g => g.visible === false)

  // ── SignalR ───────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!token) return
    let cancelled = false
    let hub: HubConnection | null = null
    void (async () => {
      try {
        hub = new HubConnectionBuilder()
          .withUrl(`${getHubUrl()}/hubs/devices`, {
            accessTokenFactory: () => token,
            skipNegotiation: true,
            transport: HttpTransportType.WebSockets,
          })
          .withAutomaticReconnect({ nextRetryDelayInMilliseconds: (ctx) => Math.min(1000 * 2 ** ctx.previousRetryCount, 30000) })
          .configureLogging(LogLevel.Error)
          .build()

        hub.on('LiveDeviceEvent', (evt: DeviceEvent) => {
          if (!evt?.deviceIdentifier || cancelled) return
          setEvents((prev) => [evt, ...prev].slice(0, 400))
        })

        hub.on('DeviceStatusChanged', (st: { deviceId: string }) => {
          if (!st?.deviceId || cancelled) return
          apiRequest<DeviceDoor[]>(`/api/devices/doors?deviceId=${st.deviceId}`, { token })
            .then((list) => {
              if (cancelled) return
              setOnlineDoors((prev) => [...prev.filter(d => d.deviceId !== st.deviceId), ...list])
            })
            .catch(() => { /* ignore */ })
        })

        await hub.start()
      } catch { /* polling remains */ }
    })()
    return () => {
      cancelled = true
      void hub?.stop()
    }
  }, [token])

  // ── Door control ──────────────────────────────────────────────────────────

  async function handleDoorControl(deviceId: string, doorIndex: number, action: string) {
    if (!token) return
    const key = `${deviceId}-${doorIndex}-${action}`
    setDoorControlLoading(key)
    setError(null)
    try {
      await apiRequest(`/api/devices/${deviceId}/doors/${doorIndex}/control`, {
        method: 'POST', token, body: JSON.stringify({ action }),
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : t('monitoring.errors.doorControlFailed', { action }))
    } finally {
      setDoorControlLoading(null)
    }
  }

  // ── Group management ──────────────────────────────────────────────────────

  function addGroup() {
    const id = newId('group')
    const defaultName = t('monitoring.newGroup')
    setGroups(prev => [...prev, { id, name: defaultName, doorKeys: [], collapsed: false, visible: true }])
    setEditingGroupId(id)
    setEditingName(defaultName)
  }

  function startEdit(group: DoorGroup) {
    setEditingGroupId(group.id)
    setEditingName(group.name)
  }

  function commitEdit() {
    if (!editingGroupId) return
    const name = editingName.trim() || t('monitoring.group')
    setGroups(prev => prev.map(g => g.id === editingGroupId ? { ...g, name } : g))
    setEditingGroupId(null)
  }

  function deleteGroup(id: string) {
    setGroups(prev => prev.filter(g => g.id !== id))
    if (editingGroupId === id) setEditingGroupId(null)
  }

  function toggleCollapse(id: string) {
    setGroups(prev => prev.map(g => g.id === id ? { ...g, collapsed: !g.collapsed } : g))
  }

  function toggleVisibility(id: string) {
    setGroups(prev => prev.map(g => g.id === id ? { ...g, visible: !(g.visible ?? true) } : g))
  }

  function moveDoorToGroup(doorKey: string, targetGroupId: string | 'ungrouped') {
    setGroups(prev => {
      let updated = prev.map(g => ({ ...g, doorKeys: g.doorKeys.filter(k => k !== doorKey) }))
      if (targetGroupId !== 'ungrouped') {
        updated = updated.map(g => g.id === targetGroupId ? { ...g, doorKeys: [...g.doorKeys, doorKey] } : g)
      }
      return updated
    })
  }

  // ── Drag-and-drop ─────────────────────────────────────────────────────────

  function onDragStart(e: React.DragEvent, doorKey: string) {
    dragKeyRef.current = doorKey
    e.dataTransfer.effectAllowed = 'move'
    // Defer opacity change so the drag ghost captures the normal look
    requestAnimationFrame(() => {
      const el = e.currentTarget as HTMLElement
      el.style.opacity = '0.35'
    })
  }

  function onDragEnd(e: React.DragEvent) {
    ;(e.currentTarget as HTMLElement).style.opacity = ''
    dragKeyRef.current = null
    setDragOverId(null)
  }

  function onDragOverGroup(e: React.DragEvent, id: string) {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverId !== id) setDragOverId(id)
  }

  function onDragLeaveGroup(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverId(null)
  }

  function onDropGroup(e: React.DragEvent, id: string) {
    e.preventDefault()
    const key = dragKeyRef.current
    if (key) moveDoorToGroup(key, id)
    dragKeyRef.current = null
    setDragOverId(null)
  }

  // ── Timeline ──────────────────────────────────────────────────────────────

  const filteredEvents = useMemo(() => {
    if (eventsFilter === 'doors') return events.filter(e => e.eventType === 1 || e.eventType === 5)
    if (eventsFilter === 'access') return events.filter(e => e.eventType === 2 || e.eventType === 3 || e.eventType === 6)
    return events
  }, [events, eventsFilter])

  useEffect(() => { setEventsPage(1) }, [eventsFilter])

  const timelinePage = useMemo(() => {
    const totalPages = Math.max(1, Math.ceil(filteredEvents.length / TIMELINE_PAGE_SIZE))
    const page = Math.min(eventsPage, totalPages)
    return { totalPages, page, slice: filteredEvents.slice((page - 1) * TIMELINE_PAGE_SIZE, page * TIMELINE_PAGE_SIZE) }
  }, [filteredEvents, eventsPage])

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(filteredEvents.length / TIMELINE_PAGE_SIZE))
    setEventsPage(p => Math.min(p, totalPages))
  }, [filteredEvents])

  // ── Door card ─────────────────────────────────────────────────────────────

  function renderDoorCard(d: DeviceDoor) {
    const doorKey = getDoorKey(d)
    const floorNo = d.doorIndex + 1
    const label = d.doorName ?? (d.isElevator ? t('monitoring.floorN', { n: floorNo }) : t('monitoring.doorN', { n: floorNo }))
    const sublabel = d.doorName
      ? (d.isElevator
        ? `${t('monitoring.floorN', { n: floorNo })} · ${d.deviceName}`
        : `${t('monitoring.doorN', { n: floorNo })} · ${d.deviceName}`)
      : d.deviceName

    return (
      <div
        key={doorKey}
        draggable
        onDragStart={e => onDragStart(e, doorKey)}
        onDragEnd={onDragEnd}
        className="flex items-center justify-between p-3 rounded-xl hover:bg-slate-50 transition-colors cursor-grab active:cursor-grabbing select-none"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-outlined text-base text-text-light/40 shrink-0">drag_indicator</span>
          <div className="min-w-0">
            <p className="text-xs font-bold text-text-dark truncate leading-tight">{label}</p>
            <p className="text-[10px] font-bold text-text-light uppercase tracking-widest truncate">{sublabel}</p>
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1 ml-2">
          {d.isElevator ? (
            <div className="flex gap-1">
              <Button variant="ghost" size="icon" icon="lock_open" title={t('monitoring.controls.openRelay')} onClick={() => handleDoorControl(d.deviceId, d.doorIndex, 'open')} disabled={!!doorControlLoading} />
              <Button variant="ghost" size="icon" icon="lock" title={t('monitoring.controls.closeRelay')} onClick={() => handleDoorControl(d.deviceId, d.doorIndex, 'close')} disabled={!!doorControlLoading} />
              <Button variant="ghost" size="icon" icon="door_open" title={t('monitoring.controls.remainOpen')} onClick={() => handleDoorControl(d.deviceId, d.doorIndex, 'alwaysopen')} disabled={!!doorControlLoading} />
              <Button variant="ghost" size="icon" icon="lock_clock" title={t('monitoring.controls.remainClosed')} onClick={() => handleDoorControl(d.deviceId, d.doorIndex, 'alwaysclose')} disabled={!!doorControlLoading} />
            </div>
          ) : (
            <div className="flex gap-1">
              <Button variant="ghost" size="icon" icon="lock_open" title={t('monitoring.controls.open')} onClick={() => handleDoorControl(d.deviceId, d.doorIndex, 'open')} disabled={!!doorControlLoading} />
              <Button variant="ghost" size="icon" icon="lock" title={t('monitoring.controls.close')} onClick={() => handleDoorControl(d.deviceId, d.doorIndex, 'close')} disabled={!!doorControlLoading} />
              <Button variant="ghost" size="icon" icon="door_open" title={t('monitoring.controls.remainOpen')} onClick={() => handleDoorControl(d.deviceId, d.doorIndex, 'alwaysopen')} disabled={!!doorControlLoading} />
              <Button variant="ghost" size="icon" icon="lock_clock" title={t('monitoring.controls.remainClosed')} onClick={() => handleDoorControl(d.deviceId, d.doorIndex, 'alwaysclose')} disabled={!!doorControlLoading} />
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Group card ────────────────────────────────────────────────────────────

  function renderGroupCard(group: DoorGroup) {
    const groupDoors = group.doorKeys
      .map(k => onlineDoorMap.get(k))
      .filter((d): d is DeviceDoor => d !== undefined)
    const onlineCount = groupDoors.length
    const isDragTarget = dragOverId === group.id

    return (
      <div
        key={group.id}
        onDragOver={e => onDragOverGroup(e, group.id)}
        onDragLeave={onDragLeaveGroup}
        onDrop={e => onDropGroup(e, group.id)}
        className={`bg-surface rounded-2xl shadow-md overflow-hidden transition-all ${isDragTarget ? 'ring-2 ring-primary ring-inset shadow-lg' : ''}`}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-border-light bg-slate-50/40 flex items-center gap-1.5">
          <span className="material-symbols-outlined text-base text-text-light select-none shrink-0">folder</span>

          {editingGroupId === group.id ? (
            <input
              className="flex-1 text-sm font-black text-text-dark bg-transparent border-b-2 border-primary outline-none py-0.5 min-w-0"
              value={editingName}
              autoFocus
              onChange={e => setEditingName(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={e => {
                if (e.key === 'Enter') commitEdit()
                if (e.key === 'Escape') setEditingGroupId(null)
              }}
            />
          ) : (
            <h3
              className="flex-1 text-sm font-black text-text-dark leading-tight cursor-pointer hover:text-primary transition-colors truncate"
              onDoubleClick={() => startEdit(group)}
              title={t('monitoring.doubleClickToRename')}
            >
              {group.name}
            </h3>
          )}

          <Badge variant={onlineCount > 0 ? 'primary' : 'neutral'} className="shrink-0">
            {onlineCount}
          </Badge>

          <button
            onClick={() => startEdit(group)}
            className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-slate-200 transition-colors shrink-0"
            title={t('monitoring.rename')}
          >
            <span className="material-symbols-outlined text-sm text-text-light">edit</span>
          </button>
          <button
            onClick={() => toggleVisibility(group.id)}
            className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-slate-200 transition-colors shrink-0"
            title={t('monitoring.hideGroup')}
          >
            <span className="material-symbols-outlined text-sm text-text-light">visibility_off</span>
          </button>
          <button
            onClick={() => toggleCollapse(group.id)}
            className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-slate-200 transition-colors shrink-0"
            title={group.collapsed ? t('monitoring.expand') : t('monitoring.collapse')}
          >
            <span className={`material-symbols-outlined text-sm text-text-light transition-transform duration-200 ${group.collapsed ? '' : 'rotate-180'}`}>
              expand_less
            </span>
          </button>
          <button
            onClick={() => deleteGroup(group.id)}
            className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-red-50 transition-colors shrink-0"
            title={t('monitoring.deleteGroup')}
          >
            <span className="material-symbols-outlined text-sm text-text-light hover:text-error-text">delete</span>
          </button>
        </div>

        {/* Doors */}
        {!group.collapsed && (
          <div className="p-2">
            {groupDoors.length > 0 ? (
              <div className="divide-y divide-divider-light/50">
                {groupDoors.map(d => renderDoorCard(d))}
              </div>
            ) : (
              <div className={`py-6 flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed transition-colors ${isDragTarget ? 'border-primary bg-primary/5' : 'border-divider-light'}`}>
                <span className="material-symbols-outlined text-2xl text-text-light/50">drag_indicator</span>
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-widest">{t('monitoring.dragDoorsHere')}</p>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <AppLayout onAction={() => { loadAccessLevels(); loadOnlineDoors(); loadDevices() }}>
      <div className="flex-1 overflow-y-auto bg-background-light pb-20 md:pb-0">
        <div className="p-6 md:p-8 space-y-6">
          <PageHeader
            className="hidden md:flex"
            title={t('monitoring.pageTitle')}
            description={t('monitoring.pageDescription')}
            actions={
              <Button variant="outline" icon="refresh" onClick={() => { loadAccessLevels(); loadOnlineDoors(); loadDevices() }}>
                {t('monitoring.syncFleet')}
              </Button>
            }
          />

          {error && (
            <div className="p-4 bg-error-bg text-error-text rounded-2xl text-xs font-bold border border-error-text/10 shadow-sm animate-in fade-in slide-in-from-top-2 duration-300">
              {error}
            </div>
          )}

          {/* ── Global Status ── */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('monitoring.globalStatus')}</h2>
              <Badge variant="primary" className="animate-pulse">{t('monitoring.liveFeed')}</Badge>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-surface p-4 rounded-2xl shadow-md">
                <p className="text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('monitoring.activeDoors')}</p>
                <p className="text-2xl font-black text-primary leading-none">{onlineDoors.length}</p>
              </div>
              <div className="bg-surface p-4 rounded-2xl shadow-md">
                <p className="text-[10px] font-black text-text-light uppercase tracking-widest mb-1">{t('monitoring.groups')}</p>
                <p className="text-2xl font-black text-text-dark leading-none">{groups.length}</p>
              </div>
            </div>
          </div>

          {/* ── Doors / Floors ── */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('monitoring.doorsFloors')}</h2>
              <Button variant="outline" size="sm" icon="create_new_folder" onClick={addGroup}>
                {t('monitoring.addGroup')}
              </Button>
            </div>

            {onlineDoors.length === 0 ? (
              <div className="py-20 text-center bg-surface rounded-2xl border border-dashed border-divider-light shadow-sm">
                <span className="material-symbols-outlined text-4xl text-text-light mb-2 block">device_hub</span>
                <p className="text-[10px] font-black text-text-muted uppercase tracking-widest">{t('monitoring.noDevicesOnline')}</p>
              </div>
            ) : (
              <>
                {/* Named groups */}
                {visibleGroups.map(group => renderGroupCard(group))}

                {/* Ungrouped */}
                {ungroupedDoors.length > 0 && (
                  <div
                    onDragOver={e => onDragOverGroup(e, 'ungrouped')}
                    onDragLeave={onDragLeaveGroup}
                    onDrop={e => onDropGroup(e, 'ungrouped')}
                    className={`bg-surface rounded-2xl shadow-md overflow-hidden transition-all ${dragOverId === 'ungrouped' ? 'ring-2 ring-primary/60 ring-inset' : ''}`}
                  >
                    <div className="px-4 py-3 border-b border-border-light bg-slate-50/40 flex items-center gap-2">
                      <span className="material-symbols-outlined text-base text-text-light select-none">inbox</span>
                      <h3 className="flex-1 text-sm font-black text-text-dark">{t('monitoring.ungrouped')}</h3>
                      <Badge variant="neutral">{ungroupedDoors.length}</Badge>
                    </div>
                    <div className="p-2 divide-y divide-divider-light/50">
                      {ungroupedDoors.map(d => renderDoorCard(d))}
                    </div>
                  </div>
                )}

                {/* First-use tip */}
                {groups.length === 0 && ungroupedDoors.length > 0 && (
                  <div className="px-4 py-3 bg-primary/5 rounded-xl border border-primary/20 flex items-center gap-3">
                    <span className="material-symbols-outlined text-primary text-xl shrink-0">info</span>
                    <p className="text-[10px] font-bold text-primary leading-snug">
                      {t('monitoring.firstUseTipBefore')} <strong>{t('monitoring.addGroup')}</strong>{t('monitoring.firstUseTipAfter')}
                    </p>
                  </div>
                )}
              </>
            )}

            {/* Hidden groups bar */}
            {hiddenGroups.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap pt-1">
                <span className="text-[9px] font-black text-text-light uppercase tracking-widest shrink-0">{t('monitoring.hiddenLabel')}</span>
                {hiddenGroups.map(g => {
                  const count = g.doorKeys.filter(k => onlineDoorMap.has(k)).length
                  return (
                    <button
                      key={g.id}
                      onClick={() => toggleVisibility(g.id)}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface border border-divider-light text-[10px] font-bold text-text-muted hover:text-text-dark hover:border-primary/40 transition-colors shadow-sm"
                      title={t('monitoring.showGroup')}
                    >
                      <span className="material-symbols-outlined text-sm">visibility</span>
                      {g.name}
                      {count > 0 && <span className="text-primary">({count})</span>}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* ── Live Activity Timeline ── */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('monitoring.liveActivityTimeline')}</h2>
              <div className="flex gap-1 border border-divider-light rounded-lg p-0.5 bg-white">
                {(['all', 'doors', 'access'] as const).map(f => (
                  <button
                    key={f}
                    onClick={() => setEventsFilter(f)}
                    className={`px-3 py-1 rounded-md text-[9px] font-black uppercase tracking-widest transition-all ${eventsFilter === f ? 'bg-primary text-white shadow-sm' : 'text-text-light hover:text-text-dark'}`}
                  >
                    {t(`monitoring.filters.${f}`)}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              {filteredEvents.length === 0 ? (
                <div className="py-20 text-center bg-surface/50 rounded-2xl border border-dashed border-divider-light">
                  <span className="material-symbols-outlined text-4xl text-text-light/50 mb-2">browse_activity</span>
                  <p className="text-[10px] font-black text-text-light uppercase tracking-widest">{t('monitoring.noActivityYet')}</p>
                </div>
              ) : (
                <>
                  {timelinePage.slice.map((evt, idx) => {
                    const pres = buildActivityPresentation(evt, deviceByIdentifier, accessLevelByDeviceId)
                    const isGranted = evt.eventType === 2
                    const isDenied = evt.eventType === 3
                    const isTimeout = evt.eventType === 6
                    const isDoorClose = evt.eventType === 5
                    const isHeartbeat = evt.eventType === 4
                    const isDeviceOp = evt.eventType === 7
                    const timeStr = new Date(evt.occurredUtc).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
                    const icon =
                      isDenied ? 'block'
                        : isGranted ? 'verified_user'
                          : isTimeout ? 'hourglass_disabled'
                            : isDoorClose ? 'door_front'
                              : isHeartbeat ? 'monitor_heart'
                                : isDeviceOp ? 'settings_remote'
                                  : evt.eventType === 1 ? 'door_open'
                                    : 'sensors'

                    return (
                      <div
                        key={`${evt.deviceIdentifier}-${evt.occurredUtc}-${evt.eventType}-p${timelinePage.page}-${idx}`}
                        className="flex gap-4 group animate-in slide-in-from-left-2 duration-300"
                      >
                        <div className="flex flex-col items-center shrink-0">
                          <div className={`w-10 h-10 rounded-2xl flex items-center justify-center shadow-sm transition-transform group-hover:scale-110 ${isGranted ? 'bg-emerald-50 text-emerald-500' :
                            isDenied || isTimeout ? 'bg-error-bg text-error-text' :
                              isHeartbeat ? 'bg-slate-100 text-text-light' :
                                isDeviceOp ? 'bg-amber-50 text-amber-700' :
                                  'bg-surface text-primary'
                            }`}>
                            <span className="material-symbols-outlined text-xl">{icon}</span>
                          </div>
                          <div className="w-0.5 flex-1 bg-border-light group-last:bg-transparent mt-2" />
                        </div>
                        <div className="flex-1 pb-6">
                          <div className="flex items-start justify-between gap-2 mb-2">
                            <div className="min-w-0 flex-1">
                              <p className={`text-sm font-black leading-snug ${isDenied || isTimeout ? 'text-error-text' : 'text-text-dark'}`}>
                                {pres.headline}
                              </p>
                              <p className="text-[9px] font-bold text-text-light uppercase tracking-widest mt-0.5">{pres.category}</p>
                            </div>
                            <p className="text-[10px] font-bold text-text-light font-mono shrink-0">{timeStr}</p>
                          </div>
                          <div className="bg-surface p-3 rounded-2xl shadow-md space-y-2">
                            {(evt.primaryFaceId || evt.personName) && (
                              <div className="flex items-center gap-3 pb-2 border-b border-divider-light/60">
                                {evt.primaryFaceId && token ? (
                                  <FaceThumbnail
                                    faceId={evt.primaryFaceId}
                                    token={token}
                                    className="w-14 h-14 rounded-xl object-cover shrink-0 border border-divider-light shadow-sm"
                                    alt={evt.personName ?? t('monitoring.person')}
                                  />
                                ) : (
                                  <div className="w-14 h-14 rounded-xl bg-slate-100 flex items-center justify-center shrink-0 border border-divider-light">
                                    <span className="material-symbols-outlined text-2xl text-text-light">person</span>
                                  </div>
                                )}
                                <div className="min-w-0">
                                  {evt.personName ? (
                                    <p className="text-sm font-black text-text-dark truncate">{evt.personName}</p>
                                  ) : (
                                    <p className="text-[10px] font-bold text-text-light uppercase tracking-widest">{t('monitoring.unknownPerson')}</p>
                                  )}
                                </div>
                              </div>
                            )}
                            {pres.lines.length > 0 && (
                              <dl className="space-y-1.5">
                                {pres.lines.map(row => (
                                  <div key={row.label} className="flex gap-2 text-[10px] leading-snug">
                                    <dt className="text-text-light font-bold uppercase tracking-tighter shrink-0 w-[88px]">{row.label}</dt>
                                    <dd className="text-text-dark font-medium break-words">{row.value}</dd>
                                  </div>
                                ))}
                              </dl>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}

                  {timelinePage.totalPages > 1 ? (
                    <div className="flex items-center justify-center gap-3 pt-2 pb-4">
                      <Button variant="outline" size="icon" icon="chevron_left" title={t('monitoring.previousPage')} disabled={timelinePage.page <= 1} onClick={() => setEventsPage(p => Math.max(1, p - 1))} />
                      <span className="text-[10px] font-black text-text-light uppercase tracking-widest tabular-nums">
                        {t('monitoring.pageOf', { page: timelinePage.page, total: timelinePage.totalPages })}
                        <span className="text-text-muted font-bold normal-case"> {t('monitoring.totalCount', { count: filteredEvents.length })}</span>
                      </span>
                      <Button variant="outline" size="icon" icon="chevron_right" title={t('monitoring.nextPage')} disabled={timelinePage.page >= timelinePage.totalPages} onClick={() => setEventsPage(p => Math.min(timelinePage.totalPages, p + 1))} />
                    </div>
                  ) : (
                    <p className="text-center text-[9px] font-bold text-text-light uppercase tracking-widest pb-2 opacity-60">
                      {t('monitoring.eventCount', { count: filteredEvents.length })}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>

        </div>
      </div>
    </AppLayout>
  )
}
