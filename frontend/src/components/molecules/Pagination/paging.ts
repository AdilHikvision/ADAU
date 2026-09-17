import { useState } from 'react';

/** Сколько строк показываем на одной странице таблицы. */
export const PAGE_SIZE = 50;

/**
 * Номер страницы, который сам возвращается на первую, когда меняется ключ
 * (вкладка, фильтр, период). Ключ — обычная строка из значений фильтров:
 * сбрасывать страницу через useEffect не нужно, лишнего рендера не будет.
 */
export function usePageReset(key: string): [number, (page: number) => void] {
    const [state, setState] = useState({ key, page: 1 });
    return [state.key === key ? state.page : 1, (page: number) => setState({ key, page })];
}

/**
 * Срез текущей страницы. Если страница вышла за диапазон (фильтр укоротил список),
 * она поджимается к последней — пустой таблицы не будет.
 */
export function pageSlice<T>(items: T[], page: number, pageSize = PAGE_SIZE): { rows: T[]; totalPages: number; page: number } {
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    const safe = Math.min(Math.max(1, page), totalPages);
    return { rows: items.slice((safe - 1) * pageSize, safe * pageSize), totalPages, page: safe };
}
