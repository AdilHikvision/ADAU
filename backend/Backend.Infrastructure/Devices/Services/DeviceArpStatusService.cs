using System.Collections.Concurrent;
using Backend.Application.Devices;
using Backend.Infrastructure.Devices;
using Backend.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Backend.Infrastructure.Devices.Services;

/// <summary>
/// Проверка статуса устройств: ARP + проверка логина/пароля через ISAPI.
/// </summary>
public sealed class DeviceArpStatusService(
    IServiceScopeFactory scopeFactory,
    IDeviceStatusBroadcaster? statusBroadcaster,
    ILogger<DeviceArpStatusService> logger) : BackgroundService, IDeviceArpStatusService
{
    private readonly ConcurrentDictionary<string, (DeviceConnectivityStatus Status, DateTime? LastSeenUtc, string? Message)> _cache = new(StringComparer.OrdinalIgnoreCase);
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(5);
    // Таймаут пробы доступности. Устройства в локальной сети отвечают за миллисекунды,
    // а опрос идёт последовательно — с большим значением цикл не уложился бы в PollInterval.
    private static readonly TimeSpan ReachabilityTimeout = TimeSpan.FromSeconds(1.5);
    private const int FailuresBeforeOffline = 2;

    public Task<DeviceRealtimeStatus?> GetStatusAsync(string deviceIdentifier, CancellationToken cancellationToken = default)
    {
        if (_cache.TryGetValue(deviceIdentifier, out var entry))
        {
            return Task.FromResult<DeviceRealtimeStatus?>(new DeviceRealtimeStatus(deviceIdentifier, entry.Status, entry.LastSeenUtc, entry.Message));
        }
        return Task.FromResult<DeviceRealtimeStatus?>(null);
    }

    public Task<IReadOnlyCollection<DeviceRealtimeStatus>> GetStatusesAsync(CancellationToken cancellationToken = default)
    {
        var statuses = _cache
            .Select(kv => new DeviceRealtimeStatus(kv.Key, kv.Value.Status, kv.Value.LastSeenUtc, kv.Value.Message))
            .ToArray();
        return Task.FromResult<IReadOnlyCollection<DeviceRealtimeStatus>>(statuses);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Раньше на не-Windows сервис здесь завершался: ARP есть только в Win32. Кэш статусов
        // оставался пустым, из-за чего API отдавал все устройства как Offline, а синхронизация
        // журналов пропускала их все. Теперь вне Windows доступность проверяется по TCP.
        logger.LogInformation(
            "DeviceArpStatusService started ({Probe} + ISAPI status check).",
            OperatingSystem.IsWindows() ? "ARP" : "TCP");

        // Общий счётчик отрицательных сигналов: и ARP-fail, и ISAPI-fail увеличивают его. Любой положительный
        // сигнал сбрасывает в 0. Helps против мерцания: устройство Hikvision часто отвечает на ARP из кэша ОС,
        // но ISAPI периодически таймаутит — без общего debounce статус скакал между Online/Offline каждые 5 сек.
        // Auth-ошибки (401/403) — исключение: учётка неверна и так останется, в Offline уходим сразу.
        var consecutiveFailures = new ConcurrentDictionary<string, int>(StringComparer.OrdinalIgnoreCase);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = scopeFactory.CreateScope();
                var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                var devices = await dbContext.Devices
                    .AsNoTracking()
                    .Select(x => new { x.DeviceIdentifier, x.IpAddress, x.Port, x.Username, x.Password, x.Id })
                    .ToListAsync(stoppingToken);

                foreach (var device in devices)
                {
                    stoppingToken.ThrowIfCancellationRequested();

                    if (string.IsNullOrWhiteSpace(device.IpAddress))
                    {
                        continue;
                    }

                    var reachable = await DeviceReachabilityHelper.IsReachableAsync(
                        device.IpAddress,
                        device.Port,
                        ReachabilityTimeout,
                        stoppingToken);

                    bool? success = null;          // null = негативный сигнал, но без auth-ошибки
                    string? failureMessage = null;
                    bool authError = false;

                    if (reachable)
                    {
                        var username = string.IsNullOrWhiteSpace(device.Username) ? "admin" : device.Username;
                        var password = device.Password ?? "";
                        var (credValid, credMessage) = await DeviceCredentialVerifier.VerifyAsync(
                            device.IpAddress,
                            device.Port,
                            username,
                            password,
                            stoppingToken);

                        if (credValid)
                        {
                            success = true;
                        }
                        else
                        {
                            // auth-ошибка определяется по сообщению из верификатора; сетевые таймауты сюда не попадают
                            authError = credMessage != null &&
                                (credMessage.Contains("логин", StringComparison.OrdinalIgnoreCase)
                                    || credMessage.Contains("Доступ запрещ", StringComparison.OrdinalIgnoreCase));
                            failureMessage = credMessage ?? "Не удалось подключиться к устройству.";
                        }
                    }
                    else
                    {
                        failureMessage = "Сеть недоступна";
                    }

                    if (success == true)
                    {
                        consecutiveFailures.TryRemove(device.DeviceIdentifier, out _);
                        var now = DateTime.UtcNow;
                        var wasOffline = !_cache.TryGetValue(device.DeviceIdentifier, out var prev) || prev.Status == DeviceConnectivityStatus.Disconnected;
                        _cache[device.DeviceIdentifier] = (DeviceConnectivityStatus.Connected, now, null);
                        if (wasOffline) NotifyStatusChanged(device.DeviceIdentifier, device.Id, true, now, null);
                    }
                    else if (authError)
                    {
                        // auth-ошибка стабильна: пароль неверен и сам не починится, debounce не нужен
                        consecutiveFailures.TryRemove(device.DeviceIdentifier, out _);
                        var wasOnline = _cache.TryGetValue(device.DeviceIdentifier, out var prev) && prev.Status == DeviceConnectivityStatus.Connected;
                        _cache[device.DeviceIdentifier] = (DeviceConnectivityStatus.Disconnected, default, failureMessage);
                        if (wasOnline) NotifyStatusChanged(device.DeviceIdentifier, device.Id, false, null, failureMessage);
                    }
                    else
                    {
                        var failCount = consecutiveFailures.AddOrUpdate(device.DeviceIdentifier, 1, (_, c) => c + 1);
                        if (failCount >= FailuresBeforeOffline)
                        {
                            var wasOnline = _cache.TryGetValue(device.DeviceIdentifier, out var prev) && prev.Status == DeviceConnectivityStatus.Connected;
                            _cache[device.DeviceIdentifier] = (DeviceConnectivityStatus.Disconnected, default, failureMessage);
                            if (wasOnline) NotifyStatusChanged(device.DeviceIdentifier, device.Id, false, null, failureMessage);
                        }
                    }
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "DeviceArpStatusService: ошибка при ARP-проверке");
            }

            await Task.Delay(PollInterval, stoppingToken);
        }
    }

    private void NotifyStatusChanged(string deviceIdentifier, Guid deviceId, bool online, DateTime? lastSeenUtc, string? statusMessage)
    {
        var statusStr = online ? "Online" : "Offline";
        if (statusBroadcaster is not null)
        {
            _ = statusBroadcaster.NotifyStatusChangedAsync(deviceId, deviceIdentifier, statusStr, lastSeenUtc, statusMessage, CancellationToken.None);
        }
    }
}
