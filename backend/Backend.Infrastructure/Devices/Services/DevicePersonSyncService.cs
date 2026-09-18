using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Backend.Application.Devices;
using Backend.Domain.Entities;
using Backend.Infrastructure.Devices;
using Backend.Infrastructure.Persistence;
using Backend.Infrastructure.System;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Backend.Infrastructure.Devices.Services;

/// <summary>Синхронизация Person, Card, Face, Fingerprint на устройства Hikvision через ISAPI.</summary>
public sealed class DevicePersonSyncService(
    AppDbContext dbContext,
    IConfiguration configuration,
    IOptions<SystemOptions> systemOptions,
    ILogger<DevicePersonSyncService> logger) : IDevicePersonSyncService
{
    private static string GetEmployeeNo(Employee e) =>
        !string.IsNullOrWhiteSpace(e.EmployeeNo) ? e.EmployeeNo.Trim()
        : e.Id.ToString("N")[..32];

    private static string GetEmployeeNo(Visitor v) =>
        !string.IsNullOrWhiteSpace(v.DocumentNumber) ? v.DocumentNumber.Trim()
        : v.Id.ToString("N")[..Math.Min(32, 32)];

    private static string TruncateEmployeeNo(string s)
    {
        if (string.IsNullOrEmpty(s)) return s;
        return s.Length > 32 ? s[..32] : s;
    }

    /// <summary>Лог тела запроса и ответа устройства при удалении отпечатка (отладка ISAPI).</summary>
    private void LogDeleteFingerprintExchange(
        string stage,
        string httpMethod,
        string path,
        string requestBody,
        bool httpSuccess,
        string? responseBody,
        string? transportError)
    {
        const int max = 8192;
        static string Trim(string? s, int m)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Length <= m ? s : s[..m] + "…(truncated)";
        }

        logger.LogInformation(
            "[DeleteFP] {Stage} {Method} {Path} httpOk={HttpOk} transportErr={TransportErr} request={Request} response={Response}",
            stage,
            httpMethod,
            path,
            httpSuccess,
            transportError ?? "-",
            Trim(requestBody, max),
            Trim(responseBody, max));
    }

    public async Task<DeviceSyncResult> SyncEmployeeAsync(Guid employeeId, Guid deviceId, CancellationToken cancellationToken = default)
    {
        var employee = await dbContext.Employees
            .Include(e => e.AccessLevels)
            .ThenInclude(a => a.AccessLevel)
            .ThenInclude(al => al!.Doors)
            .FirstOrDefaultAsync(e => e.Id == employeeId, cancellationToken);
        if (employee is null)
            return new DeviceSyncResult(false, "Сотрудник не найден.");

        var device = await dbContext.Devices.FindAsync([deviceId], cancellationToken);
        if (device is null)
            return new DeviceSyncResult(false, "Устройство не найдено.");

        var employeeNo = TruncateEmployeeNo(GetEmployeeNo(employee));
        var name = $"{employee.FirstName} {employee.LastName}".Trim();
        var doorRight = GetDoorRightForDevice(employee.AccessLevels.Select(a => a.AccessLevel).Where(al => al != null)!, deviceId);

        // userType: "normal", "visitor", "blackList" (строка, не число)
        var (type, userCategory) = employee.IsActive ? (1, "normal") : (3, "blackList");
        return await SyncUserInfoAsync(device, employeeNo, name, type, doorRight,
            gender: employee.Gender,
            validFromUtc: employee.ValidFromUtc,
            validToUtc: employee.ValidToUtc,
            userCategory,
            onlyVerify: employee.OnlyVerify,
            cancellationToken: cancellationToken);
    }

    public async Task<DeviceSyncResult> SyncVisitorAsync(Guid visitorId, Guid deviceId, CancellationToken cancellationToken = default)
    {
        var visitor = await dbContext.Visitors
            .Include(v => v.AccessLevels)
            .ThenInclude(a => a.AccessLevel)
            .ThenInclude(al => al!.Doors)
            .FirstOrDefaultAsync(v => v.Id == visitorId, cancellationToken);
        if (visitor is null)
            return new DeviceSyncResult(false, "Посетитель не найден.");

        var device = await dbContext.Devices.FindAsync([deviceId], cancellationToken);
        if (device is null)
            return new DeviceSyncResult(false, "Устройство не найдено.");

        var employeeNo = GetEmployeeNo(visitor);
        var name = $"{visitor.FirstName} {visitor.LastName}".Trim();
        var doorRight = GetDoorRightForDevice(visitor.AccessLevels.Select(a => a.AccessLevel).Where(al => al != null)!, deviceId);

        // userType: "normal", "visitor", "blackList" (строка, не число)
        var (type, userCategory) = visitor.IsActive ? (2, "visitor") : (3, "blackList");
        return await SyncUserInfoAsync(device, employeeNo, name, type, doorRight,
            validFromUtc: visitor.ValidFromUtc,
            validToUtc: visitor.ValidToUtc,
            userCategory: userCategory,
            cancellationToken: cancellationToken);
    }

    /// <summary>Person ID клиента зала на терминале (детерминированный, без хранения).</summary>
    private static string GymCustomerEmployeeNo(GymCustomer c) => c.Id.ToString("N")[..32];

    public async Task<DeviceSyncResult> SyncGymCustomerAsync(Guid customerId, Guid deviceId, CancellationToken cancellationToken = default)
    {
        var customer = await dbContext.GymCustomers.FirstOrDefaultAsync(c => c.Id == customerId, cancellationToken);
        if (customer is null)
            return new DeviceSyncResult(false, "Клиент не найден.");

        var device = await dbContext.Devices.FindAsync([deviceId], cancellationToken);
        if (device is null)
            return new DeviceSyncResult(false, "Устройство не найдено.");

        var employeeNo = GymCustomerEmployeeNo(customer);
        var name = string.Join(" ", new[] { customer.FirstName, customer.LastName }
            .Where(s => !string.IsNullOrWhiteSpace(s)));

        // Окно доступа = до даты окончания самого позднего активного абонемента клиента (если есть).
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var latestEnd = await dbContext.GymMemberships
            .Where(m => m.CustomerId == customerId
                && m.Status != GymMembershipStatus.Cancelled
                && m.EndDate >= today)
            .OrderByDescending(m => m.EndDate)
            .Select(m => (DateOnly?)m.EndDate)
            .FirstOrDefaultAsync(cancellationToken);
        DateTime? validToUtc = latestEnd is { } le
            ? le.ToDateTime(new TimeOnly(23, 59, 59), DateTimeKind.Utc)
            : null;

        // userType "custom1" (Custom User 1) — клиенты зала отличаются от штатных пользователей.
        return await SyncUserInfoAsync(device, employeeNo, name, userType: null, doorRight: [],
            gender: customer.Gender,
            validToUtc: validToUtc,
            userCategory: "custom1",
            cancellationToken: cancellationToken);
    }

    public async Task<DeviceSyncResult> DeleteGymCustomerAsync(Guid customerId, Guid deviceId, CancellationToken cancellationToken = default)
    {
        var customer = await dbContext.GymCustomers.FirstOrDefaultAsync(c => c.Id == customerId, cancellationToken);
        if (customer is null)
            return new DeviceSyncResult(false, "Клиент не найден.");
        return await DeletePersonFromDeviceAsync(GymCustomerEmployeeNo(customer), deviceId, cancellationToken);
    }

    public async Task<DeviceSyncResult> SyncCardAsync(Guid cardId, Guid deviceId, CancellationToken cancellationToken = default)
    {
        var card = await dbContext.Cards
            .Include(c => c.Employee)
            .Include(c => c.Visitor)
            .Include(c => c.GymCustomer)
            .FirstOrDefaultAsync(c => c.Id == cardId, cancellationToken);
        if (card is null)
            return new DeviceSyncResult(false, "Карта не найдена.");

        var device = await dbContext.Devices.FindAsync([deviceId], cancellationToken);
        if (device is null)
            return new DeviceSyncResult(false, "Устройство не найдено.");

        var employeeNo = card.GymCustomer != null
            ? GymCustomerEmployeeNo(card.GymCustomer)
            : card.Employee != null
                ? TruncateEmployeeNo(GetEmployeeNo(card.Employee))
                : GetEmployeeNo(card.Visitor!);

        var syncPerson = card.GymCustomerId != null
            ? await SyncGymCustomerAsync(card.GymCustomerId.Value, deviceId, cancellationToken)
            : card.Employee != null
                ? await SyncEmployeeAsync(card.EmployeeId!.Value, deviceId, cancellationToken)
                : await SyncVisitorAsync(card.VisitorId!.Value, deviceId, cancellationToken);
        if (!syncPerson.Success)
            return syncPerson;

        // ISAPI: в CardInfo обязателен узел cardType (см. capabilities: normalCard, patrolCard, qrCode …).
        var body = JsonSerializer.Serialize(new
        {
            CardInfo = new
            {
                cardNo = card.CardNo,
                cardNumber = string.IsNullOrWhiteSpace(card.CardNumber) ? card.CardNo : card.CardNumber,
                employeeNo,
                cardType = card.CardType ?? "normalCard"
            }
        });

        var client = CreateClient(device);
        var (success, error) = await TrySyncCardInfoAsync(client, body, cancellationToken);

        if (!success)
        {
            logger.LogWarning("SyncCard {CardNo} to {Device}: {Error}", card.CardNo, device.Name, error);
            return new DeviceSyncResult(false, error ?? "Ошибка синхронизации карты.");
        }
        return new DeviceSyncResult(true, null);
    }

    /// <summary>
    /// Hikvision: PUT CardInfo/SetUp применяет карту (добавление или правка). POST Record только для новой карты и часто
    /// даёт cardNoAlreadyExist/checkEmployeeNo, если у пользователя уже есть другая карта или отпечаток.
    /// </summary>
    private async Task<(bool Success, string? Error)> TrySyncCardInfoAsync(IsapiClient client, string body, CancellationToken cancellationToken)
    {
        var (success, _, error) = await client.PutJsonAsync(
            "ISAPI/AccessControl/CardInfo/SetUp?format=json",
            body,
            cancellationToken);
        if (success) return (true, null);

        (success, _, error) = await client.PostJsonAsync(
            "ISAPI/AccessControl/CardInfo/Record?format=json",
            body,
            cancellationToken);
        if (success) return (true, null);

        if (error != null && IsCardInfoRetryableConflict(error))
        {
            logger.LogDebug("CardInfo Record failed ({Error}), retrying with Modify", error);
            (success, _, error) = await client.PutJsonAsync(
                "ISAPI/AccessControl/CardInfo/Modify?format=json",
                body,
                cancellationToken);
            if (success) return (true, null);
        }

        return (false, error);
    }

    private static bool IsCardInfoRetryableConflict(string error) =>
        error.Contains("cardNoAlreadyExist", StringComparison.OrdinalIgnoreCase)
        || error.Contains("checkEmployeeNo", StringComparison.OrdinalIgnoreCase)
        || error.Contains("checkUser", StringComparison.OrdinalIgnoreCase);

    public async Task<DeviceSyncResult> SyncFaceAsync(Guid faceId, Guid deviceId, CancellationToken cancellationToken = default)
    {
        var face = await dbContext.Faces
            .Include(f => f.Employee)
            .Include(f => f.Visitor)
            .Include(f => f.GymCustomer)
            .FirstOrDefaultAsync(f => f.Id == faceId, cancellationToken);
        if (face is null)
            return new DeviceSyncResult(false, "Лицо не найдено.");

        var device = await dbContext.Devices.FindAsync([deviceId], cancellationToken);
        if (device is null)
            return new DeviceSyncResult(false, "Устройство не найдено.");

        if (device.DeviceType == DeviceType.ElevatorController)
        {
            logger.LogDebug("SyncFace: skipping elevator controller {Device} — face recognition not supported", device.Name);
            return new DeviceSyncResult(true, null);
        }

        var employeeNo = face.GymCustomer != null
            ? GymCustomerEmployeeNo(face.GymCustomer)
            : face.Employee != null
                ? TruncateEmployeeNo(GetEmployeeNo(face.Employee))
                : GetEmployeeNo(face.Visitor!);

        var syncPerson = face.GymCustomerId != null
            ? await SyncGymCustomerAsync(face.GymCustomerId.Value, deviceId, cancellationToken)
            : face.Employee != null
                ? await SyncEmployeeAsync(face.EmployeeId!.Value, deviceId, cancellationToken)
                : await SyncVisitorAsync(face.VisitorId!.Value, deviceId, cancellationToken);
        if (!syncPerson.Success)
            return syncPerson;

        var facesPath = configuration["Storage:FacesPath"] ?? Path.Combine(AppContext.BaseDirectory, "uploads", "faces");
        var fullPath = Path.Combine(facesPath, face.FilePath.TrimStart('/', '\\'));
        if (!File.Exists(fullPath))
        {
            logger.LogWarning("Face image not found: {Path}", fullPath);
            return new DeviceSyncResult(false, "Файл изображения не найден.");
        }

        var client = CreateClient(device);
        var imageBytes = await File.ReadAllBytesAsync(fullPath, cancellationToken);

        ByteArrayContent MakeImage() => new(imageBytes) { Headers = { ContentType = new("image/jpeg") } };
        StringContent MakeJson(string json) {
            var c = new StringContent(json, Encoding.UTF8, "application/json");
            c.Headers.ContentType = new global::System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
            return c;
        }
        var escapedNo = employeeNo.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");
        string? lastErr = null;

        // Ensure FDLib exists on the device (required before adding faces)
        await EnsureFDLibExistsAsync(client, cancellationToken);

        var personName = face.GymCustomer != null
            ? string.Join(" ", new[] { face.GymCustomer.FirstName, face.GymCustomer.LastName }.Where(s => !string.IsNullOrWhiteSpace(s)))
            : face.Employee != null ? $"{face.Employee.FirstName} {face.Employee.LastName}".Trim() : employeeNo;

        // Strategy 1 (Primary): PUT FDLib/FDSetUp — apply face (add or update)
        {
            var json = JsonSerializer.Serialize(new Dictionary<string, object>
            {
                ["faceLibType"] = "blackFD",
                ["FDID"] = "1",
                ["FPID"] = employeeNo,
                ["name"] = personName,
                ["bornTime"] = "2000-01-01"
            });
            logger.LogDebug("[SyncFace] Strategy 1: PUT FDLib/FDSetUp, JSON={Json}", json);
            var (ok, body, err) = await client.PutMultipartAsync("ISAPI/Intelligent/FDLib/FDSetUp?format=json",
                () => new Dictionary<string, (HttpContent, string?)>
                {
                    ["faceURL"] = (MakeJson(json), null),
                    ["img"] = (MakeImage(), "faceImage.jpg")
                }, cancellationToken);
            logger.LogDebug("[SyncFace] Strategy 1 FDSetUp: ok={Ok} body={Body} err={Err}", ok, body ?? "-", err ?? "-");
            if (ok) return new DeviceSyncResult(true, null);
            lastErr = err;
        }

        // Strategy 2: POST FDLib/FaceDataRecord — add new face
        {
            var json = JsonSerializer.Serialize(new Dictionary<string, object>
            {
                ["faceLibType"] = "blackFD",
                ["FDID"] = "1",
                ["FPID"] = employeeNo,
                ["name"] = personName,
                ["bornTime"] = "2000-01-01"
            });
            logger.LogDebug("[SyncFace] Strategy 2: POST FDLib/FaceDataRecord");
            var (ok, body, err) = await client.PostMultipartAsync("ISAPI/Intelligent/FDLib/FaceDataRecord?format=json",
                () => new Dictionary<string, (HttpContent, string?)>
                {
                    ["faceURL"] = (MakeJson(json), null),
                    ["img"] = (MakeImage(), "facePic.jpg")
                }, cancellationToken);
            logger.LogDebug("[SyncFace] Strategy 2 FaceDataRecord: ok={Ok} body={Body} err={Err}", ok, body ?? "-", err ?? "-");
            if (ok) return new DeviceSyncResult(true, null);
            lastErr = err;
        }

        // Strategy 3: POST FDLib/pictureUpload (XML) — legacy devices
        {
            var xmlData = $"""<?xml version="1.0" encoding="UTF-8"?><PictureUploadData version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><employeeNo>{escapedNo}</employeeNo><FDID>1</FDID><faceLibType>blackFD</faceLibType></PictureUploadData>""";
            logger.LogDebug("[SyncFace] Strategy 3: POST FDLib/pictureUpload");
            var (ok, body, err) = await client.PostMultipartAsync("ISAPI/Intelligent/FDLib/pictureUpload",
                () => new Dictionary<string, (HttpContent, string?)>
                {
                    ["PictureUploadData"] = (new StringContent(xmlData, Encoding.UTF8, "application/xml"), null),
                    ["face_picture"] = (MakeImage(), "face_picture.jpg")
                }, cancellationToken);
            logger.LogDebug("[SyncFace] Strategy 3 pictureUpload: ok={Ok} body={Body} err={Err}", ok, body ?? "-", err ?? "-");
            if (ok) return new DeviceSyncResult(true, null);
            lastErr = err;
        }

        logger.LogWarning("SyncFace {FaceId} to {Device}: all strategies failed. Last: {Error}", faceId, device.Name, lastErr);
        return new DeviceSyncResult(false, lastErr ?? "Ошибка синхронизации лица.");
    }

    public async Task<DeviceSyncResult> SyncFingerprintAsync(Guid fingerprintId, Guid deviceId, CancellationToken cancellationToken = default)
    {
        var fp = await dbContext.Fingerprints
            .Include(f => f.Employee)
            .Include(f => f.Visitor)
            .Include(f => f.GymCustomer)
            .FirstOrDefaultAsync(f => f.Id == fingerprintId, cancellationToken);
        if (fp is null)
            return new DeviceSyncResult(false, "Отпечаток не найден.");

        var device = await dbContext.Devices.FindAsync([deviceId], cancellationToken);
        if (device is null)
            return new DeviceSyncResult(false, "Устройство не найдено.");

        if (device.DeviceType == DeviceType.ElevatorController)
        {
            logger.LogDebug("SyncFingerprint: skipping elevator controller {Device} — fingerprint not supported", device.Name);
            return new DeviceSyncResult(true, null);
        }

        var employeeNo = fp.GymCustomer != null
            ? GymCustomerEmployeeNo(fp.GymCustomer)
            : fp.Employee != null
                ? TruncateEmployeeNo(GetEmployeeNo(fp.Employee))
                : GetEmployeeNo(fp.Visitor!);

        var syncPerson = fp.GymCustomerId != null
            ? await SyncGymCustomerAsync(fp.GymCustomerId.Value, deviceId, cancellationToken)
            : fp.Employee != null
                ? await SyncEmployeeAsync(fp.EmployeeId!.Value, deviceId, cancellationToken)
                : await SyncVisitorAsync(fp.VisitorId!.Value, deviceId, cancellationToken);
        if (!syncPerson.Success)
            return syncPerson;

        var readerId = HikvisionIsapiDefaults.GetReaderId(configuration);
        var body = IsapiFingerPrintDownload.BuildJson(
            employeeNo,
            fp.FingerIndex,
            Convert.ToBase64String(fp.TemplateData),
            readerId);

        var client = CreateClient(device);
        var (success, error) = await IsapiFingerPrintDownload.TryUploadTemplateAsync(client, body, cancellationToken);

        if (!success)
        {
            logger.LogWarning("SyncFingerprint {FpId} to {Device}: {Error}", fingerprintId, device.Name, error);
            return new DeviceSyncResult(false, error ?? "Ошибка синхронизации отпечатка.");
        }
        return new DeviceSyncResult(true, null);
    }

    public async Task<DeviceSyncResult> DeleteCardFromDeviceAsync(string cardNo, Guid deviceId, string? employeeNo = null, CancellationToken cancellationToken = default)
    {
        var device = await dbContext.Devices.FindAsync([deviceId], cancellationToken);
        if (device is null)
            return new DeviceSyncResult(false, "Устройство не найдено.");

        var client = CreateClient(device);
        var path = "ISAPI/AccessControl/CardInfo/Delete?format=json";

        var bodies = new List<string>
        {
            JsonSerializer.Serialize(new { CardInfo = new { cardNo } }),
        };
        if (!string.IsNullOrWhiteSpace(employeeNo))
            bodies.Add(JsonSerializer.Serialize(new { CardInfo = new { cardNo, employeeNo } }));

        string? lastError = null;
        foreach (var body in bodies)
        {
            // Документация Pro/Value: удаление карт — PUT; POST — запасной вариант.
            var (success, _, error) = await client.PutJsonAsync(path, body, cancellationToken);
            if (success) return new DeviceSyncResult(true, null);
            lastError = error;
            (success, _, error) = await client.PostJsonAsync(path, body, cancellationToken);
            if (success) return new DeviceSyncResult(true, null);
            lastError = error;
        }

        logger.LogWarning("DeleteCardFromDevice cardNo={CardNo} device={Device}: {Error}", cardNo, device.Name, lastError);
        return new DeviceSyncResult(false, lastError);
    }

    public async Task<DeviceSyncResult> DeleteFaceFromDeviceAsync(Guid faceId, Guid deviceId, CancellationToken cancellationToken = default)
    {
        var face = await dbContext.Faces
            .Include(f => f.Employee)
            .Include(f => f.Visitor)
            .Include(f => f.GymCustomer)
            .FirstOrDefaultAsync(f => f.Id == faceId, cancellationToken);
        if (face is null)
            return new DeviceSyncResult(false, "Лицо не найдено.");

        var device = await dbContext.Devices.FindAsync([deviceId], cancellationToken);
        if (device is null)
            return new DeviceSyncResult(false, "Устройство не найдено.");

        var employeeNo = face.Employee != null
            ? TruncateEmployeeNo(GetEmployeeNo(face.Employee))
            : GetEmployeeNo(face.Visitor!);

        var client = CreateClient(device);

        // PUT /ISAPI/Intelligent/FDLib/FDSearch/Delete?format=json&FDID=1&faceLibType=blackFD
        // Body: {"FPID":[{"value":"<employeeNo>"}]}
        var body = JsonSerializer.Serialize(new { FPID = new[] { new { value = employeeNo } } });
        var path = "ISAPI/Intelligent/FDLib/FDSearch/Delete?format=json&FDID=1&faceLibType=blackFD";

        var (success, _, error) = await client.PutJsonAsync(path, body, cancellationToken);
        if (success) return new DeviceSyncResult(true, null);

        logger.LogDebug("[DeleteFace] PUT failed: {Error}, trying POST", error);
        (success, _, error) = await client.PostJsonAsync(path, body, cancellationToken);
        if (success) return new DeviceSyncResult(true, null);

        logger.LogWarning("DeleteFace {FaceId} from {Device}: {Error}", faceId, device.Name, error);
        return new DeviceSyncResult(false, error ?? "Ошибка удаления лица с устройства.");
    }

    public async Task<DeviceSyncResult> DeleteFingerprintFromDeviceAsync(Guid fingerprintId, Guid deviceId, CancellationToken cancellationToken = default)
    {
        var fp = await dbContext.Fingerprints
            .Include(f => f.Employee)
            .Include(f => f.Visitor)
            .FirstOrDefaultAsync(f => f.Id == fingerprintId, cancellationToken);
        if (fp is null)
            return new DeviceSyncResult(false, "Отпечаток не найден.");

        var device = await dbContext.Devices.FindAsync([deviceId], cancellationToken);
        if (device is null)
            return new DeviceSyncResult(false, "Устройство не найдено.");

        var employeeNo = fp.Employee != null
            ? TruncateEmployeeNo(GetEmployeeNo(fp.Employee))
            : TruncateEmployeeNo(GetEmployeeNo(fp.Visitor!));
        var fingerIndex = fp.FingerIndex;

        var client = CreateClient(device);
        const string deletePath = "ISAPI/AccessControl/FingerPrint/Delete?format=json";
        var body = IsapiFingerPrintDownload.BuildDeleteBody(employeeNo, fingerPrintIds: [fingerIndex]);

        var (success, content, error) = await client.PutJsonAsync(deletePath, body, cancellationToken);
        LogDeleteFingerprintExchange("FingerPrintDelete", "PUT", deletePath, body, success, content, error);

        if (!success)
            return new DeviceSyncResult(false, error ?? "Транспортная ошибка при PUT FingerPrint/Delete.");

        if (IsapiJsonStatus.GetErrorMessageIfFailed(content) is { } isapiErr)
        {
            logger.LogWarning("Fingerprint delete rejected by device {Device}: {Err}", device.Name, isapiErr);
            return new DeviceSyncResult(false, isapiErr);
        }

        var waitErr = await WaitFingerprintDeleteProcessAsync(client, cancellationToken);
        if (waitErr != null)
        {
            logger.LogWarning("Fingerprint delete process failed on {Device}: {Err}", device.Name, waitErr);
            return new DeviceSyncResult(false, waitErr);
        }

        return new DeviceSyncResult(true, null);
    }


    /// <summary>Ожидание завершения асинхронного удаления отпечатка (GET FingerPrint/DeleteProcess).</summary>
    private async Task<string?> WaitFingerprintDeleteProcessAsync(IsapiClient client, CancellationToken cancellationToken)
    {
        const string progressPath = "ISAPI/AccessControl/FingerPrint/DeleteProcess?format=json";
        const int maxAttempts = 35;

        // Один раз: если API прогресса нет (404) — удаление считается синхронным, не помечаем успехом из-за сетевых сбоев.
        var (probeOk, probeContent, probeErr) = await client.GetAsync(progressPath, cancellationToken);
        LogDeleteFingerprintExchange("FingerPrint/DeleteProcess-probe", "GET", progressPath, "", probeOk, probeContent, probeErr);
        if (!probeOk && probeErr != null && (probeErr.Contains("404", StringComparison.Ordinal) || probeErr.Contains("не найден", StringComparison.OrdinalIgnoreCase)))
            return null;

        var loggedFirstPoll = false;
        string? lastPollContent = null;
        for (var attempt = 0; attempt < maxAttempts; attempt++)
        {
            var (ok, content, pollErr) = await client.GetAsync(progressPath, cancellationToken);
            if (ok && !string.IsNullOrWhiteSpace(content))
                lastPollContent = content;
            if (ok && !string.IsNullOrWhiteSpace(content) && !loggedFirstPoll)
            {
                LogDeleteFingerprintExchange("FingerPrint/DeleteProcess", "GET", progressPath, "", true, content, pollErr);
                loggedFirstPoll = true;
            }

            if (!ok)
            {
                await Task.Delay(400, cancellationToken);
                continue;
            }

            if (string.IsNullOrWhiteSpace(content))
            {
                await Task.Delay(400, cancellationToken);
                continue;
            }

            if (IsapiJsonStatus.GetErrorMessageIfFailed(content) is { } rootFail)
            {
                LogDeleteFingerprintExchange("FingerPrint/DeleteProcess-fail", "GET", progressPath, "", true, content, rootFail);
                return rootFail;
            }

            if (IsapiJsonStatus.HasExplicitSuccess(content))
                return null;

            try
            {
                using var doc = JsonDocument.Parse(content);
                var root = doc.RootElement;
                if (TryGetFingerprintDeleteProcess(root, out var proc))
                {
                    var status = GetJsonStringProperty(proc, "status", "Status");
                    if (!string.IsNullOrEmpty(status))
                    {
                        if (status.Contains("fail", StringComparison.OrdinalIgnoreCase) ||
                            status.Contains("error", StringComparison.OrdinalIgnoreCase))
                            return content.Length > 400 ? content[..400] : content;
                        if (status.Contains("complete", StringComparison.OrdinalIgnoreCase) ||
                            string.Equals(status, "ok", StringComparison.OrdinalIgnoreCase) ||
                            string.Equals(status, "success", StringComparison.OrdinalIgnoreCase))
                            return null;
                    }

                    if (proc.TryGetProperty("percent", out var pctEl) && pctEl.TryGetInt32(out var pct) && pct >= 100)
                        return null;
                }
            }
            catch (JsonException)
            {
                /* не JSON */
            }

            await Task.Delay(450, cancellationToken);
        }

        LogDeleteFingerprintExchange(
            "FingerPrint/DeleteProcess-timeout",
            "GET",
            progressPath,
            "",
            !string.IsNullOrEmpty(lastPollContent),
            lastPollContent,
            "Таймаут ожидания DeleteProcess");
        return "Таймаут: нет подтверждения завершения удаления (FingerPrint/DeleteProcess).";
    }

    private static bool TryGetFingerprintDeleteProcess(JsonElement root, out JsonElement proc)
    {
        proc = default;
        if (root.ValueKind != JsonValueKind.Object)
            return false;
        ReadOnlySpan<string> names =
        [
            "FingerPrintDeleteProcess",
            "fingerPrintDeleteProcess",
        ];
        foreach (var name in names)
        {
            if (root.TryGetProperty(name, out proc))
                return true;
        }
        return false;
    }

    private static string? GetJsonStringProperty(JsonElement obj, params string[] propertyNames)
    {
        foreach (var n in propertyNames)
        {
            if (obj.TryGetProperty(n, out var el) && el.ValueKind == JsonValueKind.String)
                return el.GetString();
        }
        return null;
    }

    public async Task<DeviceSyncResult> DeletePersonFromDeviceAsync(string employeeNo, Guid deviceId, CancellationToken cancellationToken = default)
    {
        var device = await dbContext.Devices.FindAsync([deviceId], cancellationToken);
        if (device is null)
            return new DeviceSyncResult(false, "Устройство не найдено.");

        var client = CreateClient(device);
        var escapedNo = Uri.EscapeDataString(employeeNo);

        // DS-K1T670, DS-K1T341 и др. ожидают "mode": "byEmployeeNo" и массив объектов в "EmployeeNoList"
        // Большинство терминалов используют PUT для UserInfoDetail/Delete.
        var pathUserInfoDetail = "ISAPI/AccessControl/UserInfoDetail/Delete?format=json";
        
        var jsonBodies = new List<string>
        {
            // 1. Стандартный современный формат (Pro/Value series)
            JsonSerializer.Serialize(new
            {
                UserInfoDetail = new
                {
                    mode = "byEmployeeNo",
                    EmployeeNoList = new[] { new { employeeNo } }
                }
            }, new JsonSerializerOptions { PropertyNamingPolicy = null }),

            // 2. Вариант с PascalCase для employeeNo
            JsonSerializer.Serialize(new
            {
                UserInfoDetail = new
                {
                    mode = "byEmployeeNo",
                    EmployeeNoList = new[] { new { EmployeeNo = employeeNo } }
                }
            }, new JsonSerializerOptions { PropertyNamingPolicy = null }),

            // 3. Формат без mode (как был ранее, для старых прошивок)
            JsonSerializer.Serialize(new { UserInfoDetail = new { EmployeeNoList = new { EmployeeNo = new[] { employeeNo } } } }, new JsonSerializerOptions { PropertyNamingPolicy = null }),
            
            // 4. Упрощенный формат
            JsonSerializer.Serialize(new { UserInfoDetail = new { employeeNo } }, new JsonSerializerOptions { PropertyNamingPolicy = null })
        };

        string? lastError = null;

        // Попытка 1: UserInfoDetail/Delete (PUT — основной метод для терминалов)
        foreach (var body in jsonBodies)
        {
            var (success, _, error) = await client.PutAsync(pathUserInfoDetail, body, "application/json", cancellationToken);
            if (success) return new DeviceSyncResult(true, null);
            lastError = error;
        }

        // Попытка 2: UserInfoDetail/Delete (POST — для некоторых контроллеров)
        foreach (var body in jsonBodies)
        {
            var (success, _, error) = await client.PostAsync(pathUserInfoDetail, body, "application/json", cancellationToken);
            if (success) return new DeviceSyncResult(true, null);
            lastError = error;
        }

        // Попытка 3: UserInfo/Delete ( fallback для старых устройств)
        var pathUserInfoSimple = "ISAPI/AccessControl/UserInfo/Delete?format=json";
        var simpleBody = JsonSerializer.Serialize(new { UserInfo = new { employeeNo } }, new JsonSerializerOptions { PropertyNamingPolicy = null });
        var (s3, _, e3) = await client.PutAsync(pathUserInfoSimple, simpleBody, "application/json", cancellationToken);
        if (s3) return new DeviceSyncResult(true, null);
        (s3, _, e3) = await client.PostAsync(pathUserInfoSimple, simpleBody, "application/json", cancellationToken);
        if (s3) return new DeviceSyncResult(true, null);

        // Попытка 4: Query string (если тело вообще не принимается)
        var (qsSuccess, _, qsError) = await client.PutAsync(
            $"{pathUserInfoDetail}&employeeNo={escapedNo}",
            "{}",
            "application/json",
            cancellationToken);
        if (qsSuccess) return new DeviceSyncResult(true, null);

        // Попытка 5: XML (последний шанс)
        var escaped = employeeNo.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;").Replace("'", "&apos;");
        var xmlBody = $@"<?xml version=""1.0"" encoding=""UTF-8""?>
<UserInfoDetail xmlns=""http://www.hikvision.com/ver20/XMLSchema"">
  <mode>byEmployeeNo</mode>
  <EmployeeNoList>
    <EmployeeNo>{escaped}</EmployeeNo>
  </EmployeeNoList>
</UserInfoDetail>";

        var (xmlSuccess, _, xmlError) = await client.PutAsync("ISAPI/AccessControl/UserInfoDetail/Delete?format=xml", xmlBody, "application/xml", cancellationToken);
        if (xmlSuccess) return new DeviceSyncResult(true, null);
        
        (xmlSuccess, _, xmlError) = await client.PostAsync("ISAPI/AccessControl/UserInfoDetail/Delete?format=xml", xmlBody, "application/xml", cancellationToken);
        if (xmlSuccess) return new DeviceSyncResult(true, null);

        return new DeviceSyncResult(false, lastError ?? xmlError);
    }

    private async Task EnsureFDLibExistsAsync(IsapiClient client, CancellationToken ct)
    {
        try
        {
            var (ok, content, _) = await client.GetAsync("ISAPI/Intelligent/FDLib?format=json", ct);
            if (ok && !string.IsNullOrEmpty(content))
            {
                logger.LogDebug("[EnsureFDLib] FDLib exists: {Content}", content.Length > 200 ? content[..200] : content);
                return;
            }

            var createBody = JsonSerializer.Serialize(new Dictionary<string, object>
            {
                ["faceLibType"] = "blackFD",
                ["name"] = "FaceLib",
                ["customInfo"] = ""
            });
            var (created, createContent, createErr) = await client.PostAsync(
                "ISAPI/Intelligent/FDLib?format=json",
                createBody,
                "application/json",
                ct);
            logger.LogDebug("[EnsureFDLib] Create FDLib: ok={Ok} body={Body} err={Err}",
                created, createContent ?? "-", createErr ?? "-");
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "[EnsureFDLib] Failed to ensure FDLib exists");
        }
    }

    private static int[] GetDoorRightForDevice(IEnumerable<AccessLevel?> accessLevels, Guid deviceId)
    {
        var doorIndices = new HashSet<int>();
        foreach (var al in accessLevels.Where(al => al != null))
        {
            foreach (var door in al!.Doors.Where(d => d.DeviceId == deviceId))
                doorIndices.Add(door.DoorIndex);
        }
        return doorIndices.OrderBy(x => x).ToArray();
    }

    private async Task<DeviceSyncResult> SyncUserInfoAsync(
        Device device,
        string employeeNo,
        string name,
        int? userType,
        int[] doorRight,
        string? gender = null,
        DateTime? validFromUtc = null,
        DateTime? validToUtc = null,
        string userCategory = "normal",
        bool onlyVerify = false,
        CancellationToken cancellationToken = default)
    {
        var parts = name.Trim().Split(' ', 2, StringSplitOptions.RemoveEmptyEntries);
        var givenName = parts.Length > 0 ? parts[0] : name;
        var familyName = parts.Length > 1 ? parts[1] : (parts.Length == 1 ? parts[0] : "");

        // doorNo: 1-based для ISAPI. Если дверей нет — используем дверь 1 (обязательно для многих устройств).
        var doorNoList = doorRight.Length > 0
            ? doorRight.Select(i => i + 1).ToList()
            : [1];

        var genderValue = string.IsNullOrWhiteSpace(gender) ? "unknown" : gender.Trim().ToLowerInvariant();
        if (genderValue is not ("male" or "female"))
            genderValue = "unknown";

        // Формат без Z — устройства Hikvision (Value/Pro/Controllers) ожидают "yyyy-MM-ddTHH:mm:ss" в локальном времени (из глобальных настроек)
        // По умолчанию: с сегодняшней даты до 31 дек 2034 — это «срок не задан» для устройства.
        // Дата фиксированная, а не «сегодня + N лет»: иначе она менялась бы каждый день и
        // при каждой синхронизации переписывалась бы на устройствах.
        var tz = GetTimeZone();
        var todayUtc = DateTime.UtcNow.Date;
        var defaultEndUtc = new DateTime(2034, 12, 31, 23, 59, 59, DateTimeKind.Utc);
        var fromUtc = validFromUtc ?? todayUtc;
        var toUtc = validToUtc ?? defaultEndUtc;
        var beginTime = TimeZoneInfo.ConvertTimeFromUtc(fromUtc, tz).ToString("yyyy-MM-ddTHH:mm:ss");
        var endTime = TimeZoneInfo.ConvertTimeFromUtc(toUtc, tz).ToString("yyyy-MM-ddTHH:mm:ss");

        // doorRight — строка "1" или "1,2,3" (формат, ожидаемый Face Recognition Terminals и Controllers)
        var doorRightStr = string.Join(",", doorNoList);

        // RightPlan — обязателен (MessageParametersLack без него). doorNo — число, planTemplateNo — "1" (как в ответе устройства).
        var rightPlan = doorNoList.Select(d => new { doorNo = d, planTemplateNo = "1" }).ToArray();

        // userType: "blackList" (не "block list") — реальные устройства Hikvision возвращают blackList
        var userTypeStr = userCategory.Equals("block list", StringComparison.OrdinalIgnoreCase) ? "blackList" : userCategory;

        var userInfo = new Dictionary<string, object?>
        {
            ["employeeNo"] = employeeNo,
            ["name"] = name,
            ["userType"] = userTypeStr,
            ["givenName"] = givenName,
            ["familyName"] = familyName,
            ["gender"] = genderValue,
            ["doorRight"] = doorRightStr,
            ["RightPlan"] = rightPlan,
            ["onlyVerify"] = onlyVerify,
            ["localUIRight"] = false,
            ["maxOpenDoorTime"] = 0,
            ["Valid"] = new Dictionary<string, object> { ["enable"] = true, ["beginTime"] = beginTime, ["endTime"] = endTime, ["timeType"] = "local" }
        };
        // Legacy numeric "type" (1/2/3) — отправляем только для штатных типов; для custom-типов
        // оно не нужно и конфликтует со строковым userType, поэтому опускается.
        if (userType is int legacyType)
            userInfo["type"] = legacyType;

        var jsonOpts = new JsonSerializerOptions { PropertyNamingPolicy = null, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
        var recordBody = JsonSerializer.Serialize(new Dictionary<string, object> { ["UserInfo"] = userInfo }, jsonOpts);

        var client = CreateClient(device);
        var (success, error) = await TrySyncUserInfoWithRetryAsync(client, employeeNo, recordBody, userInfo, jsonOpts, cancellationToken);

        if (!success)
        {
            logger.LogWarning("SyncUserInfo {EmployeeNo} to {Device} ({Ip}:{Port}): {Error}", employeeNo, device.Name, device.IpAddress, device.Port, error);
            return new DeviceSyncResult(false, error ?? "Ошибка синхронизации пользователя.");
        }
        return new DeviceSyncResult(true, null);
    }

    private async Task<(bool Success, string? Error)> TrySyncUserInfoWithRetryAsync(
        IsapiClient client,
        string employeeNo,
        string recordBody,
        Dictionary<string, object?> userInfo,
        JsonSerializerOptions jsonOpts,
        CancellationToken cancellationToken)
    {
        var (success, _, error) = await client.PostJsonAsync(
            "ISAPI/AccessControl/UserInfo/Record?format=json",
            recordBody,
            cancellationToken);

        if (success) return (true, null);

        if (error != null && (error.Contains("employeeNoAlreadyExist", StringComparison.OrdinalIgnoreCase)
            || error.Contains("checkUser", StringComparison.OrdinalIgnoreCase)))
        {
            logger.LogDebug("UserInfo Record: employeeNoAlreadyExist for {EmployeeNo}, retrying with Modify", employeeNo);
            (success, _, error) = await TryModifyAsync(client, employeeNo, userInfo, jsonOpts, cancellationToken);
            if (success) return (true, null);
        }

        if (IsConnectionError(error) && !cancellationToken.IsCancellationRequested)
        {
            await Task.Delay(1500, cancellationToken);
            (success, _, error) = await client.PostJsonAsync(
                "ISAPI/AccessControl/UserInfo/Record?format=json",
                recordBody,
                cancellationToken);
            if (success) return (true, null);
            if (error != null && (error.Contains("employeeNoAlreadyExist", StringComparison.OrdinalIgnoreCase) || error.Contains("checkUser", StringComparison.OrdinalIgnoreCase)))
            {
                (success, _, error) = await TryModifyAsync(client, employeeNo, userInfo, jsonOpts, cancellationToken);
            }
        }

        return (success, error);
    }

    private async Task<(bool Success, string? Content, string? Error)> TryModifyAsync(
        IsapiClient client,
        string employeeNo,
        Dictionary<string, object?> userInfo,
        JsonSerializerOptions jsonOpts,
        CancellationToken cancellationToken)
    {
        var plainBody = JsonSerializer.Serialize(new Dictionary<string, object> { ["UserInfo"] = userInfo }, jsonOpts);
        var (success, content, error) = await client.PutJsonAsync(
            "ISAPI/AccessControl/UserInfo/Modify?format=json",
            plainBody,
            cancellationToken);

        if (success) return (true, content, null);
        if (error != null && error.Contains("Invalid Content", StringComparison.OrdinalIgnoreCase))
        {
            logger.LogDebug("UserInfo Modify plain failed, retrying with UserInfoDetail wrapper");
            var modifyBody = JsonSerializer.Serialize(new Dictionary<string, object>
            {
                ["UserInfoDetail"] = new Dictionary<string, object>
                {
                    ["mode"] = "byEmployeeNo",
                    ["EmployeeNoList"] = new Dictionary<string, object> { ["EmployeeNo"] = new[] { employeeNo } }
                },
                ["UserInfo"] = userInfo
            }, jsonOpts);
            return await client.PutJsonAsync("ISAPI/AccessControl/UserInfo/Modify?format=json", modifyBody, cancellationToken);
        }
        return (success, content, error);
    }

    private static bool IsConnectionError(string? error) =>
        error != null && (error.Contains("forcibly closed", StringComparison.OrdinalIgnoreCase)
            || error.Contains("connection reset", StringComparison.OrdinalIgnoreCase)
            || error.Contains("Ошибка сети", StringComparison.OrdinalIgnoreCase));

    private TimeZoneInfo GetTimeZone()
    {
        var id = systemOptions.Value?.TimezoneId?.Trim();
        if (string.IsNullOrEmpty(id) || string.Equals(id, "UTC", StringComparison.OrdinalIgnoreCase))
            return TimeZoneInfo.Utc;
        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById(id);
        }
        catch (TimeZoneNotFoundException)
        {
            logger.LogWarning("TimezoneId '{TimezoneId}' not found, using UTC", id);
            return TimeZoneInfo.Utc;
        }
    }

    private IsapiClient CreateClient(Device device)
    {
        var username = configuration["Hikvision:Username"] ?? "admin";
        var password = (configuration["Hikvision:Password"] ?? "").Trim();
        if (string.IsNullOrEmpty(password)) password = "12345";
        var cred = new NetworkCredential(
            string.IsNullOrWhiteSpace(device.Username) ? username : device.Username,
            string.IsNullOrWhiteSpace(device.Password) ? password : device.Password);
        return new IsapiClient(
            device.IpAddress,
            device.Port,
            cred.UserName ?? "admin",
            cred.Password ?? "",
            TimeSpan.FromSeconds(30));
    }

}
