using Backend.Application.Devices;
using Backend.Application.Security;
using Backend.Infrastructure.Devices.Services;
using Backend.Infrastructure.Devices.Sdk;
using Backend.Infrastructure.Identity;
using Backend.Infrastructure.Initialization;
using Backend.Infrastructure.Persistence;
using Backend.Infrastructure.Security;
using Backend.Infrastructure.System;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Npgsql;

namespace Backend.Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(this IServiceCollection services, IConfiguration configuration)
    {
        var baseConnectionString = configuration.GetConnectionString("DefaultConnection")
            ?? throw new InvalidOperationException("ConnectionStrings:DefaultConnection is required.");
        var username = !string.IsNullOrWhiteSpace(configuration["Database:Username"])
            ? configuration["Database:Username"]
            : Environment.GetEnvironmentVariable("POSTGRES_USER");
        var password = !string.IsNullOrWhiteSpace(configuration["Database:Password"])
            ? configuration["Database:Password"]
            : Environment.GetEnvironmentVariable("POSTGRES_PASSWORD");
        if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(password))
        {
            throw new InvalidOperationException("Database credentials must be provided via Database section or environment variables.");
        }

        var connectionBuilder = new NpgsqlConnectionStringBuilder(baseConnectionString)
        {
            Username = username,
            Password = password
        };

        services.Configure<JwtOptions>(configuration.GetSection("Jwt"));
        services.Configure<SystemMonitorOptions>(configuration.GetSection(SystemMonitorOptions.SectionName));
        services.Configure<SystemOptions>(configuration.GetSection(SystemOptions.SectionName));
        services.Configure<SadpOptions>(configuration.GetSection(SadpOptions.SectionName));

        services.AddDbContext<AppDbContext>(options => options
            .UseNpgsql(connectionBuilder.ConnectionString)
            .ConfigureWarnings(w => w.Ignore(RelationalEventId.PendingModelChangesWarning)));

        services
            .AddIdentityCore<ApplicationUser>()
            .AddRoles<IdentityRole<Guid>>()
            .AddEntityFrameworkStores<AppDbContext>()
            // Без token-провайдеров GeneratePasswordResetTokenAsync бросает NotSupportedException:
            // ломались восстановление пароля по почте и смена пароля пользователю из настроек.
            .AddDefaultTokenProviders();

        services.AddSingleton<SadpDiscoveryService>();
        services.AddSingleton<HikvisionSdkClient>();
        services.AddSingleton<IHikvisionSdkClient>(provider => provider.GetRequiredService<HikvisionSdkClient>());
        services.AddSingleton<IDeviceConnectionManager, DeviceConnectionManager>();
        services.AddSingleton<IDeviceDiscoveryService, DeviceDiscoveryService>();
        services.AddSingleton<Gym.GymVisitService>();
        services.AddSingleton<EventListenerService>();
        services.AddSingleton<IEventListenerService>(provider => provider.GetRequiredService<EventListenerService>());
        services.AddHostedService(provider => provider.GetRequiredService<EventListenerService>());
        services.AddHostedService<IsapiAlertStreamService>();
        // Polling fallback для устройств у которых alertStream забит многодневным backlog'ом и
        // realtime событие физически не пробивается. POST /ISAPI/AccessControl/AcsEvent с фильтром
        // по времени каждые 2 сек. Дубли с alertStream дедуплицируются в EventListenerService.
        services.AddHostedService<AcsEventPollingService>();
        // NOTE: IsapiSubscribeEventService is intentionally NOT registered.
        // Hikvision devices have a single deploy slot per arming mode (deployID=1). The alertStream
        // service above already holds that slot, so subscribeEvent always returns
        // HTTP 400 / subStatusCode=deployExceedMax. The two channels cannot coexist.
        // The class file is kept under Devices/Services/IsapiSubscribeEventService.cs as documented
        // dead code in case a future refactor needs the subscribeEvent body shapes / variant fallback.
        services.AddSingleton<DeviceArpStatusService>();
        services.AddSingleton<IDeviceArpStatusService>(provider => provider.GetRequiredService<DeviceArpStatusService>());
        services.AddHostedService(provider => provider.GetRequiredService<DeviceArpStatusService>());
        services.AddHostedService<AttendanceCollectorService>();
        services.AddScoped<IAttendanceLogSyncService, AttendanceLogSyncService>();
        services.AddHostedService<LogSyncSchedulerService>();

        services.AddScoped<IJwtTokenService, JwtTokenService>();
        services.AddScoped<IAuditLogService, AuditLogService>();
        services.AddScoped<IDatabaseInitializer, DatabaseInitializer>();
        services.AddMemoryCache();
        services.AddScoped<IPermissionService, PermissionService>();
        services.AddSingleton<IAuthorizationHandler, PermissionAuthorizationHandler>();
        services.AddSingleton<IAuthorizationPolicyProvider, PermissionPolicyProvider>();
        services.AddScoped<ISystemStatusService, SystemStatusService>();
        services.AddScoped<IDeviceDoorService, DeviceDoorService>();
        services.AddScoped<IDeviceDoorControlService, DeviceDoorControlService>();
        services.AddScoped<IDevicePersonSyncService, DevicePersonSyncService>();
        services.AddScoped<IDevicePersonImportService, DevicePersonImportService>();
        services.AddScoped<CapturedCredentialStore>();
        // Станции регистрации: сессии захвата живут дольше запроса (ответ станции ждёт человека).
        services.AddSingleton<Devices.DeviceEnrollmentDetector>();
        services.AddSingleton<Devices.EnrollerIsapiCapture>();
        services.AddSingleton<EnrollerCaptureService>();
        services.AddScoped<IDeviceFaceCaptureService, DeviceFaceCaptureService>();
        services.AddScoped<IDeviceCardCaptureService, DeviceCardCaptureService>();
        services.AddScoped<IDeviceFingerprintCaptureService, DeviceFingerprintCaptureService>();
        services.AddScoped<IDeviceLocalizationService, DeviceLocalizationService>();
        // Парковка: решение о доступе — scoped (работает с DbContext), обработчик ANPR —
        // singleton, потому что живёт рядом с фоновым alertStream и помнит последние проезды.
        services.AddScoped<Backend.Application.Parking.IParkingAccessService, Parking.ParkingAccessService>();
        services.AddScoped<Backend.Application.Parking.IParkingBarrierService, Parking.ParkingBarrierService>();
        services.AddSingleton<Backend.Application.Parking.IParkingAnprHandler, Parking.ParkingAnprHandler>();
        services.AddHostedService<Parking.ParkingOverstayService>();
        services.AddHostedService<TimeSyncSchedulerService>();
        services.AddHostedService<Gym.GymAutoRenewService>();
        services.AddHostedService<Gym.GymVisitReconcileService>();
        services.AddSingleton<IServiceControlManager>(provider =>
        {
            var monitorOptions = provider.GetRequiredService<IOptions<SystemMonitorOptions>>();
            return OperatingSystem.IsWindows()
                ? new WindowsServiceControlManager(monitorOptions)
                : new UnsupportedServiceControlManager(monitorOptions);
        });

        return services;
    }
}
