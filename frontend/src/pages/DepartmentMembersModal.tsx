import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../components/atoms'
import { Modal } from '../components/organisms'
import { apiRequest } from '../lib/api'

interface Person {
  id: string
  firstName: string
  lastName: string
  employeeNo: string | null
  isActive: boolean
  department?: { id: string; name: string } | null
}

/**
 * Состав отдела из карточки структуры. Слева — кто уже в отделе (можно снять),
 * справа — сотрудники без отдела (можно добавить). Сотрудников других отделов
 * здесь нет: их переводят из карточки сотрудника, чтобы не перетянуть случайно.
 */
export function DepartmentMembersModal({ department, token, onClose, onChanged }: {
  department: { id: string; name: string }
  token: string
  onClose: () => void
  /** Состав поменялся — странице нужно обновить счётчики на карточках. */
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const [people, setPeople] = useState<Person[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<'add' | 'remove' | null>(null)
  const [selIn, setSelIn] = useState<Set<string>>(new Set())
  const [selFree, setSelFree] = useState<Set<string>>(new Set())
  const [qIn, setQIn] = useState('')
  const [qFree, setQFree] = useState('')
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    apiRequest<Person[]>('/api/employees', { token })
      .then((list) => { if (!cancelled) { setPeople(list); setError(null) } })
      .catch((e: unknown) => { if (!cancelled) { setPeople([]); setError(e instanceof Error ? e.message : String(e)) } })
    return () => { cancelled = true }
  }, [token, reloadTick])

  const byName = (a: Person, b: Person) =>
    `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`)
  const matches = (p: Person, q: string) => {
    const s = q.trim().toLowerCase()
    return !s || `${p.firstName} ${p.lastName} ${p.employeeNo ?? ''}`.toLowerCase().includes(s)
  }
  const members = (people ?? []).filter((p) => p.department?.id === department.id).sort(byName)
  const free = (people ?? []).filter((p) => !p.department).sort(byName)
  const shownIn = members.filter((p) => matches(p, qIn))
  const shownFree = free.filter((p) => matches(p, qFree))

  const save = async (kind: 'add' | 'remove') => {
    const ids = [...(kind === 'add' ? selFree : selIn)]
    if (ids.length === 0) return
    setSaving(kind)
    setError(null)
    try {
      await apiRequest(`/api/departments/${department.id}/employees`, {
        method: 'PUT', token,
        body: JSON.stringify(kind === 'add' ? { add: ids } : { remove: ids }),
      })
      if (kind === 'add') setSelFree(new Set())
      else setSelIn(new Set())
      setReloadTick((n) => n + 1)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(null)
    }
  }

  const column = (opts: {
    title: string
    total: number
    list: Person[]
    selected: Set<string>
    setSelected: (fn: (prev: Set<string>) => Set<string>) => void
    query: string
    setQuery: (v: string) => void
    empty: string
    action: 'add' | 'remove'
  }) => {
    const { list, selected, setSelected } = opts
    const allShown = list.length > 0 && list.every((p) => selected.has(p.id))
    const toggle = (id: string) => setSelected((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
    const toggleShown = () => setSelected((prev) => {
      const n = new Set(prev)
      list.forEach((p) => { if (allShown) n.delete(p.id); else n.add(p.id) })
      return n
    })
    return (
      <div className="flex flex-col gap-2 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] font-black uppercase tracking-widest text-text-light">
            {opts.title} <span className="text-text-dark">{opts.total}</span>
          </p>
          {list.length > 0 && (
            <button type="button" onClick={toggleShown} className="text-[10px] font-black uppercase tracking-wider text-primary hover:underline">
              {allShown ? t('companyTab.members.clearSelection') : t('companyTab.members.selectShown', { count: list.length })}
            </button>
          )}
        </div>
        <input
          type="text"
          value={opts.query}
          onChange={(e) => opts.setQuery(e.target.value)}
          placeholder={t('companyTab.members.search')}
          className="w-full rounded-xl bg-background-light border-none px-3 py-2 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
        />
        <div className="h-80 overflow-y-auto rounded-xl border border-border-light p-1 space-y-0.5">
          {people === null ? (
            <p className="px-3 py-4 text-xs text-text-light">{t('common.loading')}</p>
          ) : list.length === 0 ? (
            <p className="px-3 py-4 text-xs text-text-light">{opts.query.trim() ? t('companyTab.members.noMatches') : opts.empty}</p>
          ) : list.map((p) => {
            const checked = selected.has(p.id)
            return (
              <label key={p.id} className={`flex items-center gap-2 rounded-lg px-2 py-2 cursor-pointer transition-colors ${checked ? 'bg-primary/10' : 'hover:bg-background-light'}`}>
                <input type="checkbox" checked={checked} onChange={() => toggle(p.id)} className="h-4 w-4 shrink-0 accent-primary cursor-pointer" />
                <span className={`flex-1 min-w-0 truncate text-sm font-bold ${checked ? 'text-primary' : 'text-text-dark'} ${p.isActive ? '' : 'opacity-50'}`}>
                  {p.firstName} {p.lastName}
                </span>
                {!p.isActive && <span className="shrink-0 text-[9px] font-black uppercase text-text-light">{t('companyTab.members.inactive')}</span>}
              </label>
            )
          })}
        </div>
        <Button
          type="button"
          variant={opts.action === 'remove' ? 'outline' : undefined}
          icon={opts.action === 'remove' ? 'person_remove' : 'person_add'}
          disabled={selected.size === 0 || saving !== null}
          isLoading={saving === opts.action}
          onClick={() => void save(opts.action)}
        >
          {opts.action === 'remove'
            ? t('companyTab.members.remove', { count: selected.size })
            : t('companyTab.members.add', { count: selected.size })}
        </Button>
      </div>
    )
  }

  return (
    <Modal isOpen size="xl" title={t('companyTab.members.title', { name: department.name })} onClose={onClose}>
      <div className="space-y-3">
        {error && <p className="text-xs font-bold text-error-text">{error}</p>}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {column({
            title: t('companyTab.members.inDepartment'), total: members.length, list: shownIn,
            selected: selIn, setSelected: setSelIn, query: qIn, setQuery: setQIn,
            empty: t('companyTab.members.emptyIn'), action: 'remove',
          })}
          {column({
            title: t('companyTab.members.withoutDepartment'), total: free.length, list: shownFree,
            selected: selFree, setSelected: setSelFree, query: qFree, setQuery: setQFree,
            empty: t('companyTab.members.emptyFree'), action: 'add',
          })}
        </div>
        <p className="text-[10px] text-text-light">{t('companyTab.members.hint')}</p>
      </div>
    </Modal>
  )
}
