import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/AuthContext'
import { Button, Input } from '../components/atoms'
import { Modal } from '../components/organisms'
import { ConfirmDialog } from '../components/molecules'
import { useLoading } from '../context/LoadingContext'
import { apiRequest } from '../lib/api'
import { DepartmentMembersModal } from './DepartmentMembersModal'

interface Company {
  id: string
  name: string
  description?: string | null
}

interface DepartmentTreeItem {
  id: string
  name: string
  description?: string | null
  sortOrder: number
  parentId?: string | null
  companyId?: string | null
  employeesCount: number
  visitorsCount: number
}

interface DepartmentForm {
  name: string
  description: string
  parentId: string | null
  companyId: string | null
}

interface CompanyForm {
  name: string
  description: string
}

interface PositionItem {
  id: string
  name: string
  description?: string | null
  sortOrder: number
  employeesCount: number
}

interface PositionForm {
  name: string
  description: string
}

const emptyDeptForm: DepartmentForm = { name: '', description: '', parentId: null, companyId: null }
const emptyCompanyForm: CompanyForm = { name: '', description: '' }
const emptyPosForm: PositionForm = { name: '', description: '' }

type AppMode = 'Single' | 'Multiple' | 'None'

function buildTree(items: DepartmentTreeItem[], parentId: string | null): DepartmentTreeItem[] {
  return items
    .filter((d) => (d.parentId ?? null) === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}

/** Отдел и все вложенные — для суммы сотрудников и для поиска с предками. */
function descendantIds(items: DepartmentTreeItem[], rootId: string): string[] {
  const out: string[] = []
  const walk = (id: string) => {
    for (const d of items) if ((d.parentId ?? null) === id) { out.push(d.id); walk(d.id) }
  }
  walk(rootId)
  return out
}

export function CompanyTab() {
  const { t } = useTranslation()
  const { token } = useAuth()
  const { startLoading, stopLoading } = useLoading()
  const [mode, setMode] = useState<AppMode>('None')
  const [companies, setCompanies] = useState<Company[]>([])
  const [items, setItems] = useState<DepartmentTreeItem[]>([])
  const [positions, setPositions] = useState<PositionItem[]>([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState<'initial' | 'add-dept' | 'edit-dept' | 'add-company' | 'edit-company' | 'add-pos' | 'edit-pos' | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deptForm, setDeptForm] = useState<DepartmentForm>(emptyDeptForm)
  const [companyForm, setCompanyForm] = useState<CompanyForm>(emptyCompanyForm)
  const [posForm, setPosForm] = useState<PositionForm>(emptyPosForm)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: 'dept' | 'company' | 'pos', item: any } | null>(null)
  // Отдел, чей состав открыт в окне (клик по числу сотрудников на карточке).
  const [membersDept, setMembersDept] = useState<{ id: string; name: string } | null>(null)

  // Поиск по названию отдела: совпадения показываются вместе с родителями, ветки раскрыты.
  const [deptQuery, setDeptQuery] = useState('')
  const toggleExpanded = (id: string) => setExpandedIds((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const [settings, companyList, deptList, posList] = await Promise.all([
        apiRequest<any[]>('/api/system-settings', { token }),
        apiRequest<Company[]>('/api/companies', { token }),
        apiRequest<DepartmentTreeItem[]>('/api/departments/tree', { token }),
        apiRequest<PositionItem[]>('/api/positions', { token })
      ])

      const modeSetting = settings.find(s => s.key === 'CompanyMode')
      const currentMode = (modeSetting?.value as AppMode) || 'None'
      
      setMode(currentMode)
      setCompanies(companyList)
      setItems(deptList)
      setPositions(posList)
      setExpandedIds(new Set(deptList.map((d) => d.id)))

      if (currentMode === 'None') {
        setModal('initial')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('companyTab.failedToLoad'))
    } finally {
      setLoading(false)
      stopLoading()
    }
  }, [token, stopLoading, t])

  useEffect(() => {
    startLoading()
    load()
  }, [load, startLoading])

  const handleSetMode = async (newMode: AppMode, companyName?: string) => {
    if (!token) return
    setIsSubmitting(true)
    try {
      if (newMode === 'Single' && companyName) {
        await apiRequest('/api/companies', {
          method: 'POST',
          token,
          body: JSON.stringify({ name: companyName })
        })
      }
      await apiRequest('/api/system-settings', {
        method: 'POST',
        token,
        body: JSON.stringify({ key: 'CompanyMode', value: newMode })
      })
      setModal(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('companyTab.configurationFailed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleAddDept = (parent?: DepartmentTreeItem, companyId?: string) => {
    setDeptForm({ 
      ...emptyDeptForm, 
      parentId: parent?.id ?? null,
      companyId: companyId ?? parent?.companyId ?? companies[0]?.id ?? null
    })
    setEditingId(null)
    setModal('add-dept')
  }

  const handleEditDept = (item: DepartmentTreeItem) => {
    setDeptForm({ 
      name: item.name, 
      description: item.description ?? '', 
      parentId: item.parentId ?? null,
      companyId: item.companyId ?? null
    })
    setEditingId(item.id)
    setModal('edit-dept')
  }

  const handleSubmitDept = async () => {
    if (!token || !deptForm.name.trim()) return
    setIsSubmitting(true)
    try {
      const method = editingId ? 'PUT' : 'POST'
      const url = editingId ? `/api/departments/${editingId}` : '/api/departments'
      await apiRequest(url, {
        method,
        token,
        body: JSON.stringify({
          name: deptForm.name.trim(),
          description: deptForm.description.trim() || null,
          parentId: deptForm.parentId || null,
          companyId: deptForm.companyId || null,
        }),
      })
      setModal(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('companyTab.saveFailed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleAddCompany = () => {
    setCompanyForm(emptyCompanyForm)
    setEditingId(null)
    setModal('add-company')
  }

  const handleSubmitCompany = async () => {
    if (!token || !companyForm.name.trim()) return
    setIsSubmitting(true)
    try {
      const method = editingId ? 'PUT' : 'POST'
      const url = editingId ? `/api/companies/${editingId}` : '/api/companies'
      await apiRequest(url, {
        method,
        token,
        body: JSON.stringify({
          name: companyForm.name.trim(),
          description: companyForm.description.trim() || null
        }),
      })
      setModal(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('companyTab.saveFailed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleAddPos = () => {
    setPosForm(emptyPosForm)
    setEditingId(null)
    setModal('add-pos')
  }

  const handleEditPos = (item: PositionItem) => {
    setPosForm({ name: item.name, description: item.description ?? '' })
    setEditingId(item.id)
    setModal('edit-pos')
  }

  const handleSubmitPos = async () => {
    if (!token || !posForm.name.trim()) return
    setIsSubmitting(true)
    try {
      const method = editingId ? 'PUT' : 'POST'
      const url = editingId ? `/api/positions/${editingId}` : '/api/positions'
      await apiRequest(url, {
        method,
        token,
        body: JSON.stringify({
          name: posForm.name.trim(),
          description: posForm.description.trim() || null,
        }),
      })
      setModal(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('companyTab.saveFailed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDelete = (type: 'dept' | 'company' | 'pos', item: any) => {
    setDeleteConfirm({ type, item })
  }

  const handleConfirmDelete = async () => {
    if (!token || !deleteConfirm) return
    setIsSubmitting(true)
    try {
      const url = deleteConfirm.type === 'dept'
        ? `/api/departments/${deleteConfirm.item.id}`
        : deleteConfirm.type === 'pos'
        ? `/api/positions/${deleteConfirm.item.id}`
        : `/api/companies/${deleteConfirm.item.id}`
      await apiRequest(url, { method: 'DELETE', token })
      setDeleteConfirm(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('companyTab.deleteFailed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  if (loading) return <div className="py-16 text-center text-text-light text-sm">{t('common.loading')}</div>

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-4 bg-error-bg text-error-text rounded-2xl text-sm font-bold">{error}</div>
      )}

      {mode === 'None' && items.length === 0 ? (
        <div className="py-16 text-center space-y-8">
           <div className="max-w-2xl mx-auto bg-surface rounded-3xl p-12 shadow-md border-none">
             <span className="material-symbols-outlined text-6xl text-sky-500 mb-6 block">domain_add</span>
             <h2 className="text-2xl font-black text-text-dark mb-4">{t('companyTab.initialSetup')}</h2>
             <p className="text-text-light mb-8">{t('companyTab.initialSetupDescription')}</p>

             <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
               <div
                 className="p-6 rounded-2xl shadow-md hover:shadow-lg cursor-pointer transition-all group bg-white border-none"
                 onClick={() => setModal('initial')}
               >
                 <span className="material-symbols-outlined text-4xl text-text-light group-hover:text-sky-500 mb-4 block">business</span>
                 <h3 className="font-bold text-lg mb-2">{t('companyTab.singleCompany')}</h3>
                 <p className="text-xs text-text-light text-center">{t('companyTab.singleCompanyDescription')}</p>
               </div>

               <div
                 className="p-6 rounded-2xl shadow-md hover:shadow-lg cursor-pointer transition-all group bg-white border-none"
                 onClick={() => handleSetMode('Multiple')}
               >
                 <span className="material-symbols-outlined text-4xl text-text-light group-hover:text-sky-500 mb-4 block">hub</span>
                 <h3 className="font-bold text-lg mb-2">{t('companyTab.groupOfCompanies')}</h3>
                 <p className="text-xs text-text-light text-center">{t('companyTab.groupOfCompaniesDescription')}</p>
               </div>
             </div>
           </div>
        </div>
      ) : companies.length === 0 ? (
        <div className="py-16 text-center">
          <div className="max-w-xl mx-auto bg-surface rounded-2xl p-10 shadow-md border-none">
            <span className="material-symbols-outlined text-5xl text-sky-500 mb-4 block">domain_add</span>
            <h2 className="text-lg font-black text-text-dark mb-2">{t('companyTab.noCompanies')}</h2>
            <p className="text-sm text-text-light mb-6">
              {mode === 'Single'
                ? t('companyTab.createCompanyToStart')
                : t('companyTab.addFirstCompany')}
            </p>
            <Button icon="add" onClick={handleAddCompany}>
              {mode === 'Single' ? t('companyTab.createCompany') : t('companyTab.addCompany')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="text-[10px] font-black text-text-light uppercase tracking-widest">
              {mode === 'Multiple' ? t('companyTab.companiesAndDepartments') : t('companyTab.companyStructure')}
            </h3>
            <div className="flex gap-2">
              {mode === 'Multiple' && (
                <Button variant="outline" icon="add" onClick={handleAddCompany}>
                  {t('companyTab.addCompany')}
                </Button>
              )}
              <Button icon="add" onClick={() => handleAddDept()}>
                {t('companyTab.addDepartment')}
              </Button>
            </div>
          </div>

          <div className="space-y-4">
            {companies.map(company => {
              const companyDepts = items.filter(d => d.companyId === company.id)
              const rootDepts = buildTree(companyDepts, null)
              
              return (
                <div key={company.id} className="bg-surface rounded-2xl p-5 shadow-sm border-none">
                  <div className="flex items-center justify-between mb-3 gap-3">
                    <div className="min-w-0">
                      <h4 className="text-lg font-black text-text-dark truncate">{company.name}</h4>
                      {company.description && <p className="text-xs text-text-light">{company.description}</p>}
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        icon="edit"
                        onClick={() => {
                          setCompanyForm({ name: company.name, description: company.description ?? '' })
                          setEditingId(company.id)
                          setModal('edit-company')
                        }}
                      >
                        {mode === 'Single' ? t('companyTab.companyName') : t('common.edit')}
                      </Button>
                      {mode === 'Multiple' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-500 hover:bg-red-50"
                          onClick={() => handleDelete('company', company)}
                        >
                          ×
                        </Button>
                      )}
                    </div>
                  </div>

                  {rootDepts.length === 0 ? (
                    <div className="py-6 text-center bg-slate-50 rounded-2xl">
                      <p className="text-xs text-text-light mb-3">{t('companyTab.noDepartmentsYet')}</p>
                      <Button size="sm" variant="outline" onClick={() => handleAddDept(undefined, company.id)}>
                        {t('companyTab.createFirstDepartment')}
                      </Button>
                    </div>
                  ) : (() => {
                    const q = deptQuery.trim().toLowerCase()
                    // Совпавшие отделы и их предки: без предков совпадение висело бы вне дерева.
                    let visible: Set<string> | null = null
                    if (q) {
                      visible = new Set()
                      for (const d of companyDepts) {
                        if (!d.name.toLowerCase().includes(q)) continue
                        let cur: DepartmentTreeItem | undefined = d
                        while (cur && !visible.has(cur.id)) {
                          visible.add(cur.id)
                          cur = companyDepts.find((x) => x.id === cur!.parentId)
                        }
                      }
                    }
                    const total = (d: DepartmentTreeItem) =>
                      d.employeesCount + descendantIds(companyDepts, d.id)
                        .reduce((sum, id) => sum + (companyDepts.find((x) => x.id === id)?.employeesCount ?? 0), 0)
                    const iconBtn = 'w-7 h-7 rounded-lg flex items-center justify-center text-text-light transition-colors'

                    const renderLevel = (parentId: string | null): ReactNode[] =>
                      buildTree(companyDepts, parentId)
                        .filter((d) => !visible || visible.has(d.id))
                        .map((d) => {
                          const children = buildTree(companyDepts, d.id).filter((c) => !visible || visible.has(c.id))
                          const open = visible ? true : expandedIds.has(d.id)
                          const sum = total(d)
                          return (
                            <div key={d.id}>
                              <div className="group flex items-center gap-2 h-11 pr-1 rounded-xl hover:bg-background-light transition-colors">
                                {children.length > 0 ? (
                                  <button type="button" onClick={() => toggleExpanded(d.id)} disabled={!!visible}
                                    className="w-6 h-6 shrink-0 rounded-md flex items-center justify-center text-text-light hover:bg-slate-200/60 hover:text-text-dark">
                                    <span className={`material-symbols-outlined text-[18px] transition-transform ${open ? 'rotate-90' : ''}`}>chevron_right</span>
                                  </button>
                                ) : <span className="w-6 shrink-0" />}
                                <span className="material-symbols-outlined text-[18px] text-sky-500 shrink-0">
                                  {children.length > 0 ? (open ? 'folder_open' : 'folder') : 'workspaces'}
                                </span>
                                <div className="flex-1 min-w-0 flex items-baseline gap-2">
                                  <span className="text-sm font-bold text-text-dark truncate">{d.name}</span>
                                  {d.description && <span className="hidden sm:inline text-xs text-text-light truncate">{d.description}</span>}
                                </div>
                                {children.length > 0 && (
                                  <span className="hidden md:inline shrink-0 text-[10px] font-bold text-text-light">
                                    {t('companyTab.tree.subdepartments', { count: children.length })}
                                  </span>
                                )}
                                {d.visitorsCount > 0 && (
                                  <span className="hidden md:inline-flex shrink-0 items-center gap-1 text-[10px] font-bold text-emerald-600" title={t('companyTab.tree.visitors')}>
                                    <span className="material-symbols-outlined text-[14px]">person_pin_circle</span>{d.visitorsCount}
                                  </span>
                                )}
                                {/* Сотрудники отдела; через дробь — вместе с подотделами. Клик — состав отдела. */}
                                <button
                                  type="button"
                                  onClick={() => setMembersDept({ id: d.id, name: d.name })}
                                  title={sum > d.employeesCount
                                    ? `${t('companyTab.members.count', { count: d.employeesCount })} · ${t('companyTab.tree.withSubdepartments', { count: sum })}`
                                    : t('companyTab.members.count', { count: d.employeesCount })}
                                  className="shrink-0 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-black bg-sky-50 text-sky-700 hover:bg-sky-500 hover:text-white transition-colors"
                                >
                                  <span className="material-symbols-outlined text-[14px]">groups</span>
                                  {d.employeesCount}
                                  {sum > d.employeesCount && <span className="font-bold opacity-60">/ {sum}</span>}
                                </button>
                                <div className="flex shrink-0 md:opacity-0 md:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                                  <button type="button" title={t('companyTab.tree.addSubdepartment')} onClick={() => handleAddDept(d)} className={`${iconBtn} hover:bg-sky-100 hover:text-sky-600`}>
                                    <span className="material-symbols-outlined text-[16px]">add</span>
                                  </button>
                                  <button type="button" title={t('common.edit')} onClick={() => handleEditDept(d)} className={`${iconBtn} hover:bg-slate-200 hover:text-text-dark`}>
                                    <span className="material-symbols-outlined text-[16px]">edit</span>
                                  </button>
                                  <button type="button" title={t('common.delete')} onClick={() => handleDelete('dept', d)} className={`${iconBtn} hover:bg-red-50 hover:text-red-500`}>
                                    <span className="material-symbols-outlined text-[16px]">delete</span>
                                  </button>
                                </div>
                              </div>
                              {open && children.length > 0 && (
                                <div className="ml-[19px] pl-2 border-l border-border-light">{renderLevel(d.id)}</div>
                              )}
                            </div>
                          )
                        })

                    const rows = renderLevel(null)
                    return (
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="relative flex-1 min-w-[180px]">
                            <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-[16px] text-text-light">search</span>
                            <input
                              type="text"
                              value={deptQuery}
                              onChange={(e) => setDeptQuery(e.target.value)}
                              placeholder={t('companyTab.tree.search')}
                              className="w-full rounded-xl bg-background-light border-none pl-8 pr-3 py-2 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                            />
                          </div>
                          <button type="button" onClick={() => setExpandedIds(new Set(companyDepts.map((d) => d.id)))}
                            className="px-2 py-1.5 text-[10px] font-black uppercase tracking-wider text-text-light hover:text-primary">
                            {t('companyTab.tree.expandAll')}
                          </button>
                          <button type="button" onClick={() => setExpandedIds(new Set())}
                            className="px-2 py-1.5 text-[10px] font-black uppercase tracking-wider text-text-light hover:text-primary">
                            {t('companyTab.tree.collapseAll')}
                          </button>
                        </div>
                        {rows.length === 0
                          ? <p className="px-2 py-4 text-xs text-text-light">{t('companyTab.tree.noMatches')}</p>
                          : <div>{rows}</div>}
                      </div>
                    )
                  })()}
                </div>
              )
            })}
          </div>

          {/* Positions (должности / vəzifələr) — плоский справочник */}
          <div className="bg-surface rounded-2xl p-5 shadow-sm border-none">
            <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
              <div>
                <h4 className="text-lg font-black text-text-dark">{t('companyTab.positionsTitle')}</h4>
                <p className="text-xs text-text-light">{t('companyTab.positionsDescription')}</p>
              </div>
              <Button icon="add" onClick={handleAddPos}>
                {t('companyTab.addPosition')}
              </Button>
            </div>

            {positions.length === 0 ? (
              <div className="py-8 text-center bg-slate-50 rounded-2xl shadow-sm border-none">
                <p className="text-xs text-text-light">{t('companyTab.noPositionsYet')}</p>
              </div>
            ) : (
              <div className="divide-y divide-border-light">
                {positions.map((p) => (
                  <div key={p.id} className="group flex items-center gap-2 h-11 px-1">
                    <span className="material-symbols-outlined text-[18px] text-text-light shrink-0">badge</span>
                    <div className="flex-1 min-w-0 flex items-baseline gap-2">
                      <span className="text-sm font-bold text-text-dark truncate">{p.name}</span>
                      {p.description && <span className="hidden sm:inline text-xs text-text-light truncate">{p.description}</span>}
                    </div>
                    <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-black text-text-light" title={t('companyTab.positionEmployeesCount')}>
                      <span className="material-symbols-outlined text-[14px]">group</span>{p.employeesCount}
                    </span>
                    <div className="flex shrink-0 md:opacity-0 md:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button type="button" title={t('common.edit')} onClick={() => handleEditPos(p)}
                        className="w-7 h-7 rounded-lg flex items-center justify-center text-text-light hover:bg-slate-200 hover:text-text-dark">
                        <span className="material-symbols-outlined text-[16px]">edit</span>
                      </button>
                      <button type="button" title={t('common.delete')} onClick={() => handleDelete('pos', p)}
                        className="w-7 h-7 rounded-lg flex items-center justify-center text-text-light hover:bg-red-50 hover:text-red-500">
                        <span className="material-symbols-outlined text-[16px]">delete</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* MODALS */}
      
      {modal === 'initial' && (
        <Modal isOpen title={t('companyTab.companyName')} onClose={() => setModal(null)}>
          <div className="space-y-4">
            <p className="text-xs text-text-light">{t('companyTab.enterCompanyNameToFinish')}</p>
            <Input
              placeholder={t('companyTab.companyName')}
              value={companyForm.name}
              onChange={e => setCompanyForm({ ...companyForm, name: e.target.value })}
              autoFocus
            />
            <Button
              fullWidth
              onClick={() => handleSetMode('Single', companyForm.name)}
              isLoading={isSubmitting}
              disabled={!companyForm.name.trim()}
            >
              {t('companyTab.finish')}
            </Button>
          </div>
        </Modal>
      )}

      {(modal === 'add-dept' || modal === 'edit-dept') && (
        <Modal
          isOpen
          title={modal === 'add-dept' ? t('companyTab.addDepartment') : t('companyTab.editDepartment')}
          onClose={() => setModal(null)}
        >
          <div className="space-y-4">
            <div>
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-2">{t('common.name')}</label>
              <Input
                value={deptForm.name}
                onChange={e => setDeptForm({ ...deptForm, name: e.target.value })}
                placeholder={t('companyTab.deptNamePlaceholder')}
              />
            </div>
            <div>
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-2">{t('companyTab.description')}</label>
              <Input
                value={deptForm.description}
                onChange={e => setDeptForm({ ...deptForm, description: e.target.value })}
                placeholder={t('common.optional')}
              />
            </div>
            {mode === 'Multiple' && !deptForm.parentId && (
              <div>
                <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-2">{t('companyTab.company')}</label>
                <select
                  className="w-full bg-surface border-2 border-divider-light rounded-xl h-12 px-4 text-sm focus:border-sky-400 outline-none transition-all"
                  value={deptForm.companyId ?? ''}
                  onChange={e => setDeptForm({ ...deptForm, companyId: e.target.value })}
                >
                  {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            )}
            <Button fullWidth onClick={handleSubmitDept} isLoading={isSubmitting} disabled={!deptForm.name.trim()}>
              {modal === 'add-dept' ? t('common.add') : t('common.save')}
            </Button>
          </div>
        </Modal>
      )}

      {(modal === 'add-company' || modal === 'edit-company') && (
        <Modal
          isOpen
          title={modal === 'add-company' ? t('companyTab.addCompany') : t('companyTab.editCompany')}
          onClose={() => setModal(null)}
        >
          <div className="space-y-4">
            <div>
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-2">{t('common.name')}</label>
              <Input
                value={companyForm.name}
                onChange={e => setCompanyForm({ ...companyForm, name: e.target.value })}
                placeholder={t('companyTab.companyName')}
                autoFocus
              />
            </div>
            <div>
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-2">{t('companyTab.description')}</label>
              <Input
                value={companyForm.description}
                onChange={e => setCompanyForm({ ...companyForm, description: e.target.value })}
                placeholder={t('common.optional')}
              />
            </div>
            <Button fullWidth onClick={handleSubmitCompany} isLoading={isSubmitting} disabled={!companyForm.name.trim()}>
              {modal === 'add-company' ? t('common.add') : t('common.save')}
            </Button>
          </div>
        </Modal>
      )}

      {(modal === 'add-pos' || modal === 'edit-pos') && (
        <Modal
          isOpen
          title={modal === 'add-pos' ? t('companyTab.addPosition') : t('companyTab.editPosition')}
          onClose={() => setModal(null)}
        >
          <div className="space-y-4">
            <div>
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-2">{t('common.name')}</label>
              <Input
                value={posForm.name}
                onChange={e => setPosForm({ ...posForm, name: e.target.value })}
                placeholder={t('companyTab.positionNamePlaceholder')}
                autoFocus
              />
            </div>
            <div>
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest mb-2">{t('companyTab.description')}</label>
              <Input
                value={posForm.description}
                onChange={e => setPosForm({ ...posForm, description: e.target.value })}
                placeholder={t('common.optional')}
              />
            </div>
            <Button fullWidth onClick={handleSubmitPos} isLoading={isSubmitting} disabled={!posForm.name.trim()}>
              {modal === 'add-pos' ? t('common.add') : t('common.save')}
            </Button>
          </div>
        </Modal>
      )}

      {deleteConfirm && (
        <ConfirmDialog
          isOpen
          title={deleteConfirm.type === 'dept' ? t('companyTab.deleteDepartmentQuestion') : deleteConfirm.type === 'pos' ? t('companyTab.deletePositionQuestion') : t('companyTab.deleteCompanyQuestion')}
          message={t('companyTab.actionCannotBeUndone')}
          onConfirm={handleConfirmDelete}
          onClose={() => setDeleteConfirm(null)}
          isLoading={isSubmitting}
          variant="danger"
        />
      )}
      {membersDept && token && (
        <DepartmentMembersModal
          department={membersDept}
          token={token}
          onClose={() => setMembersDept(null)}
          // Только счётчики на карточках: полная перезагрузка свернула бы раскрытые ветки.
          onChanged={() => {
            void apiRequest<DepartmentTreeItem[]>('/api/departments/tree', { token })
              .then(setItems)
              .catch(() => {})
          }}
        />
      )}
    </div>
  )
}
