namespace Backend.Application.Devices;

/// <summary>
/// Постановка массовой записи/перезаписи людей по уровню доступа в долговечную очередь.
/// Сам прогон выполняет фоновый сервис, поэтому задача переживает рестарт и обрывы и
/// продолжается с места остановки. Возвращает Id задачи (он же syncId для SignalR).
/// </summary>
public interface IDeviceSyncQueue
{
    /// <summary>Назначение: записать указанных людей на устройства уровня.</summary>
    Task<Guid> EnqueueAccessLevelWriteAsync(
        Guid accessLevelId,
        IReadOnlyCollection<Guid> personIds,
        string? createdBy,
        string? syncId = null,
        CancellationToken cancellationToken = default);

    /// <summary>Перезапись: стереть людей с устройств уровня и записать заново.</summary>
    Task<Guid> EnqueueAccessLevelRepushAsync(
        Guid accessLevelId,
        IReadOnlyCollection<Guid> personIds,
        string? createdBy,
        string? syncId = null,
        CancellationToken cancellationToken = default);

    Task PauseAsync(Guid jobId, CancellationToken cancellationToken = default);
    Task ResumeAsync(Guid jobId, CancellationToken cancellationToken = default);
    Task CancelAsync(Guid jobId, CancellationToken cancellationToken = default);
    /// <summary>Вернуть в очередь все Failed-элементы задачи (сброс попыток).</summary>
    Task RetryFailedAsync(Guid jobId, CancellationToken cancellationToken = default);
}
