using System.Collections.Concurrent;
using System.Text.Json;
using Backend.Application.Devices;
using Backend.Domain.Entities;
using Backend.Infrastructure.Devices;
using Backend.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace Backend.Infrastructure.Devices.Services;

public sealed class DeviceCardCaptureService(
    AppDbContext dbContext,
    IDevicePersonSyncService syncService,
    DeviceEnrollmentDetector enrollmentDetector,
    EnrollerCaptureService enrollerCapture,
    CapturedCredentialStore credentialStore,
    IConfiguration configuration,
    ILogger<DeviceCardCaptureService> logger) : IDeviceCardCaptureService
{
    private static readonly ConcurrentDictionary<Guid, CardSession> Sessions = new();

    /// <summary>
    /// Если карта уже сохранена внутри StartCapture (ответ устройства с номером сразу),
    /// сессии опроса нет — отдаём completed при первом GET progress.
    /// </summary>
    private static readonly ConcurrentDictionary<Guid, Guid> PendingCardCaptureComplete = new();

    private sealed class CardSession
    {
        public required string EmployeeNo { get; init; }
        public required Guid PersonId { get; init; }
        public required string PersonType { get; init; }
        public DateTime StartedUtc { get; init; } = DateTime.UtcNow;
        /// <summary>Заведён на устройстве только ради захвата (нет уровня доступа) — убрать после завершения.</summary>
        public bool TemporaryOnDevice { get; init; }
    }

    /// <summary>Убрать временно заведённого человека с устройства.</summary>
    private async Task CleanupTemporaryAsync(Guid deviceId, string employeeNo, bool temporary, CancellationToken ct)
    {
        if (!temporary) return;
        try { await syncService.DeletePersonFromDeviceAsync(employeeNo, deviceId, ct); }
        catch (Exception ex) { logger.LogWarning(ex, "Cleanup temporary person {EmployeeNo} from device {DeviceId}", employeeNo, deviceId); }
    }

    public async Task<DeviceSyncResult> StartCaptureAsync(Guid deviceId, Guid personId, string personType, CancellationToken cancellationToken = default)
    {
        var device = await dbContext.Devices.FindAsync([deviceId], cancellationToken);
        if (device is null)
            return new DeviceSyncResult(false, "Устройство не найдено.");

        var isEnroller = await enrollmentDetector.IsEnrollerAsync(device, cancellationToken);
        var temporaryOnDevice = false;

        string employeeNo;
        if (personType == "employee")
        {
            var emp = await dbContext.Employees.AsNoTracking().FirstOrDefaultAsync(e => e.Id == personId, cancellationToken);
            if (emp is null) return new DeviceSyncResult(false, "Сотрудник не найден.");
            employeeNo = Truncate(!string.IsNullOrWhiteSpace(emp.EmployeeNo) ? emp.EmployeeNo.Trim() : emp.Id.ToString("N")[..32]);
            if (!isEnroller)
            {
                // Нет уровня доступа → человека на устройство НЕ пишем: чтение карты идёт
                // со считывателя (CaptureCardInfo по readerID), пользователь там не нужен.
                temporaryOnDevice = !await dbContext.Set<EmployeeAccessLevel>().AnyAsync(al => al.EmployeeId == personId, cancellationToken);
                if (!temporaryOnDevice)
                {
                    var syncRes = await syncService.SyncEmployeeAsync(personId, deviceId, cancellationToken);
                    if (!syncRes.Success) return syncRes;
                }
            }
        }
        else if (personType == "gymcustomer")
        {
            var c = await dbContext.GymCustomers.AsNoTracking().FirstOrDefaultAsync(x => x.Id == personId, cancellationToken);
            if (c is null) return new DeviceSyncResult(false, "Клиент не найден.");
            employeeNo = c.Id.ToString("N")[..32];
            if (!isEnroller)
            {
                var syncRes = await syncService.SyncGymCustomerAsync(personId, deviceId, cancellationToken);
                if (!syncRes.Success) return syncRes;
            }
        }
        else
        {
            var vis = await dbContext.Visitors.AsNoTracking().FirstOrDefaultAsync(v => v.Id == personId, cancellationToken);
            if (vis is null) return new DeviceSyncResult(false, "Посетитель не найден.");
            employeeNo = Truncate(!string.IsNullOrWhiteSpace(vis.DocumentNumber) ? vis.DocumentNumber.Trim() : vis.Id.ToString("N")[..32]);
            if (!isEnroller)
            {
                var syncRes = await syncService.SyncVisitorAsync(personId, deviceId, cancellationToken);
                if (!syncRes.Success) return syncRes;
            }
        }

        if (isEnroller)
            return enrollerCapture.Start(device, EnrollerCaptureKind.Card, personId, personType);

        // ISAPI doc: Card Capture is GET /ISAPI/AccessControl/CaptureCardInfo?format=json
        // It puts device into "waiting for card swipe" mode.
        // The actual card data comes from polling progress or the same endpoint.
        var client = CreateClient(device);

        logger.LogInformation("[CaptureCard] Start device={Device} employeeNo={EmpNo}", device.Name, employeeNo);

        var readerId = HikvisionIsapiDefaults.GetReaderId(configuration);
        // Enroller / accessories: в доке только GET …&readerID= (без timeout). Сначала простой запрос — иначе 400.
        var (ok, content, err) = await client.GetAsync(
            $"ISAPI/AccessControl/CaptureCardInfo?format=json&readerID={readerId}", cancellationToken);

        if (!ok)
        {
            // Pro Series: GET с readerID и timeout.
            (ok, content, err) = await client.GetAsync(
                $"ISAPI/AccessControl/CaptureCardInfo?format=json&readerID={readerId}&timeout=60", cancellationToken);
        }

        if (!ok)
        {
            (ok, content, err) = await client.GetAsync(
                $"ISAPI/AccessControl/CaptureCardInfo?format=json&readerID={readerId}&timeout=30", cancellationToken);
        }

        if (!ok)
        {
            (ok, content, err) = await client.GetAsync(
                "ISAPI/AccessControl/CaptureCardInfo?format=json", cancellationToken);
        }

        if (!ok)
        {
            var postBody = JsonSerializer.Serialize(new Dictionary<string, object>
            {
                ["CaptureCardInfo"] = new Dictionary<string, object>
                {
                    ["employeeNo"] = employeeNo,
                    ["readerID"] = readerId,
                    ["timeout"] = 60,
                },
            });
            (ok, content, err) = await client.PostJsonAsync(
                "ISAPI/AccessControl/CaptureCardInfo?format=json", postBody, cancellationToken);
        }

        if (!ok)
        {
            var postBody2 = JsonSerializer.Serialize(new { CaptureCardData = new { employeeNo, readerID = readerId } });
            (ok, content, err) = await client.PostJsonAsync(
                "ISAPI/AccessControl/CaptureCardData?format=json", postBody2, cancellationToken);
        }

        logger.LogInformation("[CaptureCard] result: ok={Ok} err={Err} len={Len}", ok, err ?? "-", content?.Length ?? 0);

        if (!ok)
        {
            logger.LogWarning("[CaptureCard] FAILED: {Error}", err);
            return new DeviceSyncResult(false, err ?? "Устройство не поддерживает захват карты. Добавьте карту вручную.");
        }

        // Some devices return cardNo immediately in the start response
        var immediateCard = ExtractCardNo(content);
        if (!string.IsNullOrWhiteSpace(immediateCard))
        {
            var saved = await SaveAndReturnAsync(immediateCard, personId, personType, deviceId, temporaryOnDevice, cancellationToken);
            await CleanupTemporaryAsync(deviceId, employeeNo, temporaryOnDevice, cancellationToken);
            if (!saved.Success)
                return new DeviceSyncResult(false, saved.Error);
            if (saved.CardId.HasValue)
                PendingCardCaptureComplete[deviceId] = saved.CardId.Value;
            return new DeviceSyncResult(true, null);
        }

        Sessions[deviceId] = new CardSession { EmployeeNo = employeeNo, PersonId = personId, PersonType = personType, TemporaryOnDevice = temporaryOnDevice };
        return new DeviceSyncResult(true, null);
    }

    public async Task<CardCaptureProgressResult> GetProgressAsync(Guid deviceId, CancellationToken cancellationToken = default)
    {
        if (enrollerCapture.TryGetProgress(deviceId, EnrollerCaptureKind.Card, out var enrollerState))
            return new CardCaptureProgressResult(enrollerState.Status, enrollerState.Message, enrollerState.ResultId);

        if (PendingCardCaptureComplete.TryRemove(deviceId, out var pendingCardId))
            return new CardCaptureProgressResult("completed", "Карта успешно считана и добавлена.", pendingCardId);

        if (!Sessions.TryGetValue(deviceId, out var session))
            return new CardCaptureProgressResult("idle", "Сессия не найдена. Запустите захват.", null);

        var device = await dbContext.Devices.FindAsync([deviceId], cancellationToken);
        if (device is null)
        {
            Sessions.TryRemove(deviceId, out _);
            await CleanupTemporaryAsync(deviceId, session.EmployeeNo, session.TemporaryOnDevice, cancellationToken);
            return new CardCaptureProgressResult("failed", "Устройство не найдено.", null);
        }

        if ((DateTime.UtcNow - session.StartedUtc).TotalSeconds > 120)
        {
            Sessions.TryRemove(deviceId, out _);
            await CleanupTemporaryAsync(deviceId, session.EmployeeNo, session.TemporaryOnDevice, cancellationToken);
            return new CardCaptureProgressResult("failed", "Таймаут захвата.", null);
        }

        var client = CreateClient(device);
        var readerId = HikvisionIsapiDefaults.GetReaderId(configuration);

        // Poll various possible progress/capture endpoints (энроллер: сначала без timeout)
        string? content = null;
        foreach (var path in new[]
        {
            $"ISAPI/AccessControl/CaptureCardInfo?format=json&readerID={readerId}",
            $"ISAPI/AccessControl/CaptureCardInfo?format=json&readerID={readerId}&timeout=60",
            "ISAPI/AccessControl/CaptureCardInfo?format=json",
            "ISAPI/AccessControl/CaptureCardData/Progress?format=json",
        })
        {
            var (ok, c, _) = await client.GetAsync(path, cancellationToken);
            if (ok && !string.IsNullOrWhiteSpace(c)) { content = c; break; }
        }

        if (string.IsNullOrWhiteSpace(content))
            return new CardCaptureProgressResult("capturing", null, null);

        try
        {
            var cardNo = ExtractCardNo(content);

            if (!string.IsNullOrWhiteSpace(cardNo))
            {
                Sessions.TryRemove(deviceId, out _);
            await CleanupTemporaryAsync(deviceId, session.EmployeeNo, session.TemporaryOnDevice, cancellationToken);

                var saved = await SaveAndReturnAsync(cardNo, session.PersonId, session.PersonType, deviceId, session.TemporaryOnDevice, cancellationToken);
                return saved.Success
                    ? new CardCaptureProgressResult("completed", "Карта успешно считана и добавлена.", saved.CardId)
                    : new CardCaptureProgressResult("failed", saved.Error, null);
            }

            // Check isCurRequestOver without card
            using var doc = JsonDocument.Parse(content);
            foreach (var prop in new[] { "CaptureCardInfo", "captureCardInfo", "CaptureCardDataProgress", "captureCardDataProgress" })
            {
                if (doc.RootElement.TryGetProperty(prop, out var el))
                {
                    if (el.TryGetProperty("isCurRequestOver", out var iso) && iso.ValueKind == JsonValueKind.True)
                    {
                        Sessions.TryRemove(deviceId, out _);
            await CleanupTemporaryAsync(deviceId, session.EmployeeNo, session.TemporaryOnDevice, cancellationToken);
                        return new CardCaptureProgressResult("failed", "Карта не была считана. Приложите карту и повторите.", null);
                    }
                }
            }
        }
        catch (Exception ex) { logger.LogDebug(ex, "Parse CaptureCard Progress"); }

        return new CardCaptureProgressResult("capturing", null, null);
    }

    private static string? ExtractCardNo(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            foreach (var prop in new[] { "CaptureCardInfo", "captureCardInfo", "CaptureCardDataProgress", "captureCardDataProgress", "CardInfo", "cardInfo" })
            {
                if (root.TryGetProperty(prop, out var el))
                {
                    if (el.TryGetProperty("cardNo", out var cn)) return cn.GetString()?.Trim();
                    if (el.TryGetProperty("CardNo", out var cn2)) return cn2.GetString()?.Trim();
                }
            }

            if (root.TryGetProperty("cardNo", out var topCn)) return topCn.GetString()?.Trim();
            if (root.TryGetProperty("CardNo", out var topCn2)) return topCn2.GetString()?.Trim();
        }
        catch { }
        return null;
    }

    /// <param name="temporaryOnDevice">Человек заведён на устройстве лишь ради захвата (нет уровня доступа):
    /// карту на устройство не пишем, иначе он снова там появится.</param>
    private async Task<(bool Success, string? Error, Guid? CardId)> SaveAndReturnAsync(string cardNo, Guid personId, string personType, Guid deviceId, bool temporaryOnDevice, CancellationToken ct)
    {
        var saved = await credentialStore.SaveCardAsync(personId, personType, cardNo, ct);
        if (!saved.Success)
            return saved;

        // Карту пишем на устройство только если человек там должен быть (есть уровень доступа).
        // Иначе SyncCardAsync заново создал бы пользователя на терминале — ровно то, чего не хотим.
        if (!temporaryOnDevice)
        {
            var cardId = saved.CardId!.Value;
            _ = Task.Run(async () =>
            {
                try { await syncService.SyncCardAsync(cardId, deviceId, CancellationToken.None); }
                catch { }
            });
        }

        return saved;
    }

    private static string Truncate(string s) => s.Length > 32 ? s[..32] : s;

    private IsapiClient CreateClient(Device device)
    {
        var username = configuration["Hikvision:Username"] ?? "admin";
        var password = (configuration["Hikvision:Password"] ?? "").Trim();
        if (string.IsNullOrEmpty(password)) password = "12345";
        return new IsapiClient(
            device.IpAddress, device.Port,
            string.IsNullOrWhiteSpace(device.Username) ? username : device.Username,
            string.IsNullOrWhiteSpace(device.Password) ? password : device.Password,
            TimeSpan.FromSeconds(20));
    }
}
