using System.Globalization;
using System.Text.Json;
using Backend.Application.Devices;
using Backend.Domain.Entities;
using Backend.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace Backend.Infrastructure.Devices.Services;

/// <summary>
/// Синхронизация событий ACS (приход/уход) с устройств в <see cref="AttendanceRecord"/> через ISAPI AcsEvent/Search.
/// </summary>
public sealed class AttendanceLogSyncService(
    AppDbContext db,
    IConfiguration configuration,
    ILogger<AttendanceLogSyncService> logger) : IAttendanceLogSyncService
{
    public async Task<AttendanceLogSyncResult> SyncAllDevicesAsync(DateTime fromUtc, DateTime toUtc, CancellationToken cancellationToken)
    {
        if (fromUtc >= toUtc)
            return new AttendanceLogSyncResult(0, 0, ["Некорректный интервал: начало не раньше конца."]);

        var allDevices = await db.Devices.AsNoTracking().ToListAsync(cancellationToken);
        if (allDevices.Count == 0)
            return new AttendanceLogSyncResult(0, 0, ["No registered devices."]);

        // Опрашиваем ВСЕ устройства. Раньше брались только те, у кого статус Connected, но статус
        // строится на ARP: устройства из другой подсети (ARP туда не доходит) и вся Linux-сборка
        // считались офлайн и в синхронизацию не попадали вовсе. Недоступное устройство теперь
        // просто отваливается по таймауту ISAPI и уходит в warnings, а не исключается заранее.
        var devices = allDevices;

        var globalUser = configuration["Hikvision:Username"] ?? "admin";
        var globalPass = (configuration["Hikvision:Password"] ?? "").Trim();
        // Время передаём в формате device-local (с offset), не UTC — это формат, который
        // подтверждённо принимает Hikvision Pro Series (см. живой запрос из web UI).
        // Offset запрашиваем у каждого устройства отдельно через /ISAPI/System/time.

        var warnings = new List<string>();
        var totalAdded = 0;
        var processed = 0;

        logger.LogInformation("LogSync: starting for all {Total} device(s), period {From}..{To}",
            devices.Count, fromUtc, toUtc);

        foreach (var device in devices)
        {
            if (cancellationToken.IsCancellationRequested) break;
            try
            {
                logger.LogInformation("LogSync: querying device '{Name}' ({Ip}:{Port})", device.Name, device.IpAddress, device.Port);
                var stats = await SyncFromDeviceAsync(db, device, globalUser, globalPass, fromUtc, toUtc, cancellationToken, logger);
                totalAdded += stats.Added;
                processed++;
                logger.LogInformation(
                    "LogSync: '{Name}' result — totalEvents={Total}, accessGranted={Granted}, addedToDb={Added}, alreadyExisted={Exists}, matchedEmployees={Matched}, unmatchedEmployeeNos=[{Unmatched}]",
                    device.Name, stats.TotalEvents, stats.Added + stats.AlreadyExists, stats.Added, stats.AlreadyExists,
                    stats.MatchedEmployees, string.Join(",", stats.UnmatchedEmployeeNos.Take(10)));

                // Объясняем что произошло. Если 0 добавлено — пользователь должен понимать почему:
                // устройство пустое, или сотрудник без EmployeeNo, или всё уже было в БД.
                if (stats.Added == 0)
                {
                    var why = stats switch
                    {
                        { TotalEvents: 0 } => "device returned no events for this date range",
                        { UnmatchedEmployees: > 0, MatchedEmployees: 0 } =>
                            $"{stats.TotalEvents} events found, but no employee matched (employeeNo not registered): {string.Join(", ", stats.UnmatchedEmployeeNos.Take(5))}",
                        { AlreadyExists: var existing } when existing == stats.TotalEvents =>
                            $"all {existing} events already saved (no new ones)",
                        _ => $"{stats.TotalEvents} events scanned, {stats.MatchedEmployees} employee(s) matched, {stats.AlreadyExists} already existed"
                    };
                    warnings.Add($"{device.Name}: {why}");
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "LogSync: device error {DeviceId} ({Ip})", device.Id, device.IpAddress);
                warnings.Add($"{device.Name}: {ex.Message}");
            }
        }

        return new AttendanceLogSyncResult(totalAdded, processed, warnings);
    }

    private record SyncStats(int Added, int TotalEvents, int MatchedEmployees, int UnmatchedEmployees, int AlreadyExists, List<string> UnmatchedEmployeeNos);

    private static async Task<SyncStats> SyncFromDeviceAsync(
        AppDbContext db,
        Domain.Entities.Device device,
        string globalUser,
        string globalPass,
        DateTime fromUtc,
        DateTime toUtc,
        CancellationToken cancellationToken,
        ILogger logger)
    {
        var client = new IsapiClient(
            device.IpAddress,
            device.Port,
            string.IsNullOrWhiteSpace(device.Username) ? globalUser : device.Username,
            string.IsNullOrWhiteSpace(device.Password) ? globalPass : device.Password,
            TimeSpan.FromSeconds(60));

        // Получаем offset от устройства, чтобы передать startTime/endTime в его local TZ.
        var tzOffset = TimeSpan.Zero;
        var (timeOk, timeBody, _) = await client.GetAsync("ISAPI/System/time", cancellationToken);
        if (timeOk && !string.IsNullOrWhiteSpace(timeBody))
        {
            var match = global::System.Text.RegularExpressions.Regex.Match(timeBody, @"<localTime>\s*([^<]+?)\s*</localTime>",
                global::System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            if (match.Success && DateTimeOffset.TryParse(match.Groups[1].Value.Trim(),
                CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out var dto))
            {
                tzOffset = dto.Offset;
            }
        }
        var fromStr = new DateTimeOffset(fromUtc, TimeSpan.Zero).ToOffset(tzOffset).ToString("yyyy-MM-ddTHH:mm:sszzz", CultureInfo.InvariantCulture);
        var toStr = new DateTimeOffset(toUtc, TimeSpan.Zero).ToOffset(tzOffset).ToString("yyyy-MM-ddTHH:mm:sszzz", CultureInfo.InvariantCulture);

        // searchID — один на всю сессию. Hikvision использует его для кэширования прошлого
        // запроса; если каждый раз новый, устройство может пересчитывать набор и возвращать
        // непредсказуемые результаты для пагинации.
        var searchId = Guid.NewGuid().ToString("N")[..8];
        // Hikvision web UI использует maxResults=24. Большие значения (500) на части прошивок
        // молча обрезаются, иногда возвращают пусто.
        const int maxBatch = 100;
        var position = 0;
        var addedTotal = 0;
        var totalEvents = 0;
        var matchedEmpIds = new HashSet<Guid>();
        var unmatchedEmpNos = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var alreadyExists = 0;

        // Дедуп ключей в памяти: устройство шлёт дубли (одно событие multiple times через
        // AcsEvent search batches), и UNIQUE constraint(DeviceId, EmployeeNoString, EventTimeUtc)
        // рушит весь SaveChangesAsync. Загружаем существующие ключи для этого устройства/периода
        // и трекаем каждый добавленный в этом sync — так ни один дубль не попадёт в DB.
        var existingKeysList = await db.DeviceAuthLogs.AsNoTracking()
            .Where(r => r.DeviceId == device.Id && r.EventTimeUtc >= fromUtc && r.EventTimeUtc <= toUtc)
            .Select(r => new { r.EmployeeNoString, r.EventTimeUtc })
            .ToListAsync(cancellationToken);
        var existingKeys = new HashSet<(string emp, long ticks)>(
            existingKeysList.Select(x => (x.EmployeeNoString, x.EventTimeUtc.Ticks)));

        while (true)
        {
            var requestBody = JsonSerializer.Serialize(new
            {
                AcsEventCond = new
                {
                    searchID = searchId,
                    searchResultPosition = position,
                    maxResults = maxBatch,
                    // major=0/minor=0: получаем ВСЕ события, фильтруем на нашей стороне.
                    // isAttendanceInfo НЕ используем: оно работает только если на устройстве
                    // включён T&A модуль, что у части прошивок выключено по умолчанию.
                    major = 0,
                    minor = 0,
                    startTime = fromStr,
                    endTime = toStr,
                    timeReverseOrder = true
                }
            });

            logger.LogInformation("LogSync: '{Name}' POST AcsEvent body={Body}", device.Name, requestBody);

            var result = await client.PostJsonAsync(
                "ISAPI/AccessControl/AcsEvent?format=json",
                requestBody,
                cancellationToken);

            if (!result.Success)
            {
                logger.LogWarning("LogSync: '{Name}' POST failed — error={Error}", device.Name, result.Error ?? "(none)");
                break;
            }
            if (string.IsNullOrWhiteSpace(result.Content))
            {
                logger.LogWarning("LogSync: '{Name}' POST returned empty content", device.Name);
                break;
            }

            // Логируем первые 1000 символов ответа — этого хватает увидеть responseStatusStrg,
            // numOfMatches, totalMatches, и хотя бы один пример InfoList элемента.
            var preview = result.Content.Length > 1000 ? result.Content[..1000] + "..." : result.Content;
            logger.LogInformation("LogSync: '{Name}' AcsEvent response (first 1000 chars): {Preview}", device.Name, preview);

            using var doc = JsonDocument.Parse(result.Content);
            var root = doc.RootElement;
            if (!root.TryGetProperty("AcsEvent", out var acsEventEl))
            {
                logger.LogWarning("LogSync: '{Name}' response has no 'AcsEvent' root", device.Name);
                break;
            }
            var status = acsEventEl.TryGetProperty("responseStatusStrg", out var rsEl) ? rsEl.GetString() : null;
            var num = acsEventEl.TryGetProperty("numOfMatches", out var nm) ? nm.GetInt32() : 0;
            var total = acsEventEl.TryGetProperty("totalMatches", out var tm) ? tm.GetInt32() : 0;
            logger.LogInformation("LogSync: '{Name}' status={Status} numOfMatches={Num} totalMatches={Total} position={Pos}",
                device.Name, status ?? "(none)", num, total, position);

            if (!acsEventEl.TryGetProperty("InfoList", out var infoListEl))
            {
                logger.LogWarning("LogSync: '{Name}' AcsEvent has no 'InfoList' (status={Status}) — stopping", device.Name, status ?? "(none)");
                break;
            }

            var batchCount = 0;
            foreach (var ev in infoListEl.EnumerateArray())
            {
                batchCount++;
                totalEvents++;
                if (!ev.TryGetProperty("employeeNoString", out var empNoEl)) continue;
                var empNo = empNoEl.GetString();
                if (string.IsNullOrWhiteSpace(empNo)) continue;

                if (!ev.TryGetProperty("time", out var timeEl)) continue;
                if (!DateTime.TryParse(timeEl.GetString(), null, DateTimeStyles.RoundtripKind, out var eventTime)) continue;
                var eventTimeUtc = eventTime.ToUniversalTime();

                // Только успешная аутентификация. Всё остальное (denied/timeout/door/operation)
                // в attendance не пишется.
                var major = ev.TryGetProperty("major", out var majorEl) ? majorEl.GetUInt32() : 0u;
                var minor = ev.TryGetProperty("minor", out var minorEl) ? minorEl.GetUInt32() : 0u;
                var (devEventType, _) = AcsEventMapper.Classify(major, minor);
                if (devEventType != DeviceEventType.AccessGranted) continue;

                // Имя берём как есть из устройства (если оно его прислало).
                var name = ev.TryGetProperty("name", out var nameEl) ? nameEl.GetString() : null;

                var empKey = empNo.Trim();
                var key = (empKey, eventTimeUtc.Ticks);
                if (!existingKeys.Add(key))
                {
                    alreadyExists++;
                    continue;
                }

                // Tracking matched/unmatched employees only for diagnostics — не блокирует запись.
                var employee = await db.Employees.AsNoTracking().FirstOrDefaultAsync(e => e.EmployeeNo == empKey, cancellationToken);
                if (employee is null) unmatchedEmpNos.Add(empKey);
                else matchedEmpIds.Add(employee.Id);

                db.DeviceAuthLogs.Add(new DeviceAuthLog
                {
                    DeviceId = device.Id,
                    EmployeeNoString = empKey,
                    Name = name,
                    EventTimeUtc = eventTimeUtc,
                    Major = (int)major,
                    Minor = (int)minor
                });
                addedTotal++;
            }

            if (batchCount > 0)
            {
                try
                {
                    await db.SaveChangesAsync(cancellationToken);
                }
                catch (DbUpdateException)
                {
                    // Race с realtime persist (через EventListenerService.IngestAsync) может всё
                    // же добавить запись параллельно. Откатываем tracker, повторяем поштучно.
                    foreach (var entry in db.ChangeTracker.Entries().ToList())
                        entry.State = EntityState.Detached;
                }
            }

            // Hikvision игнорирует maxResults=100 и отдаёт ~30 на страницу. Поэтому критерий
            // конца — это responseStatusStrg != "MORE", а не размер батча.
            if (batchCount == 0) break;
            if (!string.Equals(status, "MORE", StringComparison.OrdinalIgnoreCase)) break;

            position += batchCount;
            if (position > 200_000) break;
        }

        return new SyncStats(addedTotal, totalEvents, matchedEmpIds.Count, unmatchedEmpNos.Count, alreadyExists, unmatchedEmpNos.ToList());
    }
}
