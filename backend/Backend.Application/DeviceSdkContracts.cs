namespace Backend.Application.Devices;

public enum DeviceConnectivityStatus
{
    Disconnected = 0,
    Connected = 1
}

public enum DeviceEventType
{
    Unknown = 0,
    DoorOpened = 1,
    AccessGranted = 2,
    AccessDenied = 3,
    Heartbeat = 4,
    DoorClosed = 5,
    AuthenticationTimeout = 6,
    /// <summary>Операции на устройстве (ISAPI major 0x3: постановка на охрану, удалённая конфигурация и т.д.).</summary>
    DeviceOperation = 7
}

public sealed record DiscoveredDevice(
    string DeviceIdentifier,
    string Name,
    string IpAddress,
    int Port,
    string? Model,
    string? DeviceType,
    string? MacAddress,
    string? FirmwareVersion,
    bool? IsActivated);

public sealed record DeviceConnection(
    string DeviceIdentifier,
    string IpAddress,
    int Port,
    DeviceConnectivityStatus Status,
    DateTime ConnectedUtc,
    DateTime? LastSeenUtc);

public sealed record DeviceRealtimeStatus(
    string DeviceIdentifier,
    DeviceConnectivityStatus Status,
    DateTime? LastSeenUtc,
    string? StatusMessage = null);

public sealed record DeviceEvent(
    string DeviceIdentifier,
    DeviceEventType EventType,
    DateTime OccurredUtc,
    string Payload,
    string? Summary = null,
    /// <summary>Номер сотрудника на устройстве (employeeNo), если известен из payload или ISAPI.</summary>
    string? EmployeeNo = null,
    /// <summary>Отображаемое имя: из БД или из события устройства.</summary>
    string? PersonName = null,
    /// <summary>Лицо для миниатюры в мониторинге (первое по дате создания у сотрудника).</summary>
    Guid? PrimaryFaceId = null);

public interface IDeviceDiscoveryService
{
    Task<IReadOnlyCollection<DiscoveredDevice>> DiscoverAsync(CancellationToken cancellationToken = default);
    /// <summary>Streaming discovery: вызывает onDevice для каждого найденного устройства по мере поиска.</summary>
    Task DiscoverStreamAsync(Func<DiscoveredDevice, CancellationToken, Task> onDevice, CancellationToken cancellationToken = default);
}

public interface IDeviceConnectionManager
{
    Task<DeviceConnection> ConnectAsync(string deviceIdentifier, string ipAddress, int port, string? username = null, string? password = null, CancellationToken cancellationToken = default);
    Task DisconnectAsync(string deviceIdentifier, CancellationToken cancellationToken = default);
    Task<DeviceRealtimeStatus> GetStatusAsync(string deviceIdentifier, CancellationToken cancellationToken = default);
    Task<IReadOnlyCollection<DeviceRealtimeStatus>> GetStatusesAsync(CancellationToken cancellationToken = default);
    Task TouchHeartbeatAsync(string deviceIdentifier, DateTime occurredUtc, CancellationToken cancellationToken = default);
    Task MarkStaleConnectionsOfflineAsync(TimeSpan staleAfter, CancellationToken cancellationToken = default);
    Task<IReadOnlyCollection<DeviceConnection>> GetActiveConnectionsAsync(CancellationToken cancellationToken = default);
}

public interface IEventListenerService
{
    Task<IReadOnlyCollection<DeviceEvent>> ReadRecentEventsAsync(int take = 100, CancellationToken cancellationToken = default);
    /// <summary>Публикует событие в буфер и в SignalR (ISAPI alertStream, тесты и т.д.).</summary>
    void Publish(DeviceEvent deviceEvent);
}

public interface IDeviceStatusBroadcaster
{
    Task NotifyStatusChangedAsync(Guid deviceId, string deviceIdentifier, string status, DateTime? lastSeenUtc, string? statusMessage = null, CancellationToken cancellationToken = default);
}

public interface IDeviceActivityBroadcaster
{
    Task NotifyLiveEventAsync(DeviceEvent deviceEvent, CancellationToken cancellationToken = default);

    /// <summary>
    /// Push a progress update for a person→devices sync operation. The frontend listens on
    /// the same SignalR hub and matches by <paramref name="syncId"/> to render a progress bar
    /// (current device, current/total, status text). Stage values: "syncing", "skipped",
    /// "done", "error", "complete".
    /// </summary>
    Task NotifyPersonSyncProgressAsync(
        string syncId,
        string stage,
        int current,
        int total,
        Guid deviceId,
        string deviceName,
        string? message,
        CancellationToken cancellationToken = default);
}

public interface IDeviceArpStatusService
{
    Task<DeviceRealtimeStatus?> GetStatusAsync(string deviceIdentifier, CancellationToken cancellationToken = default);
    Task<IReadOnlyCollection<DeviceRealtimeStatus>> GetStatusesAsync(CancellationToken cancellationToken = default);
}

public sealed record DeviceDoor(Guid DeviceId, string DeviceName, int DoorIndex, string? DoorName, string? Status, bool IsElevator);

public interface IDeviceDoorService
{
    Task<IReadOnlyCollection<DeviceDoor>> GetDoorsAsync(Guid? deviceId, CancellationToken cancellationToken = default);
}

/// <summary>Режим управления дверью: открыть, закрыть, всегда открыта, всегда закрыта; вызов лифта (ISAPI Pro).</summary>
public enum DoorControlAction
{
    Open,
    Close,
    AlwaysOpen,
    AlwaysClose,
    /// <summary>visitorCallLadder — вызов лифта (посетитель).</summary>
    VisitorCallLadder,
    /// <summary>householdCallLadder — вызов лифта (жилец), нужны callNumber и callElevatorType.</summary>
    HouseholdCallLadder
}

public interface IDeviceDoorControlService
{
    /// <summary>Выполняет действие над дверью или лифтом (см. <see cref="DoorControlAction"/>).</summary>
    Task<(bool Success, string? Message)> ControlDoorAsync(
        Guid deviceId,
        int doorIndex,
        DoorControlAction action,
        int? callNumber = null,
        string? callElevatorType = null,
        CancellationToken cancellationToken = default);
}

/// <summary>Результат синхронизации Person/Card/Face/Fingerprint на устройство.</summary>
/// <summary>MessageCode — необязательный ключ локализации для Message (см. CaptureMessageCodes).
/// Заполняется там, где сообщение видит пользователь; остальные вызовы не меняются.</summary>
public sealed record DeviceSyncResult(bool Success, string? Message, string? MessageCode = null);

public interface IDevicePersonSyncService
{
    /// <summary>Синхронизирует сотрудника на устройство (UserInfo Record).</summary>
    Task<DeviceSyncResult> SyncEmployeeAsync(Guid employeeId, Guid deviceId, CancellationToken cancellationToken = default);
    /// <summary>Синхронизирует посетителя на устройство (UserInfo Record).</summary>
    Task<DeviceSyncResult> SyncVisitorAsync(Guid visitorId, Guid deviceId, CancellationToken cancellationToken = default);
    /// <summary>Синхронизирует клиента зала на устройство как custom-пользователя (userType "custom1").</summary>
    Task<DeviceSyncResult> SyncGymCustomerAsync(Guid customerId, Guid deviceId, CancellationToken cancellationToken = default);
    /// <summary>Удаляет клиента зала с устройства.</summary>
    Task<DeviceSyncResult> DeleteGymCustomerAsync(Guid customerId, Guid deviceId, CancellationToken cancellationToken = default);
    /// <summary>Синхронизирует карту на устройство (CardInfo Record).</summary>
    Task<DeviceSyncResult> SyncCardAsync(Guid cardId, Guid deviceId, CancellationToken cancellationToken = default);
    /// <summary>Синхронизирует лицо на устройство (FDLib pictureUpload).</summary>
    Task<DeviceSyncResult> SyncFaceAsync(Guid faceId, Guid deviceId, CancellationToken cancellationToken = default);
    /// <summary>Синхронизирует отпечаток на устройство (FingerPrint/SetUp с запасом FingerPrintDownload).</summary>
    Task<DeviceSyncResult> SyncFingerprintAsync(Guid fingerprintId, Guid deviceId, CancellationToken cancellationToken = default);
    /// <summary>Удаляет карту с устройства. employeeNo — person ID на терминале (как при синхронизации), часть прошивок требует в теле Delete.</summary>
    Task<DeviceSyncResult> DeleteCardFromDeviceAsync(string cardNo, Guid deviceId, string? employeeNo = null, CancellationToken cancellationToken = default);
    /// <summary>Удаляет лицо с устройства.</summary>
    Task<DeviceSyncResult> DeleteFaceFromDeviceAsync(Guid faceId, Guid deviceId, CancellationToken cancellationToken = default);
    /// <summary>Удаляет отпечаток с устройства (нужен Id записи — подгружается полный UserInfo как при синхронизации).</summary>
    Task<DeviceSyncResult> DeleteFingerprintFromDeviceAsync(Guid fingerprintId, Guid deviceId, CancellationToken cancellationToken = default);
    /// <summary>Удаляет пользователя (Person) с устройства по employeeNo.</summary>
    Task<DeviceSyncResult> DeletePersonFromDeviceAsync(string employeeNo, Guid deviceId, CancellationToken cancellationToken = default);
}

/// <summary>Результат захвата лица с устройства.
/// MessageCode — ключ для локализации на клиенте; Message остаётся человекочитаемым запасным
/// вариантом и для логов, поэтому старые клиенты продолжают работать.</summary>
public sealed record FaceCaptureProgressResult(string Status, int? Progress, string? Message, Guid? FaceId, string? MessageCode = null);

/// <summary>Захват лица с устройства Hikvision (CaptureFaceData).</summary>
public interface IDeviceFaceCaptureService
{
    /// <summary>Запускает захват лица на устройстве.</summary>
    Task<DeviceSyncResult> StartCaptureAsync(Guid deviceId, Guid personId, string personType, CancellationToken cancellationToken = default);
    /// <summary>Получает прогресс захвата и при успехе сохраняет лицо в БД.</summary>
    Task<FaceCaptureProgressResult> GetProgressAsync(Guid deviceId, CancellationToken cancellationToken = default);
}

/// <summary>Результат захвата карты с устройства.</summary>
public sealed record CardCaptureProgressResult(string Status, string? Message, Guid? CardId, string? MessageCode = null);

/// <summary>Захват карты с устройства Hikvision (CaptureCardData / ReadCard).</summary>
public interface IDeviceCardCaptureService
{
    Task<DeviceSyncResult> StartCaptureAsync(Guid deviceId, Guid personId, string personType, CancellationToken cancellationToken = default);
    Task<CardCaptureProgressResult> GetProgressAsync(Guid deviceId, CancellationToken cancellationToken = default);
}

/// <summary>Результат захвата отпечатка с устройства.</summary>
public sealed record FingerprintCaptureProgressResult(string Status, string? Message, Guid? FingerprintId, string? MessageCode = null);

/// <summary>Захват отпечатка с устройства Hikvision (CaptureFingerData).</summary>
public interface IDeviceFingerprintCaptureService
{
    Task<DeviceSyncResult> StartCaptureAsync(Guid deviceId, Guid personId, string personType, int fingerIndex, CancellationToken cancellationToken = default);
    Task<FingerprintCaptureProgressResult> GetProgressAsync(Guid deviceId, CancellationToken cancellationToken = default);
}

/// <summary>Пользователь, полученный с устройства Hikvision (UserInfo Search).</summary>
public sealed record ImportedUser(
    string EmployeeNo,
    string Name,
    string? GivenName,
    string? FamilyName,
    int Type,
    string? UserType,
    string? Gender,
    string? ValidBeginTime,
    string? ValidEndTime,
    bool OnlyVerify,
    Guid SourceDeviceId,
    string SourceDeviceName,
    /// <summary>Сырой JSON одной записи UserInfo из ответа списка (faceURL, numOfCard, FPInfo, cardNo и т.д.).</summary>
    string? UserInfoSnapshotJson = null)
{
    public List<ImportedCard> Cards { get; init; } = [];
    public List<ImportedFace> Faces { get; init; } = [];
    public List<ImportedFingerprint> Fingerprints { get; init; } = [];
    public List<ImportedIris> Irises { get; init; } = [];
}

public sealed record ImportedCard(string CardNo, string? CardType);
public sealed record ImportedFace(byte[] ImageData, int FDID);
public sealed record ImportedFingerprint(int FingerPrintID, byte[] TemplateData);
public sealed record ImportedIris(int IrisID, byte[] TemplateData);

/// <summary>Результат импорта пользователей с устройств.</summary>
public sealed record PersonImportResult(
    int ImportedCount,
    int SkippedCount,
    int ErrorCount,
    IReadOnlyCollection<PersonImportItem> Items);

public sealed record PersonImportItem(
    string EmployeeNo,
    string Name,
    Guid DeviceId,
    string DeviceName,
    bool Success,
    string? Message,
    /// <summary>Импортировано карт с устройства в БД (0, если не удалось или не было).</summary>
    int CardsImported = 0,
    /// <summary>Импортировано файлов лиц (0 или 1).</summary>
    int FacesImported = 0,
    /// <summary>Импортировано шаблонов отпечатков.</summary>
    int FingerprintsImported = 0,
    /// <summary>Импортировано шаблонов радужки.</summary>
    int IrisesImported = 0);

public interface IDevicePersonImportService
{
    /// <summary>Получает список пользователей с устройства через ISAPI UserInfo Search.</summary>
    Task<IReadOnlyCollection<ImportedUser>> FetchUsersFromDeviceAsync(Guid deviceId, CancellationToken cancellationToken = default);
    /// <summary>Импортирует пользователей с выбранных устройств в БД (создаёт Employee или Visitor).</summary>
    Task<PersonImportResult> ImportFromDevicesAsync(IReadOnlyCollection<Guid> deviceIds, Guid? companyId = null, CancellationToken cancellationToken = default);
}

/// <summary>Текущее состояние времени и часового пояса на устройстве (ISAPI /System/time).</summary>
public sealed record DeviceTimeInfo(
    Guid DeviceId,
    string DeviceName,
    bool Online,
    string? TimeMode,
    DateTimeOffset? LocalTime,
    string? TimeZone,
    string? Message);

/// <summary>Результат синхронизации времени и часового пояса на одно устройство.</summary>
public sealed record DeviceTimeSyncResult(
    Guid DeviceId,
    string DeviceName,
    bool Success,
    string? Message);

public interface IDeviceLocalizationService
{
    /// <summary>Читает текущие параметры времени с устройства (GET /ISAPI/System/time).</summary>
    Task<DeviceTimeInfo> GetDeviceTimeAsync(Guid deviceId, CancellationToken cancellationToken = default);

    /// <summary>Принудительно выставляет на устройство ручное время (UTC) и часовой пояс в формате POSIX (например, "AZT-4:00:00").</summary>
    Task<DeviceTimeSyncResult> SyncDeviceAsync(Guid deviceId, DateTime serverUtcNow, string posixTimeZone, CancellationToken cancellationToken = default);

    /// <summary>Синхронизирует время и часовой пояс со всеми устройствами.</summary>
    Task<IReadOnlyList<DeviceTimeSyncResult>> SyncAllDevicesAsync(DateTime serverUtcNow, string posixTimeZone, CancellationToken cancellationToken = default);
}
