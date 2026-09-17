using System.Collections.Concurrent;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using Backend.Application.Devices;
using Backend.Domain.Entities;
using Backend.Infrastructure.Devices;
using Backend.Infrastructure.Devices.Sdk;
using Backend.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace Backend.Infrastructure.Devices.Services;

public sealed class DeviceFaceCaptureService(
    AppDbContext dbContext,
    IDevicePersonSyncService syncService,
    IHikvisionSdkClient sdkClient,
    DeviceEnrollmentDetector enrollmentDetector,
    EnrollerCaptureService enrollerCapture,
    CapturedCredentialStore credentialStore,
    IConfiguration configuration,
    ILogger<DeviceFaceCaptureService> logger) : IDeviceFaceCaptureService
{
    private static readonly ConcurrentDictionary<Guid, CaptureSession> Sessions = new();

    private sealed class CaptureSession
    {
        public required string EmployeeNo { get; init; }
        public required Guid PersonId { get; init; }
        public required string PersonType { get; init; }
        public DateTime StartedUtc { get; init; } = DateTime.UtcNow;
        /// <summary>Человека завели на устройстве только ради захвата (у него нет уровня доступа) —
        /// после завершения его надо оттуда убрать: на устройства он попадёт лишь при назначении уровня.</summary>
        public bool TemporaryOnDevice { get; init; }
    }

    /// <summary>Убрать временно заведённого человека с устройства (ошибки глушим — захват уже состоялся).</summary>
    private async Task CleanupTemporaryAsync(Guid deviceId, CaptureSession session, CancellationToken ct)
    {
        if (!session.TemporaryOnDevice) return;
        try { await syncService.DeletePersonFromDeviceAsync(session.EmployeeNo, deviceId, ct); }
        catch (Exception ex) { logger.LogWarning(ex, "Cleanup temporary person {EmployeeNo} from device {DeviceId}", session.EmployeeNo, deviceId); }
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
                // Нет уровня доступа → человека на устройство НЕ пишем. Захват идёт с камеры терминала,
                // снимок забираем себе. Если прошивка всё же создаст пользователя сама — уберём его
                // после захвата (CleanupTemporaryAsync).
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

        // Станция регистрации: пользователей и FDLib у неё нет, захват — блокирующий запрос по своей документации.
        if (isEnroller)
            return enrollerCapture.Start(device, EnrollerCaptureKind.Face, personId, personType);

        var client = CreateClient(device);
        logger.LogInformation(
            "[CaptureFace] Start: Device={Device} ({Ip}:{Port}), EmployeeNo={EmployeeNo}, PersonType={PersonType}",
            device.Name, device.IpAddress, device.Port, employeeNo, personType);

        await EnsureFaceLibraryExistsAsync(client, device, cancellationToken);

        // Cancel any previous capture first to avoid "Device Busy"
        await CancelCaptureAsync(device, client, cancellationToken);

        var (success, content, error) = await StartCaptureFaceAsync(client, employeeNo, cancellationToken);

        // If "Device Busy" — cancel and retry once
        if (!success && error != null && error.Contains("deviceBusy", StringComparison.OrdinalIgnoreCase))
        {
            logger.LogInformation("[CaptureFace] Device busy, cancelling and retrying...");
            await CancelCaptureAsync(device, client, cancellationToken);
            await Task.Delay(1500, cancellationToken);
            (success, content, error) = await StartCaptureFaceAsync(client, employeeNo, cancellationToken);
        }

        logger.LogInformation("[CaptureFace] POST result: success={S} error={E} len={L}",
            success, error ?? "-", content?.Length ?? 0);

        if (!success)
        {
            logger.LogWarning("[CaptureFace] FAILED: {Error}", error);
            return new DeviceSyncResult(false, error ?? "Не удалось запустить захват лица.");
        }

        if (ParseStatusCodeError(content) is { } errMsg)
            return new DeviceSyncResult(false, errMsg);

        logger.LogInformation("[CaptureFace] CaptureFaceData OK for {Device}. Response: {Content}", device.Name, (content?.Length ?? 0) > 200 ? content![..200] + "..." : content ?? "(empty)");

        Sessions[deviceId] = new CaptureSession { EmployeeNo = employeeNo, PersonId = personId, PersonType = personType, TemporaryOnDevice = temporaryOnDevice };
        return new DeviceSyncResult(true, null);
    }

    public async Task<FaceCaptureProgressResult> GetProgressAsync(Guid deviceId, CancellationToken cancellationToken = default)
    {
        if (enrollerCapture.TryGetProgress(deviceId, EnrollerCaptureKind.Face, out var enrollerState))
            return new FaceCaptureProgressResult(enrollerState.Status,
                enrollerState.Status == "completed" ? 100 : null, enrollerState.Message, enrollerState.ResultId);

        if (!Sessions.TryGetValue(deviceId, out var session))
            return new FaceCaptureProgressResult("idle", null, "Сессия захвата не найдена. Запустите захват.", null);

        var device = await dbContext.Devices.FindAsync([deviceId], cancellationToken);
        if (device is null)
        {
            Sessions.TryRemove(deviceId, out _);
                await CleanupTemporaryAsync(deviceId, session, cancellationToken);
            return new FaceCaptureProgressResult("failed", null, "Устройство не найдено.", null);
        }

        if ((DateTime.UtcNow - session.StartedUtc).TotalSeconds > 120)
        {
            Sessions.TryRemove(deviceId, out _);
                await CleanupTemporaryAsync(deviceId, session, cancellationToken);
            return new FaceCaptureProgressResult("failed", null, "Таймаут захвата.", null);
        }

        var client = CreateClient(device);
        var readerId = HikvisionIsapiDefaults.GetReaderId(configuration);

        // ISAPI: GET .../CaptureFaceData/Progress?readerID=<id> (интеллектуальные хосты / часть прошивок).
        string? content = null;
        foreach (var path in new[]
                 {
                     $"ISAPI/AccessControl/CaptureFaceData/Progress?format=json&readerID={readerId}",
                     $"ISAPI/AccessControl/CaptureFaceData/Progress?readerID={readerId}",
                     "ISAPI/AccessControl/CaptureFaceData/Progress?format=json",
                     "ISAPI/AccessControl/CaptureFaceData/Progress",
                 })
        {
            var (ok, c, _) = await client.GetAsync(path, cancellationToken);
            if (ok && !string.IsNullOrWhiteSpace(c))
            {
                content = c;
                break;
            }
        }

        if (string.IsNullOrWhiteSpace(content))
            return new FaceCaptureProgressResult("capturing", null, null, null);

        logger.LogDebug("[CaptureFace] Progress raw (first 500): {Raw}",
            content!.Length > 500 ? content[..500] : content);

        try
        {
            int? progress = null;
            bool? isOver = null;
            string? faceB64 = null;
            string? message = null;

            if (content.TrimStart().StartsWith('<'))
            {
                // XML response from device
                var xml = new global::System.Xml.XmlDocument();
                xml.LoadXml(content);
                var ns = new global::System.Xml.XmlNamespaceManager(xml.NameTable);
                ns.AddNamespace("h", "http://www.isapi.org/ver20/XMLSchema");

                string? XPath(string path) =>
                    xml.SelectSingleNode(path, ns)?.InnerText ??
                    xml.SelectSingleNode(path.Replace("h:", ""), ns)?.InnerText;

                var progStr = XPath("//h:captureProgress") ?? XPath("//h:CaptureProgress");
                if (int.TryParse(progStr, out var pv)) progress = pv;

                var overStr = XPath("//h:isCurRequestOver") ?? XPath("//h:IsCurRequestOver");
                if (bool.TryParse(overStr, out var ov)) isOver = ov;

                faceB64 = XPath("//h:faceData") ?? XPath("//h:FaceData")
                    ?? XPath("//h:faceURL") ?? XPath("//h:FaceURL")
                    ?? XPath("//h:faceDataUrl") ?? XPath("//h:FaceDataUrl");
                message = XPath("//h:message") ?? XPath("//h:Message");
            }
            else
            {
                // JSON
                using var doc = JsonDocument.Parse(content);
                var root = doc.RootElement;
                foreach (var prop in new[] { "CaptureFaceDataProgress", "captureFaceDataProgress" })
                {
                    if (!root.TryGetProperty(prop, out var el)) continue;
                    progress = TryInt(el, "captureProgress", "CaptureProgress");
                    isOver = TryBool(el, "isCurRequestOver", "IsCurRequestOver");
                    faceB64 = TryStr(el, "faceData", "FaceData");
                    message = TryStr(el, "message", "Message");
                    break;
                }
            }

            if (progress == 0 && isOver == true)
            {
                Sessions.TryRemove(deviceId, out _);
                await CleanupTemporaryAsync(deviceId, session, cancellationToken);
                return new FaceCaptureProgressResult("failed", null, message ?? "Захват лица не удался.", null);
            }

            if (progress == 100 || !string.IsNullOrWhiteSpace(faceB64))
            {
                Sessions.TryRemove(deviceId, out _);
                byte[]? imageData = null;
                if (!string.IsNullOrWhiteSpace(faceB64))
                {
                    if (faceB64.StartsWith("http", StringComparison.OrdinalIgnoreCase))
                    {
                        // URL may have @WEB... suffix — strip it
                        var downloadUrl = faceB64.Contains('@') ? faceB64[..faceB64.LastIndexOf('@')] : faceB64;
                        logger.LogInformation("[CaptureFace] Downloading face image from: {Url}", downloadUrl);
                        try
                        {
                            var (dlOk, dlData, dlErr) = await client.GetBytesFromUrlAsync(downloadUrl, cancellationToken);
                            if (dlOk && dlData is { Length: > 0 })
                            {
                                imageData = dlData;
                            }
                            else
                            {
                                logger.LogWarning("[CaptureFace] Digest download failed ({Err}), trying without auth", dlErr);
                                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
                                imageData = await http.GetByteArrayAsync(downloadUrl, cancellationToken);
                            }
                        }
                        catch (Exception ex) { logger.LogWarning(ex, "Failed to download face from {Url}", downloadUrl); }
                    }
                    else
                    {
                        try { imageData = Convert.FromBase64String(faceB64); } catch { }
                    }
                }

                if (imageData is { Length: > 0 })
                {
                    var faceId = await credentialStore.SaveFaceAsync(session.PersonId, session.PersonType, imageData, cancellationToken);

                    // Снимок уже у нас — теперь убираем временную запись с устройства.
                    await CleanupTemporaryAsync(deviceId, session, cancellationToken);
                    return new FaceCaptureProgressResult("completed", 100,
                        "Лицо захвачено. Сохраните профиль для синхронизации с устройствами.",
                        faceId);
                }
                // Снимок не пришёл — временную запись всё равно убираем.
                await CleanupTemporaryAsync(deviceId, session, cancellationToken);
                return new FaceCaptureProgressResult("completed", 100,
                    "Лицо захвачено на устройстве. Изображение не получено — добавьте лицо с компьютера.", null);
            }

            return new FaceCaptureProgressResult("capturing", progress, message, null);
        }
        catch (Exception ex) { logger.LogDebug(ex, "Parse CaptureFaceData Progress"); }

        return new FaceCaptureProgressResult("capturing", null, null, null);
    }

    private static string? ParseStatusCodeError(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var r = doc.RootElement;
            if (TryStatusCode(r, out var code, out var msg) && code != 0)
                return $"Ошибка устройства {code}: {msg ?? "см. документацию"}";
            if (r.TryGetProperty("CaptureFaceData", out var inner) && TryStatusCode(inner, out code, out msg) && code != 0)
                return $"Ошибка устройства {code}: {msg ?? "см. документацию"}";
        }
        catch { }
        return null;
    }

    private static bool TryStatusCode(JsonElement el, out int code, out string? msg)
    {
        code = 0; msg = null;
        if (el.TryGetProperty("statusCode", out var c) && c.TryGetInt32(out code))
        {
            msg = el.TryGetProperty("statusString", out var s) ? s.GetString() : null;
            return true;
        }
        return false;
    }

    private async Task EnsureFaceLibraryExistsAsync(IsapiClient client, Device device, CancellationToken ct)
    {
        var (ok, content, _) = await client.GetAsync("ISAPI/Intelligent/FDLib?format=json", ct);
        if (ok && !string.IsNullOrWhiteSpace(content))
        {
            try
            {
                using var doc = JsonDocument.Parse(content);
                if (doc.RootElement.TryGetProperty("FDLib", out _) ||
                    (doc.RootElement.TryGetProperty("FDLibList", out var list) && list.GetArrayLength() > 0) ||
                    doc.RootElement.TryGetProperty("FDID", out _))
                    return;
            }
            catch { }
        }
        var body = JsonSerializer.Serialize(new { FDLib = new { FDID = 1, faceLibType = "blackFD", name = "default" } });
        var (_, _, err) = await client.PostJsonAsync("ISAPI/Intelligent/FDLib?format=json", body, ct);
        if (err != null)
            logger.LogDebug("FDLib create (optional) failed for {Device}: {Error}", device.Name, err);
    }

    /// <summary>Ссылка или Base64 лица в ответе Progress (разные имена в ISAPI).</summary>
    private static string? TryFaceImageRef(JsonElement el) =>
        TryStr(el, "faceData", "FaceData", "faceDataUrl", "FaceDataUrl", "faceURL", "FaceURL", "visibleLightURL",
            "VisibleLightURL", "faceMattingURL", "FaceMattingURL");

    private static int? TryInt(JsonElement el, params string[] names)
    {
        foreach (var n in names)
            if (el.TryGetProperty(n, out var p) && p.TryGetInt32(out var v)) return v;
        return null;
    }
    private static bool? TryBool(JsonElement el, params string[] names)
    {
        foreach (var n in names)
            if (el.TryGetProperty(n, out var p) && (p.ValueKind is JsonValueKind.True or JsonValueKind.False)) return p.GetBoolean();
        return null;
    }
    private static string? TryStr(JsonElement el, params string[] names)
    {
        foreach (var n in names)
            if (el.TryGetProperty(n, out var p)) return p.GetString();
        return null;
    }

    private static string Truncate(string s) => s.Length > 32 ? s[..32] : s;

    private async Task CancelCaptureAsync(Device device, IsapiClient client, CancellationToken ct)
    {
        // Cancel через SDK-канал (NET_DVR_STDXMLConfig) — обходит HTTP digest-auth,
        // поэтому неудачные cancel-попытки не вызывают локаута admin-аккаунта.
        // Прошивки разных серий принимают cancel разными способами — пробуем все известные.
        var cancelVariants = new (string Line, string? Body)[]
        {
            ("DELETE /ISAPI/AccessControl/CaptureFaceData", null),
            ("PUT /ISAPI/AccessControl/CaptureFaceData/Cancel",
                @"<?xml version=""1.0"" encoding=""UTF-8""?><CancelCaptureCmd version=""2.0"" xmlns=""http://www.isapi.org/ver20/XMLSchema""/>"),
            ("POST /ISAPI/AccessControl/CaptureFaceData/Cancel",
                @"<?xml version=""1.0"" encoding=""UTF-8""?><CancelCaptureCmd version=""2.0"" xmlns=""http://www.isapi.org/ver20/XMLSchema""/>"),
            ("PUT /ISAPI/AccessControl/CaptureFaceData",
                @"<?xml version=""1.0"" encoding=""UTF-8""?><CaptureFaceDataCond version=""2.0"" xmlns=""http://www.isapi.org/ver20/XMLSchema""><cancelFlag>true</cancelFlag></CaptureFaceDataCond>"),
        };

        var deviceId = device.DeviceIdentifier ?? device.IpAddress ?? string.Empty;
        bool cancelled = false;
        foreach (var (line, body) in cancelVariants)
        {
            if (ct.IsCancellationRequested) break;
            try
            {
                var (ok, resp, err) = await sdkClient.TrySendIsapiViaSdkAsync(deviceId, line, body, ct);
                logger.LogDebug("[CaptureFace] SDK Cancel '{Line}': ok={Ok} err={Err} respLen={L}", line, ok, err, resp?.Length ?? 0);
                if (ok)
                {
                    cancelled = true;
                    break;
                }
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "[CaptureFace] SDK Cancel '{Line}' threw", line);
            }
        }

        if (cancelled) return;

        // HTTP fallback (если SDK не залогинен или STDXMLConfig недоступен в этой версии SDK).
        try
        {
            var (ok, _, err) = await client.DeleteAsync("ISAPI/AccessControl/CaptureFaceData", null, null, ct);
            logger.LogDebug("[CaptureFace] HTTP Cancel: ok={Ok} err={Err}", ok, err ?? "-");
            if (!ok)
            {
                await client.PutAsync("ISAPI/AccessControl/CaptureFaceData/Cancel",
                    @"<?xml version=""1.0"" encoding=""UTF-8""?><CancelCaptureCmd version=""2.0"" xmlns=""http://www.isapi.org/ver20/XMLSchema""/>",
                    "application/xml", ct);
            }
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "[CaptureFace] HTTP Cancel exception (non-fatal)");
        }
    }

    private async Task<(bool Success, string? Content, string? Error)> StartCaptureFaceAsync(
        IsapiClient client, string employeeNo, CancellationToken ct)
    {
        var readerId = HikvisionIsapiDefaults.GetReaderId(configuration);
        var fdid = configuration["Hikvision:CaptureFaceFDID"]?.Trim();
        if (string.IsNullOrEmpty(fdid)) fdid = "1";

        const string pathJson = "ISAPI/AccessControl/CaptureFaceData?format=json";
        var esc = global::System.Security.SecurityElement.Escape(employeeNo);
        var escFdid = global::System.Security.SecurityElement.Escape(fdid);

        var success = false;
        string? content = null;
        string? error = null;

        async Task TryJson(string label, Dictionary<string, object> root)
        {
            if (success) return;
            var body = JsonSerializer.Serialize(root);
            var (ok, c, e) = await client.PostJsonAsync(pathJson, body, ct);
            logger.LogInformation("[CaptureFace] {Label}: success={S} error={E}", label, ok, e ?? "-");
            if (!ok) return;
            success = true;
            content = c;
            error = e;
        }

        async Task TryXml(string label, string xml)
        {
            if (success) return;
            var (ok, c, e) = await client.PostAsync("ISAPI/AccessControl/CaptureFaceData", xml, "application/xml", ct);
            logger.LogInformation("[CaptureFace] {Label}: success={S} error={E}", label, ok, e ?? "-");
            if (!ok) return;
            success = true;
            content = c;
            error = e;
        }

        Dictionary<string, object> PersonFields(string dataTypeValue) => new()
        {
            ["employeeNo"] = employeeNo,
            ["FDID"] = fdid,
            ["dataType"] = dataTypeValue,
            ["readerID"] = readerId,
            ["captureInfrared"] = false,
        };

        Dictionary<string, object> PersonFieldsNoDataType() => new()
        {
            ["employeeNo"] = employeeNo,
            ["FDID"] = fdid,
            ["readerID"] = readerId,
            ["captureInfrared"] = false,
        };

        Dictionary<string, object> MinimalFields(string? dataTypeValue)
        {
            var d = new Dictionary<string, object>
            {
                ["readerID"] = readerId,
                ["captureInfrared"] = false,
            };
            if (dataTypeValue != null)
                d["dataType"] = dataTypeValue;
            return d;
        }

        // Exact format per device /CaptureFaceData/capabilities: the CaptureFaceDataCond accepts
        // ONLY captureInfrared + dataType (no employeeNo / FDID / readerID). Extra nodes → badXmlFormat.
        await TryXml("XML exact Cond url",
            """<?xml version="1.0" encoding="UTF-8"?><CaptureFaceDataCond version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><captureInfrared>false</captureInfrared><dataType>url</dataType></CaptureFaceDataCond>""");
        await TryXml("XML exact Cond binary",
            """<?xml version="1.0" encoding="UTF-8"?><CaptureFaceDataCond version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><captureInfrared>false</captureInfrared><dataType>binary</dataType></CaptureFaceDataCond>""");
        await TryJson("JSON exact Cond url", new Dictionary<string, object> { ["CaptureFaceDataCond"] = new Dictionary<string, object> { ["captureInfrared"] = false, ["dataType"] = "url" } });

        await TryJson("JSON CaptureFaceData+person url", new Dictionary<string, object> { ["CaptureFaceData"] = PersonFields("url") });
        await TryJson("JSON CaptureFaceDataCond+person url", new Dictionary<string, object> { ["CaptureFaceDataCond"] = PersonFields("url") });
        await TryJson("JSON CaptureFaceData+person omit dataType", new Dictionary<string, object> { ["CaptureFaceData"] = PersonFieldsNoDataType() });
        await TryJson("JSON CaptureFaceDataCond+person omit dataType", new Dictionary<string, object> { ["CaptureFaceDataCond"] = PersonFieldsNoDataType() });
        await TryJson("JSON CaptureFaceData+person binary", new Dictionary<string, object> { ["CaptureFaceData"] = PersonFields("binary") });
        await TryJson("JSON CaptureFaceDataCond+person binary", new Dictionary<string, object> { ["CaptureFaceDataCond"] = PersonFields("binary") });
        await TryJson("JSON minimal Cond url", new Dictionary<string, object> { ["CaptureFaceDataCond"] = MinimalFields("url") });
        await TryJson("JSON minimal CaptureFaceData url", new Dictionary<string, object> { ["CaptureFaceData"] = MinimalFields("url") });
        await TryJson("JSON minimal Cond binary", new Dictionary<string, object> { ["CaptureFaceDataCond"] = MinimalFields("binary") });
        await TryJson("JSON minimal CaptureFaceData binary", new Dictionary<string, object> { ["CaptureFaceData"] = MinimalFields("binary") });
        await TryJson("JSON minimal Cond omit dataType", new Dictionary<string, object> { ["CaptureFaceDataCond"] = MinimalFields(null) });
        await TryJson("JSON minimal root omit dataType", new Dictionary<string, object> { ["CaptureFaceData"] = MinimalFields(null) });

        await TryXml("XML+person url",
            $@"<?xml version=""1.0"" encoding=""UTF-8""?><CaptureFaceDataCond version=""2.0"" xmlns=""http://www.isapi.org/ver20/XMLSchema""><employeeNo>{esc}</employeeNo><FDID>{escFdid}</FDID><dataType>url</dataType><readerID>{readerId}</readerID><captureInfrared>false</captureInfrared></CaptureFaceDataCond>");
        await TryXml("XML+person omit dataType",
            $@"<?xml version=""1.0"" encoding=""UTF-8""?><CaptureFaceDataCond version=""2.0"" xmlns=""http://www.isapi.org/ver20/XMLSchema""><employeeNo>{esc}</employeeNo><FDID>{escFdid}</FDID><readerID>{readerId}</readerID><captureInfrared>false</captureInfrared></CaptureFaceDataCond>");
        await TryXml("XML+person binary",
            $@"<?xml version=""1.0"" encoding=""UTF-8""?><CaptureFaceDataCond version=""2.0"" xmlns=""http://www.isapi.org/ver20/XMLSchema""><employeeNo>{esc}</employeeNo><FDID>{escFdid}</FDID><dataType>binary</dataType><readerID>{readerId}</readerID><captureInfrared>false</captureInfrared></CaptureFaceDataCond>");
        await TryXml("XML minimal url",
            $"""<?xml version="1.0" encoding="UTF-8"?><CaptureFaceDataCond version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><captureInfrared>false</captureInfrared><dataType>url</dataType><readerID>{readerId}</readerID></CaptureFaceDataCond>""");
        await TryXml("XML minimal binary",
            $"""<?xml version="1.0" encoding="UTF-8"?><CaptureFaceDataCond version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><captureInfrared>false</captureInfrared><dataType>binary</dataType><readerID>{readerId}</readerID></CaptureFaceDataCond>""");
        await TryXml("XML minimal omit dataType",
            $"""<?xml version="1.0" encoding="UTF-8"?><CaptureFaceDataCond version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><captureInfrared>false</captureInfrared><readerID>{readerId}</readerID></CaptureFaceDataCond>""");

        // Enroller / accessories (ISAPI_Access Control Accessories_Enrollers): запуск захвата — multipart/form-data,
        // часть CaptureFace с XML (см. таблицу Parameter Name в доке), не сырой POST application/xml.
        async Task TryMultipart(string label, string path, string xml)
        {
            if (success) return;
            var (ok, c, e) = await client.PostMultipartAsync(path, () => new Dictionary<string, (HttpContent, string?)>
            {
                ["CaptureFace"] = (new StringContent(xml, Encoding.UTF8, "application/xml"), null),
            }, ct);
            logger.LogInformation("[CaptureFace] {Label}: success={S} error={E}", label, ok, e ?? "-");
            if (!ok) return;
            success = true;
            content = c;
            error = e;
        }

        var ns = "http://www.isapi.org/ver20/XMLSchema";
        var mpMinimalUrl =
            $"""<?xml version="1.0" encoding="UTF-8"?><CaptureFaceDataCond version="2.0" xmlns="{ns}"><captureInfrared>false</captureInfrared><dataType>url</dataType><readerID>{readerId}</readerID></CaptureFaceDataCond>""";
        var mpMinimalBinary =
            $"""<?xml version="1.0" encoding="UTF-8"?><CaptureFaceDataCond version="2.0" xmlns="{ns}"><captureInfrared>false</captureInfrared><dataType>binary</dataType><readerID>{readerId}</readerID></CaptureFaceDataCond>""";
        var mpWithPersonUrl =
            $"""<?xml version="1.0" encoding="UTF-8"?><CaptureFaceDataCond version="2.0" xmlns="{ns}"><employeeNo>{esc}</employeeNo><FDID>{escFdid}</FDID><captureInfrared>false</captureInfrared><dataType>url</dataType><readerID>{readerId}</readerID></CaptureFaceDataCond>""";

        await TryMultipart("MP CaptureFace minimal url", "ISAPI/AccessControl/CaptureFaceData", mpMinimalUrl);
        await TryMultipart("MP CaptureFace minimal binary", "ISAPI/AccessControl/CaptureFaceData", mpMinimalBinary);
        await TryMultipart("MP CaptureFace+person url", "ISAPI/AccessControl/CaptureFaceData", mpWithPersonUrl);
        await TryMultipart("MP CaptureFace minimal url ?format=xml", "ISAPI/AccessControl/CaptureFaceData?format=xml", mpMinimalUrl);

        return (success, content, error);
    }

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
