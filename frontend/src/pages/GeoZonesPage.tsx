import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AppLayout } from '../components/templates'
import { Button, Input } from '../components/atoms'
import { PageHeader, Modal } from '../components/organisms'
import { apiRequest } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { MapContainer, TileLayer, Circle, Marker, useMapEvents, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Fix Leaflet default icon URL issue under bundlers (Vite shipped Leaflet's CSS without the
// images, default markers point to broken paths). Re-bind to the CDN-hosted assets.
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

function ClickHandler({ onClick }: { onClick: (lat: number, lng: number) => void }) {
  useMapEvents({ click(e) { onClick(e.latlng.lat, e.latlng.lng) } })
  return null
}

function FlyTo({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap()
  useEffect(() => { map.flyTo([lat, lng], Math.max(map.getZoom(), 16), { duration: 0.4 }) }, [lat, lng])
  return null
}

interface GeoZone {
  id: string
  name: string
  latitude: number
  longitude: number
  radiusMeters: number
  isActive: boolean
}

export function GeoZonesPage() {
  const { t } = useTranslation()
  const { token } = useAuth()
  const [zones, setZones] = useState<GeoZone[]>([])
  const [loading, setLoading] = useState(false)

  const [modal, setModal] = useState<'create' | 'edit' | 'delete' | null>(null)
  const [editing, setEditing] = useState<GeoZone | null>(null)
  const [form, setForm] = useState({ name: '', latitude: '', longitude: '', radiusMeters: '100', isActive: true })
  const [saving, setSaving] = useState(false)

  const load = async () => {
    if (!token) return
    setLoading(true)
    try { setZones(await apiRequest<GeoZone[]>('/api/geo-zones', { token })) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [token])

  const openCreate = () => {
    setEditing(null)
    setForm({ name: '', latitude: '', longitude: '', radiusMeters: '100', isActive: true })
    setModal('create')
  }
  const openEdit = (z: GeoZone) => {
    setEditing(z)
    setForm({ name: z.name, latitude: String(z.latitude), longitude: String(z.longitude), radiusMeters: String(z.radiusMeters), isActive: z.isActive })
    setModal('edit')
  }

  const useCurrentLocation = async () => {
    if (!('geolocation' in navigator)) { alert(t('geoZones.geolocationNotSupported')); return }
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000, enableHighAccuracy: true })
      )
      setForm((p) => ({ ...p, latitude: pos.coords.latitude.toFixed(6), longitude: pos.coords.longitude.toFixed(6) }))
    } catch {
      // По http браузер блокирует геолокацию — без пояснения это выглядит как поломка.
      const hint = window.isSecureContext ? '' : `\n${t('geoZones.insecureContextHint')}`
      alert(t('geoZones.failedToGetLocation') + hint)
    }
  }

  const save = async () => {
    if (!token) return
    const lat = parseFloat(form.latitude)
    const lon = parseFloat(form.longitude)
    const radius = parseInt(form.radiusMeters, 10)
    if (!form.name.trim() || isNaN(lat) || isNaN(lon) || isNaN(radius) || radius <= 0) return
    setSaving(true)
    try {
      const body = JSON.stringify({ name: form.name.trim(), latitude: lat, longitude: lon, radiusMeters: radius, isActive: form.isActive })
      if (modal === 'create') await apiRequest('/api/geo-zones', { method: 'POST', token, body })
      else if (modal === 'edit' && editing) await apiRequest(`/api/geo-zones/${editing.id}`, { method: 'PUT', token, body })
      setModal(null); setEditing(null)
      await load()
    } finally { setSaving(false) }
  }

  const remove = async () => {
    if (!token || !editing) return
    setSaving(true)
    try {
      await apiRequest(`/api/geo-zones/${editing.id}`, { method: 'DELETE', token })
      setModal(null); setEditing(null)
      await load()
    } finally { setSaving(false) }
  }

  return (
    <AppLayout onAction={() => {}}>
      <div className="flex-1 overflow-y-auto bg-background-light pb-20 md:pb-0">
        <div className="p-6 md:p-10 space-y-6">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <PageHeader
              className="p-0 border-none shadow-none bg-transparent"
              title={t('geoZones.title')}
              description={t('geoZones.description')}
            />
            <Button icon="add" onClick={openCreate}>{t('geoZones.newZone')}</Button>
          </div>

          {zones.length > 0 && (
            <div className="bg-surface rounded-2xl shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-border">
                <p className="text-xs font-black text-text-light uppercase tracking-widest">{t('geoZones.allZones')}</p>
              </div>
              <MapContainer
                center={[zones[0].latitude, zones[0].longitude]}
                zoom={13}
                style={{ height: 360, width: '100%' }}
              >
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                {zones.map((z) => (
                  <Circle
                    key={z.id}
                    center={[z.latitude, z.longitude]}
                    radius={z.radiusMeters}
                    pathOptions={{ color: z.isActive ? '#16a34a' : '#94a3b8', fillOpacity: 0.15 }}
                    eventHandlers={{ click: () => openEdit(z) }}
                  />
                ))}
              </MapContainer>
            </div>
          )}

          <div className="bg-surface rounded-2xl shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-border">
              <p className="text-xs font-black text-text-light uppercase tracking-widest">{t('geoZones.zoneCount', { count: zones.length })}</p>
            </div>
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <span className="spinner-ring text-3xl text-primary" aria-hidden="true" />
              </div>
            ) : zones.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2 text-text-light">
                <span className="material-symbols-outlined text-4xl">location_off</span>
                <p className="text-sm">{t('geoZones.emptyState')}</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] font-black text-text-light uppercase tracking-widest border-b border-border">
                      <th className="px-5 py-3 text-left">{t('common.name')}</th>
                      <th className="px-5 py-3 text-left">{t('geoZones.columns.latitude')}</th>
                      <th className="px-5 py-3 text-left">{t('geoZones.columns.longitude')}</th>
                      <th className="px-5 py-3 text-right">{t('geoZones.columns.radiusMeters')}</th>
                      <th className="px-5 py-3 text-left">{t('common.active')}</th>
                      <th className="px-5 py-3 text-right">{t('common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {zones.map((z) => (
                      <tr key={z.id} className="border-b border-border last:border-none hover:bg-background-light transition-colors">
                        <td className="px-5 py-3 font-bold text-text-dark">{z.name}</td>
                        <td className="px-5 py-3 font-mono text-text-light">{z.latitude.toFixed(6)}</td>
                        <td className="px-5 py-3 font-mono text-text-light">{z.longitude.toFixed(6)}</td>
                        <td className="px-5 py-3 text-right text-text-dark">{z.radiusMeters}</td>
                        <td className="px-5 py-3">
                          {z.isActive
                            ? <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full text-green-600 bg-green-50">{t('common.active')}</span>
                            : <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full text-text-light bg-background-light">{t('geoZones.off')}</span>}
                        </td>
                        <td className="px-5 py-3 text-right">
                          <button onClick={() => openEdit(z)} className="text-[10px] font-black uppercase tracking-wider text-primary hover:underline mr-3">{t('common.edit')}</button>
                          <button onClick={() => { setEditing(z); setModal('delete') }} className="text-[10px] font-black uppercase tracking-wider text-error-text hover:underline">{t('common.delete')}</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      <Modal isOpen={modal === 'create' || modal === 'edit'} onClose={() => { setModal(null); setEditing(null) }} title={modal === 'create' ? t('geoZones.newGeoZone') : t('geoZones.editGeoZone')}>
        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('common.name')}</label>
            <Input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder={t('geoZones.namePlaceholder')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('geoZones.columns.latitude')}</label>
              <Input value={form.latitude} onChange={(e) => setForm((p) => ({ ...p, latitude: e.target.value }))} placeholder="40.4093" />
            </div>
            <div className="space-y-1.5">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('geoZones.columns.longitude')}</label>
              <Input value={form.longitude} onChange={(e) => setForm((p) => ({ ...p, longitude: e.target.value }))} placeholder="49.8671" />
            </div>
          </div>
          <Button variant="outline" icon="my_location" onClick={useCurrentLocation}>{t('geoZones.useCurrentLocation')}</Button>
          {(() => {
            const lat = parseFloat(form.latitude)
            const lon = parseFloat(form.longitude)
            const radius = parseInt(form.radiusMeters, 10) || 100
            const valid = !isNaN(lat) && !isNaN(lon)
            const center: [number, number] = valid ? [lat, lon] : [40.4093, 49.8671] // fallback Baku
            return (
              <div className="rounded-xl overflow-hidden border border-border-light">
                <p className="px-3 py-2 text-[10px] font-bold text-text-light bg-slate-50 border-b border-border-light">{t('geoZones.clickToSetCenter')}</p>
                <MapContainer center={center} zoom={valid ? 16 : 12} style={{ height: 240, width: '100%' }}>
                  <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />
                  <ClickHandler onClick={(la, ln) => setForm((p) => ({ ...p, latitude: la.toFixed(6), longitude: ln.toFixed(6) }))} />
                  {valid && <Marker position={center} />}
                  {valid && <Circle center={center} radius={radius} pathOptions={{ color: '#0ea5e9', fillOpacity: 0.15 }} />}
                  {valid && <FlyTo lat={lat} lng={lon} />}
                </MapContainer>
              </div>
            )
          })()}
          <div className="space-y-1.5">
            <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('geoZones.radiusMeters')}</label>
            <Input type="number" min={1} value={form.radiusMeters} onChange={(e) => setForm((p) => ({ ...p, radiusMeters: e.target.value }))} />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.isActive} onChange={(e) => setForm((p) => ({ ...p, isActive: e.target.checked }))} className="w-4 h-4 rounded border-border-light text-primary focus:ring-primary/30" />
            <span className="text-sm font-bold text-text-dark">{t('common.active')}</span>
          </label>
          <div className="flex gap-3 pt-2">
            <Button variant="outline" fullWidth onClick={() => { setModal(null); setEditing(null) }}>{t('common.cancel')}</Button>
            <Button fullWidth isLoading={saving} onClick={save} disabled={!form.name.trim()}>{modal === 'create' ? t('common.create') : t('common.save')}</Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={modal === 'delete'} onClose={() => { setModal(null); setEditing(null) }} title={t('geoZones.deleteZone')}>
        <div className="space-y-4 pt-2">
          <p className="text-sm text-text-dark">
            {t('geoZones.deletePrefix')} <strong>{editing?.name}</strong>?
          </p>
          <div className="flex gap-3">
            <Button variant="outline" fullWidth onClick={() => { setModal(null); setEditing(null) }}>{t('common.cancel')}</Button>
            <Button variant="danger" fullWidth isLoading={saving} onClick={remove}>{t('common.delete')}</Button>
          </div>
        </div>
      </Modal>
    </AppLayout>
  )
}
