using System.Collections.Concurrent;
using Backend.Application.Devices;
using Backend.Domain.Entities;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Backend.Infrastructure.Devices.Services;

public enum EnrollerCaptureKind
{
    Face,
    Fingerprint,
    Card,
}

/// <param name="Status">capturing | completed | failed — тот же словарь, что у захвата с терминалов.</param>
public sealed record EnrollerCaptureState(string Status, string? Message, Guid? ResultId, string? MessageCode = null);

/// <summary>
/// Захват лица, отпечатка и карты на станции регистрации (DS-K1F…). Запросы станции блокирующие,
/// поэтому захват идёт в фоне, а страница опрашивает состояние через обычный /capture/progress.
/// На станцию человек не пишется: результат сразу сохраняется в базу.
/// </summary>
public sealed class EnrollerCaptureService(
    EnrollerIsapiCapture isapi,
    IServiceScopeFactory scopeFactory,
    IConfiguration configuration,
    ILogger<EnrollerCaptureService> logger)
{
    /// <summary>Столько же ждут захват с терминала.</summary>
    private static readonly TimeSpan SessionTimeout = TimeSpan.FromSeconds(120);
    private static readonly TimeSpan RetryDelay = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan ProgressPollInterval = TimeSpan.FromSeconds(1);

    private readonly ConcurrentDictionary<Guid, Session> _sessions = new();

    private sealed class Session(EnrollerCaptureKind kind, string prompt, string promptCode)
    {
        public EnrollerCaptureKind Kind { get; } = kind;
        public string Prompt { get; } = prompt;
        public string PromptCode { get; } = promptCode;
        public CancellationTokenSource Cancellation { get; } = new(SessionTimeout);
        public volatile EnrollerCaptureState State = new("capturing", prompt, null, promptCode);
        public volatile bool Superseded;
    }

    /// <summary>Запускает захват в фоне. Незавершённый захват на этой же станции прерывается.</summary>
    public DeviceSyncResult Start(Device device, EnrollerCaptureKind kind, Guid personId, string personType, int fingerIndex = 1)
    {
        IsapiClient client;
        try
        {
            client = CreateClient(device);
        }
        catch (ArgumentException ex)
        {
            return new DeviceSyncResult(false, ex.Message);
        }

        var session = new Session(kind,
            kind switch
            {
                EnrollerCaptureKind.Face => "Посмотрите в камеру станции регистрации…",
                EnrollerCaptureKind.Fingerprint => "Приложите палец к сканеру станции регистрации…",
                _ => "Приложите карту к считывателю станции регистрации…",
            },
            kind switch
            {
                EnrollerCaptureKind.Face => CaptureMessageCodes.EnrollerFacePrompt,
                EnrollerCaptureKind.Fingerprint => CaptureMessageCodes.EnrollerFingerPrompt,
                _ => CaptureMessageCodes.EnrollerCardPrompt,
            });

        if (_sessions.TryGetValue(device.Id, out var previous))
        {
            previous.Superseded = true;
            try { previous.Cancellation.Cancel(); }
            catch (ObjectDisposedException) { /* предыдущий захват уже завершился */ }
        }
        _sessions[device.Id] = session;

        logger.LogInformation("[Enroller] Start {Kind} on {Device} ({Ip}) for {PersonType} {PersonId}",
            kind, device.Name, device.IpAddress, personType, personId);

        var deviceName = device.Name;
        _ = Task.Run(() => RunAsync(session, client, deviceName, personId, personType, Math.Clamp(fingerIndex, 1, 10)));
        return new DeviceSyncResult(true, null);
    }

    /// <summary>Состояние захвата этого вида на станции; false — такого захвата нет (устройство не станция или сессия уже отдана).</summary>
    public bool TryGetProgress(Guid deviceId, EnrollerCaptureKind kind, out EnrollerCaptureState state)
    {
        state = null!;
        if (!_sessions.TryGetValue(deviceId, out var session) || session.Kind != kind)
            return false;

        state = session.State;
        if (state.Status != "capturing")
            _sessions.TryRemove(KeyValuePair.Create(deviceId, session));
        return true;
    }

    private async Task RunAsync(Session session, IsapiClient client, string deviceName, Guid personId, string personType, int fingerIndex)
    {
        var ct = session.Cancellation.Token;
        try
        {
            session.State = session.Kind switch
            {
                EnrollerCaptureKind.Face => await CaptureFaceAsync(session, client, personId, personType, ct),
                EnrollerCaptureKind.Fingerprint => await CaptureFingerprintAsync(session, client, personId, personType, fingerIndex, ct),
                _ => await CaptureCardAsync(session, client, personId, personType, ct),
            };
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            session.State = session.Superseded
                ? Failed("Захват прерван: на станции запущен новый захват.", CaptureMessageCodes.EnrollerRestarted)
                : session.Kind switch
                {
                    EnrollerCaptureKind.Face => Failed("Время ожидания истекло: лицо не было захвачено станцией регистрации.", CaptureMessageCodes.EnrollerFaceTimeout),
                    EnrollerCaptureKind.Fingerprint => Failed("Время ожидания истекло: палец не был приложен к сканеру.", CaptureMessageCodes.EnrollerFingerTimeout),
                    _ => Failed("Время ожидания истекло: карта не была приложена к считывателю.", CaptureMessageCodes.EnrollerCardTimeout),
                };
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "[Enroller] {Kind} capture on {Device} failed", session.Kind, deviceName);
            session.State = Failed(ex.Message);
        }
        finally
        {
            logger.LogInformation("[Enroller] {Kind} on {Device}: {Status} {Message}",
                session.Kind, deviceName, session.State.Status, session.State.Message ?? "-");
            session.Cancellation.Dispose();
        }
    }

    private async Task<EnrollerCaptureState> CaptureFaceAsync(Session session, IsapiClient client, Guid personId, string personType, CancellationToken ct)
    {
        var result = await WaitForCaptureAsync(session,
            token => isapi.CaptureFaceAsync(client, token),
            token => isapi.GetFaceProgressAsync(client, token),
            ct);
        if (result.Outcome != EnrollerCallOutcome.Captured)
            return Failed(result.Message ?? "Не удалось захватить лицо.", CaptureMessageCodes.FaceCaptureFailed);

        await using var scope = scopeFactory.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredService<CapturedCredentialStore>();
        var faceId = await store.SaveFaceAsync(personId, personType, result.Data!, CancellationToken.None);
        return new EnrollerCaptureState("completed", "Лицо захвачено. Сохраните профиль для синхронизации с устройствами.", faceId, CaptureMessageCodes.FaceCaptured);
    }

    private async Task<EnrollerCaptureState> CaptureFingerprintAsync(Session session, IsapiClient client, Guid personId, string personType, int fingerIndex, CancellationToken ct)
    {
        var result = await WaitForCaptureAsync(session,
            token => isapi.CaptureFingerprintAsync(client, fingerIndex, token),
            progress: null,
            ct);
        if (result.Outcome != EnrollerCallOutcome.Captured)
            return Failed(result.Message ?? "Не удалось получить данные отпечатка.", CaptureMessageCodes.FingerprintReadFailed);

        await using var scope = scopeFactory.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredService<CapturedCredentialStore>();
        var fingerprintId = await store.SaveFingerprintAsync(personId, personType, fingerIndex, result.Data!, CancellationToken.None);
        return new EnrollerCaptureState("completed", "Отпечаток успешно захвачен.", fingerprintId, CaptureMessageCodes.FingerprintCaptured);
    }

    private async Task<EnrollerCaptureState> CaptureCardAsync(Session session, IsapiClient client, Guid personId, string personType, CancellationToken ct)
    {
        var readerId = HikvisionIsapiDefaults.GetReaderId(configuration);
        var result = await WaitForCaptureAsync(session,
            token => isapi.CaptureCardAsync(client, readerId, token),
            progress: null,
            ct);
        if (result.Outcome != EnrollerCallOutcome.Captured)
            return Failed(result.Message ?? "Не удалось считать карту.", CaptureMessageCodes.CardReadFailed);

        await using var scope = scopeFactory.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredService<CapturedCredentialStore>();
        var (success, error, cardId) = await store.SaveCardAsync(personId, personType, result.Data!, CancellationToken.None);
        return success
            ? new EnrollerCaptureState("completed", "Карта успешно считана и добавлена.", cardId, CaptureMessageCodes.CardCaptured)
            : Failed(error);
    }

    /// <summary>
    /// Повторяет запрос, пока станция не отдаст данные или окончательную ошибку: истёкший таймаут станции (captureTimeout)
    /// и занятость — не повод прерывать сессию, человек может подойти позже. Предел — общий таймаут сессии.
    /// </summary>
    private static async Task<EnrollerCallResult<T>> WaitForCaptureAsync<T>(
        Session session,
        Func<CancellationToken, Task<EnrollerCallResult<T>>> start,
        Func<CancellationToken, Task<EnrollerCallResult<T>>>? progress,
        CancellationToken ct) where T : class
    {
        while (true)
        {
            ct.ThrowIfCancellationRequested();
            session.State = session.State with { Message = session.Prompt, MessageCode = session.PromptCode };

            var result = await start(ct);
            while (result.Outcome == EnrollerCallOutcome.Pending && progress is not null)
            {
                await Task.Delay(ProgressPollInterval, ct);
                var polled = await progress(ct);
                if (polled.Outcome == EnrollerCallOutcome.Rejected)
                    break;
                result = polled;
            }

            if (result.Outcome is EnrollerCallOutcome.Captured or EnrollerCallOutcome.Failed or EnrollerCallOutcome.Rejected)
                return result;

            if (!string.IsNullOrEmpty(result.Message))
                session.State = session.State with { Message = result.Message };
            await Task.Delay(RetryDelay, ct);
        }
    }

    private static EnrollerCaptureState Failed(string? message, string? code = null) => new("failed", message, null, code);

    /// <summary>Таймаут HTTP равен сессии: запрос станции висит, пока человек не предъявит лицо, палец или карту.</summary>
    private IsapiClient CreateClient(Device device)
    {
        var username = configuration["Hikvision:Username"] ?? "admin";
        var password = (configuration["Hikvision:Password"] ?? "").Trim();
        if (string.IsNullOrEmpty(password)) password = "12345";
        return new IsapiClient(
            device.IpAddress, device.Port,
            string.IsNullOrWhiteSpace(device.Username) ? username : device.Username,
            string.IsNullOrWhiteSpace(device.Password) ? password : device.Password,
            SessionTimeout);
    }
}
