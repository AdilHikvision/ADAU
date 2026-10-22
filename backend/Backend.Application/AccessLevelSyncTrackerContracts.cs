namespace Backend.Application.Devices;

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
