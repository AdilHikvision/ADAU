using Backend.Application.Security;
using Backend.Infrastructure.Identity;
using Backend.Infrastructure.Persistence;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Backend.Infrastructure.Initialization;

public sealed class DatabaseInitializer(
    AppDbContext dbContext,
    RoleManager<IdentityRole<Guid>> roleManager,
    UserManager<ApplicationUser> userManager,
    ILogger<DatabaseInitializer> logger) : IDatabaseInitializer
{
    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        await dbContext.Database.MigrateAsync(cancellationToken);

        // One-time: add columns if missing (migrations may not have been applied in order)
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE devices ADD COLUMN IF NOT EXISTS "DeviceIdentifier" character varying(120) DEFAULT ''
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE devices ADD COLUMN IF NOT EXISTS "LastSeenUtc" timestamp with time zone
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE devices ADD COLUMN IF NOT EXISTS "Username" character varying(64)
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE devices ADD COLUMN IF NOT EXISTS "Password" character varying(120)
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            UPDATE devices SET "DeviceIdentifier" = 'device-' || REPLACE(CAST("Id" AS text), '-', '') WHERE "DeviceIdentifier" IS NULL OR "DeviceIdentifier" = ''
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE UNIQUE INDEX IF NOT EXISTS "IX_devices_DeviceIdentifier" ON devices ("DeviceIdentifier")
            """, cancellationToken);

        // Remove PersonnelNumber (deprecated)
        await dbContext.Database.ExecuteSqlRawAsync("""
            DROP INDEX IF EXISTS "IX_employees_PersonnelNumber"
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE employees DROP COLUMN IF EXISTS "PersonnelNumber"
            """, cancellationToken);

        // AddCardsFacesFingerprints: EmployeeNo и таблицы cards/faces/fingerprints
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE employees ADD COLUMN IF NOT EXISTS "EmployeeNo" character varying(32)
            """, cancellationToken);

        // AddEmployeeGenderValid: Gender, ValidFromUtc, ValidToUtc
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE employees ADD COLUMN IF NOT EXISTS "Gender" character varying(16)
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE employees ADD COLUMN IF NOT EXISTS "ValidFromUtc" timestamp with time zone
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE employees ADD COLUMN IF NOT EXISTS "ValidToUtc" timestamp with time zone
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE employees ADD COLUMN IF NOT EXISTS "OnlyVerify" boolean DEFAULT false
            """, cancellationToken);

        // Visitor ValidFromUtc, ValidToUtc (model has them, migration missed visitors table)
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE visitors ADD COLUMN IF NOT EXISTS "ValidFromUtc" timestamp with time zone
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE visitors ADD COLUMN IF NOT EXISTS "ValidToUtc" timestamp with time zone
            """, cancellationToken);

        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE UNIQUE INDEX IF NOT EXISTS "IX_employees_EmployeeNo" ON employees ("EmployeeNo") WHERE "EmployeeNo" IS NOT NULL
            """, cancellationToken);

        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE TABLE IF NOT EXISTS companies (
                "Id" uuid NOT NULL PRIMARY KEY,
                "Name" character varying(255) NOT NULL,
                "Description" character varying(500),
                "CreatedUtc" timestamp with time zone NOT NULL,
                "UpdatedUtc" timestamp with time zone
            )
            """, cancellationToken);

        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE TABLE IF NOT EXISTS system_settings (
                "Id" uuid NOT NULL PRIMARY KEY,
                "Key" character varying(120) NOT NULL,
                "Value" text,
                "CreatedUtc" timestamp with time zone NOT NULL,
                "UpdatedUtc" timestamp with time zone
            )
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE UNIQUE INDEX IF NOT EXISTS "IX_system_settings_Key" ON system_settings ("Key")
            """, cancellationToken);

        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE departments ADD COLUMN IF NOT EXISTS "CompanyId" uuid REFERENCES companies("Id") ON DELETE SET NULL
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE employees ADD COLUMN IF NOT EXISTS "CompanyId" uuid REFERENCES companies("Id") ON DELETE SET NULL
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE visitors ADD COLUMN IF NOT EXISTS "CompanyId" uuid REFERENCES companies("Id") ON DELETE SET NULL
            """, cancellationToken);

        // Должности (positions) + FK у сотрудников — страховка для баз, где миграция не применилась.
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE TABLE IF NOT EXISTS positions (
                "Id" uuid NOT NULL PRIMARY KEY,
                "Name" character varying(200) NOT NULL,
                "Description" character varying(500),
                "SortOrder" integer NOT NULL DEFAULT 0,
                "CreatedUtc" timestamp with time zone NOT NULL,
                "UpdatedUtc" timestamp with time zone
            )
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE employees ADD COLUMN IF NOT EXISTS "PositionId" uuid REFERENCES positions("Id") ON DELETE SET NULL
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE INDEX IF NOT EXISTS "IX_employees_PositionId" ON employees ("PositionId")
            """, cancellationToken);

        // Aktiv Parking (нативно): жильцы, транспорт, пропуска — страховка для баз без миграции.
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE TABLE IF NOT EXISTS parking_residents (
                "Id" uuid NOT NULL PRIMARY KEY,
                "FullName" character varying(200) NOT NULL,
                "Phone" character varying(64),
                "Unit" character varying(64),
                "Notes" character varying(1000),
                "IsActive" boolean NOT NULL DEFAULT TRUE,
                "CreatedUtc" timestamp with time zone NOT NULL,
                "UpdatedUtc" timestamp with time zone
            )
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE TABLE IF NOT EXISTS parking_vehicles (
                "Id" uuid NOT NULL PRIMARY KEY,
                "ResidentId" uuid REFERENCES parking_residents("Id") ON DELETE SET NULL,
                "Plate" character varying(32) NOT NULL,
                "PlateNormalized" character varying(32) NOT NULL,
                "Brand" character varying(120),
                "Color" character varying(64),
                "Notes" character varying(1000),
                "IsActive" boolean NOT NULL DEFAULT TRUE,
                "CreatedUtc" timestamp with time zone NOT NULL,
                "UpdatedUtc" timestamp with time zone
            )
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE TABLE IF NOT EXISTS parking_permits (
                "Id" uuid NOT NULL PRIMARY KEY,
                "VehicleId" uuid NOT NULL REFERENCES parking_vehicles("Id") ON DELETE CASCADE,
                "ZoneId" uuid REFERENCES parking_zones("Id") ON DELETE SET NULL,
                "ValidFrom" date NOT NULL,
                "ValidTo" date,
                "IsActive" boolean NOT NULL DEFAULT TRUE,
                "Notes" character varying(1000),
                "CreatedUtc" timestamp with time zone NOT NULL,
                "UpdatedUtc" timestamp with time zone
            )
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE INDEX IF NOT EXISTS "IX_parking_vehicles_PlateNormalized" ON parking_vehicles ("PlateNormalized")
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE INDEX IF NOT EXISTS "IX_parking_permits_VehicleId" ON parking_permits ("VehicleId")
            """, cancellationToken);

        // Платная парковка: тарифы, абонементы, журнал событий + расширения авто/списков/сессий.
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE TABLE IF NOT EXISTS parking_tariffs (
                "Id" uuid NOT NULL PRIMARY KEY,
                "Name" character varying(200) NOT NULL,
                "Kind" integer NOT NULL DEFAULT 1,
                "FreeMinutes" integer NOT NULL DEFAULT 0,
                "PricePerHour" numeric(12,2) NOT NULL DEFAULT 0,
                "PricePerDay" numeric(12,2) NOT NULL DEFAULT 0,
                "FixedPrice" numeric(12,2) NOT NULL DEFAULT 0,
                "MaxPerDay" numeric(12,2),
                "NightPricePerHour" numeric(12,2),
                "NightFrom" interval,
                "NightTo" interval,
                "WeekendPricePerHour" numeric(12,2),
                "IsActive" boolean NOT NULL DEFAULT TRUE,
                "IsDefault" boolean NOT NULL DEFAULT FALSE,
                "SortOrder" integer NOT NULL DEFAULT 0,
                "CreatedUtc" timestamp with time zone NOT NULL,
                "UpdatedUtc" timestamp with time zone
            )
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE TABLE IF NOT EXISTS parking_subscriptions (
                "Id" uuid NOT NULL PRIMARY KEY,
                "Plate" character varying(32) NOT NULL,
                "PlateNormalized" character varying(32) NOT NULL,
                "Name" character varying(200) NOT NULL,
                "StartDate" date NOT NULL,
                "EndDate" date NOT NULL,
                "EntriesLimit" integer,
                "EntriesUsed" integer NOT NULL DEFAULT 0,
                "Unlimited" boolean NOT NULL DEFAULT FALSE,
                "IsActive" boolean NOT NULL DEFAULT TRUE,
                "Notes" character varying(1000),
                "CreatedUtc" timestamp with time zone NOT NULL,
                "UpdatedUtc" timestamp with time zone
            )
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE TABLE IF NOT EXISTS parking_events (
                "Id" uuid NOT NULL PRIMARY KEY,
                "Type" character varying(64) NOT NULL,
                "Message" character varying(1000),
                "Plate" character varying(32),
                "Source" character varying(120),
                "CreatedUtc" timestamp with time zone NOT NULL,
                "UpdatedUtc" timestamp with time zone
            )
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE parking_vehicles
                ADD COLUMN IF NOT EXISTS "Country" character varying(8),
                ADD COLUMN IF NOT EXISTS "Company" character varying(200),
                ADD COLUMN IF NOT EXISTS "VehicleType" character varying(32),
                ADD COLUMN IF NOT EXISTS "PhotoUrl" character varying(500),
                ADD COLUMN IF NOT EXISTS "OwnerName" character varying(200),
                ADD COLUMN IF NOT EXISTS "OwnerPhone" character varying(64)
            """, cancellationToken);
        // Владельцы мест: за одним закреплено N мест и любое число номеров.
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE TABLE IF NOT EXISTS parking_holders (
                "Id" uuid NOT NULL PRIMARY KEY,
                "Name" character varying(200) NOT NULL,
                "Phone" character varying(64),
                "Unit" character varying(64),
                "SpacesLimit" integer NOT NULL DEFAULT 1,
                "IsActive" boolean NOT NULL DEFAULT TRUE,
                "Notes" character varying(1000),
                "CreatedUtc" timestamp with time zone NOT NULL,
                "UpdatedUtc" timestamp with time zone
            )
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE parking_plates
                ADD COLUMN IF NOT EXISTS "Category" character varying(32),
                ADD COLUMN IF NOT EXISTS "ValidTo" date,
                ADD COLUMN IF NOT EXISTS "TimeLimitMinutes" integer,
                ADD COLUMN IF NOT EXISTS "HolderId" uuid REFERENCES parking_holders("Id") ON DELETE SET NULL
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE parking_vehicles
                ADD COLUMN IF NOT EXISTS "HolderId" uuid REFERENCES parking_holders("Id") ON DELETE SET NULL,
                ADD COLUMN IF NOT EXISTS "TimeLimitMinutes" integer,
                ADD COLUMN IF NOT EXISTS "Category" character varying(32)
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE INDEX IF NOT EXISTS "IX_parking_vehicles_HolderId" ON parking_vehicles ("HolderId")
            """, cancellationToken);
        // Разрешение на въезд живёт в самой карточке машины: срок действия и зона.
        // Перенос данных из пропусков делает миграция AddParkingVehicleAccess.
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE parking_vehicles
                ADD COLUMN IF NOT EXISTS "AccessValidTo" date,
                ADD COLUMN IF NOT EXISTS "ZoneId" uuid REFERENCES parking_zones("Id") ON DELETE SET NULL
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE INDEX IF NOT EXISTS "IX_parking_vehicles_ZoneId" ON parking_vehicles ("ZoneId")
            """, cancellationToken);

        // Перенос белого списка в машины с пропусками делает миграция ParkingVehicleHolder:
        // он должен пройти до удаления колонок, поэтому здесь его дублировать нельзя.
        // Подчищаем только остатки на случай базы, накатанной одними патчами.
        await dbContext.Database.ExecuteSqlRawAsync("""
            DELETE FROM parking_plates WHERE "ListType" = 1
            """, cancellationToken);
        // ANPR-камеры: направление проезда, зона и реле шлагбаума задаются на самом устройстве.
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE devices
                ADD COLUMN IF NOT EXISTS "ParkingDirection" integer,
                ADD COLUMN IF NOT EXISTS "ParkingZoneId" uuid,
                ADD COLUMN IF NOT EXISTS "BarrierOutput" integer
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE parking_sessions
                ADD COLUMN IF NOT EXISTS "CameraName" character varying(120),
                ADD COLUMN IF NOT EXISTS "PhotoUrl" character varying(500),
                ADD COLUMN IF NOT EXISTS "RecognitionConfidence" double precision,
                ADD COLUMN IF NOT EXISTS "Operator" character varying(120),
                ADD COLUMN IF NOT EXISTS "Cost" numeric(12,2),
                ADD COLUMN IF NOT EXISTS "PaymentMethod" character varying(32),
                ADD COLUMN IF NOT EXISTS "PaidUtc" timestamp with time zone,
                ADD COLUMN IF NOT EXISTS "TariffId" uuid,
                ADD COLUMN IF NOT EXISTS "OverstayUtc" timestamp with time zone,
                ADD COLUMN IF NOT EXISTS "PaidUntilUtc" timestamp with time zone,
                ADD COLUMN IF NOT EXISTS "PaidAmount" numeric(12,2)
            """, cancellationToken);
        // Раньше оплата закрывала сессию и сумма считалась принятой — переносим её в PaidAmount,
        // чтобы старые записи не выглядели долгом после появления доплат.
        await dbContext.Database.ExecuteSqlRawAsync("""
            UPDATE parking_sessions SET "PaidAmount" = "Cost"
            WHERE "PaidAmount" IS NULL AND "PaidUtc" IS NOT NULL AND "Cost" IS NOT NULL
            """, cancellationToken);
        // Занятое место: схема парковки показывает, какая машина где стоит.
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE parking_sessions
                ADD COLUMN IF NOT EXISTS "SpaceId" uuid REFERENCES parking_spaces("Id") ON DELETE SET NULL
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE INDEX IF NOT EXISTS "IX_parking_sessions_SpaceId" ON parking_sessions ("SpaceId")
            """, cancellationToken);

        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE TABLE IF NOT EXISTS cards (
                "Id" uuid NOT NULL PRIMARY KEY,
                "EmployeeId" uuid REFERENCES employees("Id") ON DELETE CASCADE,
                "VisitorId" uuid REFERENCES visitors("Id") ON DELETE CASCADE,
                "CardNo" character varying(64) NOT NULL,
                "CardNumber" character varying(120),
                "CreatedUtc" timestamp with time zone NOT NULL,
                "UpdatedUtc" timestamp with time zone,
                CONSTRAINT "CK_Cards_Owner" CHECK (("EmployeeId" IS NOT NULL AND "VisitorId" IS NULL) OR ("EmployeeId" IS NULL AND "VisitorId" IS NOT NULL))
            )
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE UNIQUE INDEX IF NOT EXISTS "IX_cards_CardNo" ON cards ("CardNo")
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE INDEX IF NOT EXISTS "IX_cards_EmployeeId" ON cards ("EmployeeId")
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE INDEX IF NOT EXISTS "IX_cards_VisitorId" ON cards ("VisitorId")
            """, cancellationToken);

        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE TABLE IF NOT EXISTS faces (
                "Id" uuid NOT NULL PRIMARY KEY,
                "EmployeeId" uuid REFERENCES employees("Id") ON DELETE CASCADE,
                "VisitorId" uuid REFERENCES visitors("Id") ON DELETE CASCADE,
                "FilePath" character varying(500) NOT NULL,
                "FDID" integer NOT NULL DEFAULT 1,
                "CreatedUtc" timestamp with time zone NOT NULL,
                "UpdatedUtc" timestamp with time zone,
                CONSTRAINT "CK_Faces_Owner" CHECK (("EmployeeId" IS NOT NULL AND "VisitorId" IS NULL) OR ("EmployeeId" IS NULL AND "VisitorId" IS NOT NULL))
            )
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE INDEX IF NOT EXISTS "IX_faces_EmployeeId" ON faces ("EmployeeId")
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE INDEX IF NOT EXISTS "IX_faces_VisitorId" ON faces ("VisitorId")
            """, cancellationToken);

        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE TABLE IF NOT EXISTS fingerprints (
                "Id" uuid NOT NULL PRIMARY KEY,
                "EmployeeId" uuid REFERENCES employees("Id") ON DELETE CASCADE,
                "VisitorId" uuid REFERENCES visitors("Id") ON DELETE CASCADE,
                "TemplateData" bytea NOT NULL,
                "FingerIndex" integer NOT NULL DEFAULT 1,
                "CreatedUtc" timestamp with time zone NOT NULL,
                "UpdatedUtc" timestamp with time zone,
                CONSTRAINT "CK_Fingerprints_Owner" CHECK (("EmployeeId" IS NOT NULL AND "VisitorId" IS NULL) OR ("EmployeeId" IS NULL AND "VisitorId" IS NOT NULL))
            )
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE INDEX IF NOT EXISTS "IX_fingerprints_EmployeeId" ON fingerprints ("EmployeeId")
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE INDEX IF NOT EXISTS "IX_fingerprints_VisitorId" ON fingerprints ("VisitorId")
            """, cancellationToken);

        // LateToleranceMinutes — допустимое опоздание в минутах (0 = без допуска)
        await dbContext.Database.ExecuteSqlRawAsync("""
            ALTER TABLE work_schedules ADD COLUMN IF NOT EXISTS "LateToleranceMinutes" integer NOT NULL DEFAULT 0
            """, cancellationToken);

        // Почасовые разрешения на отлучку (icazə) — часы отсутствия внутри рабочего дня.
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE TABLE IF NOT EXISTS attendance_permissions (
                "Id" uuid NOT NULL PRIMARY KEY,
                "EmployeeId" uuid NOT NULL REFERENCES employees("Id") ON DELETE CASCADE,
                "Date" date NOT NULL,
                "FromTime" interval NOT NULL,
                "ToTime" interval NOT NULL,
                "Reason" character varying(500),
                "ShowInReport" boolean NOT NULL DEFAULT true,
                "CreatedUtc" timestamp with time zone NOT NULL,
                "UpdatedUtc" timestamp with time zone
            )
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE UNIQUE INDEX IF NOT EXISTS "IX_attendance_permissions_EmployeeId_Date" ON attendance_permissions ("EmployeeId", "Date")
            """, cancellationToken);

        foreach (var role in SystemRoles.All)
        {
            if (!await roleManager.RoleExistsAsync(role))
            {
                await roleManager.CreateAsync(new IdentityRole<Guid>(role));
            }
        }

        // role_permissions: связь role-name → permission-key
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE TABLE IF NOT EXISTS role_permissions (
                "RoleName" character varying(128) NOT NULL,
                "Permission" character varying(128) NOT NULL,
                PRIMARY KEY ("RoleName", "Permission")
            )
            """, cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync("""
            CREATE INDEX IF NOT EXISTS "IX_role_permissions_RoleName" ON role_permissions ("RoleName")
            """, cancellationToken);

        // Seed default permission rows ONLY for system roles that have ZERO rows yet.
        // Это значит: первая инициализация раздаёт дефолты, последующие правки админа не перетираются.
        foreach (var (roleName, defaults) in Permissions.Defaults)
        {
            // Admin не сидим в таблицу — он получает все permission'ы через short-circuit в PermissionService.
            if (string.Equals(roleName, SystemRoles.Admin, StringComparison.OrdinalIgnoreCase)) continue;
            if (defaults.Count == 0) continue;

            var hasAny = await dbContext.RolePermissions.AnyAsync(r => r.RoleName == roleName, cancellationToken);
            if (hasAny) continue;

            foreach (var perm in defaults)
            {
                dbContext.RolePermissions.Add(new Backend.Domain.Entities.RolePermission
                {
                    RoleName = roleName,
                    Permission = perm
                });
            }
        }
        await dbContext.SaveChangesAsync(cancellationToken);

        // Удаление работника выделено из Employees.Manage в отдельное Employees.Delete.
        // Роли, которые умели удалять до обновления, получают новое право один раз —
        // иначе обновление молча отняло бы у них то, что уже было. Флаг в system_settings
        // защищает от повторной выдачи: если админ снимет удаление, оно не вернётся.
        const string employeesDeleteSplitFlag = "Migrations.EmployeesDeleteSplit";
        if (!await dbContext.SystemSettings.AnyAsync(s => s.Key == employeesDeleteSplitFlag, cancellationToken))
        {
            var rows = await dbContext.RolePermissions
                .Where(r => r.Permission == Permissions.EmployeesManage || r.Permission == Permissions.EmployeesDelete)
                .ToListAsync(cancellationToken);
            var canDelete = rows
                .Where(r => r.Permission == Permissions.EmployeesDelete)
                .Select(r => r.RoleName)
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
            foreach (var roleName in rows
                .Where(r => r.Permission == Permissions.EmployeesManage)
                .Select(r => r.RoleName)
                .Where(name => !canDelete.Contains(name))
                .Distinct(StringComparer.OrdinalIgnoreCase))
            {
                dbContext.RolePermissions.Add(new Backend.Domain.Entities.RolePermission
                {
                    RoleName = roleName,
                    Permission = Permissions.EmployeesDelete
                });
            }
            dbContext.SystemSettings.Add(new Backend.Domain.Entities.SystemSetting
            {
                Key = employeesDeleteSplitFlag,
                Value = "1"
            });
            await dbContext.SaveChangesAsync(cancellationToken);
        }

        // Davamiyyət kriteriyaları: дефолтные строки только если таблица пуста —
        // дальше они правятся через Settings → Davamiyyət kriteriyaları и не перетираются.
        if (!await dbContext.AttendanceCriterias.AnyAsync(cancellationToken))
        {
            var criteriaDefaults = new (string Key, string Label, string Letter, string Color, string DisplayMode, int SortOrder)[]
            {
                ("normal",      "Tam iş günü",      "",  "#2E7D32", "hours",  0),
                ("undertime",   "Natamam iş günü",  "N", "#E8A33D", "hours",  1),
                ("overtime",    "Əlavə iş",         "",  "#2563EB", "hours",  2),
                ("late",        "Gecikmə",          "",  "#EA6A47", "hours",  3),
                ("early_leave", "Erkən çıxış",      "",  "#8B5CF6", "hours",  4),
                ("dayoff",      "İstirahət günü",   "İ", "#94A3B8", "letter", 5),
                ("onleave",     "Məzuniyyət",       "M", "#6366F1", "letter", 6),
                ("absent",      "İşə çıxmayıb",     "X", "#DC2626", "letter", 7),
            };
            foreach (var c in criteriaDefaults)
            {
                dbContext.AttendanceCriterias.Add(new Backend.Domain.Entities.AttendanceCriteria
                {
                    Key = c.Key,
                    Label = c.Label,
                    Letter = c.Letter,
                    Color = c.Color,
                    DisplayMode = c.DisplayMode,
                    Enabled = true,
                    SortOrder = c.SortOrder
                });
            }
            await dbContext.SaveChangesAsync(cancellationToken);
        }

        // Первый администратор создаётся только вручную через /api/auth/setup-admin-password (страница Initial Setup), не из конфигурации.
        if (!await userManager.Users.AnyAsync(cancellationToken))
        {
            logger.LogInformation("No users in database. Complete initial setup in the UI to create the administrator account.");
        }
    }
}
