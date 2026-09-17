import { useTranslation } from 'react-i18next';

interface PaginationProps {
    page: number;
    totalPages: number;
    /** Всего строк — показывается в подписи «страница X из Y (всего N)». */
    total: number;
    onPage: (page: number) => void;
    /** Верхняя граница-разделитель: не нужна, когда блок стоит отдельной карточкой. */
    bordered?: boolean;
}

/** Навигация по страницам под таблицей. На одной странице не показывается. */
export function Pagination({ page, totalPages, total, onPage, bordered = true }: PaginationProps) {
    const { t } = useTranslation();
    if (totalPages <= 1) return null;
    const btn = 'w-8 h-8 flex items-center justify-center rounded-xl transition-colors';
    // Первая, последняя и соседние страницы; разрывы между ними — многоточием.
    const items = Array.from({ length: totalPages }, (_, i) => i + 1)
        .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
        .reduce<(number | '…')[]>((acc, p, idx, arr) => {
            if (idx > 0 && arr[idx - 1] < p - 1) acc.push('…');
            acc.push(p);
            return acc;
        }, []);

    return (
        <div className={`flex flex-wrap items-center justify-between gap-2 px-5 py-3 ${bordered ? 'border-t border-border' : ''}`}>
            <span className="text-[11px] font-bold text-text-muted">
                {t('people.pageOf', { page, total: totalPages, count: total })}
            </span>
            <div className="flex items-center gap-1">
                <button type="button" onClick={() => onPage(page - 1)} disabled={page === 1}
                    className={`${btn} bg-background-light text-text-muted hover:text-primary disabled:opacity-30`}>
                    <span className="material-symbols-outlined text-base">chevron_left</span>
                </button>
                {items.map((p, idx) => p === '…' ? (
                    <span key={`gap-${idx}`} className={`${btn} text-xs text-text-muted`}>…</span>
                ) : (
                    <button key={p} type="button" onClick={() => onPage(p)}
                        className={`${btn} text-xs font-black ${page === p ? 'bg-primary text-white shadow' : 'bg-background-light text-text-muted hover:text-primary'}`}>
                        {p}
                    </button>
                ))}
                <button type="button" onClick={() => onPage(page + 1)} disabled={page === totalPages}
                    className={`${btn} bg-background-light text-text-muted hover:text-primary disabled:opacity-30`}>
                    <span className="material-symbols-outlined text-base">chevron_right</span>
                </button>
            </div>
        </div>
    );
}
