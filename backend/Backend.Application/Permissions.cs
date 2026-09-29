namespace Backend.Application.Security;

/// <summary>
/// Каталог всех разрешений (permissions) системы. Каждое разрешение — это строковый ключ
/// формата "Group.Action". Привязка ролей к разрешениям хранится в таблице role_permissions
/// и редактируется через UI (Settings → Roles).
/// </summary>
public static class Permissions
{
    // Devices & access control hardware
    public const string DevicesView = "Devices.View";
    public const string DevicesManage = "Devices.Manage";
    public const string DevicesControlDoor = "Devices.ControlDoor";

    // Access levels
    public const string AccessLevelsView = "AccessLevels.View";
    public const string AccessLevelsManage = "AccessLevels.Manage";

    // Organisation
    public const string CompaniesView = "Companies.View";
    public const string CompaniesManage = "Companies.Manage";
    public const string DepartmentsView = "Departments.View";
    public const string DepartmentsManage = "Departments.Manage";

    // People
    public const string EmployeesView = "Employees.View";
    /// <summary>Добавление и изменение работников. Удаление выделено в Employees.Delete.</summary>
    public const string EmployeesManage = "Employees.Manage";
    public const string EmployeesDelete = "Employees.Delete";
    public const string VisitorsView = "Visitors.View";
    public const string VisitorsManage = "Visitors.Manage";
    public const string CredentialsManage = "Credentials.Manage";

    // Time attendance & schedules
    public const string SchedulesView = "Schedules.View";
    public const string SchedulesManage = "Schedules.Manage";
    public const string AttendanceView = "Attendance.View";
    public const string AttendanceManage = "Attendance.Manage";
    public const string LeavesView = "Leaves.View";
    public const string LeavesManage = "Leaves.Manage";
    public const string GeoZonesManage = "GeoZones.Manage";

    // Payroll
    public const string PayrollView = "Payroll.View";
    public const string PayrollManage = "Payroll.Manage";

    // Reports
    public const string ReportsView = "Reports.View";

    // Parking
    public const string ParkingView = "Parking.View";
    public const string ParkingManage = "Parking.Manage";
    public const string ParkingOperate = "Parking.Operate";

    // Housing (ЖКХ)
    public const string HousingView = "Housing.View";
    public const string HousingManage = "Housing.Manage";

    // System administration
    public const string UsersManage = "Users.Manage";
    public const string RolesManage = "Roles.Manage";
    public const string AuditView = "Audit.View";
    public const string SettingsManage = "Settings.Manage";
    public const string SystemManage = "System.Manage";
    public const string BackupsManage = "Backups.Manage";

    /// <summary>
    /// Описание одного permission'а для UI-матрицы.
    /// </summary>
    public sealed record Descriptor(string Key, string Group, string Label, string Description);

    public static IReadOnlyList<Descriptor> Catalog { get; } =
    [
        new(DevicesView, "Devices", "View devices", "See device list, statuses, events, time settings."),
        new(DevicesManage, "Devices", "Manage devices", "Create / edit / delete devices, connect/disconnect, sync time, capture biometrics."),
        new(DevicesControlDoor, "Devices", "Control doors", "Open/close doors and elevator floors remotely."),

        new(AccessLevelsView, "Access control", "View access levels", "See access level list and the doors they cover."),
        new(AccessLevelsManage, "Access control", "Manage access levels", "Create / edit / delete access levels and door bindings."),

        new(CompaniesView, "Organisation", "View companies", "See company list."),
        new(CompaniesManage, "Organisation", "Manage companies", "Create / edit / delete companies."),
        new(DepartmentsView, "Organisation", "View departments", "See department tree."),
        new(DepartmentsManage, "Organisation", "Manage departments", "Create / edit / delete departments."),

        new(EmployeesView, "People", "View employees", "See employee list and details."),
        new(EmployeesManage, "People", "Add and edit employees", "Create and edit employees, push them to devices. Deleting requires a separate permission."),
        new(EmployeesDelete, "People", "Delete employees", "Delete employees together with their credentials and remove them from devices."),
        new(VisitorsView, "People", "View visitors", "See visitor list."),
        new(VisitorsManage, "People", "Manage visitors", "Create / edit / delete visitors and push them to devices."),
        new(CredentialsManage, "People", "Manage credentials", "Cards, faces, fingerprints, irises — add/remove/sync."),

        new(SchedulesView, "Attendance", "View schedules", "See work schedules and the planner."),
        new(SchedulesManage, "Attendance", "Manage schedules", "Create / edit / delete work schedules, assign to employees, edit planner."),
        new(AttendanceView, "Attendance", "View attendance", "See daily / period attendance and requests."),
        new(AttendanceManage, "Attendance", "Manage attendance", "Approve/reject requests, edit corrections, manage log sync."),
        new(LeavesView, "Attendance", "View leaves", "See leave list."),
        new(LeavesManage, "Attendance", "Manage leaves", "Create / approve / reject leaves."),
        new(GeoZonesManage, "Attendance", "Manage geo-zones", "Create / edit / delete check-in geo-zones."),

        new(PayrollView, "Payroll", "View payroll", "See periods, entries and salary configs."),
        new(PayrollManage, "Payroll", "Manage payroll", "Create / calculate / approve periods, edit salary and components, send reports."),

        new(ReportsView, "Reports", "View reports", "Download attendance/payroll reports (Excel, PDF) and email them."),

        new(ParkingView, "Parking", "View parking", "See zones, vehicles, permits, sessions, history and the event journal."),
        new(ParkingManage, "Parking", "Manage parking", "Edit zones and spaces, tariffs, subscriptions, permits, allow/block lists and the vehicle database."),
        new(ParkingOperate, "Parking", "Operate parking", "Barrier decisions, manual entry, exit and taking payments at the POS."),

        new(HousingView, "Housing", "View housing", "See residents and the housing structure (blocks, entrances, floors)."),
        new(HousingManage, "Housing", "Manage housing", "Create / edit / delete housing structure nodes and assign residents to them."),

        new(UsersManage, "System", "Manage users", "Create / edit / delete system users, reset passwords."),
        new(RolesManage, "System", "Manage roles", "Create / delete roles and assign permissions."),
        new(AuditView, "System", "View audit logs", "Read the system audit log."),
        new(SettingsManage, "System", "Manage settings", "Edit system settings, SMTP, email templates, time/log-sync schedules."),
        new(SystemManage, "System", "System control", "Start/stop services, run health checks."),
        new(BackupsManage, "System", "Manage backups", "Create / download / delete database backups."),
    ];

    public static IReadOnlyCollection<string> All { get; } =
        Catalog.Select(d => d.Key).ToArray();

    /// <summary>
    /// Дефолтная матрица: какая системная роль какие permission'ы получает при первичном seed'е.
    /// Если строка для роли уже существует в role_permissions, она НЕ перезаписывается.
    /// Admin всегда получает все permission'ы (вычисляется на лету в коде, не из таблицы).
    /// </summary>
    public static IReadOnlyDictionary<string, IReadOnlyCollection<string>> Defaults { get; } =
        new Dictionary<string, IReadOnlyCollection<string>>
        {
            [SystemRoles.Admin] = All,
            [SystemRoles.SecurityOperator] =
            [
                DevicesView, DevicesManage, DevicesControlDoor,
                AccessLevelsView, AccessLevelsManage,
                CompaniesView, DepartmentsView,
                EmployeesView, VisitorsView, VisitorsManage,
                CredentialsManage,
                // Охрана работает со шлагбаумом и справочниками парковки, но не с кассой.
                ParkingView, ParkingManage, ParkingOperate,
                // Жильцов охрана видит, но структуру дома не правит.
                HousingView,
            ],
            [SystemRoles.HrOperator] =
            [
                CompaniesView, CompaniesManage,
                DepartmentsView, DepartmentsManage,
                EmployeesView, EmployeesManage, EmployeesDelete,
                VisitorsView,
                SchedulesView, SchedulesManage,
                AttendanceView, AttendanceManage,
                LeavesView, LeavesManage,
                GeoZonesManage,
                PayrollView, PayrollManage,
                ReportsView,
                HousingView, HousingManage,
            ],
            // Employee role's access is granted through dedicated /api/self-service/* endpoints,
            // not through the permission catalog.
            [SystemRoles.Employee] = [],
        };
}
