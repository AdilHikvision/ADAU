import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

interface DateInputProps {
    /** Дата YYYY-MM-DD или пустая строка — как у <input type="date">. */
    value: string;
    /** Сигнатура как у нативного поля: обработчики вида (e) => set(e.target.value) подходят без правок. */
    onChange?: (e: { target: { value: string } }) => void;
    className?: string;
    min?: string;
    max?: string;
    title?: string;
    disabled?: boolean;
    /** Обязательное поле формы: пустое значение не даёт её отправить, «Очистить» скрыто. */
    required?: boolean;
    id?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const toYmd = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

function parseYmd(value: string): { y: number; m: number; d: number } | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (!match) return null;
    return { y: +match[1], m: +match[2] - 1, d: +match[3] };
}

/**
 * Поле даты со своим календарём вместо браузерного. У нативного <input type="date">
 * первый день недели берётся из региональных настроек Windows и браузера, поэтому у части
 * пользователей неделя начиналась с воскресенья. Здесь неделя всегда с понедельника,
 * а названия месяцев и дней — на языке интерфейса.
 */
export function DateInput({ value, onChange, className = '', min, max, title, disabled, required, id }: DateInputProps) {
    const { t, i18n } = useTranslation();
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLButtonElement>(null);
    const popRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

    const selected = parseYmd(value);
    const today = new Date();
    const [view, setView] = useState({ y: selected?.y ?? today.getFullYear(), m: selected?.m ?? today.getMonth() });

    const show = () => {
        if (disabled) return;
        // Каждое открытие начинается с месяца выбранной даты, а не с того, где листали в прошлый раз.
        setView({ y: selected?.y ?? today.getFullYear(), m: selected?.m ?? today.getMonth() });
        setOpen(true);
    };

    // Окно рисуется поверх страницы (портал), чтобы его не обрезали модалки и прокручиваемые блоки.
    useLayoutEffect(() => {
        if (!open || !anchorRef.current) return;
        const r = anchorRef.current.getBoundingClientRect();
        const h = popRef.current?.offsetHeight ?? 330;
        const w = popRef.current?.offsetWidth ?? 280;
        const below = r.bottom + 4 + h <= window.innerHeight;
        setPos({
            left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)),
            top: below ? r.bottom + 4 : Math.max(8, r.top - h - 4),
        });
    }, [open, view]);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            const target = e.target as Node;
            if (popRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
            setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        // Страница прокрутилась — поле уехало из-под окна, проще закрыть.
        const onScroll = (e: Event) => { if (!popRef.current?.contains(e.target as Node)) setOpen(false); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onScroll);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onScroll);
        };
    }, [open]);

    const lang = i18n.language;
    const monthNames = useMemo(() => {
        const fmt = new Intl.DateTimeFormat(lang, { month: 'long' });
        return Array.from({ length: 12 }, (_, m) => fmt.format(new Date(2024, m, 1)));
    }, [lang]);
    // 1 января 2024 — понедельник: семь дней подряд дают названия с понедельника по воскресенье.
    const weekdayNames = useMemo(() => {
        const fmt = new Intl.DateTimeFormat(lang, { weekday: 'short' });
        return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)));
    }, [lang]);

    const thisYear = today.getFullYear();
    const years = Array.from({ length: 111 }, (_, i) => thisYear + 10 - i);

    // Сетка: пустые ячейки до первого числа, считая понедельник первым днём недели.
    const lead = (new Date(view.y, view.m, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
    const cells: (number | null)[] = [...Array<null>(lead).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];

    const shiftMonth = (delta: number) => {
        const d = new Date(view.y, view.m + delta, 1);
        setView({ y: d.getFullYear(), m: d.getMonth() });
    };
    const outOfRange = (ymd: string) => (!!min && ymd < min) || (!!max && ymd > max);
    const pick = (ymd: string) => {
        onChange?.({ target: { value: ymd } });
        setOpen(false);
    };

    const todayYmd = toYmd(today.getFullYear(), today.getMonth(), today.getDate());
    const label = selected ? `${pad(selected.d)}.${pad(selected.m + 1)}.${selected.y}` : '';
    const navBtn = 'w-7 h-7 flex items-center justify-center rounded-lg text-text-light hover:bg-background-light hover:text-text-dark';
    const selectCls = 'rounded-lg bg-background-light border-none px-1.5 py-1 text-xs font-bold text-text-dark outline-none cursor-pointer';

    return (
        <>
            <button
                ref={anchorRef}
                type="button"
                id={id}
                title={title}
                disabled={disabled}
                onClick={() => (open ? setOpen(false) : show())}
                className={`inline-flex items-center justify-between gap-2 text-left whitespace-nowrap disabled:opacity-50 ${className}`}
            >
                <span className={selected ? '' : 'opacity-50'}>{label || t('datePicker.placeholder')}</span>
                <span className="material-symbols-outlined text-[16px] opacity-60 shrink-0">calendar_today</span>
            </button>
            {/* Проверку обязательности делает браузер — ему нужно настоящее поле формы. */}
            {required && (
                <input
                    tabIndex={-1}
                    aria-hidden="true"
                    required
                    value={value}
                    onChange={() => {}}
                    style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
                />
            )}
            {open && createPortal(
                <div
                    ref={popRef}
                    style={{ position: 'fixed', left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
                    className="z-[9999] w-[280px] bg-surface rounded-2xl shadow-2xl border border-border-light p-3 space-y-2"
                >
                    <div className="flex items-center gap-1">
                        <button type="button" className={navBtn} onClick={() => shiftMonth(-1)}>
                            <span className="material-symbols-outlined text-[18px]">chevron_left</span>
                        </button>
                        <select className={`${selectCls} flex-1 min-w-0 capitalize`} value={view.m} onChange={(e) => setView((v) => ({ ...v, m: +e.target.value }))}>
                            {monthNames.map((name, m) => <option key={m} value={m}>{name}</option>)}
                        </select>
                        <select className={selectCls} value={view.y} onChange={(e) => setView((v) => ({ ...v, y: +e.target.value }))}>
                            {!years.includes(view.y) && <option value={view.y}>{view.y}</option>}
                            {years.map((y) => <option key={y} value={y}>{y}</option>)}
                        </select>
                        <button type="button" className={navBtn} onClick={() => shiftMonth(1)}>
                            <span className="material-symbols-outlined text-[18px]">chevron_right</span>
                        </button>
                    </div>

                    <div className="grid grid-cols-7 gap-0.5">
                        {weekdayNames.map((name, i) => (
                            <span key={i} className={`py-1 text-center text-[10px] font-black uppercase ${i >= 5 ? 'text-rose-400' : 'text-text-light'}`}>{name}</span>
                        ))}
                        {cells.map((day, i) => {
                            if (day === null) return <span key={`e${i}`} />;
                            const ymd = toYmd(view.y, view.m, day);
                            const isSelected = ymd === value.slice(0, 10);
                            const isToday = ymd === todayYmd;
                            const blocked = outOfRange(ymd);
                            return (
                                <button
                                    key={ymd}
                                    type="button"
                                    disabled={blocked}
                                    onClick={() => pick(ymd)}
                                    className={`h-8 rounded-lg text-xs font-bold transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                                        isSelected ? 'bg-primary text-white'
                                            : isToday ? 'bg-primary/10 text-primary hover:bg-primary/20'
                                            : i % 7 >= 5 ? 'text-rose-500 hover:bg-background-light'
                                            : 'text-text-dark hover:bg-background-light'}`}
                                >
                                    {day}
                                </button>
                            );
                        })}
                    </div>

                    <div className="flex items-center justify-between border-t border-border-light pt-2">
                        {required ? <span /> : (
                            <button type="button" onClick={() => pick('')} className="px-1 text-[11px] font-black uppercase tracking-wide text-text-light hover:text-text-dark">
                                {t('common.clear')}
                            </button>
                        )}
                        <button type="button" disabled={outOfRange(todayYmd)} onClick={() => pick(todayYmd)} className="px-1 text-[11px] font-black uppercase tracking-wide text-primary disabled:opacity-30">
                            {t('common.today')}
                        </button>
                    </div>
                </div>,
                document.body,
            )}
        </>
    );
}
