import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Input } from '../components/atoms'
import { Modal } from '../components/organisms'
import { useAuth } from '../auth/AuthContext'
import { apiRequest } from '../lib/api'
import { loadHousingBlocks, type HousingBlockItem } from './housingBlocks'

/* ═══ Структура ЖКХ: комплекс → корпус → подъезд → этаж. Дерево той же природы, что
   и департаменты, но показано вложенным списком, а не схемой: у дома глубина больше,
   а узлов на уровне — десятки, и горизонтальная схема из CompanyTab здесь не читается. ═══ */

interface BlockForm {
    name: string
    description: string
    parentId: string | null
}

const emptyForm: BlockForm = { name: '', description: '', parentId: null }

/** Дети узла в порядке сортировки. Сирот (родителя удалили) поднимаем в корень. */
function childrenOf(items: HousingBlockItem[], parentId: string | null): HousingBlockItem[] {
    const ids = new Set(items.map((i) => i.id))
    return items
        .filter((i) => {
            const effectiveParent = i.parentId && ids.has(i.parentId) ? i.parentId : null
            return effectiveParent === parentId
        })
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}

function BlockRow({
    item,
    items,
    depth,
    onAddChild,
    onEdit,
    onDelete,
}: {
    item: HousingBlockItem
    items: HousingBlockItem[]
    depth: number
    onAddChild: (parent: HousingBlockItem) => void
    onEdit: (item: HousingBlockItem) => void
    onDelete: (item: HousingBlockItem) => void
}) {
    const { t } = useTranslation()
    const children = childrenOf(items, item.id)

    return (
        <>
            <div
                className="group flex items-center gap-3 rounded-xl border border-border-light bg-surface px-3 py-2.5 transition-colors hover:border-primary/35 hover:bg-primary/4"
                style={{ marginLeft: depth * 22 }}
            >
                <span className="material-symbols-outlined shrink-0 text-[18px] text-primary/70">
                    {/* Структура университета: факультет → подразделения. */}
                    {depth === 0 ? 'school' : children.length > 0 ? 'account_tree' : 'groups'}
                </span>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-bold text-text-dark">{item.name}</p>
                    {item.description && (
                        <p className="truncate text-[11px] text-text-light">{item.description}</p>
                    )}
                </div>

                <span
                    title={t('housing.residentsInBlock')}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg bg-slate-75 px-2 py-1"
                >
                    <span className="material-symbols-outlined text-[13px] text-primary">groups</span>
                    <span className="text-[11px] font-black text-text-dark">{item.residentCount}</span>
                </span>

                <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <button
                        type="button"
                        onClick={() => onAddChild(item)}
                        title={t('housing.addChild')}
                        className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors hover:bg-primary hover:text-white"
                    >
                        <span className="material-symbols-outlined text-[15px]">add</span>
                    </button>
                    <button
                        type="button"
                        onClick={() => onEdit(item)}
                        title={t('common.edit')}
                        className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-75 text-text-muted transition-colors hover:bg-slate-200"
                    >
                        <span className="material-symbols-outlined text-[15px]">edit</span>
                    </button>
                    <button
                        type="button"
                        onClick={() => onDelete(item)}
                        title={t('common.delete')}
                        className="flex h-7 w-7 items-center justify-center rounded-lg bg-red-50 text-red-500 transition-colors hover:bg-red-500 hover:text-white"
                    >
                        <span className="material-symbols-outlined text-[15px]">delete</span>
                    </button>
                </div>
            </div>

            {children.map((child) => (
                <BlockRow
                    key={child.id}
                    item={child}
                    items={items}
                    depth={depth + 1}
                    onAddChild={onAddChild}
                    onEdit={onEdit}
                    onDelete={onDelete}
                />
            ))}
        </>
    )
}

export function HousingTab() {
    const { t } = useTranslation()
    const { token, hasAnyPermission } = useAuth()
    const canManage = hasAnyPermission(['Housing.Manage'])

    const [items, setItems] = useState<HousingBlockItem[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const [modalOpen, setModalOpen] = useState(false)
    const [editingId, setEditingId] = useState<string | null>(null)
    const [form, setForm] = useState<BlockForm>(emptyForm)
    const [saving, setSaving] = useState(false)
    const [deleteTarget, setDeleteTarget] = useState<HousingBlockItem | null>(null)

    /** Перезагрузка после сохранения или удаления. Спиннер здесь не поднимаем:
     *  список короткий, а мигание рамкой на каждое переименование только мешает. */
    const load = useCallback(async () => {
        if (!token) return
        try {
            setItems(await loadHousingBlocks(token))
            setError(null)
        } catch (e) {
            setError(e instanceof Error ? e.message : t('housing.errors.load'))
        }
    }, [token, t])

    // Первая загрузка: состояние трогаем только в колбэках промиса, синхронно в теле
    // эффекта setState не вызываем — иначе лишний каскад рендеров.
    useEffect(() => {
        if (!token) return
        let cancelled = false
        loadHousingBlocks(token)
            .then((list) => { if (!cancelled) setItems(list) })
            .catch((e) => {
                if (!cancelled) setError(e instanceof Error ? e.message : t('housing.errors.load'))
            })
            .finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    }, [token, t])

    const roots = useMemo(() => childrenOf(items, null), [items])
    const parentName = form.parentId ? items.find((i) => i.id === form.parentId)?.name : null

    const openCreate = (parent?: HousingBlockItem) => {
        setEditingId(null)
        setForm({ ...emptyForm, parentId: parent?.id ?? null })
        setError(null)
        setModalOpen(true)
    }

    const openEdit = (item: HousingBlockItem) => {
        setEditingId(item.id)
        setForm({ name: item.name, description: item.description ?? '', parentId: item.parentId ?? null })
        setError(null)
        setModalOpen(true)
    }

    const save = async () => {
        if (!token || !form.name.trim()) return
        setSaving(true)
        setError(null)
        try {
            await apiRequest(editingId ? `/api/housing-blocks/${editingId}` : '/api/housing-blocks', {
                method: editingId ? 'PUT' : 'POST',
                token,
                body: JSON.stringify({
                    name: form.name.trim(),
                    description: form.description.trim() || null,
                    parentId: form.parentId,
                }),
            })
            setModalOpen(false)
            await load()
        } catch (e) {
            setError(e instanceof Error ? e.message : t('housing.errors.save'))
        } finally {
            setSaving(false)
        }
    }

    const confirmDelete = async () => {
        if (!token || !deleteTarget) return
        setError(null)
        try {
            await apiRequest(`/api/housing-blocks/${deleteTarget.id}`, { method: 'DELETE', token })
            setDeleteTarget(null)
            await load()
        } catch (e) {
            setError(e instanceof Error ? e.message : t('housing.errors.delete'))
            setDeleteTarget(null)
        }
    }

    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="text-sm font-black uppercase tracking-widest text-text-dark">
                        {t('housing.structureTitle')}
                    </h3>
                    <p className="mt-1 text-xs text-text-light">{t('housing.structureHint')}</p>
                </div>
                {canManage && (
                    <Button icon="add" size="md" onClick={() => openCreate()}>
                        {t('housing.addBlock')}
                    </Button>
                )}
            </div>

            {error && !modalOpen && (
                <div className="rounded-xl bg-error-bg p-4 text-xs font-bold text-error-text">{error}</div>
            )}

            {loading ? (
                <div className="py-16 text-center text-xs font-bold uppercase tracking-widest text-text-light">
                    {t('common.loading')}
                </div>
            ) : roots.length === 0 ? (
                <div className="rounded-2xl bg-surface py-16 text-center shadow-md">
                    <span className="material-symbols-outlined mb-3 text-5xl text-text-light">school</span>
                    <p className="text-sm font-bold uppercase tracking-widest text-text-muted">
                        {t('housing.empty')}
                    </p>
                </div>
            ) : (
                <div className="space-y-1.5">
                    {roots.map((item) => (
                        <BlockRow
                            key={item.id}
                            item={item}
                            items={items}
                            depth={0}
                            onAddChild={openCreate}
                            onEdit={openEdit}
                            onDelete={setDeleteTarget}
                        />
                    ))}
                </div>
            )}

            <Modal
                isOpen={modalOpen}
                onClose={() => setModalOpen(false)}
                title={editingId ? t('housing.editBlock') : t('housing.addBlock')}
            >
                <div className="space-y-4">
                    {parentName && (
                        <p className="rounded-xl bg-slate-75 px-3 py-2 text-[11px] font-bold text-text-muted">
                            {t('housing.parentLabel', { name: parentName })}
                        </p>
                    )}
                    <div>
                        <label className="mb-2 block text-[10px] font-black uppercase tracking-widest text-text-light">
                            {t('common.name')}
                        </label>
                        <Input
                            value={form.name}
                            onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                            placeholder={t('housing.blockNamePlaceholder')}
                        />
                    </div>
                    <div>
                        <label className="mb-2 block text-[10px] font-black uppercase tracking-widest text-text-light">
                            {t('housing.blockDescription')}
                        </label>
                        <Input
                            value={form.description}
                            onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                            placeholder={t('common.optional')}
                        />
                    </div>
                    {/* Родителя можно сменить и у существующего узла — так узел переносят между корпусами. */}
                    {editingId && (
                        <div className="space-y-1.5">
                            <label className="block text-[10px] font-black uppercase tracking-widest text-text-light">
                                {t('housing.parentBlock')}
                            </label>
                            <select
                                value={form.parentId ?? ''}
                                onChange={(e) => setForm((p) => ({ ...p, parentId: e.target.value || null }))}
                                className="w-full rounded-xl border border-border-light bg-white px-4 py-2.5 text-sm font-bold text-text-dark outline-none focus:ring-2 focus:ring-primary/20"
                            >
                                <option value="">{t('housing.noParent')}</option>
                                {items
                                    .filter((i) => i.id !== editingId)
                                    .map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                            </select>
                        </div>
                    )}
                    {error && (
                        <p className="rounded-xl bg-error-bg px-3 py-2.5 text-[11.5px] font-bold text-error-text">{error}</p>
                    )}
                    <div className="flex justify-end gap-3 pt-1">
                        <Button variant="outline" onClick={() => setModalOpen(false)}>{t('common.cancel')}</Button>
                        <Button onClick={save} isLoading={saving} disabled={!form.name.trim() || saving}>
                            {t('common.save')}
                        </Button>
                    </div>
                </div>
            </Modal>

            <Modal
                isOpen={deleteTarget !== null}
                onClose={() => setDeleteTarget(null)}
                title={t('housing.deleteBlock')}
            >
                <div className="space-y-4">
                    <p className="text-sm text-text-dark">
                        {t('housing.deleteConfirm', { name: deleteTarget?.name ?? '' })}
                    </p>
                    {(deleteTarget?.residentCount ?? 0) > 0 && (
                        <p className="rounded-xl bg-amber-50 px-3 py-2.5 text-[11.5px] font-bold text-amber-800">
                            {t('housing.deleteResidentsWarning', { count: deleteTarget?.residentCount ?? 0 })}
                        </p>
                    )}
                    <div className="flex justify-end gap-3">
                        <Button variant="outline" onClick={() => setDeleteTarget(null)}>{t('common.cancel')}</Button>
                        <Button variant="danger" onClick={confirmDelete}>{t('common.delete')}</Button>
                    </div>
                </div>
            </Modal>
        </div>
    )
}
