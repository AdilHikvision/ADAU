import { UserDropdown, NotificationBell } from '../../molecules';
import { Logo } from '../../atoms';
import { useAuth } from '../../../auth/AuthContext';
import { useNotifications } from '../../../hooks/useNotifications';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useModule } from '../../../context/ModuleContext';
import type { ModuleKey } from '../../../config/modules';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface TopBarProps {
    title: string;
    breadcrumb?: string;
    searchPlaceholder?: string;
    actionIcon?: string;
    onAction?: () => void;
}

interface NavItem {
    labelKey: string;
    path: string;
    icon: string;
    /** Ключ со списком синонимов для поиска. Нет ключа — ищем только по названию. */
    keywordsKey?: string;
    /** Пункт виден только в этих модулях. Без поля — виден всегда (Настройки, Статус). */
    modules?: ModuleKey[];
    /** Показывать, если есть хотя бы одно из прав. Пусто — показывать всем. */
    anyOf?: string[];
    /** Только для платного режима парковки (parking.mode = Paid). */
    paidParkingOnly?: boolean;
    /** Название в модуле ЖКХ. Без поля название одинаково во всех модулях. */
    housingLabelKey?: string;
    /** Синонимы для модуля ЖКХ — ищем и по ним, чтобы «жильцы» находили страницу. */
    housingKeywordsKey?: string;
}

// Список зеркалит сайдбар: в поиске не должно быть страниц выключенного модуля
// или тех, на которые у пользователя нет прав.
const NAV_ITEMS: NavItem[] = [
    // ─── Workforce ───
    { labelKey: 'nav.dashboard', path: '/dashboard', icon: 'grid_view', keywordsKey: 'topBar.navKeywords.dashboard', modules: ['workforce'] },
    { labelKey: 'nav.people', path: '/people', icon: 'group', keywordsKey: 'topBar.navKeywords.people', housingLabelKey: 'nav.peopleAndResidents', housingKeywordsKey: 'topBar.navKeywords.residents', modules: ['workforce', 'housing'], anyOf: ['Employees.View', 'Visitors.View'] },
    { labelKey: 'nav.monitoring', path: '/monitoring', icon: 'monitor_heart', keywordsKey: 'topBar.navKeywords.monitoring', modules: ['workforce', 'housing'], anyOf: ['Devices.View'] },
    { labelKey: 'nav.accessLevels', path: '/access-levels', icon: 'admin_panel_settings', keywordsKey: 'topBar.navKeywords.accessLevels', modules: ['workforce', 'housing'], anyOf: ['AccessLevels.View'] },
    { labelKey: 'nav.workHours', path: '/work-hours', icon: 'schedule', keywordsKey: 'topBar.navKeywords.workHours', modules: ['workforce', 'housing'], anyOf: ['Attendance.View'] },
    { labelKey: 'nav.schedulePlanner', path: '/schedule-planner', icon: 'calendar_month', keywordsKey: 'topBar.navKeywords.schedulePlanner', modules: ['workforce'], anyOf: ['Schedules.View'] },
    { labelKey: 'nav.approvals', path: '/approvals', icon: 'approval', keywordsKey: 'topBar.navKeywords.approvals', modules: ['workforce'], anyOf: ['Attendance.Manage', 'Leaves.Manage'] },
    { labelKey: 'nav.geoZones', path: '/geo-zones', icon: 'my_location', keywordsKey: 'topBar.navKeywords.geoZones', modules: ['workforce'], anyOf: ['GeoZones.Manage'] },
    { labelKey: 'nav.payroll', path: '/payroll', icon: 'payments', keywordsKey: 'topBar.navKeywords.payroll', modules: ['workforce'], anyOf: ['Payroll.View'] },

    // ─── Parking ───
    { labelKey: 'nav.dashboard', path: '/', icon: 'grid_view', keywordsKey: 'topBar.navKeywords.dashboard', modules: ['parking', 'housing'] },
    { labelKey: 'parking.nav.management', path: '/parking/management', icon: 'local_parking', keywordsKey: 'topBar.navKeywords.parkingManagement', modules: ['parking'], anyOf: ['Parking.Manage'] },
    { labelKey: 'parking.nav.vehicles', path: '/parking/vehicles', icon: 'directions_car', keywordsKey: 'topBar.navKeywords.parkingVehicles', modules: ['parking'], anyOf: ['Parking.View'] },
    { labelKey: 'parking.nav.holders', path: '/parking/holders', icon: 'key', keywordsKey: 'topBar.navKeywords.parkingHolders', modules: ['parking'], anyOf: ['Parking.View'] },
    { labelKey: 'parking.nav.blacklist', path: '/parking/blacklist', icon: 'block', keywordsKey: 'topBar.navKeywords.parkingBlacklist', modules: ['parking'], anyOf: ['Parking.View'] },
    { labelKey: 'parking.nav.pos', path: '/parking/pos', icon: 'point_of_sale', keywordsKey: 'topBar.navKeywords.parkingPos', modules: ['parking'], anyOf: ['Parking.Operate'], paidParkingOnly: true },
    { labelKey: 'parking.nav.tariffs', path: '/parking/tariffs', icon: 'sell', keywordsKey: 'topBar.navKeywords.parkingTariffs', modules: ['parking'], anyOf: ['Parking.Manage'], paidParkingOnly: true },
    { labelKey: 'parking.nav.history', path: '/parking/history', icon: 'history', keywordsKey: 'topBar.navKeywords.parkingHistory', modules: ['parking'], anyOf: ['Parking.View'] },
    { labelKey: 'parking.nav.reports', path: '/parking/ap-reports', icon: 'bar_chart', keywordsKey: 'topBar.navKeywords.parkingReports', modules: ['parking'], anyOf: ['Parking.View'] },

    // ─── Общие ───
    { labelKey: 'nav.settings', path: '/settings', icon: 'settings', keywordsKey: 'topBar.navKeywords.settings', anyOf: ['Settings.Manage', 'Companies.Manage', 'Users.Manage', 'Roles.Manage', 'Audit.View'] },
    { labelKey: 'nav.systemStatus', path: '/status', icon: 'monitoring', keywordsKey: 'topBar.navKeywords.systemStatus', anyOf: ['System.Manage'] },
]

function getInitials(email: string | null | undefined): string {
    if (!email) return '?';
    const part = email.split('@')[0];
    if (!part) return '?';
    const first = part[0]?.toUpperCase() ?? '?';
    const second = part[1]?.toUpperCase();
    return second ? `${first}${second}` : first;
}

export function TopBar({ title, breadcrumb, searchPlaceholder, actionIcon, onAction }: TopBarProps) {
    const { user, logout, hasAnyPermission } = useAuth();
    const { activeModule, parkingPaid } = useModule();
    const isHousing = activeModule === 'housing';
    const { t } = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();
    const initials = getInitials(user?.email);
    const { notifications, unreadCount, markRead, markAllRead } = useNotifications();

    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // Сначала отсекаем чужой модуль и недоступные права — иначе в поиске
    // всплывали бы страницы модуля, который в этой установке выключен.
    const available = NAV_ITEMS.filter(item => {
        if (item.modules && !item.modules.includes(activeModule)) return false;
        if (item.paidParkingOnly && !parkingPaid) return false;
        if (!item.anyOf || item.anyOf.length === 0) return true;
        return hasAnyPermission(item.anyOf);
    });

    // В модуле ЖКХ «Работники» показываются как «Жильцы и работники» и находятся
    // ещё и по слову «жильцы».
    const labelOf = (item: NavItem) => t(isHousing && item.housingLabelKey ? item.housingLabelKey : item.labelKey);
    const keywordsOf = (item: NavItem) => [
        item.keywordsKey,
        isHousing ? item.housingKeywordsKey : undefined,
    ].filter(Boolean).map(k => t(k as string).toLowerCase());

    const needle = query.trim().toLowerCase();
    const results = needle
        ? available.filter(item =>
            labelOf(item).toLowerCase().includes(needle) ||
            keywordsOf(item).some(k => k.includes(needle))
        )
        : [];

    const isOpen = results.length > 0;

    useEffect(() => {
        setQuery('');
    }, [location.pathname]);

    useEffect(() => {
        setActiveIndex(0);
    }, [query]);

    useEffect(() => {
        function onMouseDown(e: MouseEvent) {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setQuery('');
            }
        }
        document.addEventListener('mousedown', onMouseDown);
        return () => document.removeEventListener('mousedown', onMouseDown);
    }, []);

    // Ctrl/Cmd + K focuses the command search from anywhere.
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                inputRef.current?.focus();
            }
        }
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, []);

    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (!isOpen) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIndex(i => Math.min(i + 1, results.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIndex(i => Math.max(i - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (results[activeIndex]) {
                navigate(results[activeIndex].path);
                setQuery('');
                inputRef.current?.blur();
            }
        } else if (e.key === 'Escape') {
            setQuery('');
            inputRef.current?.blur();
        }
    }

    const handleLogout = () => {
        logout();
        window.location.href = '/login';
    };

    return (
        <header className="sticky top-0 z-20 shrink-0 bg-white/85 backdrop-blur-xl border-b border-border-light">
            {/* Desktop Top Bar */}
            <div className="hidden md:flex items-center justify-between px-8 py-3 min-h-[64px]">
                {/* Left: Breadcrumb / Title */}
                <div className="flex items-center gap-3 text-sm">
                    {breadcrumb ? (
                        <div className="flex items-center gap-2">
                            <Link to="/" className="text-text-light font-medium hover:text-primary transition-colors cursor-pointer no-underline">
                                {breadcrumb}
                            </Link>
                            <span className="material-symbols-outlined text-sm text-text-light/70">chevron_right</span>
                            <span className="text-text-dark font-bold tracking-tight">{title}</span>
                        </div>
                    ) : (
                        <span className="text-xl font-bold tracking-tight text-text-dark">{title}</span>
                    )}
                </div>

                {/* Right: Search, Bell, Avatar */}
                <div className="flex items-center gap-4 flex-1 justify-end">
                    {/* Search with dropdown */}
                    <div ref={containerRef} className="relative w-full max-w-[320px]">
                        <div className="relative group">
                            <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-[18px] text-text-light group-focus-within:text-primary transition-colors pointer-events-none">search</span>
                            <input
                                ref={inputRef}
                                type="text"
                                value={query}
                                onChange={e => setQuery(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder={searchPlaceholder || t('topBar.searchPages')}
                                className="w-full pl-10 pr-16 py-2 text-sm rounded-xl border border-transparent bg-slate-75 text-text-dark placeholder:text-text-light focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/40 focus:bg-white transition-all"
                            />
                            <kbd className="absolute right-3 top-1/2 -translate-y-1/2 hidden lg:flex items-center gap-0.5 rounded-md border border-border-base bg-white px-1.5 py-0.5 text-[10px] font-bold text-text-light pointer-events-none">
                                Ctrl K
                            </kbd>
                        </div>

                        {isOpen && (
                            <div className="animate-pop absolute top-full mt-2 left-0 right-0 bg-white rounded-2xl shadow-float border border-border-light z-50 overflow-hidden p-1.5">
                                {results.map((item, i) => (
                                    <button
                                        key={item.path}
                                        type="button"
                                        onMouseDown={() => {
                                            navigate(item.path);
                                            setQuery('');
                                        }}
                                        onMouseEnter={() => setActiveIndex(i)}
                                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ${i === activeIndex ? 'bg-primary/8 text-primary' : 'text-text-dark'}`}
                                    >
                                        <span className={`material-symbols-outlined text-[18px] shrink-0 ${i === activeIndex ? 'text-primary icon-fill' : 'text-text-muted'}`}>
                                            {item.icon}
                                        </span>
                                        <span className="text-sm font-semibold">{labelOf(item)}</span>
                                        {i === activeIndex && (
                                            <span className="material-symbols-outlined ml-auto text-[16px] text-primary/60">keyboard_return</span>
                                        )}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="flex items-center gap-2">
                        <NotificationBell
                            notifications={notifications}
                            unreadCount={unreadCount}
                            onMarkRead={markRead}
                            onMarkAllRead={markAllRead}
                        />
                        <UserDropdown initials={initials} onLogout={handleLogout} />
                    </div>
                </div>
            </div>

            {/* Mobile Top Bar */}
            <div className="md:hidden flex items-center justify-between px-6 py-4 min-h-[72px]">
                <div className="flex items-center">
                    <Logo size={40} />
                </div>
                <div className="flex-1 text-center">
                    <h1 className="text-lg font-extrabold text-text-dark tracking-tight leading-none">{title}</h1>
                </div>
                <div className="flex items-center justify-end">
                    {actionIcon || onAction ? (
                        <button
                            onClick={onAction}
                            className="w-10 h-10 flex items-center justify-center bg-brand-gradient text-white rounded-xl shadow-primary hover:scale-105 active:scale-95 transition-all"
                        >
                            <span className="material-symbols-outlined text-2xl">{actionIcon || 'add'}</span>
                        </button>
                    ) : (
                        <div className="w-10" />
                    )}
                </div>
            </div>
        </header>
    );
}
