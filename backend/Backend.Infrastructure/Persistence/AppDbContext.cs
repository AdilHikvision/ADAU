using Backend.Domain.Entities;
using Backend.Infrastructure.Identity;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

namespace Backend.Infrastructure.Persistence;

public static class SeedIds
{
    public static readonly Guid DeviceStatusOnline = Guid.Parse("6B848B1C-D122-41C7-BDF9-2EA4E0054A01");
    public static readonly Guid DeviceStatusOffline = Guid.Parse("847FF661-F4A6-4844-B50A-D1731E28A602");
    public static readonly Guid DeviceStatusUnknown = Guid.Parse("A46A8AC3-95DD-4A0D-A8D6-1DFEC5B40603");
}

public sealed class AppDbContext(DbContextOptions<AppDbContext> options)
    : IdentityDbContext<ApplicationUser, IdentityRole<Guid>, Guid>(options)
{
    public DbSet<Company> Companies => Set<Company>();
    public DbSet<SystemSetting> SystemSettings => Set<SystemSetting>();
    public DbSet<Device> Devices => Set<Device>();
    public DbSet<DeviceStatus> DeviceStatuses => Set<DeviceStatus>();
    public DbSet<Department> Departments => Set<Department>();
    public DbSet<HousingBlock> HousingBlocks => Set<HousingBlock>();
    public DbSet<Position> Positions => Set<Position>();
    public DbSet<Employee> Employees => Set<Employee>();
    public DbSet<Visitor> Visitors => Set<Visitor>();
    public DbSet<AccessLevel> AccessLevels => Set<AccessLevel>();
    public DbSet<AccessLevelDoor> AccessLevelDoors => Set<AccessLevelDoor>();
    public DbSet<EmployeeAccessLevel> EmployeeAccessLevels => Set<EmployeeAccessLevel>();
    public DbSet<VisitorAccessLevel> VisitorAccessLevels => Set<VisitorAccessLevel>();
    public DbSet<Card> Cards => Set<Card>();
    public DbSet<Face> Faces => Set<Face>();
    public DbSet<Fingerprint> Fingerprints => Set<Fingerprint>();
    public DbSet<Iris> Irises => Set<Iris>();
    public DbSet<WorkSchedule> WorkSchedules => Set<WorkSchedule>();
    public DbSet<WorkScheduleShift> WorkScheduleShifts => Set<WorkScheduleShift>();
    public DbSet<AttendanceRecord> AttendanceRecords => Set<AttendanceRecord>();
    public DbSet<AttendanceRequest> AttendanceRequests => Set<AttendanceRequest>();
    public DbSet<DeviceAuthLog> DeviceAuthLogs => Set<DeviceAuthLog>();
    public DbSet<AttendanceCorrection> AttendanceCorrections => Set<AttendanceCorrection>();
    public DbSet<AttendancePermission> AttendancePermissions => Set<AttendancePermission>();
    public DbSet<AttendanceCriteria> AttendanceCriterias => Set<AttendanceCriteria>();
    public DbSet<GeoZone> GeoZones => Set<GeoZone>();
    public DbSet<EmployeeDayPattern> EmployeeDayPatterns => Set<EmployeeDayPattern>();
    public DbSet<PayrollComponent> PayrollComponents => Set<PayrollComponent>();
    public DbSet<EmployeeSalaryConfig> EmployeeSalaryConfigs => Set<EmployeeSalaryConfig>();
    public DbSet<EmployeePayrollComponent> EmployeePayrollComponents => Set<EmployeePayrollComponent>();
    public DbSet<PayrollPeriod> PayrollPeriods => Set<PayrollPeriod>();
    public DbSet<PayrollEntry> PayrollEntries => Set<PayrollEntry>();
    public DbSet<EmployeeLeave> EmployeeLeaves => Set<EmployeeLeave>();
    public DbSet<Notification> Notifications => Set<Notification>();
    public DbSet<NotificationRead> NotificationReads => Set<NotificationRead>();
    public DbSet<AuditLogEntry> AuditLogs => Set<AuditLogEntry>();
    public DbSet<RolePermission> RolePermissions => Set<RolePermission>();
    public DbSet<GymTariff> GymTariffs => Set<GymTariff>();
    public DbSet<GymCustomer> GymCustomers => Set<GymCustomer>();
    public DbSet<GymMembership> GymMemberships => Set<GymMembership>();
    public DbSet<GymGiftCertificate> GymGiftCertificates => Set<GymGiftCertificate>();
    public DbSet<GymPayment> GymPayments => Set<GymPayment>();
    public DbSet<GymSupplier> GymSuppliers => Set<GymSupplier>();
    public DbSet<GymProduct> GymProducts => Set<GymProduct>();
    public DbSet<GymStockMovement> GymStockMovements => Set<GymStockMovement>();
    public DbSet<GymPurchaseOrder> GymPurchaseOrders => Set<GymPurchaseOrder>();
    public DbSet<GymPurchaseOrderItem> GymPurchaseOrderItems => Set<GymPurchaseOrderItem>();
    public DbSet<GymStocktake> GymStocktakes => Set<GymStocktake>();
    public DbSet<GymStocktakeItem> GymStocktakeItems => Set<GymStocktakeItem>();
    public DbSet<GymFinanceAccount> GymFinanceAccounts => Set<GymFinanceAccount>();
    public DbSet<GymFinanceCategory> GymFinanceCategories => Set<GymFinanceCategory>();
    public DbSet<GymFinanceTransaction> GymFinanceTransactions => Set<GymFinanceTransaction>();
    public DbSet<GymSale> GymSales => Set<GymSale>();
    public DbSet<GymSaleItem> GymSaleItems => Set<GymSaleItem>();

    // ─── Parking Management ───
    public DbSet<ParkingZone> ParkingZones => Set<ParkingZone>();
    public DbSet<ParkingFloor> ParkingFloors => Set<ParkingFloor>();
    public DbSet<ParkingRow> ParkingRows => Set<ParkingRow>();
    public DbSet<ParkingSpace> ParkingSpaces => Set<ParkingSpace>();
    public DbSet<ParkingPlate> ParkingPlates => Set<ParkingPlate>();
    public DbSet<ParkingHolder> ParkingHolders => Set<ParkingHolder>();
    public DbSet<ParkingSession> ParkingSessions => Set<ParkingSession>();
    public DbSet<ParkingResident> ParkingResidents => Set<ParkingResident>();
    public DbSet<ParkingVehicle> ParkingVehicles => Set<ParkingVehicle>();
    public DbSet<ParkingPermit> ParkingPermits => Set<ParkingPermit>();
    public DbSet<ParkingTariff> ParkingTariffs => Set<ParkingTariff>();
    public DbSet<ParkingSubscription> ParkingSubscriptions => Set<ParkingSubscription>();
    public DbSet<ParkingEvent> ParkingEvents => Set<ParkingEvent>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);

        builder.Entity<Device>(entity =>
        {
            entity.ToTable("devices");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.DeviceIdentifier).HasMaxLength(120).IsRequired();
            entity.Property(x => x.Name).HasMaxLength(200).IsRequired();
            entity.Property(x => x.IpAddress).HasMaxLength(120).IsRequired();
            entity.Property(x => x.Location).HasMaxLength(255);
            entity.Property(x => x.DeviceType).HasConversion<int>().IsRequired();
            entity.Property(x => x.LastSeenUtc);
            entity.Property(x => x.Username).HasMaxLength(64);
            entity.Property(x => x.Password).HasMaxLength(120);
            entity.Property(x => x.BarrierOutput);
            entity.HasIndex(x => x.DeviceIdentifier).IsUnique();
            entity.HasOne(x => x.DeviceStatus).WithMany(x => x.Devices).HasForeignKey(x => x.DeviceStatusId);
        });

        builder.Entity<Company>(entity =>
        {
            entity.ToTable("companies");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Name).HasMaxLength(255).IsRequired();
            entity.Property(x => x.Description).HasMaxLength(500);
        });

        builder.Entity<SystemSetting>(entity =>
        {
            entity.ToTable("system_settings");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Key).HasMaxLength(120).IsRequired();
            entity.HasIndex(x => x.Key).IsUnique();
        });

        builder.Entity<Department>(entity =>
        {
            entity.ToTable("departments");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Name).HasMaxLength(200).IsRequired();
            entity.Property(x => x.Description).HasMaxLength(500);
            entity.HasOne(x => x.Company).WithMany(x => x.Departments).HasForeignKey(x => x.CompanyId).OnDelete(DeleteBehavior.SetNull);
            entity.HasOne(x => x.Parent).WithMany(x => x.Children).HasForeignKey(x => x.ParentId).OnDelete(DeleteBehavior.Restrict);
        });

        builder.Entity<HousingBlock>(entity =>
        {
            entity.ToTable("housing_blocks");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Name).HasMaxLength(200).IsRequired();
            entity.Property(x => x.Description).HasMaxLength(500);
            // Restrict, как у департаментов: узел с детьми удаляется только после детей.
            entity.HasOne(x => x.Parent).WithMany(x => x.Children).HasForeignKey(x => x.ParentId).OnDelete(DeleteBehavior.Restrict);
        });

        builder.Entity<Position>(entity =>
        {
            entity.ToTable("positions");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Name).HasMaxLength(200).IsRequired();
            entity.Property(x => x.Description).HasMaxLength(500);
        });

        builder.Entity<DeviceStatus>(entity =>
        {
            entity.ToTable("device_statuses");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Code).HasMaxLength(64).IsRequired();
            entity.Property(x => x.Name).HasMaxLength(120).IsRequired();
            entity.HasIndex(x => x.Code).IsUnique();

            entity.HasData(
                new DeviceStatus { Id = SeedIds.DeviceStatusOnline, Code = "online", Name = "Online", CreatedUtc = DateTime.UnixEpoch },
                new DeviceStatus { Id = SeedIds.DeviceStatusOffline, Code = "offline", Name = "Offline", CreatedUtc = DateTime.UnixEpoch },
                new DeviceStatus { Id = SeedIds.DeviceStatusUnknown, Code = "unknown", Name = "Unknown", CreatedUtc = DateTime.UnixEpoch });
        });

        builder.Entity<Employee>(entity =>
        {
            entity.ToTable("employees");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.FirstName).HasMaxLength(150).IsRequired();
            entity.Property(x => x.LastName).HasMaxLength(150).IsRequired();
            entity.Property(x => x.MiddleName).HasMaxLength(150);
            entity.Property(x => x.Fin).HasMaxLength(16);
            entity.Property(x => x.StaffRate).HasPrecision(4, 2).HasDefaultValue(1m);
            entity.Property(x => x.EmployeeNo).HasMaxLength(32);
            entity.Property(x => x.ExternalId).HasMaxLength(64).HasColumnName("ExternalId");
            entity.Property(x => x.Gender).HasMaxLength(16);
            entity.Property(x => x.SelfServiceEmail).HasMaxLength(256);
            entity.HasIndex(x => x.EmployeeNo).IsUnique().HasFilter("EmployeeNo IS NOT NULL");
            entity.HasIndex(x => x.SelfServiceEmail).IsUnique().HasFilter("\"SelfServiceEmail\" IS NOT NULL");
            entity.HasOne(x => x.Department).WithMany(x => x.Employees).HasForeignKey(x => x.DepartmentId).OnDelete(DeleteBehavior.SetNull);
            entity.HasOne(x => x.Position).WithMany(x => x.Employees).HasForeignKey(x => x.PositionId).OnDelete(DeleteBehavior.SetNull);
            entity.HasOne(x => x.Company).WithMany(x => x.Employees).HasForeignKey(x => x.CompanyId).OnDelete(DeleteBehavior.SetNull);
            entity.HasOne(x => x.WorkSchedule).WithMany(x => x.Employees).HasForeignKey(x => x.WorkScheduleId).OnDelete(DeleteBehavior.SetNull);
            entity.HasOne(x => x.HousingBlock).WithMany(x => x.Residents).HasForeignKey(x => x.HousingBlockId).OnDelete(DeleteBehavior.SetNull);
        });

        builder.Entity<Visitor>(entity =>
        {
            entity.ToTable("visitors");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.FirstName).HasMaxLength(150).IsRequired();
            entity.Property(x => x.LastName).HasMaxLength(150).IsRequired();
            entity.Property(x => x.DocumentNumber).HasMaxLength(120);
            entity.HasIndex(x => x.DocumentNumber);
            entity.HasOne(x => x.Department).WithMany(x => x.Visitors).HasForeignKey(x => x.DepartmentId).OnDelete(DeleteBehavior.SetNull);
            entity.HasOne(x => x.Company).WithMany(x => x.Visitors).HasForeignKey(x => x.CompanyId).OnDelete(DeleteBehavior.SetNull);
        });

        builder.Entity<AccessLevel>(entity =>
        {
            entity.ToTable("access_levels");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Name).HasMaxLength(160).IsRequired();
            entity.Property(x => x.Description).HasMaxLength(500);
            entity.HasIndex(x => x.Name).IsUnique();
        });

        builder.Entity<AccessLevelDoor>(entity =>
        {
            entity.ToTable("access_level_doors");
            entity.HasKey(x => new { x.AccessLevelId, x.DeviceId, x.DoorIndex });
            entity.HasOne(x => x.AccessLevel).WithMany(x => x.Doors).HasForeignKey(x => x.AccessLevelId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(x => x.Device).WithMany(x => x.AccessLevelDoors).HasForeignKey(x => x.DeviceId).OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(x => new { x.DeviceId, x.DoorIndex });
        });

        builder.Entity<EmployeeAccessLevel>(entity =>
        {
            entity.ToTable("employee_access_levels");
            entity.HasKey(x => new { x.EmployeeId, x.AccessLevelId });
            entity.HasOne(x => x.Employee).WithMany(x => x.AccessLevels).HasForeignKey(x => x.EmployeeId);
            entity.HasOne(x => x.AccessLevel).WithMany(x => x.EmployeeAccessLevels).HasForeignKey(x => x.AccessLevelId);
        });

        builder.Entity<VisitorAccessLevel>(entity =>
        {
            entity.ToTable("visitor_access_levels");
            entity.HasKey(x => new { x.VisitorId, x.AccessLevelId });
            entity.HasOne(x => x.Visitor).WithMany(x => x.AccessLevels).HasForeignKey(x => x.VisitorId);
            entity.HasOne(x => x.AccessLevel).WithMany(x => x.VisitorAccessLevels).HasForeignKey(x => x.AccessLevelId);
        });

        builder.Entity<Card>(entity =>
        {
            entity.ToTable("cards");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.CardNo).HasMaxLength(64).IsRequired();
            entity.Property(x => x.CardNumber).HasMaxLength(120);
            entity.Property(x => x.CardType).HasMaxLength(32);
            entity.HasOne(x => x.Employee).WithMany(x => x.Cards).HasForeignKey(x => x.EmployeeId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(x => x.Visitor).WithMany(x => x.Cards).HasForeignKey(x => x.VisitorId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(x => x.GymCustomer).WithMany().HasForeignKey(x => x.GymCustomerId).OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(x => x.CardNo).IsUnique();
            entity.HasCheckConstraint("CK_Cards_Owner", "(\"EmployeeId\" IS NOT NULL)::int + (\"VisitorId\" IS NOT NULL)::int + (\"GymCustomerId\" IS NOT NULL)::int = 1");
        });

        builder.Entity<Face>(entity =>
        {
            entity.ToTable("faces");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.FilePath).HasMaxLength(500).IsRequired();
            entity.HasOne(x => x.Employee).WithMany(x => x.Faces).HasForeignKey(x => x.EmployeeId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(x => x.Visitor).WithMany(x => x.Faces).HasForeignKey(x => x.VisitorId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(x => x.GymCustomer).WithMany().HasForeignKey(x => x.GymCustomerId).OnDelete(DeleteBehavior.Cascade);
            entity.HasCheckConstraint("CK_Faces_Owner", "(\"EmployeeId\" IS NOT NULL)::int + (\"VisitorId\" IS NOT NULL)::int + (\"GymCustomerId\" IS NOT NULL)::int = 1");
        });

        builder.Entity<Fingerprint>(entity =>
        {
            entity.ToTable("fingerprints");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.TemplateData).IsRequired();
            entity.HasOne(x => x.Employee).WithMany(x => x.Fingerprints).HasForeignKey(x => x.EmployeeId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(x => x.Visitor).WithMany(x => x.Fingerprints).HasForeignKey(x => x.VisitorId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(x => x.GymCustomer).WithMany().HasForeignKey(x => x.GymCustomerId).OnDelete(DeleteBehavior.Cascade);
            entity.HasCheckConstraint("CK_Fingerprints_Owner", "(\"EmployeeId\" IS NOT NULL)::int + (\"VisitorId\" IS NOT NULL)::int + (\"GymCustomerId\" IS NOT NULL)::int = 1");
        });

        builder.Entity<Iris>(entity =>
        {
            entity.ToTable("irises");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.TemplateData).IsRequired();
            entity.HasOne(x => x.Employee).WithMany(x => x.Irises).HasForeignKey(x => x.EmployeeId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(x => x.Visitor).WithMany(x => x.Irises).HasForeignKey(x => x.VisitorId).OnDelete(DeleteBehavior.Cascade);
            entity.HasCheckConstraint("CK_Irises_Owner", "(\"EmployeeId\" IS NOT NULL AND \"VisitorId\" IS NULL) OR (\"EmployeeId\" IS NULL AND \"VisitorId\" IS NOT NULL)");
        });

        builder.Entity<WorkSchedule>(entity =>
        {
            entity.ToTable("work_schedules");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Name).HasMaxLength(200).IsRequired();
            entity.Property(x => x.Type).HasConversion<int>().IsRequired();
            entity.Property(x => x.RequiredHoursPerDay).HasPrecision(5, 2);
            entity.Property(x => x.Color).HasMaxLength(7).HasDefaultValue("#6366f1");
        });

        builder.Entity<WorkScheduleShift>(entity =>
        {
            entity.ToTable("work_schedule_shifts");
            entity.HasKey(x => x.Id);
            entity.HasOne(x => x.WorkSchedule).WithMany(x => x.Shifts).HasForeignKey(x => x.WorkScheduleId).OnDelete(DeleteBehavior.Cascade);
            entity.Property(x => x.Name).HasMaxLength(100).IsRequired();
            entity.Property(x => x.RequiredHoursPerDay).HasPrecision(5, 2);
        });

        builder.Entity<AttendanceRecord>(entity =>
        {
            entity.ToTable("attendance_records");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.EventType).HasConversion<int>().IsRequired();
            entity.Property(x => x.Source).HasMaxLength(32).IsRequired();
            entity.HasOne(x => x.Employee).WithMany(x => x.AttendanceRecords).HasForeignKey(x => x.EmployeeId).OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(x => new { x.EmployeeId, x.EventTimeUtc }).IsUnique();
        });

        builder.Entity<AttendanceRequest>(entity =>
        {
            entity.ToTable("attendance_requests");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Type).HasConversion<int>().IsRequired();
            entity.Property(x => x.Status).HasConversion<int>().IsRequired();
            entity.Property(x => x.Comment).HasMaxLength(1000);
            entity.Property(x => x.ReviewComment).HasMaxLength(1000);
            entity.HasOne(x => x.Employee).WithMany(x => x.AttendanceRequests).HasForeignKey(x => x.EmployeeId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<DeviceAuthLog>(entity =>
        {
            entity.ToTable("device_auth_logs");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.EmployeeNoString).HasMaxLength(64).IsRequired();
            entity.Property(x => x.Name).HasMaxLength(256);
            entity.HasOne(x => x.Device).WithMany().HasForeignKey(x => x.DeviceId).OnDelete(DeleteBehavior.SetNull);
            entity.HasIndex(x => new { x.DeviceId, x.EmployeeNoString, x.EventTimeUtc }).IsUnique();
            entity.HasIndex(x => x.EventTimeUtc);
            entity.HasIndex(x => x.EmployeeNoString);
        });

        builder.Entity<AttendanceCorrection>(entity =>
        {
            entity.ToTable("attendance_corrections");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Comment).HasMaxLength(1000);
            entity.HasOne(x => x.Employee).WithMany().HasForeignKey(x => x.EmployeeId).OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(x => new { x.EmployeeId, x.DateUtc }).IsUnique();
        });

        builder.Entity<AttendancePermission>(entity =>
        {
            entity.ToTable("attendance_permissions");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Reason).HasMaxLength(500);
            entity.HasOne(x => x.Employee).WithMany().HasForeignKey(x => x.EmployeeId).OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(x => new { x.EmployeeId, x.Date }).IsUnique();
        });

        builder.Entity<GeoZone>(entity =>
        {
            entity.ToTable("geo_zones");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Name).HasMaxLength(128).IsRequired();
        });

        builder.Entity<EmployeeDayPattern>(entity =>
        {
            entity.ToTable("employee_day_patterns");
            entity.HasKey(x => x.Id);
            entity.HasOne(x => x.Employee).WithMany(x => x.DayPatterns).HasForeignKey(x => x.EmployeeId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(x => x.WorkSchedule).WithMany().HasForeignKey(x => x.WorkScheduleId).OnDelete(DeleteBehavior.SetNull);
            entity.HasIndex(x => new { x.EmployeeId, x.Date }).IsUnique();
        });

        builder.Entity<PayrollComponent>(entity =>
        {
            entity.ToTable("payroll_components");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Name).HasMaxLength(200).IsRequired();
            entity.Property(x => x.ComponentType).HasConversion<int>().IsRequired();
            entity.Property(x => x.Amount).HasPrecision(14, 2);
            entity.Property(x => x.Percentage).HasPrecision(7, 4);
            entity.Property(x => x.Description).HasMaxLength(500);
        });

        builder.Entity<EmployeeSalaryConfig>(entity =>
        {
            entity.ToTable("employee_salary_configs");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.SalaryType).HasConversion<int>().IsRequired();
            entity.Property(x => x.BaseAmount).HasPrecision(14, 2).IsRequired();
            entity.Property(x => x.Currency).HasMaxLength(8).HasDefaultValue("AZN");
            entity.Property(x => x.OvertimeMultiplier).HasPrecision(5, 2).HasDefaultValue(1.5m);
            entity.HasOne(x => x.Employee).WithMany().HasForeignKey(x => x.EmployeeId).OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(x => x.EmployeeId);
        });

        builder.Entity<EmployeePayrollComponent>(entity =>
        {
            entity.ToTable("employee_payroll_components");
            entity.HasKey(x => new { x.SalaryConfigId, x.ComponentId });
            entity.HasOne(x => x.SalaryConfig).WithMany(x => x.Components).HasForeignKey(x => x.SalaryConfigId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(x => x.Component).WithMany(x => x.EmployeeComponents).HasForeignKey(x => x.ComponentId).OnDelete(DeleteBehavior.Cascade);
            entity.Property(x => x.OverrideAmount).HasPrecision(14, 2);
            entity.Property(x => x.OverridePercentage).HasPrecision(7, 4);
        });

        builder.Entity<PayrollPeriod>(entity =>
        {
            entity.ToTable("payroll_periods");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Status).HasConversion<int>().IsRequired();
            entity.Property(x => x.Notes).HasMaxLength(1000);
            // Year/Month больше не уникальны: период — это произвольный date range, нескольких в одном месяце допустимо.
        });

        builder.Entity<PayrollEntry>(entity =>
        {
            entity.ToTable("payroll_entries");
            entity.HasKey(x => x.Id);
            entity.HasOne(x => x.Period).WithMany(x => x.Entries).HasForeignKey(x => x.PeriodId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(x => x.Employee).WithMany().HasForeignKey(x => x.EmployeeId).OnDelete(DeleteBehavior.Cascade);
            entity.Property(x => x.WorkedHours).HasPrecision(8, 2);
            entity.Property(x => x.OvertimeHours).HasPrecision(8, 2);
            entity.Property(x => x.BasePay).HasPrecision(14, 2);
            entity.Property(x => x.OvertimePay).HasPrecision(14, 2);
            entity.Property(x => x.AllowancesTotal).HasPrecision(14, 2);
            entity.Property(x => x.BonusesTotal).HasPrecision(14, 2);
            entity.Property(x => x.GrossPay).HasPrecision(14, 2);
            entity.Property(x => x.DeductionsTotal).HasPrecision(14, 2);
            entity.Property(x => x.TaxRate).HasPrecision(5, 2);
            entity.Property(x => x.TaxAmount).HasPrecision(14, 2);
            entity.Property(x => x.NetPay).HasPrecision(14, 2);
            entity.Property(x => x.Status).HasConversion<int>().IsRequired();
            entity.Property(x => x.Notes).HasMaxLength(1000);
            entity.HasIndex(x => new { x.PeriodId, x.EmployeeId }).IsUnique();
        });

        builder.Entity<EmployeeLeave>(b => {
            b.HasKey(e => e.Id);
            b.Property(e => e.Reason).HasMaxLength(500);
            b.Property(e => e.Notes).HasMaxLength(1000);
            b.HasOne(e => e.Employee).WithMany(emp => emp.Leaves).HasForeignKey(e => e.EmployeeId).OnDelete(DeleteBehavior.Cascade);
            b.HasIndex(e => e.EmployeeId);
            b.HasIndex(e => new { e.EmployeeId, e.StartDate });
        });

        builder.Entity<Notification>(entity =>
        {
            entity.ToTable("notifications");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Type).HasMaxLength(64).IsRequired();
            entity.Property(x => x.Title).HasMaxLength(256).IsRequired();
            entity.Property(x => x.Body).HasMaxLength(1000).IsRequired();
            entity.Property(x => x.ReferenceId).HasMaxLength(128);
            entity.HasIndex(x => x.UserId);
            entity.HasIndex(x => x.CreatedUtc);
        });

        builder.Entity<NotificationRead>(entity =>
        {
            entity.ToTable("notification_reads");
            entity.HasKey(x => new { x.NotificationId, x.UserId });
            entity.HasOne<Notification>().WithMany().HasForeignKey(x => x.NotificationId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<RolePermission>(entity =>
        {
            entity.ToTable("role_permissions");
            entity.HasKey(x => new { x.RoleName, x.Permission });
            entity.Property(x => x.RoleName).HasMaxLength(128).IsRequired();
            entity.Property(x => x.Permission).HasMaxLength(128).IsRequired();
            entity.HasIndex(x => x.RoleName);
        });

        builder.Entity<GymTariff>(entity =>
        {
            entity.ToTable("gym_tariffs");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Name).HasMaxLength(200).IsRequired();
            entity.Property(x => x.Description).HasMaxLength(1000);
            entity.Property(x => x.Kind).HasConversion<int>().IsRequired();
            entity.Property(x => x.Price).HasPrecision(14, 2);
            entity.Property(x => x.Currency).HasMaxLength(8).HasDefaultValue("AZN");
            entity.Property(x => x.DurationType).HasConversion<int>().IsRequired();
            entity.HasIndex(x => x.IsActive);
        });

        builder.Entity<GymCustomer>(entity =>
        {
            entity.ToTable("gym_customers");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.FirstName).HasMaxLength(120).IsRequired();
            entity.Property(x => x.LastName).HasMaxLength(120);
            entity.Property(x => x.Phone).HasMaxLength(40);
            entity.Property(x => x.Email).HasMaxLength(256);
            entity.Property(x => x.Gender).HasMaxLength(16);
            entity.Property(x => x.Notes).HasMaxLength(1000);
            entity.HasIndex(x => x.IsActive);
            entity.HasIndex(x => x.Phone);
        });

        builder.Entity<GymMembership>(entity =>
        {
            entity.ToTable("gym_memberships");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.TariffName).HasMaxLength(200).IsRequired();
            entity.Property(x => x.Price).HasPrecision(14, 2);
            entity.Property(x => x.Currency).HasMaxLength(8).HasDefaultValue("AZN");
            entity.Property(x => x.Status).HasConversion<int>().IsRequired();
            entity.Property(x => x.Notes).HasMaxLength(1000);
            entity.HasOne(x => x.Customer).WithMany().HasForeignKey(x => x.CustomerId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(x => x.Tariff).WithMany().HasForeignKey(x => x.TariffId).OnDelete(DeleteBehavior.SetNull);
            entity.HasIndex(x => x.CustomerId);
        });

        builder.Entity<GymGiftCertificate>(entity =>
        {
            entity.ToTable("gym_gift_certificates");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Code).HasMaxLength(40).IsRequired();
            entity.Property(x => x.TariffName).HasMaxLength(200).IsRequired();
            entity.Property(x => x.Price).HasPrecision(14, 2);
            entity.Property(x => x.Currency).HasMaxLength(8).HasDefaultValue("AZN");
            entity.Property(x => x.RecipientName).HasMaxLength(200);
            entity.Property(x => x.Status).HasConversion<int>().IsRequired();
            entity.HasOne(x => x.Tariff).WithMany().HasForeignKey(x => x.TariffId).OnDelete(DeleteBehavior.SetNull);
            entity.HasIndex(x => x.Code).IsUnique();
        });

        builder.Entity<GymPayment>(entity =>
        {
            entity.ToTable("gym_payments");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Amount).HasPrecision(14, 2);
            entity.Property(x => x.Currency).HasMaxLength(8).HasDefaultValue("AZN");
            entity.Property(x => x.Method).HasConversion<int>().IsRequired();
            entity.Property(x => x.Note).HasMaxLength(500);
            entity.HasOne(x => x.Customer).WithMany().HasForeignKey(x => x.CustomerId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(x => x.Membership).WithMany().HasForeignKey(x => x.MembershipId).OnDelete(DeleteBehavior.SetNull);
            entity.HasIndex(x => x.CustomerId);
        });

        builder.Entity<GymSupplier>(entity =>
        {
            entity.ToTable("gym_suppliers");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Name).HasMaxLength(200).IsRequired();
            entity.Property(x => x.ContactName).HasMaxLength(200);
            entity.Property(x => x.Phone).HasMaxLength(40);
            entity.Property(x => x.Email).HasMaxLength(256);
            entity.Property(x => x.Address).HasMaxLength(500);
            entity.Property(x => x.Notes).HasMaxLength(1000);
            entity.HasIndex(x => x.IsActive);
        });

        builder.Entity<GymProduct>(entity =>
        {
            entity.ToTable("gym_products");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Name).HasMaxLength(200).IsRequired();
            entity.Property(x => x.Sku).HasMaxLength(64);
            entity.Property(x => x.Barcode).HasMaxLength(64);
            entity.Property(x => x.Category).HasMaxLength(120);
            entity.Property(x => x.Unit).HasMaxLength(16).HasDefaultValue("pcs");
            entity.Property(x => x.SalePrice).HasPrecision(14, 2);
            entity.Property(x => x.Cost).HasPrecision(14, 2);
            entity.Property(x => x.Currency).HasMaxLength(8).HasDefaultValue("AZN");
            entity.Property(x => x.StockQuantity).HasPrecision(18, 3);
            entity.Property(x => x.MinStock).HasPrecision(18, 3);
            entity.HasOne(x => x.Supplier).WithMany().HasForeignKey(x => x.SupplierId).OnDelete(DeleteBehavior.SetNull);
            entity.HasIndex(x => x.IsActive);
            entity.HasIndex(x => x.Sku);
        });

        builder.Entity<GymStockMovement>(entity =>
        {
            entity.ToTable("gym_stock_movements");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Type).HasConversion<int>().IsRequired();
            entity.Property(x => x.Quantity).HasPrecision(18, 3);
            entity.Property(x => x.UnitCost).HasPrecision(14, 2);
            entity.Property(x => x.BalanceAfter).HasPrecision(18, 3);
            entity.Property(x => x.Reason).HasMaxLength(500);
            entity.Property(x => x.Reference).HasMaxLength(120);
            entity.Property(x => x.UserEmail).HasMaxLength(256);
            entity.HasOne(x => x.Product).WithMany().HasForeignKey(x => x.ProductId).OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(x => new { x.ProductId, x.CreatedUtc });
            entity.HasIndex(x => x.Type);
        });

        builder.Entity<GymPurchaseOrder>(entity =>
        {
            entity.ToTable("gym_purchase_orders");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Number).HasMaxLength(40).IsRequired();
            entity.Property(x => x.SupplierName).HasMaxLength(200);
            entity.Property(x => x.Status).HasConversion<int>().IsRequired();
            entity.Property(x => x.Currency).HasMaxLength(8).HasDefaultValue("AZN");
            entity.Property(x => x.Total).HasPrecision(14, 2);
            entity.Property(x => x.Notes).HasMaxLength(1000);
            entity.HasOne(x => x.Supplier).WithMany().HasForeignKey(x => x.SupplierId).OnDelete(DeleteBehavior.SetNull);
            entity.HasIndex(x => x.Number).IsUnique();
            entity.HasIndex(x => x.Status);
        });

        builder.Entity<GymPurchaseOrderItem>(entity =>
        {
            entity.ToTable("gym_purchase_order_items");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.ProductName).HasMaxLength(200);
            entity.Property(x => x.Quantity).HasPrecision(18, 3);
            entity.Property(x => x.UnitCost).HasPrecision(14, 2);
            entity.HasOne(x => x.PurchaseOrder).WithMany(x => x.Items).HasForeignKey(x => x.PurchaseOrderId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(x => x.Product).WithMany().HasForeignKey(x => x.ProductId).OnDelete(DeleteBehavior.Restrict);
            entity.HasIndex(x => x.PurchaseOrderId);
        });

        builder.Entity<GymStocktake>(entity =>
        {
            entity.ToTable("gym_stocktakes");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Number).HasMaxLength(40).IsRequired();
            entity.Property(x => x.Status).HasConversion<int>().IsRequired();
            entity.Property(x => x.Notes).HasMaxLength(1000);
            entity.HasIndex(x => x.Number).IsUnique();
            entity.HasIndex(x => x.Status);
        });

        builder.Entity<GymStocktakeItem>(entity =>
        {
            entity.ToTable("gym_stocktake_items");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.ProductName).HasMaxLength(200);
            entity.Property(x => x.ExpectedQuantity).HasPrecision(18, 3);
            entity.Property(x => x.CountedQuantity).HasPrecision(18, 3);
            entity.HasOne(x => x.Stocktake).WithMany(x => x.Items).HasForeignKey(x => x.StocktakeId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(x => x.Product).WithMany().HasForeignKey(x => x.ProductId).OnDelete(DeleteBehavior.Restrict);
            entity.HasIndex(x => x.StocktakeId);
        });

        builder.Entity<GymFinanceAccount>(entity =>
        {
            entity.ToTable("gym_finance_accounts");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Name).HasMaxLength(200).IsRequired();
            entity.Property(x => x.Type).HasConversion<int>().IsRequired();
            entity.Property(x => x.Currency).HasMaxLength(8).HasDefaultValue("AZN");
            entity.Property(x => x.OpeningBalance).HasPrecision(16, 2);
            entity.Property(x => x.Balance).HasPrecision(16, 2);
            entity.Property(x => x.BankName).HasMaxLength(200);
            entity.Property(x => x.AccountNumber).HasMaxLength(64);
            entity.HasIndex(x => x.Type);
            entity.HasIndex(x => x.IsActive);
        });

        builder.Entity<GymFinanceCategory>(entity =>
        {
            entity.ToTable("gym_finance_categories");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Name).HasMaxLength(200).IsRequired();
            entity.Property(x => x.Direction).HasConversion<int>().IsRequired();
            entity.Property(x => x.Color).HasMaxLength(7).HasDefaultValue("#6366f1");
            entity.HasIndex(x => x.Direction);
        });

        builder.Entity<GymFinanceTransaction>(entity =>
        {
            entity.ToTable("gym_finance_transactions");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Direction).HasConversion<int>().IsRequired();
            entity.Property(x => x.Amount).HasPrecision(16, 2);
            entity.Property(x => x.Currency).HasMaxLength(8).HasDefaultValue("AZN");
            entity.Property(x => x.Description).HasMaxLength(500);
            entity.Property(x => x.Reference).HasMaxLength(120);
            entity.Property(x => x.CounterpartyName).HasMaxLength(200);
            entity.Property(x => x.Method).HasMaxLength(32);
            entity.Property(x => x.BalanceAfter).HasPrecision(16, 2);
            entity.Property(x => x.UserEmail).HasMaxLength(256);
            entity.HasOne(x => x.Account).WithMany().HasForeignKey(x => x.AccountId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(x => x.Category).WithMany().HasForeignKey(x => x.CategoryId).OnDelete(DeleteBehavior.SetNull);
            entity.HasIndex(x => new { x.Direction, x.OccurredOn });
            entity.HasIndex(x => x.AccountId);
            entity.HasIndex(x => x.OccurredOn);
        });

        builder.Entity<GymSale>(entity =>
        {
            entity.ToTable("gym_sales");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Number).HasMaxLength(40).IsRequired();
            entity.Property(x => x.CustomerName).HasMaxLength(255);
            entity.Property(x => x.Subtotal).HasPrecision(14, 2);
            entity.Property(x => x.Discount).HasPrecision(14, 2);
            entity.Property(x => x.Total).HasPrecision(14, 2);
            entity.Property(x => x.Currency).HasMaxLength(8).HasDefaultValue("AZN");
            entity.Property(x => x.PaymentMethod).HasConversion<int>().IsRequired();
            entity.Property(x => x.Status).HasConversion<int>().IsRequired();
            entity.Property(x => x.Note).HasMaxLength(500);
            entity.Property(x => x.UserEmail).HasMaxLength(256);
            entity.HasOne(x => x.Customer).WithMany().HasForeignKey(x => x.CustomerId).OnDelete(DeleteBehavior.SetNull);
            entity.HasIndex(x => x.Number).IsUnique();
            entity.HasIndex(x => x.SoldUtc);
            entity.HasIndex(x => x.CustomerId);
        });

        builder.Entity<GymSaleItem>(entity =>
        {
            entity.ToTable("gym_sale_items");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.ProductName).HasMaxLength(200);
            entity.Property(x => x.Quantity).HasPrecision(18, 3);
            entity.Property(x => x.UnitPrice).HasPrecision(14, 2);
            entity.Property(x => x.LineTotal).HasPrecision(14, 2);
            entity.HasOne(x => x.Sale).WithMany(x => x.Items).HasForeignKey(x => x.SaleId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(x => x.Product).WithMany().HasForeignKey(x => x.ProductId).OnDelete(DeleteBehavior.SetNull);
            entity.HasIndex(x => x.SaleId);
        });

        // ─── Parking Management ───────────────────────────────────────────────
        builder.Entity<ParkingZone>(entity =>
        {
            entity.ToTable("parking_zones");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Name).HasMaxLength(200).IsRequired();
            entity.Property(x => x.Code).HasMaxLength(32);
            entity.Property(x => x.Description).HasMaxLength(1000);
            entity.HasIndex(x => x.IsActive);
        });

        builder.Entity<ParkingHolder>(entity =>
        {
            entity.ToTable("parking_holders");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Name).HasMaxLength(200).IsRequired();
            entity.Property(x => x.Phone).HasMaxLength(64);
            entity.Property(x => x.Unit).HasMaxLength(64);
            entity.Property(x => x.Notes).HasMaxLength(1000);
            entity.HasIndex(x => x.IsActive);
        });

        builder.Entity<ParkingPlate>(entity =>
        {
            entity.ToTable("parking_plates");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Plate).HasMaxLength(32).IsRequired();
            entity.Property(x => x.PlateNormalized).HasMaxLength(32).IsRequired();
            entity.Property(x => x.Category).HasMaxLength(32);
            entity.HasIndex(x => new { x.PlateNormalized, x.ListType });
        });

        builder.Entity<ParkingSession>(entity =>
        {
            entity.ToTable("parking_sessions");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Plate).HasMaxLength(32).IsRequired();
            entity.Property(x => x.PlateNormalized).HasMaxLength(32).IsRequired();
            entity.Property(x => x.CameraName).HasMaxLength(120);
            entity.Property(x => x.PhotoUrl).HasMaxLength(500);
            entity.Property(x => x.Operator).HasMaxLength(120);
            entity.Property(x => x.PaymentMethod).HasMaxLength(32);
            entity.Property(x => x.Cost).HasPrecision(12, 2);
            // Место освобождается, если его удалили из структуры: сессия при этом остаётся.
            entity.HasOne(x => x.Space).WithMany().HasForeignKey(x => x.SpaceId).OnDelete(DeleteBehavior.SetNull);
            entity.HasIndex(x => new { x.ZoneId, x.ExitedUtc });
            entity.HasIndex(x => x.PlateNormalized);
            entity.HasIndex(x => x.EnteredUtc);
            entity.HasIndex(x => x.SpaceId);
        });

        builder.Entity<ParkingTariff>(entity =>
        {
            entity.ToTable("parking_tariffs");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Name).HasMaxLength(200).IsRequired();
            entity.Property(x => x.Kind).HasConversion<int>().IsRequired();
            entity.Property(x => x.PricePerHour).HasPrecision(12, 2);
            entity.Property(x => x.PricePerDay).HasPrecision(12, 2);
            entity.Property(x => x.FixedPrice).HasPrecision(12, 2);
            entity.Property(x => x.MaxPerDay).HasPrecision(12, 2);
            entity.Property(x => x.NightPricePerHour).HasPrecision(12, 2);
            entity.Property(x => x.WeekendPricePerHour).HasPrecision(12, 2);
        });

        builder.Entity<ParkingSubscription>(entity =>
        {
            entity.ToTable("parking_subscriptions");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Plate).HasMaxLength(32).IsRequired();
            entity.Property(x => x.PlateNormalized).HasMaxLength(32).IsRequired();
            entity.Property(x => x.Name).HasMaxLength(200).IsRequired();
            entity.Property(x => x.Notes).HasMaxLength(1000);
            entity.HasIndex(x => x.PlateNormalized);
        });

        builder.Entity<ParkingEvent>(entity =>
        {
            entity.ToTable("parking_events");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Type).HasMaxLength(64).IsRequired();
            entity.Property(x => x.Message).HasMaxLength(1000);
            entity.Property(x => x.Plate).HasMaxLength(32);
            entity.Property(x => x.Source).HasMaxLength(120);
            entity.HasIndex(x => x.CreatedUtc);
            entity.HasIndex(x => x.Type);
        });

        builder.Entity<ParkingFloor>(entity =>
        {
            entity.ToTable("parking_floors");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Name).HasMaxLength(120).IsRequired();
            entity.HasOne(x => x.Zone).WithMany(x => x.Floors).HasForeignKey(x => x.ZoneId).OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(x => x.ZoneId);
        });

        builder.Entity<ParkingRow>(entity =>
        {
            entity.ToTable("parking_rows");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Name).HasMaxLength(120).IsRequired();
            entity.HasOne(x => x.Floor).WithMany(x => x.Rows).HasForeignKey(x => x.FloorId).OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(x => x.FloorId);
        });

        builder.Entity<ParkingSpace>(entity =>
        {
            entity.ToTable("parking_spaces");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Code).HasMaxLength(60).IsRequired();
            entity.Property(x => x.Type).HasConversion<int>().IsRequired();
            entity.Property(x => x.Notes).HasMaxLength(1000);
            entity.HasOne(x => x.Row).WithMany(x => x.Spaces).HasForeignKey(x => x.RowId).OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(x => x.RowId);
            entity.HasIndex(x => x.Type);
        });

        builder.Entity<ParkingResident>(entity =>
        {
            entity.ToTable("parking_residents");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.FullName).HasMaxLength(200).IsRequired();
            entity.Property(x => x.Phone).HasMaxLength(64);
            entity.Property(x => x.Unit).HasMaxLength(64);
            entity.Property(x => x.Notes).HasMaxLength(1000);
            entity.HasIndex(x => x.IsActive);
        });

        builder.Entity<ParkingVehicle>(entity =>
        {
            entity.ToTable("parking_vehicles");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Plate).HasMaxLength(32).IsRequired();
            entity.Property(x => x.PlateNormalized).HasMaxLength(32).IsRequired();
            entity.Property(x => x.Brand).HasMaxLength(120);
            entity.Property(x => x.Color).HasMaxLength(64);
            entity.Property(x => x.Notes).HasMaxLength(1000);
            entity.Property(x => x.Country).HasMaxLength(8);
            entity.Property(x => x.Company).HasMaxLength(200);
            entity.Property(x => x.VehicleType).HasMaxLength(32);
            entity.Property(x => x.PhotoUrl).HasMaxLength(500);
            entity.Property(x => x.OwnerName).HasMaxLength(200);
            entity.Property(x => x.OwnerPhone).HasMaxLength(64);
            entity.Property(x => x.Category).HasMaxLength(32);
            entity.HasOne(x => x.Resident).WithMany(x => x.Vehicles).HasForeignKey(x => x.ResidentId).OnDelete(DeleteBehavior.SetNull);
            // Удаление владельца не трогает машины — они просто теряют привязку и квоту.
            entity.HasOne(x => x.Holder).WithMany(x => x.Vehicles).HasForeignKey(x => x.HolderId).OnDelete(DeleteBehavior.SetNull);
            // Удаление зоны не удаляет машину: она просто получает доступ во все зоны.
            entity.HasOne(x => x.Zone).WithMany().HasForeignKey(x => x.ZoneId).OnDelete(DeleteBehavior.SetNull);
            entity.HasIndex(x => x.PlateNormalized);
            entity.HasIndex(x => x.ResidentId);
            entity.HasIndex(x => x.HolderId);
            entity.HasIndex(x => x.ZoneId);
        });

        builder.Entity<ParkingPermit>(entity =>
        {
            entity.ToTable("parking_permits");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Notes).HasMaxLength(1000);
            entity.HasOne(x => x.Vehicle).WithMany(x => x.Permits).HasForeignKey(x => x.VehicleId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(x => x.Zone).WithMany().HasForeignKey(x => x.ZoneId).OnDelete(DeleteBehavior.SetNull);
            entity.HasIndex(x => x.VehicleId);
            entity.HasIndex(x => x.ZoneId);
        });

        builder.Entity<AuditLogEntry>(entity =>
        {
            entity.ToTable("audit_logs");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.UserEmail).HasMaxLength(256);
            entity.Property(x => x.Category).HasMaxLength(64).IsRequired();
            entity.Property(x => x.Action).HasMaxLength(256).IsRequired();
            entity.Property(x => x.Method).HasMaxLength(16).IsRequired();
            entity.Property(x => x.Path).HasMaxLength(512).IsRequired();
            entity.Property(x => x.IpAddress).HasMaxLength(64);
            entity.Property(x => x.Description).HasMaxLength(2000);
            entity.HasIndex(x => x.TimestampUtc);
            entity.HasIndex(x => x.UserId);
            entity.HasIndex(x => x.Category);
        });

        builder.Entity<AttendanceCriteria>(entity =>
        {
            entity.ToTable("attendance_criteria");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Key).HasMaxLength(32).IsRequired();
            entity.Property(x => x.Label).HasMaxLength(160).IsRequired();
            entity.Property(x => x.Letter).HasMaxLength(8);
            entity.Property(x => x.Color).HasMaxLength(16).IsRequired();
            entity.Property(x => x.DisplayMode).HasMaxLength(16).IsRequired();
            entity.HasIndex(x => x.Key).IsUnique();
        });
    }
}
