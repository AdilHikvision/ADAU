import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppNotification } from '../../../hooks/useNotifications';

const TYPE_ICON: Record<string, string> = {
    DeviceOffline: 'wifi_off',
    DeviceOnline: 'wifi',
    ApprovalRequest: 'assignment',
    ApprovalApproved: 'check_circle',
    ApprovalRejected: 'cancel',
    DailyReport: 'bar_chart',
};

const TYPE_COLOR: Record<string, string> = {
    DeviceOffline: 'text-error-text',
    DeviceOnline: 'text-success-text',
    ApprovalRequest: 'text-primary',
    ApprovalApproved: 'text-success-text',
    ApprovalRejected: 'text-error-text',
    DailyReport: 'text-primary',
};

/** Параметры-перечисления (тип заявки, вид отпуска) приходят с бэкенда как есть
 *  («Vacation», «CheckIn»…) — переводим их, иначе внутри переведённой фразы
 *  остаётся английское слово. Неизвестное значение показываем как есть. */
const ENUM_PARAMS = ['type', 'leaveType'];

function parseNotifText(raw: string, t: (key: string, params?: Record<string, unknown>) => string): string {
    try {
        const parsed = JSON.parse(raw) as { k?: string; p?: Record<string, unknown> };
        if (parsed && typeof parsed.k === 'string') {
            const params = { ...(parsed.p ?? {}) };
            for (const key of ENUM_PARAMS) {
                const value = params[key];
                if (typeof value === 'string' && value.length > 0) {
                    params[key] = t(`notifications.enums.${value}`, { defaultValue: value });
                }
            }
            return t(parsed.k, params);
        }
    } catch {
        // not JSON — return as-is
    }
    return raw;
}

function useTimeAgo() {
    const { t } = useTranslation();
    return (dateStr: string): string => {
        const diff = Date.now() - new Date(dateStr).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return t('notifications.justNow');
        if (mins < 60) return t('notifications.minutesAgo', { count: mins });
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return t('notifications.hoursAgo', { count: hrs });
        return t('notifications.daysAgo', { count: Math.floor(hrs / 24) });
    };
}

interface NotificationBellProps {
    notifications: AppNotification[];
    unreadCount: number;
    onMarkRead: (id: string) => void;
    onMarkAllRead: () => void;
}

export function NotificationBell({ notifications, unreadCount, onMarkRead, onMarkAllRead }: NotificationBellProps) {
    const { t } = useTranslation();
    const timeAgo = useTimeAgo();
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        function onMouseDown(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        }
        document.addEventListener('mousedown', onMouseDown);
        return () => document.removeEventListener('mousedown', onMouseDown);
    }, []);

    return (
        <div className="relative" ref={ref}>
            <button
                type="button"
                onClick={() => setOpen(v => !v)}
                className="relative w-9 h-9 rounded-xl hover:bg-slate-75 transition-colors flex items-center justify-center"
            >
                <span className="material-symbols-outlined text-xl text-text-base">notifications</span>
                {unreadCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[17px] h-[17px] rounded-full bg-error-text text-white text-[10px] font-bold flex items-center justify-center px-1 leading-none ring-2 ring-white">
                        {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                )}
            </button>

            {open && (
                <div className="absolute right-0 top-full mt-2 w-80 bg-white rounded-2xl shadow-float border border-border-light animate-pop z-50 overflow-hidden flex flex-col max-h-[420px]">
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-3 border-b border-border-light">
                        <span className="text-sm font-bold text-text-dark">{t('notifications.title')}</span>
                        {unreadCount > 0 && (
                            <button
                                type="button"
                                onClick={onMarkAllRead}
                                className="text-xs text-primary font-semibold hover:underline"
                            >
                                {t('notifications.markAllRead')}
                            </button>
                        )}
                    </div>

                    {/* List */}
                    <div className="overflow-y-auto flex-1">
                        {notifications.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-10 gap-2 text-text-muted">
                                <span className="material-symbols-outlined text-3xl">notifications_none</span>
                                <span className="text-sm">{t('notifications.empty')}</span>
                            </div>
                        ) : (
                            notifications.map(n => (
                                <button
                                    key={n.id}
                                    type="button"
                                    onClick={() => { if (!n.isRead) onMarkRead(n.id); }}
                                    className={`w-full flex items-start gap-3 px-4 py-3 text-left transition-colors border-b border-border-light last:border-0 ${n.isRead ? 'bg-white hover:bg-slate-75' : 'bg-primary/4 hover:bg-primary/8'}`}
                                >
                                    <span className={`material-symbols-outlined text-[20px] mt-0.5 shrink-0 ${TYPE_COLOR[n.type] ?? 'text-text-muted'}`}>
                                        {TYPE_ICON[n.type] ?? 'circle_notifications'}
                                    </span>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs font-bold leading-snug text-text-dark">
                                            {parseNotifText(n.title, t)}
                                        </p>
                                        {/* Тело может быть пустым (напр. дневной отчёт — только заголовок) — пустую строку не рисуем. */}
                                        {parseNotifText(n.body, t).trim() !== '' && (
                                            <p className="text-xs text-text-light leading-snug mt-0.5 line-clamp-2">
                                                {parseNotifText(n.body, t)}
                                            </p>
                                        )}
                                        <p className="text-[10px] text-text-muted mt-1">{timeAgo(n.createdAtUtc)}</p>
                                    </div>
                                    {!n.isRead && (
                                        <span className="w-2 h-2 rounded-full bg-primary shrink-0 mt-1.5" />
                                    )}
                                </button>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
