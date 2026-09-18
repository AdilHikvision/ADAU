namespace Backend.Application.Devices;

/// <summary>
/// Коды сообщений захвата биометрии и карт. Уходят на клиент рядом с текстом сообщения
/// и переводятся там (people.bio.capture.*): сам текст на сервере только русский,
/// а интерфейс бывает на трёх языках. Значения — часть контракта, менять нельзя.
/// </summary>
public static class CaptureMessageCodes
{
    // Общие
    public const string DeviceNotFound = "deviceNotFound";
    public const string EmployeeNotFound = "employeeNotFound";
    public const string VisitorNotFound = "visitorNotFound";
    public const string CustomerNotFound = "customerNotFound";
    public const string SessionNotFound = "sessionNotFound";
    public const string CaptureTimeout = "captureTimeout";

    // Успешный результат
    public const string FaceCaptured = "faceCaptured";
    public const string FaceCapturedNoImage = "faceCapturedNoImage";
    public const string FingerprintCaptured = "fingerprintCaptured";
    public const string CardCaptured = "cardCaptured";

    // Станция регистрации (enroller): подсказки и таймауты
    public const string EnrollerFacePrompt = "enrollerFacePrompt";
    public const string EnrollerCardPrompt = "enrollerCardPrompt";
    public const string EnrollerFingerPrompt = "enrollerFingerPrompt";
    public const string EnrollerFaceTimeout = "enrollerFaceTimeout";
    public const string EnrollerCardTimeout = "enrollerCardTimeout";
    public const string EnrollerFingerTimeout = "enrollerFingerTimeout";
    public const string EnrollerRestarted = "enrollerRestarted";

    // Ошибки по типам учётных данных
    public const string FaceCaptureFailed = "faceCaptureFailed";
    public const string FaceStartFailed = "faceStartFailed";
    public const string CardReadFailed = "cardReadFailed";
    public const string CardNotRead = "cardNotRead";
    public const string CardCaptureUnsupported = "cardCaptureUnsupported";
    public const string FingerprintPrompt = "fingerprintPrompt";
    public const string FingerprintReadFailed = "fingerprintReadFailed";
    public const string FingerprintBadFormat = "fingerprintBadFormat";
    public const string FingerprintEmptyTemplate = "fingerprintEmptyTemplate";
    public const string FingerprintTimeout = "fingerprintTimeout";
    public const string FingerprintNoResponse = "fingerprintNoResponse";
}
