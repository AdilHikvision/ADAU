import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../atoms'
import { Modal } from '../Modal'

/** Группа в дереве слева: отдел у работников, факультет (блок) у студентов. */
export interface PickerGroup {
    id: string
    name: string
    parentId?: string | null
    sortOrder: number
}

export interface PickerPerson {
    id: string
    firstName: string
    lastName: string
    employeeNo?: string | null
    /** Группа человека в дереве. Null — человек не попадёт ни в одну группу. */
    groupId?: string | null
    /** Подпись под именем: отдел, факультет и т.п. */
    groupName?: string | null
}

export interface PeoplePickerSelection {
    personIds: string[]
    groupIds: string[]
}

interface PeoplePickerProps {
    onClose: () => void
    title: string
    groups: PickerGroup[]
    people: PickerPerson[]
    /** Начальный выбор — окно правит свою копию и отдаёт её по «Применить». */
    selection: PeoplePickerSelection
    onApply: (selection: PeoplePickerSelection) => void
    /**
     * Разрешён ли выбор групп целиком. Фильтр отчётов — да (группа уходит на сервер
     * как есть). Там, где нужны конкретные люди, группу разворачивает вызывающий код.
     */
    allowGroups?: boolean
    /** Показывать пункт «все» (снимает любой выбор). Для назначения людей он не нужен. */
    allowEmpty?: boolean
    /** Ключи подписей: у студентов вместо отделов — факультеты. */
    text?: {
        groupSearch: string
        personSearch: string
        allGroups: string
        allPeople: string
        noneInGroup: string
        selectWholeGroup: string
        unselectWholeGroup: string
    }
}

const DEFAULT_TEXT = {
    groupSearch: 'peoplePicker.groupSearch',
    personSearch: 'peoplePicker.personSearch',
    allGroups: 'peoplePicker.allGroups',
    allPeople: 'peoplePicker.allPeople',
    noneInGroup: 'peoplePicker.noneInGroup',
    selectWholeGroup: 'peoplePicker.selectWholeGroup',
    unselectWholeGroup: 'peoplePicker.unselectWholeGroup',
}

/**
 * Окно выбора людей: слева дерево групп, справа люди выбранной группы.
 *
 * Одиночный режим повторяет прежнее поведение «Select employee»: клик по человеку
 * выбирает его одного и закрывает окно. Кнопка «Несколько» включает накопительный
 * выбор — галочки у людей и групп, в том числе из разных групп сразу.
 *
 * Компонент монтируют только на время показа: {open && <PeoplePicker …/>}. Тогда
 * состояние берётся из selection при монтировании и не тянется от прошлого открытия.
 */
export function PeoplePicker({
    onClose,
    title,
    groups,
    people,
    selection,
    onApply,
    allowGroups = true,
    allowEmpty = true,
    text = DEFAULT_TEXT,
}: PeoplePickerProps) {
    const { t } = useTranslation()
    const [personIds, setPersonIds] = useState<string[]>(selection.personIds)
    const [groupIds, setGroupIds] = useState<string[]>(selection.groupIds)
    // Несколько человек выбирают редко, поэтому режим включается кнопкой. Если окно
    // открыли с уже накопленным выбором, включаем его сразу.
    const [multiple, setMultiple] = useState(
        selection.personIds.length > 1 || (selection.personIds.length > 0 && selection.groupIds.length > 0),
    )
    const [browseGroupId, setBrowseGroupId] = useState<string | null>(null)
    const [groupSearch, setGroupSearch] = useState('')
    const [personSearch, setPersonSearch] = useState('')

    /** Группа и все вложенные: выбрав корневую, видим людей из подгрупп. */
    const descendants = (rootId: string): Set<string> => {
        const set = new Set<string>([rootId])
        let grew = true
        while (grew) {
            grew = false
            for (const g of groups) {
                if (g.parentId && set.has(g.parentId) && !set.has(g.id)) { set.add(g.id); grew = true }
            }
        }
        return set
    }

    const browseScope = browseGroupId ? descendants(browseGroupId) : null
    const inScope = (p: PickerPerson) => p.groupId != null && browseScope!.has(p.groupId)
    const personQuery = personSearch.trim().toLowerCase()
    const visiblePeople = people.filter((p) => {
        if (browseScope && !inScope(p)) return false
        if (!personQuery) return true
        const hay = `${p.firstName} ${p.lastName} ${p.employeeNo ?? ''}`.toLowerCase()
        return hay.includes(personQuery)
    })

    const togglePerson = (id: string) => {
        setPersonIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
    }
    const toggleGroup = (id: string) => {
        setGroupIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
    }
    const clearAll = () => { setPersonIds([]); setGroupIds([]) }
    const apply = (next?: PeoplePickerSelection) => {
        onApply(next ?? { personIds, groupIds })
        onClose()
    }

    const groupQuery = groupSearch.trim().toLowerCase()
    const groupRow = (g: PickerGroup, depth: number): ReactNode => {
        const checked = groupIds.includes(g.id)
        const browsing = browseGroupId === g.id
        return (
            <div
                key={g.id}
                className={`flex items-center gap-2 rounded-lg pr-2 transition-colors ${browsing ? 'bg-primary/10' : 'hover:bg-background-light'}`}
                style={{ paddingLeft: 8 + depth * 16 }}
            >
                {allowGroups && (
                    <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleGroup(g.id)}
                        aria-label={g.name}
                        className="h-4 w-4 shrink-0 accent-primary cursor-pointer"
                    />
                )}
                <button
                    type="button"
                    onClick={() => setBrowseGroupId(g.id)}
                    className={`flex-1 min-w-0 text-left py-2 text-sm font-bold truncate ${checked || browsing ? 'text-primary' : 'text-text-dark'}`}
                >
                    {g.name}
                </button>
            </div>
        )
    }
    const renderGroups = (parentId: string | null, depth: number): ReactNode[] =>
        groups
            .filter((g) => (g.parentId ?? null) === parentId)
            .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
            .flatMap((g) => [groupRow(g, depth), ...renderGroups(g.id, depth + 1)])

    const selectedCount = personIds.length + groupIds.length

    return (
        <Modal isOpen title={title} onClose={onClose}>
            <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[11px] leading-snug text-text-light">
                        {t(multiple ? 'peoplePicker.multiHint' : 'peoplePicker.singleHint')}
                    </p>
                    <button
                        type="button"
                        onClick={() => setMultiple((m) => !m)}
                        aria-pressed={multiple}
                        className={`shrink-0 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[10px] font-black uppercase tracking-widest transition-colors ${multiple ? 'bg-primary text-white' : 'bg-background-light text-text-muted hover:text-text-dark'}`}
                    >
                        <span className="material-symbols-outlined text-sm">{multiple ? 'check_box' : 'check_box_outline_blank'}</span>
                        {t('peoplePicker.multiSelect')}
                    </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <input
                            type="text"
                            value={groupSearch}
                            onChange={(e) => setGroupSearch(e.target.value)}
                            placeholder={t(text.groupSearch)}
                            className="w-full rounded-xl bg-background-light border-none px-3 py-2 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                        />
                        <div className="h-80 overflow-y-auto rounded-xl border border-border-light p-1 space-y-0.5">
                            <button
                                type="button"
                                onClick={() => { setBrowseGroupId(null); if (allowEmpty) clearAll() }}
                                className={`w-full text-left px-3 py-2 rounded-lg text-sm font-bold transition-colors ${browseGroupId === null && selectedCount === 0 ? 'bg-primary text-white' : 'text-text-dark hover:bg-background-light'}`}
                            >
                                {t(text.allGroups)}
                            </button>
                            {groupQuery
                                ? groups
                                    .filter((g) => g.name.toLowerCase().includes(groupQuery))
                                    .sort((a, b) => a.name.localeCompare(b.name))
                                    .map((g) => groupRow(g, 0))
                                : renderGroups(null, 0)}
                        </div>
                    </div>

                    <div className="space-y-2">
                        <input
                            type="text"
                            value={personSearch}
                            onChange={(e) => setPersonSearch(e.target.value)}
                            placeholder={t(text.personSearch)}
                            className="w-full rounded-xl bg-background-light border-none px-3 py-2 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
                        />
                        <div className="h-80 overflow-y-auto rounded-xl border border-border-light p-1 space-y-0.5">
                            {allowEmpty && (
                                <button
                                    type="button"
                                    onClick={() => apply({ personIds: [], groupIds: [] })}
                                    className={`w-full text-left px-3 py-2 rounded-lg text-sm font-bold transition-colors ${selectedCount === 0 ? 'bg-primary text-white' : 'text-text-dark hover:bg-background-light'}`}
                                >
                                    {t(text.allPeople)}
                                </button>
                            )}
                            {allowGroups && browseGroupId && (() => {
                                const count = people.filter(inScope).length
                                const checked = groupIds.includes(browseGroupId)
                                return (
                                    <button
                                        type="button"
                                        onClick={() => toggleGroup(browseGroupId)}
                                        className={`w-full text-left px-3 py-2 rounded-lg text-sm font-bold transition-colors ${checked ? 'bg-primary text-white' : 'text-primary hover:bg-primary/10'}`}
                                    >
                                        <span className="flex items-center gap-2">
                                            <span className="material-symbols-outlined text-base shrink-0">{checked ? 'check_circle' : 'groups'}</span>
                                            <span className="truncate">
                                                {checked ? t(text.unselectWholeGroup) : t(text.selectWholeGroup, { count })}
                                            </span>
                                        </span>
                                    </button>
                                )
                            })()}
                            {visiblePeople.length === 0 ? (
                                <p className="px-3 py-4 text-xs text-text-light">{t(text.noneInGroup)}</p>
                            ) : (
                                visiblePeople.map((p) => {
                                    const checked = personIds.includes(p.id)
                                    return (
                                        <div
                                            key={p.id}
                                            className={`flex items-center gap-2 rounded-lg pr-2 transition-colors ${checked ? 'bg-primary text-white' : 'hover:bg-background-light'}`}
                                        >
                                            {multiple && (
                                                <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    onChange={() => togglePerson(p.id)}
                                                    aria-label={`${p.firstName} ${p.lastName}`}
                                                    className="ml-2 h-4 w-4 shrink-0 accent-primary cursor-pointer"
                                                />
                                            )}
                                            <button
                                                type="button"
                                                // Одиночный режим: выбрали человека — окно закрылось, как было раньше.
                                                onClick={() => multiple ? togglePerson(p.id) : apply({ personIds: [p.id], groupIds: [] })}
                                                className="flex-1 min-w-0 text-left px-3 py-2"
                                            >
                                                <span className={`block text-sm font-bold truncate ${checked ? 'text-white' : 'text-text-dark'}`}>
                                                    {p.firstName} {p.lastName}
                                                </span>
                                                {p.groupName && (
                                                    <span className={`block text-[10px] truncate ${checked ? 'text-white/80' : 'text-text-light'}`}>{p.groupName}</span>
                                                )}
                                            </button>
                                        </div>
                                    )
                                })
                            )}
                        </div>
                    </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-light pt-3">
                    <p className="text-xs font-bold text-text-light">
                        {selectedCount > 0
                            ? t('peoplePicker.selected', { people: personIds.length, groups: groupIds.length })
                            : t('peoplePicker.nothingSelected')}
                    </p>
                    <div className="flex items-center gap-2">
                        {selectedCount > 0 && (
                            <Button type="button" variant="outline" onClick={clearAll}>{t('peoplePicker.clear')}</Button>
                        )}
                        <Button type="button" onClick={() => apply()}>{t('common.apply')}</Button>
                    </div>
                </div>
            </div>
        </Modal>
    )
}
