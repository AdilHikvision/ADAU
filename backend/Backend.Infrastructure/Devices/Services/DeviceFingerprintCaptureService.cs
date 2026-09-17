using System.Collections.Concurrent;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Xml;
using Backend.Application.Devices;
using Backend.Domain.Entities;
using Backend.Infrastructure.Devices;
using Backend.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Backend.Infrastructure.Devices.Services;

public sealed class DeviceFingerprintCaptureService(
    AppDbContext dbContext,
    IDevicePersonSyncService syncService,
    IServiceScopeFactory scopeFactory,
    DeviceEnrollmentDetector enrollmentDetector,
    EnrollerCaptureService enrollerCapture,
    IConfiguration configuration,
    ILogger<DeviceFingerprintCaptureService> logger) : IDeviceFingerprintCaptureService
{
    private static readonly ConcurrentDictionary<Guid, FpSession> Sessions = new();

    private sealed class FpSession
    {
        public required string EmployeeNo { get; init; }
        public required Guid PersonId { get; init; }
        public required string PersonType { get; init; }
        public required int FingerIndex { get; init; }
        public DateTime StartedUtc { get; init; } = DateTime.UtcNow;
        public string Status { get; set; } = "starting";
        public string? Message { get; set; }
        public Guid? FingerprintId { get; set; }
        /// <summary>Заведён на устройстве только ради захвата (нет уровня доступа) — убрать после завершения.</summary>
        public bool TemporaryOnDevice { get; init; }
    }

    /// <summary>Убрать временно заведённого человека с устройства.</summary>
    private async Task CleanupTemporaryAsync(Guid deviceId, FpSession session, CancellationToken ct)
    {
        if (!session.TemporaryOnDevice) return;
        try { await syncService.DeletePersonFromDeviceAsync(session.EmployeeNo, deviceId, ct); }
        catch (Exception ex) { logger.LogWarning(ex, "Cleanup temporary person {EmployeeNo} from device {DeviceId}", session.EmployeeNo, deviceId); }
    }

    public async Task<DeviceSyncResult> StartCaptureAsync(Guid deviceId, Guid personId, string personType, int fingerIndex, CancellationToken cancellationToken = default)
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
                // Нет уровня доступа → человека на устройство НЕ пишем вовсе: захват отпечатка
                // читается со считывателя (в запросе только fingerNo), пользователь там не нужен.
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
            return enrollerCapture.Start(device, EnrollerCaptureKind.Fingerprint, personId, personType, fingerIndex);

        var fpIndex = Math.Clamp(fingerIndex, 1, 10);
        var session = new FpSession
        {
            EmployeeNo = employeeNo,
            PersonId = personId,
            PersonType = personType,
            FingerIndex = fpIndex,
            Status = "capturing",
            Message = "Приложите палец к считывателю на устройстве...",
            TemporaryOnDevice = temporaryOnDevice
        };
        Sessions[deviceId] = session;

        logger.LogInformation("[CaptureFP] Start device={Device} employeeNo={EmpNo} finger={Idx}",
            device.Name, employeeNo, fpIndex);

        // Run capture in background — CaptureFingerPrint is synchronous (blocks until finger is placed)
        _ = Task.Run(async () =>
        {
            try
            {
                await DoCaptureAsync(deviceId, device, session, CancellationToken.None);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "[CaptureFP] Background capture failed");
                session.Status = "failed";
                session.Message = ex.Message;
            }
            finally
            {
                // Захват окончен (успешно или нет) — временную запись с устройства убираем.
                await CleanupTemporaryAsync(deviceId, session, CancellationToken.None);
            }
        });

        return new DeviceSyncResult(true, null);
    }

    private async Task DoCaptureAsync(Guid deviceId, Device device, FpSession session, CancellationToken ct)
    {
        var client = CreateClient(device);
        var readerId = HikvisionIsapiDefaults.GetReaderId(configuration);

        // POST /ISAPI/AccessControl/CaptureFingerPrint (см. ISAPI Ultra/Pro: обычно fingerNo; часть терминалов — с employeeNo).
        var fingerOnlyXml = $"""<?xml version="1.0" encoding="UTF-8"?><CaptureFingerPrintCond version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><fingerNo>{session.FingerIndex}</fingerNo></CaptureFingerPrintCond>""";
        var esc = global::System.Security.SecurityElement.Escape(session.EmployeeNo);
        var withEmpXml = $"""<?xml version="1.0" encoding="UTF-8"?><CaptureFingerPrintCond version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><employeeNo>{esc}</employeeNo><fingerNo>{session.FingerIndex}</fingerNo></CaptureFingerPrintCond>""";

        logger.LogDebug("[CaptureFP] POST CaptureFingerPrint (fingerNo only)");
        var (ok, content, err) = await client.PostAsync(
            "ISAPI/AccessControl/CaptureFingerPrint", fingerOnlyXml, "application/xml", ct);
        if (!ok && err != null && (err.Contains("dataType", StringComparison.OrdinalIgnoreCase) || err.Contains("Invalid Content", StringComparison.OrdinalIgnoreCase) || err.Contains("badParameters", StringComparison.OrdinalIgnoreCase)))
        {
            logger.LogDebug("[CaptureFP] Retrying CaptureFingerPrint with employeeNo + fingerNo");
            (ok, content, err) = await client.PostAsync(
                "ISAPI/AccessControl/CaptureFingerPrint", withEmpXml, "application/xml", ct);
        }

        if (!ok)
        {
            logger.LogDebug("[CaptureFP] Retrying CaptureFingerPrint multipart (CaptureFingerPrint part)");
            (ok, content, err) = await client.PostMultipartAsync("ISAPI/AccessControl/CaptureFingerPrint", () => new Dictionary<string, (HttpContent, string?)>
            {
                ["CaptureFingerPrint"] = (new StringContent(fingerOnlyXml, Encoding.UTF8, "application/xml"), null),
            }, ct);
        }
        if (!ok)
        {
            (ok, content, err) = await client.PostMultipartAsync("ISAPI/AccessControl/CaptureFingerPrint", () => new Dictionary<string, (HttpContent, string?)>
            {
                ["CaptureFingerPrint"] = (new StringContent(withEmpXml, Encoding.UTF8, "application/xml"), null),
            }, ct);
        }
        logger.LogDebug("[CaptureFP] CaptureFingerPrint result: ok={Ok} content={Content} err={Err}",
            ok, content?.Length > 500 ? content[..500] : content ?? "-", err ?? "-");

        // Сессию не удаляем: итог (в том числе failed) заберёт GetProgressAsync, иначе страница получит «idle» и будет ждать вечно.
        if (!ok)
        {
            session.Status = "failed";
            session.Message = err ?? "Устройство не ответило на запрос захвата отпечатка.";
            return;
        }

        // Parse response — may be plain XML or multipart (XML + image)
        string? fingerData = null;
        int? quality = null;

        if (!string.IsNullOrWhiteSpace(content))
        {
            try
            {
                // If multipart response, extract the XML part
                var xmlContent = ExtractXmlFromContent(content);

                if (xmlContent.TrimStart().StartsWith('<'))
                {
                    var xml = new XmlDocument();
                    xml.LoadXml(xmlContent);
                    var ns = new XmlNamespaceManager(xml.NameTable);
                    ns.AddNamespace("h", "http://www.isapi.org/ver20/XMLSchema");

                    fingerData = XPath(xml, ns, "//h:fingerData") ?? XPath(xml, ns, "//h:FingerData")
                        ?? XPath(xml, ns, "//h:fingerPrintData") ?? XPath(xml, ns, "//h:FingerPrintData");
                    var qStr = XPath(xml, ns, "//h:fingerPrintQuality") ?? XPath(xml, ns, "//h:FingerPrintQuality");
                    if (int.TryParse(qStr, out var q)) quality = q;
                }
                else if (xmlContent.TrimStart().StartsWith('{'))
                {
                    using var doc = JsonDocument.Parse(xmlContent);
                    var root = doc.RootElement;
                    foreach (var prop in new[] { "CaptureFingerPrint", "captureFingerPrint" })
                    {
                        if (!root.TryGetProperty(prop, out var el)) continue;
                        fingerData = TryStr(el, "fingerData", "FingerData", "fingerPrintData", "FingerPrintData");
                        quality = TryInt(el, "fingerPrintQuality", "FingerPrintQuality");
                        break;
                    }
                }
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "[CaptureFP] Failed to parse response");
            }
        }

        if (string.IsNullOrWhiteSpace(fingerData))
        {
            session.Status = "failed";
            session.Message = "Не удалось получить данные отпечатка. Попробуйте ещё раз.";
            return;
        }

        logger.LogInformation("[CaptureFP] Got fingerData len={Len} quality={Q}", fingerData!.Length, quality);

        byte[] templateData;
        try { templateData = Convert.FromBase64String(fingerData.Trim()); }
        catch
        {
            session.Status = "failed";
            session.Message = "Неверный формат данных отпечатка.";
            return;
        }

        if (templateData.Length == 0)
        {
            session.Status = "failed";
            session.Message = "Пустой шаблон отпечатка.";
            return;
        }

        // Save fingerprint to DB — must use a new scope: request-scoped AppDbContext is disposed
        // after StartCaptureAsync returns; background Task.Run must not touch the request context.
        Guid fpId;
        await using (var scope = scopeFactory.CreateAsyncScope())
        {
            var store = scope.ServiceProvider.GetRequiredService<CapturedCredentialStore>();
            fpId = await store.SaveFingerprintAsync(session.PersonId, session.PersonType, session.FingerIndex, templateData, ct);
        }

        // SetUp → Download: второй и следующие пальцы без SetUp часто не принимаются (см. ISAPI Pro 9.12.2.3 / 9.12.2.4)
        var downloadBody = IsapiFingerPrintDownload.BuildJson(session.EmployeeNo, session.FingerIndex, fingerData.Trim(), readerId);
        var (dlOk, dlErr) = await IsapiFingerPrintDownload.TryUploadTemplateAsync(client, downloadBody, ct);
        if (!dlOk)
            logger.LogWarning("[CaptureFP] Fingerprint template upload failed: {Err}. Fingerprint saved to DB only.", dlErr);
        else
            logger.LogInformation("[CaptureFP] Fingerprint template OK for {EmpNo} finger={Idx}", session.EmployeeNo, session.FingerIndex);

        session.Status = "completed";
        session.Message = "Отпечаток успешно захвачен.";
        session.FingerprintId = fpId;
    }

    public Task<FingerprintCaptureProgressResult> GetProgressAsync(Guid deviceId, CancellationToken cancellationToken = default)
    {
        if (enrollerCapture.TryGetProgress(deviceId, EnrollerCaptureKind.Fingerprint, out var enrollerState))
            return Task.FromResult(new FingerprintCaptureProgressResult(enrollerState.Status, enrollerState.Message, enrollerState.ResultId));

        if (!Sessions.TryGetValue(deviceId, out var session))
            return Task.FromResult(new FingerprintCaptureProgressResult("idle", "Сессия захвата не найдена.", null));

        if ((DateTime.UtcNow - session.StartedUtc).TotalSeconds > 120 && session.Status == "capturing")
        {
            session.Status = "failed";
            session.Message = "Таймаут захвата (120 сек). Приложите палец быстрее.";
        }

        var result = new FingerprintCaptureProgressResult(session.Status, session.Message, session.FingerprintId);

        if (session.Status is "completed" or "failed")
            Sessions.TryRemove(deviceId, out _);

        return Task.FromResult(result);
    }

    /// <summary>
    /// Extracts the XML portion from a response that may be multipart form-data.
    /// CaptureFingerPrint response is multipart: XML part + fingerprint image.
    /// </summary>
    private static string ExtractXmlFromContent(string raw)
    {
        var trimmed = raw.TrimStart();
        if (trimmed.StartsWith('<') || trimmed.StartsWith('{'))
            return trimmed;

        // Multipart response — find the XML section between boundaries
        // Look for <?xml or <CaptureFingerPrint
        var xmlStart = raw.IndexOf("<?xml", StringComparison.OrdinalIgnoreCase);
        if (xmlStart < 0)
            xmlStart = raw.IndexOf("<CaptureFingerPrint", StringComparison.OrdinalIgnoreCase);
        if (xmlStart < 0)
            return raw;

        // Find the end of the XML section (next boundary marker --)
        var xmlEnd = raw.IndexOf("\r\n--", xmlStart, StringComparison.Ordinal);
        if (xmlEnd < 0)
            xmlEnd = raw.IndexOf("\n--", xmlStart, StringComparison.Ordinal);
        if (xmlEnd < 0)
            return raw[xmlStart..];

        return raw[xmlStart..xmlEnd].Trim();
    }

    private static string? XPath(XmlDocument xml, XmlNamespaceManager ns, string path) =>
        xml.SelectSingleNode(path, ns)?.InnerText ??
        xml.SelectSingleNode(path.Replace("h:", ""), ns)?.InnerText;

    private static int? TryInt(JsonElement el, params string[] names)
    {
        foreach (var n in names) if (el.TryGetProperty(n, out var p) && p.TryGetInt32(out var v)) return v;
        return null;
    }
    private static string? TryStr(JsonElement el, params string[] names)
    {
        foreach (var n in names) if (el.TryGetProperty(n, out var p)) return p.GetString();
        return null;
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
            TimeSpan.FromSeconds(60));
    }
}
