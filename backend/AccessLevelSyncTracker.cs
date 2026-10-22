using System.Collections.Concurrent;

/// <summary>
/// Серверный реестр активных фоновых записей людей на устройства по уровням доступа.
/// Прогресс по SignalR привязан к syncId текущей вкладки и после перелогина/в другой
/// сессии недоступен; этот реестр хранит статус на сервере, чтобы любая сессия видела,
/// что по уровню идёт запись (и показывала это на карточке вместо числа людей).
/// </summary>
public interface IAccessLevelSyncTracker
{
    /// <summary>Начать задачу по уровню: стадия ("erasing"/"writing") и ожидаемое число людей.</summary>
    void Start(Guid accessLevelId, int total, string stage);
    /// <summary>Сменить стадию; при указании total счётчик сбрасывается на 0.</summary>
    void SetStage(Guid accessLevelId, string stage, int? total = null);
    /// <summary>Сколько людей уже обработано.</summary>
    void Report(Guid accessLevelId, int done);
    /// <summary>Завершить задачу (убрать из реестра).</summary>
    void Finish(Guid accessLevelId);
    /// <summary>Снимок всех активных задач.</summary>
    IReadOnlyList<AccessLevelSyncStatus> GetActive();
}

public sealed record AccessLevelSyncStatus(Guid AccessLevelId, string Stage, int Done, int Total);

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
