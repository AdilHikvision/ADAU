using Backend.Application.Devices;
using Backend.Domain.Entities;
using Backend.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Backend.Infrastructure.Devices.Services;

/// <summary>
/// Постановка массовой записи/перезаписи людей по уровню доступа в долговечную очередь
/// (таблицы device_sync_jobs / device_sync_items). Прогон выполняет
/// <see cref="DeviceSyncQueueProcessor"/>.
/// </summary>
public sealed class DeviceSyncQueue(AppDbContext dbContext) : IDeviceSyncQueue
{
    private static string ResolveEmployeeNo(Guid id, string? employeeNo)
    {
        var no = !string.IsNullOrWhiteSpace(employeeNo) ? employeeNo.Trim() : id.ToString("N")[..32];
        return no.Length > 32 ? no[..32] : no;
    }

    public Task<Guid> EnqueueAccessLevelWriteAsync(
        Guid accessLevelId, IReadOnlyCollection<Guid> personIds, string? createdBy, string? syncId = null, CancellationToken cancellationToken = default)
        => EnqueueUpsertAsync(DeviceSyncJobKind.AccessLevelWrite, accessLevelId, personIds, createdBy, syncId, force: false, cancellationToken);

    public Task<Guid> EnqueueAccessLevelRepushAsync(
        Guid accessLevelId, IReadOnlyCollection<Guid> personIds, string? createdBy, string? syncId = null, CancellationToken cancellationToken = default)
        => EnqueueUpsertAsync(DeviceSyncJobKind.AccessLevelRepush, accessLevelId, personIds, createdBy, syncId, force: true, cancellationToken);

    private async Task<Guid> EnqueueUpsertAsync(
        DeviceSyncJobKind kind, Guid accessLevelId, IReadOnlyCollection<Guid> personIds, string? createdBy, string? syncId, bool force, CancellationToken cancellationToken)
    {
        var ids = personIds.Distinct().ToList();

        // Устройства уровня: пишем только на них (как в прежнем пути — restrictToDeviceIds).
        var deviceIds = await dbContext.AccessLevelDoors.AsNoTracking()
            .Where(d => d.AccessLevelId == accessLevelId)
            .Select(d => d.DeviceId)
            .Distinct()
            .ToListAsync(cancellationToken);

        var employeeNos = await dbContext.Employees.AsNoTracking()
            .Where(e => ids.Contains(e.Id))
            .Select(e => new { e.Id, e.EmployeeNo })
            .ToDictionaryAsync(e => e.Id, e => ResolveEmployeeNo(e.Id, e.EmployeeNo), cancellationToken);

        var job = new DeviceSyncJob
        {
            Kind = kind,
            Status = DeviceSyncJobStatus.Queued,
            AccessLevelId = accessLevelId,
            SyncId = string.IsNullOrWhiteSpace(syncId) ? Guid.NewGuid().ToString("N") : syncId.Trim(),
            CreatedBy = createdBy,
            Force = force,
            TotalItems = employeeNos.Count * deviceIds.Count,
        };
        dbContext.DeviceSyncJobs.Add(job);
        await dbContext.SaveChangesAsync(cancellationToken);

        if (deviceIds.Count == 0 || employeeNos.Count == 0)
        {
            // Писать некуда/некого — закрываем сразу, чтобы не висела пустая задача.
            job.Status = DeviceSyncJobStatus.Completed;
            job.FinishedUtc = DateTime.UtcNow;
            await dbContext.SaveChangesAsync(cancellationToken);
            return job.Id;
        }

        // Пакетная вставка элементов (person × device). Для тысяч людей это десятки тысяч строк —
        // вставляем чанками с выключенным авто-детектом, чтобы не раздувать время постановки.
        var prevAutoDetect = dbContext.ChangeTracker.AutoDetectChangesEnabled;
        dbContext.ChangeTracker.AutoDetectChangesEnabled = false;
        try
        {
            var buffer = new List<DeviceSyncItem>(capacity: 5000);
            foreach (var personId in ids)
            {
                if (!employeeNos.TryGetValue(personId, out var no)) continue;
                foreach (var deviceId in deviceIds)
                {
                    buffer.Add(new DeviceSyncItem
                    {
                        JobId = job.Id,
                        DeviceId = deviceId,
                        PersonId = personId,
                        EmployeeNo = no,
                        Op = DeviceSyncItemOp.Upsert,
                        Status = DeviceSyncItemStatus.Pending,
                    });
                    if (buffer.Count >= 5000)
                    {
                        dbContext.DeviceSyncItems.AddRange(buffer);
                        await dbContext.SaveChangesAsync(cancellationToken);
                        dbContext.ChangeTracker.Clear();
                        buffer.Clear();
                    }
                }
            }
            if (buffer.Count > 0)
            {
                dbContext.DeviceSyncItems.AddRange(buffer);
                await dbContext.SaveChangesAsync(cancellationToken);
                dbContext.ChangeTracker.Clear();
            }
        }
        finally
        {
            dbContext.ChangeTracker.AutoDetectChangesEnabled = prevAutoDetect;
        }

        return job.Id;
    }

    public async Task PauseAsync(Guid jobId, CancellationToken cancellationToken = default)
    {
        var job = await dbContext.DeviceSyncJobs.FirstOrDefaultAsync(j => j.Id == jobId, cancellationToken);
        if (job is null) return;
        if (job.Status is DeviceSyncJobStatus.Queued or DeviceSyncJobStatus.Running)
        {
            job.Status = DeviceSyncJobStatus.Paused;
            job.UpdatedUtc = DateTime.UtcNow;
            await dbContext.SaveChangesAsync(cancellationToken);
        }
    }

    public async Task ResumeAsync(Guid jobId, CancellationToken cancellationToken = default)
    {
        var job = await dbContext.DeviceSyncJobs.FirstOrDefaultAsync(j => j.Id == jobId, cancellationToken);
        if (job is null) return;
        if (job.Status is DeviceSyncJobStatus.Paused)
        {
            job.Status = DeviceSyncJobStatus.Queued;
            job.UpdatedUtc = DateTime.UtcNow;
            await dbContext.SaveChangesAsync(cancellationToken);
        }
    }

    public async Task CancelAsync(Guid jobId, CancellationToken cancellationToken = default)
    {
        var job = await dbContext.DeviceSyncJobs.FirstOrDefaultAsync(j => j.Id == jobId, cancellationToken);
        if (job is null) return;
        if (job.Status is DeviceSyncJobStatus.Completed or DeviceSyncJobStatus.CompletedWithErrors or DeviceSyncJobStatus.Cancelled)
            return;

        job.Status = DeviceSyncJobStatus.Cancelled;
        job.FinishedUtc = DateTime.UtcNow;
        job.UpdatedUtc = DateTime.UtcNow;
        await dbContext.DeviceSyncItems
            .Where(i => i.JobId == jobId && (i.Status == DeviceSyncItemStatus.Pending || i.Status == DeviceSyncItemStatus.InProgress))
            .ExecuteUpdateAsync(s => s.SetProperty(i => i.Status, DeviceSyncItemStatus.Skipped), cancellationToken);
        await dbContext.SaveChangesAsync(cancellationToken);
    }

    public async Task RetryFailedAsync(Guid jobId, CancellationToken cancellationToken = default)
    {
        var job = await dbContext.DeviceSyncJobs.FirstOrDefaultAsync(j => j.Id == jobId, cancellationToken);
        if (job is null) return;

        var changed = await dbContext.DeviceSyncItems
            .Where(i => i.JobId == jobId && i.Status == DeviceSyncItemStatus.Failed)
            .ExecuteUpdateAsync(s => s
                .SetProperty(i => i.Status, DeviceSyncItemStatus.Pending)
                .SetProperty(i => i.Attempts, 0)
                .SetProperty(i => i.LastError, (string?)null)
                .SetProperty(i => i.NextAttemptUtc, (DateTime?)null), cancellationToken);

        if (changed > 0 && job.Status is DeviceSyncJobStatus.Completed or DeviceSyncJobStatus.CompletedWithErrors)
        {
            job.Status = DeviceSyncJobStatus.Queued;
            job.FinishedUtc = null;
            job.UpdatedUtc = DateTime.UtcNow;
            await dbContext.SaveChangesAsync(cancellationToken);
        }
    }
}
