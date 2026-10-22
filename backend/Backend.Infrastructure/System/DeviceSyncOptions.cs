namespace Backend.Infrastructure.System;

/// <summary>Настройки долговечной очереди записи людей на устройства (этап 1).</summary>
public sealed class DeviceSyncOptions
{
    public const string SectionName = "DeviceSync";

    /// <summary>
    /// true — назначение и перезапись людей на уровень идут через очередь в БД (с resume,
    /// повторами, параллелью по устройствам). false — прежний путь (Task.Run в памяти).
    /// Фиче-флаг для безопасного отката.
    /// </summary>
    public bool UseQueue { get; set; } = false;

    /// <summary>Сколько устройств писать одновременно. У каждого устройства свой воркер
    /// (внутри устройства — по очереди).</summary>
    public int MaxParallelDevices { get; set; } = 44;

    /// <summary>Максимум попыток на один элемент при временных ошибках, прежде чем пометить Failed.</summary>
    public int MaxAttempts { get; set; } = 6;

    /// <summary>Бэкофф повторов (секунды) по номеру попытки; последнее значение используется для всех дальнейших.</summary>
    public int[] RetryBackoffSeconds { get; set; } = [2, 5, 15, 60, 300];

    /// <summary>Пауза (секунды) перед повторной попыткой к офлайн-устройству.</summary>
    public int OfflineRetrySeconds { get; set; } = 60;
}
