using Backend.Application.Devices;
using Backend.Domain.Entities;
using Backend.Infrastructure.Persistence;
using Backend.Infrastructure.System;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Backend.Infrastructure.Devices.Services;

/// <summary>
/// Фоновый прогон очереди записи людей на устройства. Берёт задачи по одной (FIFO),
/// на каждое устройство запускает отдельный воркер (внутри устройства — по очереди,
/// устройства — параллельно), повторяет временные ошибки с бэкоффом, ждёт офлайн-устройства,
/// переживает рестарт (при старте возвращает «в работе» → «ожидает»). Прогресс отдаёт через
/// существующий трекер уровней и SignalR, чтобы текущий UI продолжал работать.
/// </summary>
public sealed class DeviceSyncQueueProcessor(
    IServiceScopeFactory scopeFactory,
    IOptions<DeviceSyncOptions> options,
    IAccessLevelSyncTracker tracker,
    IDeviceActivityBroadcaster broadcaster,
    ILogger<DeviceSyncQueueProcessor> logger) : BackgroundService
{
    private readonly DeviceSyncOptions _options = options.Value;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.UseQueue)
        {
            logger.LogInformation("DeviceSyncQueueProcessor: DeviceSync:UseQueue=false — очередь выключена, прежний путь записи.");
            return;
        }

        await ResetInProgressAsync(stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            Guid? jobId = null;
            try
            {
                jobId = await PickNextJobAsync(stoppingToken);
                if (jobId is null)
                {
                    await Task.Delay(TimeSpan.FromSeconds(2), stoppingToken);
                    continue;
                }

                await ProcessJobAsync(jobId.Value, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "DeviceSyncQueueProcessor: ошибка обработки задачи {JobId}", jobId);
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            }
        }
    }

    /// <summary>После рестарта «в работе» → «ожидает»: такие элементы никто уже не пишет.</summary>
    private async Task ResetInProgressAsync(CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        await db.DeviceSyncItems
            .Where(i => i.Status == DeviceSyncItemStatus.InProgress)
            .ExecuteUpdateAsync(s => s.SetProperty(i => i.Status, DeviceSyncItemStatus.Pending), ct);
    }

    private async Task<Guid?> PickNextJobAsync(CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var job = await db.DeviceSyncJobs
            .Where(j => j.Status == DeviceSyncJobStatus.Queued || j.Status == DeviceSyncJobStatus.Running)
            .OrderBy(j => j.CreatedUtc)
            .FirstOrDefaultAsync(ct);
        if (job is null) return null;

        if (job.Status == DeviceSyncJobStatus.Queued)
        {
            job.Status = DeviceSyncJobStatus.Running;
            job.StartedUtc ??= DateTime.UtcNow;
            job.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
        }
        return job.Id;
    }

    private async Task ProcessJobAsync(Guid jobId, CancellationToken ct)
    {
        Guid? accessLevelId;
        string syncId;
        string stage;
        using (var scope = scopeFactory.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var job = await db.DeviceSyncJobs.FirstOrDefaultAsync(j => j.Id == jobId, ct);
            if (job is null) return;
            accessLevelId = job.AccessLevelId;
            syncId = string.IsNullOrEmpty(job.SyncId) ? job.Id.ToString("N") : job.SyncId;
            stage = job.Kind == DeviceSyncJobKind.AccessLevelErase ? "erasing" : "writing";
        }

        if (accessLevelId is Guid alStart)
        {
            var totalPersons = await DistinctPersonCountAsync(jobId, onlyPending: false, ct);
            tracker.Start(alStart, totalPersons, stage);
        }

        // Параллельный прогресс-таймер: пока работают воркеры, раз в несколько секунд
        // обновляет счётчики задачи и трекер уровня (per-item SignalR шлют сами воркеры).
        using var progressCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var progressTask = RunProgressLoopAsync(jobId, accessLevelId, progressCts.Token);

        try
        {
            var deviceIds = await DevicesWithPendingAsync(jobId, ct);
            if (deviceIds.Count > 0)
            {
                await Parallel.ForEachAsync(
                    deviceIds,
                    new ParallelOptions
                    {
                        MaxDegreeOfParallelism = Math.Max(1, Math.Min(_options.MaxParallelDevices, deviceIds.Count)),
                        CancellationToken = ct
                    },
                    async (deviceId, token) => await RunDeviceWorkerAsync(jobId, deviceId, syncId, token));
            }
        }
        finally
        {
            progressCts.Cancel();
            try { await progressTask; } catch { /* прогресс — best-effort */ }
            if (accessLevelId is Guid alEnd) tracker.Finish(alEnd);
        }

        await FinalizeJobAsync(jobId, syncId, ct);
    }

    /// <summary>Воркер одного устройства: крутится, пока его элементы не завершены или
    /// задача не на паузе/отмене. Офлайн-устройство ждёт и пробует снова, не тратя попытки.</summary>
    private async Task RunDeviceWorkerAsync(Guid jobId, Guid deviceId, string syncId, CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var sync = scope.ServiceProvider.GetRequiredService<IDevicePersonSyncService>();

        var deviceName = await db.Devices.AsNoTracking()
            .Where(d => d.Id == deviceId).Select(d => d.Name).FirstOrDefaultAsync(ct) ?? deviceId.ToString();

        var processedSinceStatusCheck = 0;

        while (!ct.IsCancellationRequested)
        {
            if (await IsJobStoppedAsync(db, jobId, ct)) return;

            var now = DateTime.UtcNow;
            var dueIds = await db.DeviceSyncItems.AsNoTracking()
                .Where(i => i.JobId == jobId && i.DeviceId == deviceId
                    && i.Status == DeviceSyncItemStatus.Pending
                    && (i.NextAttemptUtc == null || i.NextAttemptUtc <= now))
                .OrderBy(i => i.Op == DeviceSyncItemOp.Delete ? 0 : 1)
                .ThenBy(i => i.CreatedUtc)
                .Select(i => i.Id)
                .ToListAsync(ct);

            if (dueIds.Count == 0)
            {
                // Есть ли ещё незавершённые, но отложенные (бэкофф/офлайн)?
                var nextAt = await db.DeviceSyncItems.AsNoTracking()
                    .Where(i => i.JobId == jobId && i.DeviceId == deviceId && i.Status == DeviceSyncItemStatus.Pending)
                    .MinAsync(i => (DateTime?)i.NextAttemptUtc, ct);
                if (nextAt is null) return; // ничего не осталось — устройство готово
                var wait = nextAt.Value - DateTime.UtcNow;
                if (wait < TimeSpan.FromSeconds(1)) wait = TimeSpan.FromSeconds(1);
                if (wait > TimeSpan.FromSeconds(30)) wait = TimeSpan.FromSeconds(30);
                await Task.Delay(wait, ct);
                continue;
            }

            // Проверяем связь один раз на пачку: молчащее устройство иначе съело бы таймаут на каждом.
            var answering = await sync.FilterAnsweringDevicesAsync([deviceId], ct);
            if (answering.Count == 0)
            {
                var next = DateTime.UtcNow.AddSeconds(_options.OfflineRetrySeconds);
                await db.DeviceSyncItems
                    .Where(i => i.JobId == jobId && i.DeviceId == deviceId && i.Status == DeviceSyncItemStatus.Pending)
                    .ExecuteUpdateAsync(s => s.SetProperty(i => i.NextAttemptUtc, next), ct);
                await broadcaster.NotifyPersonSyncProgressAsync(
                    syncId, "skipped", 0, 0, deviceId, deviceName, "Офлайн — ждём", ct);
                await Task.Delay(TimeSpan.FromSeconds(Math.Min(_options.OfflineRetrySeconds, 30)), ct);
                continue;
            }

            foreach (var itemId in dueIds)
            {
                if (ct.IsCancellationRequested) return;
                if (processedSinceStatusCheck++ >= 25)
                {
                    processedSinceStatusCheck = 0;
                    if (await IsJobStoppedAsync(db, jobId, ct)) return;
                }

                db.ChangeTracker.Clear();
                var item = await db.DeviceSyncItems.FirstOrDefaultAsync(i => i.Id == itemId, ct);
                if (item is null || item.Status != DeviceSyncItemStatus.Pending) continue;

                item.Status = DeviceSyncItemStatus.InProgress;
                item.Attempts++;
                item.LastAttemptUtc = DateTime.UtcNow;
                await db.SaveChangesAsync(ct);

                bool ok;
                string? err;
                try
                {
                    (ok, err) = item.Op == DeviceSyncItemOp.Delete
                        ? await DeleteAsync(sync, item, ct)
                        : await UpsertAsync(sync, db, item, ct);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    item.Status = DeviceSyncItemStatus.Pending;
                    await db.SaveChangesAsync(CancellationToken.None);
                    return;
                }
                catch (Exception ex)
                {
                    ok = false;
                    err = ex.Message;
                }

                if (ok)
                {
                    item.Status = DeviceSyncItemStatus.Done;
                    item.LastError = null;
                }
                else if (IsTransient(err) && item.Attempts < _options.MaxAttempts)
                {
                    item.Status = DeviceSyncItemStatus.Pending;
                    item.NextAttemptUtc = DateTime.UtcNow.Add(BackoffFor(item.Attempts));
                    item.LastError = Trim(err, 1024);
                }
                else
                {
                    item.Status = DeviceSyncItemStatus.Failed;
                    item.LastError = Trim(err, 1024);
                }
                item.UpdatedUtc = DateTime.UtcNow;
                await db.SaveChangesAsync(ct);

                await broadcaster.NotifyPersonSyncProgressAsync(
                    syncId,
                    item.Status == DeviceSyncItemStatus.Done ? "done"
                        : item.Status == DeviceSyncItemStatus.Failed ? "error" : "syncing",
                    0, 0, deviceId, deviceName,
                    item.Status == DeviceSyncItemStatus.Failed ? item.LastError : null,
                    ct);
            }
        }
    }

    private static async Task<(bool Ok, string? Error)> UpsertAsync(
        IDevicePersonSyncService sync, AppDbContext db, DeviceSyncItem item, CancellationToken ct)
    {
        var errs = new List<string>();
        var res = await sync.SyncEmployeeAsync(item.PersonId, item.DeviceId, ct);
        var ok = res.Success;
        if (!res.Success && !string.IsNullOrWhiteSpace(res.Message)) errs.Add(res.Message!);

        var faceIds = await db.Faces.AsNoTracking().Where(f => f.EmployeeId == item.PersonId).Select(f => f.Id).ToListAsync(ct);
        foreach (var id in faceIds)
        {
            var r = await sync.SyncFaceAsync(id, item.DeviceId, ct, ensurePerson: false);
            if (!r.Success) { ok = false; if (!string.IsNullOrWhiteSpace(r.Message)) errs.Add("лицо: " + r.Message); }
        }

        var fpIds = await db.Fingerprints.AsNoTracking().Where(f => f.EmployeeId == item.PersonId).Select(f => f.Id).ToListAsync(ct);
        foreach (var id in fpIds)
        {
            var r = await sync.SyncFingerprintAsync(id, item.DeviceId, ct, ensurePerson: false);
            if (!r.Success) { ok = false; if (!string.IsNullOrWhiteSpace(r.Message)) errs.Add("отпечаток: " + r.Message); }
        }

        var cardIds = await db.Cards.AsNoTracking().Where(c => c.EmployeeId == item.PersonId).Select(c => c.Id).ToListAsync(ct);
        foreach (var id in cardIds)
        {
            var r = await sync.SyncCardAsync(id, item.DeviceId, ct, ensurePerson: false);
            if (!r.Success) { ok = false; if (!string.IsNullOrWhiteSpace(r.Message)) errs.Add("карта: " + r.Message); }
        }

        return (ok, errs.Count > 0 ? string.Join("; ", errs.Take(3)) : null);
    }

    private static async Task<(bool Ok, string? Error)> DeleteAsync(
        IDevicePersonSyncService sync, DeviceSyncItem item, CancellationToken ct)
    {
        var res = await sync.DeletePersonFromDeviceAsync(item.EmployeeNo, item.DeviceId, ct);
        return (res.Success, res.Message);
    }

    private async Task<bool> IsJobStoppedAsync(AppDbContext db, Guid jobId, CancellationToken ct)
    {
        var status = await db.DeviceSyncJobs.AsNoTracking()
            .Where(j => j.Id == jobId).Select(j => (DeviceSyncJobStatus?)j.Status).FirstOrDefaultAsync(ct);
        return status is DeviceSyncJobStatus.Paused or DeviceSyncJobStatus.Cancelled or null;
    }

    private async Task<List<Guid>> DevicesWithPendingAsync(Guid jobId, CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return await db.DeviceSyncItems.AsNoTracking()
            .Where(i => i.JobId == jobId && i.Status == DeviceSyncItemStatus.Pending)
            .Select(i => i.DeviceId)
            .Distinct()
            .ToListAsync(ct);
    }

    private async Task<int> DistinctPersonCountAsync(Guid jobId, bool onlyPending, CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var q = db.DeviceSyncItems.AsNoTracking().Where(i => i.JobId == jobId);
        if (onlyPending)
            q = q.Where(i => i.Status == DeviceSyncItemStatus.Pending || i.Status == DeviceSyncItemStatus.InProgress);
        return await q.Select(i => i.PersonId).Distinct().CountAsync(ct);
    }

    private async Task RunProgressLoopAsync(Guid jobId, Guid? accessLevelId, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await Task.Delay(TimeSpan.FromSeconds(4), ct); }
            catch (OperationCanceledException) { break; }
            await UpdateProgressAsync(jobId, accessLevelId, ct);
        }
    }

    private async Task UpdateProgressAsync(Guid jobId, Guid? accessLevelId, CancellationToken ct)
    {
        try
        {
            using var scope = scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

            var grouped = await db.DeviceSyncItems.AsNoTracking()
                .Where(i => i.JobId == jobId)
                .GroupBy(i => i.Status)
                .Select(g => new { Status = g.Key, Count = g.Count() })
                .ToListAsync(ct);

            int CountOf(DeviceSyncItemStatus s) => grouped.Where(g => g.Status == s).Sum(g => g.Count);
            var total = grouped.Sum(g => g.Count);
            var done = CountOf(DeviceSyncItemStatus.Done);
            var failed = CountOf(DeviceSyncItemStatus.Failed);
            var skipped = CountOf(DeviceSyncItemStatus.Skipped);

            var job = await db.DeviceSyncJobs.FirstOrDefaultAsync(j => j.Id == jobId, ct);
            if (job is not null)
            {
                job.TotalItems = total;
                job.DoneItems = done;
                job.FailedItems = failed;
                job.SkippedItems = skipped;
                job.UpdatedUtc = DateTime.UtcNow;
                await db.SaveChangesAsync(ct);
            }

            if (accessLevelId is Guid alId)
            {
                var totalPersons = await db.DeviceSyncItems.AsNoTracking()
                    .Where(i => i.JobId == jobId).Select(i => i.PersonId).Distinct().CountAsync(ct);
                var pendingPersons = await db.DeviceSyncItems.AsNoTracking()
                    .Where(i => i.JobId == jobId && (i.Status == DeviceSyncItemStatus.Pending || i.Status == DeviceSyncItemStatus.InProgress))
                    .Select(i => i.PersonId).Distinct().CountAsync(ct);
                tracker.Report(alId, Math.Max(0, totalPersons - pendingPersons));
            }
        }
        catch (OperationCanceledException) { /* остановка */ }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "DeviceSyncQueueProcessor: не удалось обновить прогресс задачи {JobId}", jobId);
        }
    }

    private async Task FinalizeJobAsync(Guid jobId, string syncId, CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var job = await db.DeviceSyncJobs.FirstOrDefaultAsync(j => j.Id == jobId, ct);
        if (job is null) return;

        // Пауза/отмена — не финализируем: пауза продолжится после Resume, отмена уже помечена.
        if (job.Status is DeviceSyncJobStatus.Paused or DeviceSyncJobStatus.Cancelled) return;

        var pending = await db.DeviceSyncItems.AsNoTracking()
            .CountAsync(i => i.JobId == jobId && (i.Status == DeviceSyncItemStatus.Pending || i.Status == DeviceSyncItemStatus.InProgress), ct);
        if (pending > 0) return; // ещё есть что делать (например, офлайн-устройство) — не закрываем

        var failed = await db.DeviceSyncItems.AsNoTracking()
            .CountAsync(i => i.JobId == jobId && i.Status == DeviceSyncItemStatus.Failed, ct);

        job.Status = failed > 0 ? DeviceSyncJobStatus.CompletedWithErrors : DeviceSyncJobStatus.Completed;
        job.FinishedUtc = DateTime.UtcNow;
        job.UpdatedUtc = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);

        await broadcaster.NotifyPersonSyncProgressAsync(syncId, "complete", 0, 0, Guid.Empty, "", "batch-complete", ct);
    }

    // ───────── Классификация ошибок и бэкофф ─────────

    private static readonly string[] PermanentMarkers =
    [
        "facequality", "face quality", "no face", "noface", "lowfacescore", "image quality",
        "capacity", "memory full", "device is full", "exceed", "not support", "notsupport",
        "неверный логин", "доступ запрещён", "файл изображения не найден"
    ];

    private static bool IsTransient(string? error)
    {
        if (string.IsNullOrWhiteSpace(error)) return true; // неизвестно — считаем временной, но под лимитом попыток
        var e = error.ToLowerInvariant();
        foreach (var m in PermanentMarkers)
            if (e.Contains(m)) return false;
        return true;
    }

    private TimeSpan BackoffFor(int attempts)
    {
        var arr = _options.RetryBackoffSeconds;
        if (arr is null || arr.Length == 0) return TimeSpan.FromSeconds(30);
        var idx = Math.Clamp(attempts - 1, 0, arr.Length - 1);
        return TimeSpan.FromSeconds(arr[idx]);
    }

    private static string? Trim(string? s, int max)
        => string.IsNullOrEmpty(s) ? s : (s.Length <= max ? s : s[..max]);
}
