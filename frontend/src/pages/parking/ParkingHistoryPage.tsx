import { DateInput } from '../../components/atoms/DateInput'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AppLayout } from '../../components/templates'
import { Button, Input } from '../../components/atoms'
import { PageHeader, Modal } from '../../components/organisms'
import { apiRequest } from '../../lib/api'
import { useAuth } from '../../auth/AuthContext'

/* ═══ История въездов/выездов + журнал событий парковки. Оплата выезда (платный режим). ═══ */

interface HistoryRow {
  id: string; plate: string; zoneName: string | null
  enteredUtc: string; exitedUtc: string | null; durationMinutes: number | null
  cameraName: string | null; photoUrl: string | null; recognitionConfidence: number | null; operator: string | null
  cost: number | null; paymentMethod: string | null; paidUtc: string | null; isPaid: boolean
  /** Выехал, стоимость начислена, но оплаты не было. */
  isDebt?: boolean
  /** Простоял дольше разрешённого лимита. */
  overstay?: boolean
}
interface EventRow { id: string; type: string; message: string | null; plate: string | null; source: string | null; createdUtc: string }
interface Quote { sessionId: string; plate: string; enteredUtc: string; minutes: number; amount: number; tariffName: string | null; requiresPayment: boolean }

const EVENT_STYLE: Record<string, { icon: string; cls: string }> = {
  barrier_open: { icon: 'door_open', cls: 'bg-green-50 text-green-700' },
  barrier_close: { icon: 'door_front', cls: 'bg-slate-100 text-slate-600' },
  manual_open: { icon: 'pan_tool', cls: 'bg-blue-50 text-blue-700' },
  camera_error: { icon: 'videocam_off', cls: 'bg-amber-50 text-amber-700' },
  recognition_error: { icon: 'image_not_supported', cls: 'bg-amber-50 text-amber-700' },
  power_loss: { icon: 'power_off', cls: 'bg-red-50 text-red-700' },
  admin_login: { icon: 'admin_panel_settings', cls: 'bg-indigo-50 text-indigo-700' },
  denied: { icon: 'block', cls: 'bg-orange-50 text-orange-700' },
  alarm: { icon: 'warning', cls: 'bg-red-50 text-red-700' },
}

const fmtDT = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—'
const fmtDur = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${Math.round(m)}m`)

export function ParkingHistoryPage() {
  const { t } = useTranslation()
  const { token } = useAuth()
  const [tab, setTab] = useState<'history' | 'events'>('history')
  const [plateQ, setPlateQ] = useState('')
  const [from, setFrom] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10) })
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10))
  const [eventType, setEventType] = useState('')
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [events, setEvents] = useState<EventRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [quote, setQuote] = useState<Quote | null>(null)
  const [payMethod, setPayMethod] = useState('cash')
  const [paying, setPaying] = useState(false)

  const load = useCallback(async () => {
    if (!token) return
    try {
      const p = new URLSearchParams({ from, to })
      if (plateQ.trim()) p.set('plate', plateQ.trim())
      const e = new URLSearchParams({ from, to })
      if (eventType) e.set('type', eventType)
      const [h, ev] = await Promise.all([
        apiRequest<HistoryRow[]>(`/api/parking/history?${p}`, { token }),
        apiRequest<EventRow[]>(`/api/parking/events?${e}`, { token }),
      ])
      setRows(h); setEvents(ev); setError(null)
    } catch (e2) { setError(e2 instanceof Error ? e2.message : 'error') }
  }, [token, from, to, plateQ, eventType])
  useEffect(() => { void load() }, [load])

  const openQuote = async (plate: string) => {
    if (!token) return
    try {
      const q = await apiRequest<Quote>('/api/parking/exit-quote', { method: 'POST', token, body: JSON.stringify({ plate }) })
      setPayMethod('cash')
      setQuote(q)
    } catch (e) { setError(e instanceof Error ? e.message : 'error') }
  }

  const pay = async () => {
    if (!token || !quote) return
    setPaying(true)
    try {
      await apiRequest('/api/parking/pay', { method: 'POST', token, body: JSON.stringify({ sessionId: quote.sessionId, method: payMethod }) })
      setQuote(null); await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'error') } finally { setPaying(false) }
  }

  const fieldCls = 'h-10 px-3 rounded-xl border border-divider-light bg-white text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/10 outline-none'

  return (
    <AppLayout>
      <div className="p-6 space-y-6">
        <PageHeader title={t('parking.hist.pageTitle')} description={t('parking.hist.pageDesc')} />
        {error && <div className="p-4 bg-error-bg text-error-text rounded-2xl text-sm font-bold">{error}</div>}

        <div className="flex flex-wrap items-end gap-3 bg-surface rounded-2xl shadow-sm p-4">
          <div className="flex gap-1 bg-background-light rounded-xl p-1">
            {(['history', 'events'] as const).map((tt) => (
              <button key={tt} type="button" onClick={() => setTab(tt)}
                className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${tab === tt ? 'bg-primary text-white shadow-sm' : 'text-text-light hover:text-text-dark'}`}>
                {t(`parking.hist.tab.${tt}`)}
              </button>
            ))}
          </div>
          <div className="space-y-1">
            <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('common.from')}</label>
            <DateInput className={fieldCls} value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('common.to')}</label>
            <DateInput className={fieldCls} value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          {tab === 'history' ? (
            <div className="flex-1 min-w-40">
              <Input placeholder={t('parking.hist.searchPlate')} value={plateQ} onChange={(e) => setPlateQ(e.target.value.toUpperCase())} />
            </div>
          ) : (
            <div className="space-y-1">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('common.type')}</label>
              <select className={fieldCls} value={eventType} onChange={(e) => setEventType(e.target.value)}>
                <option value="">{t('common.all')}</option>
                {Object.keys(EVENT_STYLE).map((k) => <option key={k} value={k}>{t(`parking.hist.event.${k}`)}</option>)}
              </select>
            </div>
          )}
        </div>

        {tab === 'history' ? (
          <div className="bg-surface rounded-2xl shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] font-black text-text-light uppercase tracking-widest border-b border-border">
                    <th className="px-4 py-3 text-left">{t('parking.ap.plate')}</th>
                    <th className="px-4 py-3 text-left">{t('parking.ap.zone')}</th>
                    <th className="px-4 py-3 text-left">{t('parking.ap.entered')}</th>
                    <th className="px-4 py-3 text-left">{t('parking.ap.exited')}</th>
                    <th className="px-4 py-3 text-right">{t('parking.ap.duration')}</th>
                    <th className="px-4 py-3 text-left">{t('parking.hist.camera')}</th>
                    <th className="px-4 py-3 text-right">{t('parking.hist.confidence')}</th>
                    <th className="px-4 py-3 text-left">{t('parking.hist.operator')}</th>
                    <th className="px-4 py-3 text-right">{t('parking.hist.cost')}</th>
                    <th className="px-4 py-3 text-left">{t('parking.hist.paymentMethod')}</th>
                    <th className="px-4 py-3 text-right">{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-none hover:bg-background-light transition-colors">
                      <td className="px-4 py-3 font-mono font-black text-text-dark whitespace-nowrap">
                        {r.photoUrl ? <a href={r.photoUrl} target="_blank" rel="noreferrer" className="underline decoration-dotted" title={t('parking.hist.photo')}>{r.plate}</a> : r.plate}
                      </td>
                      <td className="px-4 py-3 text-text-light">{r.zoneName ?? '—'}</td>
                      <td className="px-4 py-3 font-mono text-xs text-text-light whitespace-nowrap">{fmtDT(r.enteredUtc)}</td>
                      <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">
                        {r.exitedUtc ? fmtDT(r.exitedUtc) : <span className="text-green-700 font-bold">{t('parking.ap.inside')}</span>}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">
                        {r.durationMinutes != null ? fmtDur(r.durationMinutes) : '—'}
                        {r.overstay && (
                          <span className="ml-1.5 inline-flex items-center rounded px-1.5 py-0.5 bg-amber-100 text-amber-800 text-[10px] font-black uppercase tracking-wider" title={t('parking.hist.overstayHint')}>
                            {t('parking.hist.overstay')}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-text-light text-xs">{r.cameraName ?? '—'}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs">{r.recognitionConfidence != null ? `${Math.round(r.recognitionConfidence * 100)}%` : '—'}</td>
                      <td className="px-4 py-3 text-text-light text-xs">{r.operator ?? '—'}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs font-bold text-text-dark">{r.cost != null ? r.cost.toFixed(2) : '—'}</td>
                      <td className="px-4 py-3 text-xs">
                        {r.isDebt ? (
                          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 bg-red-100 text-red-700 font-black uppercase tracking-wider text-[10px]">
                            <span className="material-symbols-outlined text-[13px]">money_off</span>
                            {t('parking.hist.unpaid')}
                          </span>
                        ) : (
                          <span className="text-text-light">{r.paymentMethod ? t(`parking.hist.pay.${r.paymentMethod}`, { defaultValue: r.paymentMethod }) : '—'}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {!r.exitedUtc && (
                          <button type="button" className="text-[10px] font-black uppercase tracking-wider text-primary hover:underline"
                            onClick={() => void openQuote(r.plate)}>
                            {t('parking.hist.exitPay')}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan={11} className="px-5 py-10 text-center text-sm text-text-light">{t('parking.ap.noSessions')}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="bg-surface rounded-2xl shadow-sm overflow-hidden">
            <div className="divide-y divide-border">
              {events.map((e) => {
                const st = EVENT_STYLE[e.type] ?? { icon: 'info', cls: 'bg-slate-100 text-slate-600' }
                return (
                  <div key={e.id} className="px-5 py-3 flex items-center gap-4">
                    <span className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${st.cls}`}>
                      <span className="material-symbols-outlined text-[20px]">{st.icon}</span>
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-black text-text-dark">
                        {t(`parking.hist.event.${e.type}`, { defaultValue: e.type })}
                        {e.plate && <span className="ml-2 font-mono text-xs font-bold text-text-light">{e.plate}</span>}
                      </p>
                      {e.message && <p className="text-xs text-text-light truncate">{e.message}</p>}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-mono text-xs text-text-light">{fmtDT(e.createdUtc)}</p>
                      {e.source && <p className="text-[10px] text-text-light">{e.source}</p>}
                    </div>
                  </div>
                )
              })}
              {events.length === 0 && <p className="px-5 py-10 text-center text-sm text-text-light">{t('parking.hist.noEvents')}</p>}
            </div>
          </div>
        )}
      </div>

      {/* Оплата выезда */}
      {quote && (
        <Modal isOpen title={t('parking.hist.exitPayTitle', { plate: quote.plate })} onClose={() => setQuote(null)}>
          <div className="space-y-4">
            <div className="bg-background-light rounded-2xl p-4 space-y-1">
              <p className="text-xs text-text-light">{t('parking.ap.entered')}: <span className="font-mono font-bold text-text-dark">{fmtDT(quote.enteredUtc)}</span></p>
              <p className="text-xs text-text-light">{t('parking.ap.duration')}: <span className="font-mono font-bold text-text-dark">{fmtDur(quote.minutes)}</span></p>
              {quote.tariffName && <p className="text-xs text-text-light">{t('parking.hist.tariff')}: <span className="font-bold text-text-dark">{quote.tariffName}</span></p>}
              <p className="text-lg font-black text-text-dark pt-1">{t('parking.hist.toPay')}: {quote.amount.toFixed(2)} AZN</p>
            </div>
            {quote.requiresPayment && (
              <div>
                <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-1.5">{t('parking.hist.paymentMethod')}</label>
                <select className="w-full h-10 px-3 rounded-xl border border-divider-light bg-white text-sm font-bold text-text-dark outline-none" value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                  {['cash', 'card', 'online'].map((m) => <option key={m} value={m}>{t(`parking.hist.pay.${m}`)}</option>)}
                </select>
              </div>
            )}
            <Button fullWidth isLoading={paying} onClick={pay}>
              {quote.requiresPayment ? t('parking.hist.payAndOpen') : t('parking.hist.openBarrier')}
            </Button>
          </div>
        </Modal>
      )}
    </AppLayout>
  )
}
