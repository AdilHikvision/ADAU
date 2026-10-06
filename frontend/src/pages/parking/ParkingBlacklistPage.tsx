import { DateInput } from '../../components/atoms/DateInput'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AppLayout } from '../../components/templates'
import { Button, Input } from '../../components/atoms'
import { PageHeader } from '../../components/organisms'
import { ConfirmDialog } from '../../components/molecules'
import { apiRequest } from '../../lib/api'
import { useAuth } from '../../auth/AuthContext'

/* ═══ Чёрный список: номера, которым шлагбаум не открывается никогда.
   Проверяется раньше всех остальных правил, поэтому запрет сильнее и белого
   списка, и абонемента: попытка въезда уходит в журнал тревогой. ═══ */

interface BlockedPlate {
  id: string
  plate: string
  note: string | null
  category: string | null
  validTo: string | null
  createdUtc: string
}

/** Причина блокировки: одна из четырёх, чтобы отчёты не разъезжались на свободном тексте. */
const REASONS = ['unpaid', 'violator', 'stolen', 'banned'] as const

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'

export function ParkingBlacklistPage() {
  const { t } = useTranslation()
  const { token } = useAuth()
  const [rows, setRows] = useState<BlockedPlate[]>([])
  const [search, setSearch] = useState('')
  const [plate, setPlate] = useState('')
  const [category, setCategory] = useState('')
  const [note, setNote] = useState('')
  const [validTo, setValidTo] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState<BlockedPlate | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    try {
      setRows(await apiRequest<BlockedPlate[]>('/api/parking/plates', { token }))
      setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'error') }
  }, [token])
  useEffect(() => { void load() }, [load])

  const add = async () => {
    const p = plate.trim()
    if (!token || !p) return
    setSaving(true)
    try {
      await apiRequest('/api/parking/plates', {
        method: 'POST', token,
        body: JSON.stringify({
          plate: p,
          listType: 'Block',
          category: category || null,
          note: note.trim() || null,
          // Пустая дата — блокировка бессрочная.
          validTo: validTo || null,
        }),
      })
      setPlate(''); setCategory(''); setNote(''); setValidTo('')
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'error') } finally { setSaving(false) }
  }

  const doDelete = async () => {
    if (!token || !confirmDel) return
    setSaving(true)
    try {
      await apiRequest(`/api/parking/plates/${confirmDel.id}`, { method: 'DELETE', token })
      setConfirmDel(null); await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'error') } finally { setSaving(false) }
  }

  const q = search.trim().toLowerCase()
  const shown = rows.filter((r) => !q || r.plate.toLowerCase().includes(q) || (r.note ?? '').toLowerCase().includes(q))
  const fieldCls = 'h-10 px-3 rounded-xl border border-divider-light bg-white text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/10 outline-none'

  return (
    <AppLayout>
      <div className="p-6 space-y-6">
        <PageHeader title={t('parking.blacklist.pageTitle')} description={t('parking.blacklist.pageDesc')} />
        {error && <div className="p-4 bg-error-bg text-error-text rounded-2xl text-sm font-bold">{error}</div>}

        <div className="bg-surface rounded-2xl shadow-sm p-4 space-y-3">
          <div className="text-sm font-bold text-text-dark">{t('parking.blacklist.addTitle')}</div>
          <div className="flex flex-wrap items-center gap-2">
            <Input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} placeholder="10-AA-100" />
            <select className={fieldCls} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{t('parking.cfg.reasonAny')}</option>
              {REASONS.map((r) => <option key={r} value={r}>{t(`parking.cfg.reason.${r}`)}</option>)}
            </select>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('parking.blacklist.note')} />
            <DateInput className={fieldCls} title={t('parking.blacklist.validTo')}
              value={validTo} onChange={(e) => setValidTo(e.target.value)} />
            <Button icon="block" isLoading={saving} disabled={!plate.trim()} onClick={add}>{t('common.add')}</Button>
          </div>
          <div className="text-[11px] leading-relaxed text-text-light">{t('parking.blacklist.validToHint')}</div>
        </div>

        <div className="bg-surface rounded-2xl shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <Input placeholder={t('parking.blacklist.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] font-black text-text-light uppercase tracking-widest border-b border-border">
                  <th className="px-5 py-3 text-left">{t('parking.ap.plate')}</th>
                  <th className="px-5 py-3 text-left">{t('parking.blacklist.reason')}</th>
                  <th className="px-5 py-3 text-left">{t('parking.blacklist.note')}</th>
                  <th className="px-5 py-3 text-left">{t('parking.blacklist.validTo')}</th>
                  <th className="px-5 py-3 text-left">{t('parking.blacklist.added')}</th>
                  <th className="px-5 py-3 text-right">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-none hover:bg-background-light transition-colors">
                    <td className="px-5 py-3 font-mono font-black text-text-dark whitespace-nowrap">{r.plate}</td>
                    <td className="px-5 py-3">
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-bold bg-red-50 text-red-700">
                        {r.category ? t(`parking.cfg.reason.${r.category}`, { defaultValue: r.category }) : t('parking.cfg.reasonAny')}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-text-light">{r.note ?? '—'}</td>
                    <td className="px-5 py-3 font-mono text-xs text-text-light">{r.validTo ?? t('parking.ap.unlimited')}</td>
                    <td className="px-5 py-3 font-mono text-xs text-text-light">{fmtDate(r.createdUtc)}</td>
                    <td className="px-5 py-3 text-right">
                      <button type="button" className="text-[10px] font-black uppercase tracking-wider text-error-text hover:underline"
                        onClick={() => setConfirmDel(r)}>
                        {t('parking.blacklist.unblock')}
                      </button>
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr><td colSpan={6} className="px-5 py-10 text-center text-sm text-text-light">{t('parking.blacklist.empty')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {confirmDel && (
        <ConfirmDialog isOpen title={t('parking.blacklist.unblockQuestion', { plate: confirmDel.plate })}
          message={t('parking.blacklist.unblockHint')}
          onConfirm={doDelete} onClose={() => setConfirmDel(null)} isLoading={saving} variant="danger" />
      )}
    </AppLayout>
  )
}
