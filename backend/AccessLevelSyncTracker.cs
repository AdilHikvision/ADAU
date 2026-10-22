using System.Collections.Concurrent;
using Backend.Application.Devices;

/// <summary>
/// Реализация реестра активных фоновых записей по уровням доступа (in-memory, singleton).
/// Интерфейс <see cref="IAccessLevelSyncTracker"/> и запись статуса живут в Backend.Application,
/// чтобы к реестру мог обращаться и фоновый сервис очереди из Backend.Infrastructure.
/// </summary>
public sealed class AccessLevelSyncTracker : IAccessLevelSyncTracker
{
    private sealed class Job
    {
        public string Stage = "writing";
        public int Done;
        public int Total;
    }

    private readonly ConcurrentDictionary<Guid, Job> _jobs = new();

    public void Start(Guid accessLevelId, int total, string stage)
        => _jobs[accessLevelId] = new Job { Stage = stage, Total = total, Done = 0 };

    public void SetStage(Guid accessLevelId, string stage, int? total = null)
    {
        if (!_jobs.TryGetValue(accessLevelId, out var job)) return;
        job.Stage = stage;
        if (total.HasValue) { job.Total = total.Value; job.Done = 0; }
    }

    public void Report(Guid accessLevelId, int done)
    {
        if (_jobs.TryGetValue(accessLevelId, out var job)) job.Done = done;
    }

    public void Finish(Guid accessLevelId) => _jobs.TryRemove(accessLevelId, out _);

    public IReadOnlyList<AccessLevelSyncStatus> GetActive()
        => _jobs.Select(kv => new AccessLevelSyncStatus(kv.Key, kv.Value.Stage, kv.Value.Done, kv.Value.Total)).ToList();
}
