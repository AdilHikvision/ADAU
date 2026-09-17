import { useTranslation } from 'react-i18next';
import { NavItem } from '../../molecules';
import { Logo } from '../../atoms';
import { useAuth } from '../../../auth/AuthContext';
import { useModule } from '../../../context/ModuleContext';
import { MODULES, type ModuleKey } from '../../../config/modules';

interface NavConfig {
    to: string;
    icon: string;
    labelKey?: string;
    /** Literal label — used when there is no i18n key (e.g. embedded Aktiv Parking tabs). */
    label?: string;
    end?: boolean;
    /** Show item if user has at least one of these permissions. Omit/empty = always show (e.g. Dashboard). */
    anyOf?: string[];
    /** Restrict item to these modules. Omit = visible in every module (e.g. Dashboard, Settings). */
    modules?: ModuleKey[];
    /** Показывать только когда парковка в платном режиме (parking.mode = Paid). */
    paidParkingOnly?: boolean;
    /** Название в модуле ЖКХ. Без поля название одинаково во всех модулях. */
    housingLabelKey?: string;
}

// Top section — feature pages. Dashboard is visible in every module; the rest are Workforce-only.
const PRIMARY_NAV: NavConfig[] = [
    { to: '/dashboard', icon: 'grid_view', labelKey: 'nav.dashboard', modules: ['workforce'] },
    { to: '/', icon: 'grid_view', labelKey: 'nav.dashboard', end: true, modules: ['gym', 'parking', 'housing'] },
    { to: '/people', icon: 'group', labelKey: 'nav.people', housingLabelKey: 'nav.peopleAndResidents', anyOf: ['Employees.View', 'Visitors.View'], modules: ['workforce', 'housing'] },
    { to: '/monitoring', icon: 'monitor_heart', labelKey: 'nav.monitoring', anyOf: ['Devices.View'], modules: ['workforce', 'housing'] },
    { to: '/access-levels', icon: 'admin_panel_settings', labelKey: 'nav.accessLevels', anyOf: ['AccessLevels.View'], modules: ['workforce', 'housing'] },
    { to: '/work-hours', icon: 'schedule', labelKey: 'nav.workHours', anyOf: ['Attendance.View'], modules: ['workforce', 'housing'] },
    { to: '/authentication-records', icon: 'fingerprint', labelKey: 'nav.authRecords', anyOf: ['Attendance.View'], modules: ['workforce', 'housing'] },
    { to: '/schedule-planner', icon: 'calendar_month', labelKey: 'nav.schedulePlanner', anyOf: ['Schedules.View'], modules: ['workforce'] },
    { to: '/approvals', icon: 'approval', labelKey: 'nav.approvals', anyOf: ['Attendance.Manage', 'Leaves.Manage'], modules: ['workforce'] },
    { to: '/geo-zones', icon: 'my_location', labelKey: 'nav.geoZones', anyOf: ['GeoZones.Manage'], modules: ['workforce'] },
    { to: '/payroll', icon: 'payments', labelKey: 'nav.payroll', anyOf: ['Payroll.View'], modules: ['workforce'] },

    // ─── Gym Management ───
    { to: '/gym/customers', icon: 'groups', labelKey: 'gym.nav.customers', modules: ['gym'] },
    { to: '/gym/subscriptions', icon: 'card_membership', labelKey: 'gym.nav.subscriptions', modules: ['gym'] },
    { to: '/gym/inventory', icon: 'inventory_2', labelKey: 'gym.nav.inventory', modules: ['gym'] },
    { to: '/gym/finance', icon: 'account_balance_wallet', labelKey: 'gym.nav.finance', modules: ['gym'] },
    { to: '/gym/analytics', icon: 'analytics', labelKey: 'gym.nav.analytics', modules: ['gym'] },
    { to: '/gym/pos', icon: 'point_of_sale', labelKey: 'gym.nav.pos', modules: ['gym'] },

    // ─── Parking Management ───
    { to: '/parking/management', icon: 'local_parking', labelKey: 'parking.nav.management', anyOf: ['Parking.Manage'], modules: ['parking'] },

    // ─── Aktiv Parking (нативные страницы ProjectX) ───
    // "Ana Səhifə" Dashboard tabında göstərilir (parking modulunda), ona görə burada ayrıca yoxdur.
    { to: '/parking/vehicles', icon: 'directions_car', labelKey: 'parking.nav.vehicles', anyOf: ['Parking.View'], modules: ['parking'] },
    { to: '/parking/holders', icon: 'key', labelKey: 'parking.nav.holders', anyOf: ['Parking.View'], modules: ['parking'] },
    { to: '/parking/blacklist', icon: 'block', labelKey: 'parking.nav.blacklist', anyOf: ['Parking.View'], modules: ['parking'] },
    { to: '/parking/pos', icon: 'point_of_sale', labelKey: 'parking.nav.pos', anyOf: ['Parking.Operate'], modules: ['parking'], paidParkingOnly: true },
    { to: '/parking/tariffs', icon: 'sell', labelKey: 'parking.nav.tariffs', anyOf: ['Parking.Manage'], modules: ['parking'], paidParkingOnly: true },
    { to: '/parking/history', icon: 'history', labelKey: 'parking.nav.history', anyOf: ['Parking.View'], modules: ['parking'] },
    { to: '/parking/ap-reports', icon: 'bar_chart', labelKey: 'parking.nav.reports', anyOf: ['Parking.View'], modules: ['parking'] },
];

// System section — admin / settings pages.
const SYSTEM_NAV: NavConfig[] = [
    // Settings page has multiple tabs; show it for anyone who can manage at least one settings area.
    { to: '/settings', icon: 'settings', labelKey: 'nav.settings', anyOf: ['Settings.Manage', 'Companies.Manage', 'Users.Manage', 'Roles.Manage', 'Audit.View'] },
    { to: '/status', icon: 'monitoring', labelKey: 'nav.systemStatus', anyOf: ['System.Manage'] },
];

export function Sidebar() {
    const { hasAnyPermission } = useAuth();
    const { t } = useTranslation();
    // Режим парковки живёт в ModuleContext: сайдбар пересоздаётся на каждой странице,
    // и своё состояние сбрасывалось бы в «бесплатный» — пункты «Касса» и «Тарифы»
    // мигали бы при каждом переходе, пока идёт запрос.
    const { activeModule, openPicker, canSwitchModules, parkingPaid } = useModule();
    const isHousing = activeModule === 'housing';
    const module = MODULES[activeModule];

    const isAllowed = (item: NavConfig): boolean => {
        if (item.modules && !item.modules.includes(activeModule)) return false;
        if (item.paidParkingOnly && !parkingPaid) return false;
        if (!item.anyOf || item.anyOf.length === 0) return true;
        return hasAnyPermission(item.anyOf);
    };

    // В модуле ЖКХ «Работники» становятся «Жильцами и работниками»: страница одна,
    // просто в ней появляется вкладка жильцов.
    const navLabel = (item: NavConfig): string => {
        if (item.label) return item.label;
        const key = isHousing && item.housingLabelKey ? item.housingLabelKey : item.labelKey;
        return key ? t(key) : '';
    };

    const primary = PRIMARY_NAV.filter(isAllowed);
    const system = SYSTEM_NAV.filter(isAllowed);

    return (
        <aside className="hidden md:flex flex-col w-[264px] bg-sidebar border-r border-sidebar-border py-6 shrink-0 h-full">
            {/* Шапка. Фон меню тёмный, поэтому логотип идёт без подложки. */}
            <div className="px-5 mb-7">
                {activeModule === 'parking' ? (
                    <div className="flex items-center gap-3">
                        <span
                            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white text-xl font-extrabold"
                            style={{ background: '#6C5CE7' }}
                        >
                            P
                        </span>
                        <div>
                            <h1 className="text-[15px] font-extrabold leading-tight tracking-tight text-sidebar-text">Aktiv Parking</h1>
                        </div>
                    </div>
                ) : (
                    // Только логотип: в нём уже есть название (ADAU и полное имя университета),
                    // подпись модуля под ним дублировала бы его.
                    <Logo size={48} plate={false} />
                )}
            </div>

            {/* Карточка-переключатель нужна только когда активирован не один модуль. */}
            {canSwitchModules && (
            <button
                type="button"
                onClick={openPicker}
                title={t('modules.switch')}
                className="group mx-3 mb-5 flex items-center gap-3 rounded-2xl border border-sidebar-border bg-sidebar-hover/60 p-2.5 text-left transition-all hover:border-primary/50 hover:bg-primary/15"
            >
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-linear-to-br ${module.gradient} text-white shadow-inner-soft`}>
                    <img src={module.image} alt="" className="h-full w-full object-cover" />
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block text-[9px] font-extrabold uppercase tracking-[0.16em] text-sidebar-muted">{t('modules.label')}</span>
                    <span className="block truncate text-sm font-bold text-sidebar-text">{t(module.nameKey)}</span>
                </span>
                <span className="material-symbols-outlined shrink-0 text-lg text-sidebar-muted transition-colors group-hover:text-primary-light">unfold_more</span>
            </button>
            )}

            <nav className="flex-1 overflow-y-auto px-3 space-y-1">
                {primary.map(item => (
                    <NavItem key={item.to} to={item.to} icon={item.icon} label={navLabel(item)} end={item.end} />
                ))}
            </nav>

            {system.length > 0 && (
                <div className="px-3 pt-4 mt-2 mb-2 border-t border-sidebar-border">
                    <p className="px-3 text-[9px] font-extrabold text-sidebar-muted tracking-[0.18em] uppercase mb-2">{t('nav.system')}</p>
                    <nav className="space-y-1">
                        {system.map(item => (
                            <NavItem key={item.to} to={item.to} icon={item.icon} label={navLabel(item)} />
                        ))}
                    </nav>
                </div>
            )}

            <div className="px-6 pt-2 text-[10px] font-bold uppercase tracking-[0.14em] text-sidebar-muted/70">
                v{__APP_VERSION__}
            </div>

        </aside>
    );
}
