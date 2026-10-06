import { DateInput } from '../../components/atoms/DateInput'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AppLayout } from '../../components/templates'
import { Button, Input } from '../../components/atoms'
import { PageHeader, Modal } from '../../components/organisms'
import { ConfirmDialog } from '../../components/molecules'
import { apiRequest } from '../../lib/api'
import { useAuth } from '../../auth/AuthContext'

/* ═══ Тарифы платной парковки + абонементы (нативно, /api/parking/tariffs|subscriptions) ═══ */

interface Tariff {
  id: string; name: string; kind: 'Hourly' | 'Daily' | 'Fixed'; freeMinutes: number
  pricePerHour: number; pricePerDay: number; fixedPrice: number; maxPerDay: number | null
  nightPricePerHour: number | null; nightFrom: string | null; nightTo: string | null
  weekendPricePerHour: number | null; isActive: boolean; isDefault: boolean; sortOrder: number
}
interface Subscription {
  id: string; plate: string; name: string; startDate: string; endDate: string
  entriesLimit: number | null; entriesUsed: number; unlimited: boolean; isActive: boolean; notes: string | null
  status: 'active' | 'scheduled' | 'suspended' | 'expired' | 'exhausted'
}

const emptyTariff = {
  name: '', kind: 'Hourly' as Tariff['kind'], freeMinutes: '15', pricePerHour: '2', pricePerDay: '15', fixedPrice: '5',
  maxPerDay: '', nightPricePerHour: '', nightFrom: '20:00', nightTo: '08:00', weekendPricePerHour: '', isActive: true, isDefault: false,
}
const emptySub = { plate: '', name: '', startDate: new Date().toISOString().slice(0, 10), endDate: '', entriesLimit: '', unlimited: false, isActive: true, notes: '' }

const SUB_CHIP: Record<string, string> = {
  active: 'bg-green-50 text-green-700', scheduled: 'bg-blue-50 text-blue-700',
  suspended: 'bg-amber-50 text-amber-700', expired: 'bg-red-50 text-red-700', exhausted: 'bg-slate-100 text-slate-600',
}

export function ParkingTariffsPage() {
  const { t } = useTranslation()
  const { token } = useAuth()
  const [tariffs, setTariffs] = useState<Tariff[]>([])
  const [subs, setSubs] = useState<Subscription[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [modal, setModal] = useState<'tariff' | 'sub' | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [tf, setTf] = useState(emptyTariff)
  const [sf, setSf] = useState(emptySub)
  const [confirmDel, setConfirmDel] = useState<{ kind: 'tariff' | 'sub'; id: string; label: string } | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    try {
      const [tt, ss] = await Promise.all([
        apiRequest<Tariff[]>('/api/parking/tariffs', { token }),
        apiRequest<Subscription[]>('/api/parking/subscriptions', { token }),
      ])
      setTariffs(tt); setSubs(ss); setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'error') }
  }, [token])
  useEffect(() => { void load() }, [load])

  const num = (s: string): number => parseFloat(s) || 0
  const numOrNull = (s: string): number | null => (s.trim() === '' ? null : parseFloat(s) || 0)

  const saveTariff = async () => {
    if (!token || !tf.name.trim()) return
    setSaving(true)
    try {
      const body = JSON.stringify({
        name: tf.name.trim(), kind: tf.kind, freeMinutes: Math.max(0, parseInt(tf.freeMinutes, 10) || 0),
        pricePerHour: num(tf.pricePerHour), pricePerDay: num(tf.pricePerDay), fixedPrice: num(tf.fixedPrice),
        maxPerDay: numOrNull(tf.maxPerDay),
        nightPricePerHour: numOrNull(tf.nightPricePerHour),
        nightFrom: tf.nightPricePerHour.trim() !== '' && tf.nightFrom ? tf.nightFrom + ':00' : null,
        nightTo: tf.nightPricePerHour.trim() !== '' && tf.nightTo ? tf.nightTo + ':00' : null,
        weekendPricePerHour: numOrNull(tf.weekendPricePerHour),
        isActive: tf.isActive, isDefault: tf.isDefault, sortOrder: 0,
      })
      await apiRequest(editingId ? `/api/parking/tariffs/${editingId}` : '/api/parking/tariffs', { method: editingId ? 'PUT' : 'POST', token, body })
      setModal(null); await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'error') } finally { setSaving(false) }
  }

  const saveSub = async () => {
    if (!token || !sf.plate.trim() || !sf.endDate) return
    setSaving(true)
    try {
      const body = JSON.stringify({
        plate: sf.plate.trim(), name: sf.name.trim() || '—',
        startDate: sf.startDate, endDate: sf.endDate,
        entriesLimit: sf.unlimited || sf.entriesLimit.trim() === '' ? null : Math.max(1, parseInt(sf.entriesLimit, 10) || 1),
        unlimited: sf.unlimited, isActive: sf.isActive, notes: sf.notes.trim() || null,
      })
      await apiRequest(editingId ? `/api/parking/subscriptions/${editingId}` : '/api/parking/subscriptions', { method: editingId ? 'PUT' : 'POST', token, body })
      setModal(null); await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'error') } finally { setSaving(false) }
  }

  const doDelete = async () => {
    if (!token || !confirmDel) return
    setSaving(true)
    try {
      await apiRequest(`/api/parking/${confirmDel.kind === 'tariff' ? 'tariffs' : 'subscriptions'}/${confirmDel.id}`, { method: 'DELETE', token })
      setConfirmDel(null); await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'error') } finally { setSaving(false) }
  }

  const fieldCls = 'w-full h-10 px-3 rounded-xl border border-divider-light bg-white text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/10 outline-none'
  const lbl = 'block text-[10px] font-black text-text-light uppercase tracking-widest mb-1.5'

  const tariffSummary = (x: Tariff): string => {
    const parts: string[] = []
    if (x.freeMinutes > 0) parts.push(t('parking.tariff.sumFree', { min: x.freeMinutes }))
    if (x.kind === 'Hourly') {
      parts.push(t('parking.tariff.sumHourly', { price: x.pricePerHour }))
      if (x.nightPricePerHour != null) parts.push(t('parking.tariff.sumNight', { price: x.nightPricePerHour, from: x.nightFrom ?? '', to: x.nightTo ?? '' }))
      if (x.weekendPricePerHour != null) parts.push(t('parking.tariff.sumWeekend', { price: x.weekendPricePerHour }))
      if (x.maxPerDay != null) parts.push(t('parking.tariff.sumMaxDay', { price: x.maxPerDay }))
    } else if (x.kind === 'Daily') parts.push(t('parking.tariff.sumDaily', { price: x.pricePerDay }))
    else parts.push(t('parking.tariff.sumFixed', { price: x.fixedPrice }))
    return parts.join(' · ')
  }

  return (
    <AppLayout>
      <div className="p-6 space-y-6">
        <PageHeader title={t('parking.tariff.pageTitle')} description={t('parking.tariff.pageDesc')} />
        {error && <div className="p-4 bg-error-bg text-error-text rounded-2xl text-sm font-bold">{error}</div>}

        {/* Тарифы */}
        <div className="bg-surface rounded-2xl shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between">
            <p className="text-xs font-black text-text-light uppercase tracking-widest">{t('parking.tariff.tariffs')}</p>
            <Button icon="add" onClick={() => { setTf(emptyTariff); setEditingId(null); setModal('tariff') }}>{t('parking.tariff.addTariff')}</Button>
          </div>
          {tariffs.length === 0 ? (
            <div className="py-10 text-center text-sm text-text-light">{t('parking.tariff.noTariffs')}</div>
          ) : (
            <div className="divide-y divide-border">
              {tariffs.map((x) => (
                <div key={x.id} className="px-5 py-4 flex items-center gap-4">
                  <span className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${x.isActive ? 'bg-primary/10 text-primary' : 'bg-slate-100 text-slate-400'}`}>
                    <span className="material-symbols-outlined">{x.kind === 'Hourly' ? 'schedule' : x.kind === 'Daily' ? 'today' : 'sell'}</span>
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-black text-text-dark truncate">
                      {x.name}
                      {x.isDefault && <span className="ml-2 text-[9px] font-black uppercase tracking-widest text-primary bg-primary/10 rounded-md px-1.5 py-0.5">{t('parking.tariff.default')}</span>}
                      {!x.isActive && <span className="ml-2 text-[9px] font-black uppercase tracking-widest text-text-light">{t('parking.ap.inactive')}</span>}
                    </p>
                    <p className="text-xs text-text-light truncate">{t(`parking.tariff.kind.${x.kind}`)} · {tariffSummary(x)}</p>
                  </div>
                  <button type="button" className="text-[10px] font-black uppercase tracking-wider text-primary hover:underline"
                    onClick={() => {
                      setTf({
                        name: x.name, kind: x.kind, freeMinutes: String(x.freeMinutes),
                        pricePerHour: String(x.pricePerHour), pricePerDay: String(x.pricePerDay), fixedPrice: String(x.fixedPrice),
                        maxPerDay: x.maxPerDay != null ? String(x.maxPerDay) : '',
                        nightPricePerHour: x.nightPricePerHour != null ? String(x.nightPricePerHour) : '',
                        nightFrom: x.nightFrom ?? '20:00', nightTo: x.nightTo ?? '08:00',
                        weekendPricePerHour: x.weekendPricePerHour != null ? String(x.weekendPricePerHour) : '',
                        isActive: x.isActive, isDefault: x.isDefault,
                      })
                      setEditingId(x.id); setModal('tariff')
                    }}>
                    {t('common.edit')}
                  </button>
                  <button type="button" className="text-[10px] font-black uppercase tracking-wider text-error-text hover:underline"
                    onClick={() => setConfirmDel({ kind: 'tariff', id: x.id, label: x.name })}>
                    {t('common.delete')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Абонементы */}
        <div className="bg-surface rounded-2xl shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between">
            <p className="text-xs font-black text-text-light uppercase tracking-widest">{t('parking.sub.title')}</p>
            <Button icon="add" onClick={() => { setSf(emptySub); setEditingId(null); setModal('sub') }}>{t('parking.sub.add')}</Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] font-black text-text-light uppercase tracking-widest border-b border-border">
                  <th className="px-5 py-3 text-left">{t('parking.ap.plate')}</th>
                  <th className="px-5 py-3 text-left">{t('common.name')}</th>
                  <th className="px-5 py-3 text-left">{t('parking.sub.period')}</th>
                  <th className="px-5 py-3 text-left">{t('parking.sub.entries')}</th>
                  <th className="px-5 py-3 text-left">{t('common.status')}</th>
                  <th className="px-5 py-3 text-right">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {subs.map((x) => (
                  <tr key={x.id} className="border-b border-border last:border-none hover:bg-background-light transition-colors">
                    <td className="px-5 py-3 font-mono font-black text-text-dark">{x.plate}</td>
                    <td className="px-5 py-3 text-text-dark font-bold">{x.name}</td>
                    <td className="px-5 py-3 font-mono text-xs text-text-light">{x.startDate} – {x.endDate}</td>
                    <td className="px-5 py-3 text-text-light text-xs">
                      {x.unlimited ? t('parking.sub.unlimited') : x.entriesLimit != null ? `${x.entriesUsed} / ${x.entriesLimit}` : '—'}
                    </td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-bold ${SUB_CHIP[x.status]}`}>
                        {t(`parking.sub.status.${x.status}`)}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right space-x-2 whitespace-nowrap">
                      <button type="button" className="text-[10px] font-black uppercase tracking-wider text-primary hover:underline"
                        onClick={() => {
                          setSf({ plate: x.plate, name: x.name, startDate: x.startDate, endDate: x.endDate, entriesLimit: x.entriesLimit != null ? String(x.entriesLimit) : '', unlimited: x.unlimited, isActive: x.isActive, notes: x.notes ?? '' })
                          setEditingId(x.id); setModal('sub')
                        }}>
                        {t('common.edit')}
                      </button>
                      <button type="button" className="text-[10px] font-black uppercase tracking-wider text-error-text hover:underline"
                        onClick={() => setConfirmDel({ kind: 'sub', id: x.id, label: x.plate })}>
                        {t('common.delete')}
                      </button>
                    </td>
                  </tr>
                ))}
                {subs.length === 0 && (
                  <tr><td colSpan={6} className="px-5 py-10 text-center text-sm text-text-light">{t('parking.sub.none')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Тариф — модалка */}
      {modal === 'tariff' && (
        <Modal isOpen title={editingId ? t('parking.tariff.editTariff') : t('parking.tariff.addTariff')} onClose={() => setModal(null)}>
          <div className="space-y-3">
            <Input placeholder={t('common.name')} value={tf.name} onChange={(e) => setTf({ ...tf, name: e.target.value })} autoFocus />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={lbl}>{t('parking.tariff.kindLabel')}</label>
                <select className={fieldCls} value={tf.kind} onChange={(e) => setTf({ ...tf, kind: e.target.value as Tariff['kind'] })}>
                  {(['Hourly', 'Daily', 'Fixed'] as const).map((k) => <option key={k} value={k}>{t(`parking.tariff.kind.${k}`)}</option>)}
                </select>
              </div>
              <div>
                <label className={lbl}>{t('parking.tariff.freeMinutes')}</label>
                <input type="number" min={0} className={fieldCls} value={tf.freeMinutes} onChange={(e) => setTf({ ...tf, freeMinutes: e.target.value })} />
              </div>
            </div>
            {tf.kind === 'Hourly' && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={lbl}>{t('parking.tariff.pricePerHour')}</label>
                    <input type="number" min={0} step={0.5} className={fieldCls} value={tf.pricePerHour} onChange={(e) => setTf({ ...tf, pricePerHour: e.target.value })} />
                  </div>
                  <div>
                    <label className={lbl}>{t('parking.tariff.maxPerDay')}</label>
                    <input type="number" min={0} step={0.5} className={fieldCls} placeholder="—" value={tf.maxPerDay} onChange={(e) => setTf({ ...tf, maxPerDay: e.target.value })} />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className={lbl}>{t('parking.tariff.nightPrice')}</label>
                    <input type="number" min={0} step={0.5} className={fieldCls} placeholder="—" value={tf.nightPricePerHour} onChange={(e) => setTf({ ...tf, nightPricePerHour: e.target.value })} />
                  </div>
                  <div>
                    <label className={lbl}>{t('parking.tariff.nightFrom')}</label>
                    <input type="time" className={fieldCls} value={tf.nightFrom} onChange={(e) => setTf({ ...tf, nightFrom: e.target.value })} />
                  </div>
                  <div>
                    <label className={lbl}>{t('parking.tariff.nightTo')}</label>
                    <input type="time" className={fieldCls} value={tf.nightTo} onChange={(e) => setTf({ ...tf, nightTo: e.target.value })} />
                  </div>
                </div>
                <div>
                  <label className={lbl}>{t('parking.tariff.weekendPrice')}</label>
                  <input type="number" min={0} step={0.5} className={fieldCls} placeholder="—" value={tf.weekendPricePerHour} onChange={(e) => setTf({ ...tf, weekendPricePerHour: e.target.value })} />
                </div>
              </>
            )}
            {tf.kind === 'Daily' && (
              <div>
                <label className={lbl}>{t('parking.tariff.pricePerDay')}</label>
                <input type="number" min={0} step={0.5} className={fieldCls} value={tf.pricePerDay} onChange={(e) => setTf({ ...tf, pricePerDay: e.target.value })} />
              </div>
            )}
            {tf.kind === 'Fixed' && (
              <div>
                <label className={lbl}>{t('parking.tariff.fixedPrice')}</label>
                <input type="number" min={0} step={0.5} className={fieldCls} value={tf.fixedPrice} onChange={(e) => setTf({ ...tf, fixedPrice: e.target.value })} />
              </div>
            )}
            <div className="flex items-center gap-5">
              <label className="flex items-center gap-2 text-sm font-bold text-text-dark cursor-pointer">
                <input type="checkbox" checked={tf.isActive} onChange={(e) => setTf({ ...tf, isActive: e.target.checked })} className="w-4 h-4 accent-primary" />
                {t('parking.ap.active')}
              </label>
              <label className="flex items-center gap-2 text-sm font-bold text-text-dark cursor-pointer">
                <input type="checkbox" checked={tf.isDefault} onChange={(e) => setTf({ ...tf, isDefault: e.target.checked })} className="w-4 h-4 accent-primary" />
                {t('parking.tariff.default')}
              </label>
            </div>
            <Button fullWidth isLoading={saving} disabled={!tf.name.trim()} onClick={saveTariff}>{editingId ? t('common.save') : t('common.add')}</Button>
          </div>
        </Modal>
      )}

      {/* Абонемент — модалка */}
      {modal === 'sub' && (
        <Modal isOpen title={editingId ? t('parking.sub.edit') : t('parking.sub.add')} onClose={() => setModal(null)}>
          <div className="space-y-3">
            <Input placeholder={t('parking.ap.plate')} value={sf.plate} onChange={(e) => setSf({ ...sf, plate: e.target.value.toUpperCase() })} autoFocus />
            <Input placeholder={t('parking.sub.namePlaceholder')} value={sf.name} onChange={(e) => setSf({ ...sf, name: e.target.value })} />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={lbl}>{t('common.from')}</label>
                <DateInput className={fieldCls} value={sf.startDate} onChange={(e) => setSf({ ...sf, startDate: e.target.value })} />
              </div>
              <div>
                <label className={lbl}>{t('parking.sub.endDate')}</label>
                <DateInput className={fieldCls} value={sf.endDate} onChange={(e) => setSf({ ...sf, endDate: e.target.value })} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm font-bold text-text-dark cursor-pointer">
              <input type="checkbox" checked={sf.unlimited} onChange={(e) => setSf({ ...sf, unlimited: e.target.checked })} className="w-4 h-4 accent-primary" />
              {t('parking.sub.unlimited')}
            </label>
            {!sf.unlimited && (
              <div>
                <label className={lbl}>{t('parking.sub.entriesLimit')}</label>
                <input type="number" min={1} className={fieldCls} placeholder="—" value={sf.entriesLimit} onChange={(e) => setSf({ ...sf, entriesLimit: e.target.value })} />
              </div>
            )}
            <label className="flex items-center gap-2 text-sm font-bold text-text-dark cursor-pointer">
              <input type="checkbox" checked={sf.isActive} onChange={(e) => setSf({ ...sf, isActive: e.target.checked })} className="w-4 h-4 accent-primary" />
              {t('parking.ap.active')}
            </label>
            <Button fullWidth isLoading={saving} disabled={!sf.plate.trim() || !sf.endDate} onClick={saveSub}>{editingId ? t('common.save') : t('common.add')}</Button>
          </div>
        </Modal>
      )}

      {confirmDel && (
        <ConfirmDialog isOpen title={t('parking.ap.deleteQuestion', { name: confirmDel.label })} message={t('companyTab.actionCannotBeUndone')}
          onConfirm={doDelete} onClose={() => setConfirmDel(null)} isLoading={saving} variant="danger" />
      )}
    </AppLayout>
  )
}
