using System.Text;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;
using Microsoft.Extensions.Logging;

namespace Backend.Infrastructure.Devices;

/// <summary>Чем закончилось одно обращение к станции регистрации.</summary>
public enum EnrollerCallOutcome
{
    /// <summary>Данные получены.</summary>
    Captured,
    /// <summary>Захват запущен, но результата в ответе нет — нужно опросить прогресс.</summary>
    Pending,
    /// <summary>Человек не успел (captureTimeout), устройство занято или ответ пустой — запрос стоит повторить.</summary>
    Retry,
    /// <summary>Прошивка отклонила формат запроса — стоит попробовать другой вариант из документации.</summary>
    Rejected,
    /// <summary>Окончательная ошибка: качество, авторизация, сеть.</summary>
    Failed,
}

/// <param name="Data">Не null только при <see cref="EnrollerCallOutcome.Captured"/>.</param>
public sealed record EnrollerCallResult<T>(EnrollerCallOutcome Outcome, T? Data, string? Message) where T : class;

/// <summary>
/// Сбор учётных данных на станции регистрации DS-K1F… по «ISAPI Access Control Accessories — Enrollers», §7.3.
/// Запросы блокирующие: станция отвечает, когда человек предъявил лицо/палец/карту или истёк её таймаут (captureTimeout).
/// Запрос — обычный XML/GET; multipart (XML + JPEG) бывает только в ответе.
/// </summary>
public sealed class EnrollerIsapiCapture(ILogger<EnrollerIsapiCapture> logger)
{
    private const string IsapiNamespace = "http://www.isapi.org/ver20/XMLSchema";

    private sealed record Part(string Name, byte[] Body);

    /// <summary>§7.3.2.1 POST /ISAPI/AccessControl/CaptureFaceData.</summary>
    public async Task<EnrollerCallResult<byte[]>> CaptureFaceAsync(IsapiClient client, CancellationToken cancellationToken)
    {
        EnrollerCallResult<byte[]>? result = null;
        // binary — снимок приходит частью FaceData прямо в ответе; url (умолчание прошивки) — ссылкой faceDataUrl.
        // JSON — не из документации станции, запасной вариант для прошивок, отвергающих XML.
        foreach (var (label, path, body, contentType) in new[]
                 {
                     ("xml binary", "ISAPI/AccessControl/CaptureFaceData", FaceXml("binary"), "application/xml"),
                     ("xml url", "ISAPI/AccessControl/CaptureFaceData", FaceXml("url"), "application/xml"),
                     ("json url", "ISAPI/AccessControl/CaptureFaceData?format=json",
                         """{"CaptureFaceDataCond":{"captureInfrared":false,"dataType":"url"}}""", "application/json"),
                 })
        {
            var response = await client.SendRawAsync(HttpMethod.Post, path, body, contentType, cancellationToken);
            result = await ReadFaceResponseAsync(client, response, fromProgress: false, cancellationToken);
            LogCall($"CaptureFaceData {label}", response, result.Outcome, result.Message);
            if (result.Outcome != EnrollerCallOutcome.Rejected)
                return result;
        }
        return result! with { Outcome = EnrollerCallOutcome.Failed };
    }

    private static string FaceXml(string dataType) =>
        $"""<?xml version="1.0" encoding="UTF-8"?><CaptureFaceDataCond xmlns="{IsapiNamespace}" version="2.0"><captureInfrared>false</captureInfrared><dataType>{dataType}</dataType></CaptureFaceDataCond>""";

    /// <summary>Ответ устройства пишем в лог целиком при отказе: по нему видно, что именно не поддерживает прошивка.</summary>
    private void LogCall(string call, IsapiRawResponse response, EnrollerCallOutcome outcome, string? message)
    {
        if (outcome is EnrollerCallOutcome.Rejected or EnrollerCallOutcome.Failed)
        {
            var body = response.Body.Length == 0 ? "-" : Encoding.UTF8.GetString(response.Body, 0, Math.Min(response.Body.Length, 600));
            logger.LogWarning("[Enroller] {Call}: HTTP {Status} {Outcome} {Message}; body: {Body}",
                call, response.StatusCode, outcome, message ?? "-", body);
        }
        else
        {
            logger.LogInformation("[Enroller] {Call}: HTTP {Status} {Outcome} {Message}",
                call, response.StatusCode, outcome, message ?? "-");
        }
    }

    /// <summary>§7.3.2.4 GET /ISAPI/AccessControl/CaptureFaceData/Progress.</summary>
    public async Task<EnrollerCallResult<byte[]>> GetFaceProgressAsync(IsapiClient client, CancellationToken cancellationToken)
    {
        var response = await client.SendRawAsync(HttpMethod.Get, "ISAPI/AccessControl/CaptureFaceData/Progress", null, null, cancellationToken);
        return await ReadFaceResponseAsync(client, response, fromProgress: true, cancellationToken);
    }

    /// <summary>§7.3.3.1 POST /ISAPI/AccessControl/CaptureFingerPrint → fingerData (Base64).</summary>
    public async Task<EnrollerCallResult<byte[]>> CaptureFingerprintAsync(IsapiClient client, int fingerNo, CancellationToken cancellationToken)
    {
        EnrollerCallResult<byte[]>? result = null;
        foreach (var (label, path, body, contentType) in new[]
                 {
                     ("xml", "ISAPI/AccessControl/CaptureFingerPrint",
                         $"""<?xml version="1.0" encoding="UTF-8"?><CaptureFingerPrintCond xmlns="{IsapiNamespace}" version="2.0"><fingerNo>{fingerNo}</fingerNo></CaptureFingerPrintCond>""",
                         "application/xml"),
                     ("json", "ISAPI/AccessControl/CaptureFingerPrint?format=json",
                         JsonSerializer.Serialize(new { CaptureFingerPrintCond = new { fingerNo } }), "application/json"),
                 })
        {
            var response = await client.SendRawAsync(HttpMethod.Post, path, body, contentType, cancellationToken);
            result = ReadFingerprintResponse(response);
            LogCall($"CaptureFingerPrint {label} fingerNo={fingerNo}", response, result.Outcome, result.Message);
            if (result.Outcome != EnrollerCallOutcome.Rejected)
                return result;
        }
        return result! with { Outcome = EnrollerCallOutcome.Failed };
    }

    private EnrollerCallResult<byte[]> ReadFingerprintResponse(IsapiRawResponse response)
    {
        if (!response.Success)
            return FromFailedResponse<byte[]>(response);

        var (text, _) = SplitResponse(response);
        var fields = ReadFields(text);
        if (FromDeviceStatus<byte[]>(fields, response.StatusCode) is { } deviceError)
            return deviceError;

        var fingerData = fields.GetValueOrDefault("fingerData");
        if (string.IsNullOrWhiteSpace(fingerData))
            return new(EnrollerCallOutcome.Retry, null, null);
        try
        {
            var template = Convert.FromBase64String(fingerData.Trim());
            logger.LogInformation("[Enroller] Fingerprint template {Length} bytes, quality={Quality}",
                template.Length, fields.GetValueOrDefault("fingerPrintQuality") ?? "-");
            return template.Length > 0
                ? new(EnrollerCallOutcome.Captured, template, null)
                : new(EnrollerCallOutcome.Retry, null, null);
        }
        catch (FormatException)
        {
            return new(EnrollerCallOutcome.Failed, null, "Станция регистрации вернула шаблон отпечатка в неверном формате.");
        }
    }

    /// <summary>§7.3.1.2 GET /ISAPI/AccessControl/CaptureCardInfo?format=json&amp;readerID= → CardInfo.cardNo.</summary>
    public async Task<EnrollerCallResult<string>> CaptureCardAsync(IsapiClient client, int readerId, CancellationToken cancellationToken)
    {
        EnrollerCallResult<string>? result = null;
        foreach (var path in new[]
                 {
                     $"ISAPI/AccessControl/CaptureCardInfo?format=json&readerID={readerId}",
                     "ISAPI/AccessControl/CaptureCardInfo?format=json",
                 })
        {
            var response = await client.SendRawAsync(HttpMethod.Get, path, null, null, cancellationToken);
            result = ReadCardResponse(response);
            LogCall(path, response, result.Outcome, result.Message);
            if (result.Outcome != EnrollerCallOutcome.Rejected)
                return result;
        }
        return result! with { Outcome = EnrollerCallOutcome.Failed };
    }

    private static EnrollerCallResult<string> ReadCardResponse(IsapiRawResponse response)
    {
        if (!response.Success)
            return FromFailedResponse<string>(response);

        var fields = ReadFields(Encoding.UTF8.GetString(response.Body));
        if (FromDeviceStatus<string>(fields, response.StatusCode) is { } deviceError)
            return deviceError;

        var cardNo = fields.GetValueOrDefault("cardNo")?.Trim();
        return string.IsNullOrEmpty(cardNo)
            ? new(EnrollerCallOutcome.Retry, null, null)
            : new(EnrollerCallOutcome.Captured, cardNo, null);
    }

    private async Task<EnrollerCallResult<byte[]>> ReadFaceResponseAsync(
        IsapiClient client, IsapiRawResponse response, bool fromProgress, CancellationToken cancellationToken)
    {
        if (!response.Success)
            return FromFailedResponse<byte[]>(response);

        var (text, pictures) = SplitResponse(response);
        var fields = ReadFields(text);
        if (FromDeviceStatus<byte[]>(fields, response.StatusCode) is { } deviceError)
            return deviceError;

        // В ответе binary: FaceData — видимый свет; InfraredFaceData / faceMatting нам не нужны.
        var picture = pictures.FirstOrDefault(p => p.Name.Equals("FaceData", StringComparison.OrdinalIgnoreCase))
            ?? pictures.FirstOrDefault(p => !p.Name.Contains("Infrared", StringComparison.OrdinalIgnoreCase)
                                            && !p.Name.Contains("Matting", StringComparison.OrdinalIgnoreCase));
        if (picture is not null)
            return new(EnrollerCallOutcome.Captured, picture.Body, null);

        var url = fields.GetValueOrDefault("faceDataUrl") ?? fields.GetValueOrDefault("faceURL");
        if (!string.IsNullOrWhiteSpace(url))
        {
            var image = await DownloadPictureAsync(client, url, cancellationToken);
            return image is not null
                ? new(EnrollerCallOutcome.Captured, image, null)
                : new(EnrollerCallOutcome.Failed, null, "Лицо захвачено, но снимок не удалось скачать со станции регистрации.");
        }

        int.TryParse(fields.GetValueOrDefault("captureProgress"), out var progress);
        var isOver = string.Equals(fields.GetValueOrDefault("isCurRequestOver"), "true", StringComparison.OrdinalIgnoreCase);
        if (fromProgress && progress >= 100)
            return new(EnrollerCallOutcome.Failed, null, "Лицо захвачено, но станция регистрации не передала снимок.");
        if (isOver)
            return new(EnrollerCallOutcome.Retry, null, "Лицо не захвачено — повторяем захват…");
        return new(EnrollerCallOutcome.Pending, null, null);
    }

    /// <summary>Скачивание снимка по faceDataUrl: сначала путь через адрес устройства из базы (ссылка может содержать внутренний IP), потом сама ссылка.</summary>
    private async Task<byte[]?> DownloadPictureAsync(IsapiClient client, string url, CancellationToken cancellationToken)
    {
        var raw = url.Trim();
        // Hikvision дописывает к ссылке «@WEB…»; терминалы отдают файл без этого суффикса.
        var at = raw.LastIndexOf('@');
        var stripped = at > raw.IndexOf("://", StringComparison.Ordinal) + 3 ? raw[..at] : raw;

        foreach (var candidate in new[] { stripped, raw }.Distinct())
        {
            var path = Uri.TryCreate(candidate, UriKind.Absolute, out var absolute) ? absolute.PathAndQuery : candidate;
            var response = await client.SendRawAsync(HttpMethod.Get, path, null, null, cancellationToken);
            if (response.Success && IsImage(response.Body))
                return response.Body;
        }

        foreach (var candidate in new[] { stripped, raw }.Distinct())
        {
            if (!Uri.TryCreate(candidate, UriKind.Absolute, out _)) continue;
            var (ok, data, error) = await client.GetBytesFromUrlAsync(candidate, cancellationToken);
            if (ok && data is not null && IsImage(data))
                return data;
            logger.LogWarning("[Enroller] Face picture download {Url} failed: {Error}", candidate, error ?? "не изображение");
        }
        return null;
    }

    private static EnrollerCallResult<T> FromFailedResponse<T>(IsapiRawResponse response) where T : class
    {
        if (response.StatusCode == 0)
            return response.TimedOut
                ? new(EnrollerCallOutcome.Retry, null, null)
                : new(EnrollerCallOutcome.Failed, null, $"Станция регистрации недоступна: {response.Error}");
        if (response.StatusCode is 401 or 403)
            return new(EnrollerCallOutcome.Failed, null, "Неверный логин или пароль станции регистрации.");

        var fields = ReadFields(SplitResponse(response).Text);
        return FromDeviceStatus<T>(fields, response.StatusCode)
            ?? (response.StatusCode is 404 or 405
                ? new(EnrollerCallOutcome.Rejected, null, "Станция регистрации не поддерживает этот запрос.")
                : new(EnrollerCallOutcome.Failed, null, $"Станция регистрации вернула ошибку: {response.Error}"));
    }

    /// <summary>ResponseStatus (statusCode ≠ 1) → исход по таблицам ошибок §7.3; null — статуса ошибки в теле нет.</summary>
    private static EnrollerCallResult<T>? FromDeviceStatus<T>(IReadOnlyDictionary<string, string> fields, int httpStatus) where T : class
    {
        var sub = fields.GetValueOrDefault("subStatusCode");
        var hasCode = int.TryParse(fields.GetValueOrDefault("statusCode"), out var code);
        if (sub is null && (!hasCode || code == 1))
            return null;

        switch (sub?.ToLowerInvariant())
        {
            case "devicebusy":
                return new(EnrollerCallOutcome.Retry, null, "Станция регистрации занята предыдущей операцией — ожидание…");
            case "capturetimeout":
                return new(EnrollerCallOutcome.Retry, null, null);
            case "facelowqulity" or "facelowquality":
                return new(EnrollerCallOutcome.Failed, null, "Низкое качество снимка лица. Повторите захват, глядя прямо в камеру.");
            case "fingerprintlowqulity" or "fingerprintlowquality":
                return new(EnrollerCallOutcome.Failed, null, "Низкое качество отпечатка. Приложите палец плотнее и повторите.");
            case "fileuploadfailed":
                return new(EnrollerCallOutcome.Failed, null, "Станция регистрации не смогла передать снимок. Повторите захват.");
            case "notsupport" or "invalidoperation" or "badparameters" or "badxmlformat" or "badxmlcontent"
                or "badjsonformat" or "badjsoncontent" or "badurlformat" or "methodnotallowed":
                return new(EnrollerCallOutcome.Rejected, null, $"Станция регистрации отклонила запрос ({sub}).");
        }

        var statusString = fields.GetValueOrDefault("statusString") ?? $"HTTP {httpStatus}";
        return new(EnrollerCallOutcome.Failed, null,
            $"Станция регистрации вернула ошибку: {statusString}{(sub is null ? "" : $" ({sub})")}.");
    }

    /// <summary>Тело ответа: текстовая часть (XML/JSON) и картинки, если ответ multipart.</summary>
    private static (string Text, List<Part> Pictures) SplitResponse(IsapiRawResponse response)
    {
        var boundary = GetBoundary(response.ContentType, response.Body);
        if (boundary is null)
            return IsImage(response.Body)
                ? (string.Empty, [new Part("FaceData", response.Body)])
                : (Encoding.UTF8.GetString(response.Body), []);

        string? text = null;
        var pictures = new List<Part>();
        foreach (var part in ParseMultipart(response.Body, boundary))
        {
            if (IsImage(part.Body))
                pictures.Add(part);
            else if (text is null && Encoding.UTF8.GetString(part.Body).TrimStart() is var s && (s.StartsWith('<') || s.StartsWith('{')))
                text = s;
        }
        return (text ?? string.Empty, pictures);
    }

    private static string? GetBoundary(string? contentType, byte[] body)
    {
        if (contentType?.Contains("multipart", StringComparison.OrdinalIgnoreCase) == true)
        {
            foreach (var parameter in contentType.Split(';'))
            {
                var kv = parameter.Trim();
                if (kv.StartsWith("boundary=", StringComparison.OrdinalIgnoreCase))
                    return kv["boundary=".Length..].Trim('"');
            }
        }

        // Часть прошивок отдаёт multipart с Content-Type application/xml — узнаём по первой строке «--boundary».
        if (body.Length > 2 && body[0] == '-' && body[1] == '-')
        {
            var lineEnd = Array.IndexOf(body, (byte)'\n');
            if (lineEnd > 2)
                return Encoding.ASCII.GetString(body, 2, lineEnd - 2).TrimEnd('\r');
        }
        return null;
    }

    private static List<Part> ParseMultipart(byte[] data, string boundary)
    {
        var parts = new List<Part>();
        var delimiter = Encoding.ASCII.GetBytes("--" + boundary);
        var cursor = data.AsSpan().IndexOf(delimiter);
        while (cursor >= 0)
        {
            var afterDelimiter = cursor + delimiter.Length;
            if (afterDelimiter + 1 < data.Length && data[afterDelimiter] == '-' && data[afterDelimiter + 1] == '-')
                break;

            var headersStart = SkipLineBreak(data, afterDelimiter);
            var (headersEnd, bodyStart) = FindHeadersEnd(data, headersStart);
            if (bodyStart < 0)
                break;

            var headers = Encoding.ASCII.GetString(data, headersStart, headersEnd - headersStart)
                .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

            // Content-Length точнее поиска разделителя: в JPEG байты «--boundary» теоретически возможны.
            int bodyEnd;
            int next;
            if (TryHeaderValue(headers, "Content-Length") is { } lengthRaw && int.TryParse(lengthRaw, out var length)
                && length >= 0 && bodyStart + length <= data.Length)
            {
                bodyEnd = bodyStart + length;
                var rel = data.AsSpan(bodyEnd).IndexOf(delimiter);
                next = rel < 0 ? -1 : bodyEnd + rel;
            }
            else
            {
                var rel = data.AsSpan(bodyStart).IndexOf(delimiter);
                next = rel < 0 ? -1 : bodyStart + rel;
                bodyEnd = next < 0 ? data.Length : next;
                if (bodyEnd > bodyStart && data[bodyEnd - 1] == '\n') bodyEnd--;
                if (bodyEnd > bodyStart && data[bodyEnd - 1] == '\r') bodyEnd--;
            }

            parts.Add(new Part(GetPartName(TryHeaderValue(headers, "Content-Disposition")), data[bodyStart..bodyEnd]));
            cursor = next;
        }
        return parts;
    }

    private static int SkipLineBreak(byte[] data, int index)
    {
        if (index < data.Length && data[index] == '\r') index++;
        if (index < data.Length && data[index] == '\n') index++;
        return index;
    }

    private static (int HeadersEnd, int BodyStart) FindHeadersEnd(byte[] data, int from)
    {
        var crlf = data.AsSpan(from).IndexOf("\r\n\r\n"u8);
        var lf = data.AsSpan(from).IndexOf("\n\n"u8);
        if (crlf >= 0 && (lf < 0 || crlf <= lf))
            return (from + crlf, from + crlf + 4);
        return lf >= 0 ? (from + lf, from + lf + 2) : (-1, -1);
    }

    private static string? TryHeaderValue(string[] headers, string name)
    {
        foreach (var header in headers)
        {
            var colon = header.IndexOf(':');
            if (colon > 0 && header[..colon].Trim().Equals(name, StringComparison.OrdinalIgnoreCase))
                return header[(colon + 1)..].Trim();
        }
        return null;
    }

    /// <summary>name из Content-Disposition; Hikvision пишет его и в кавычках, и без.</summary>
    private static string GetPartName(string? disposition)
    {
        if (disposition is null) return string.Empty;
        foreach (var parameter in disposition.Split(';'))
        {
            var kv = parameter.Trim();
            if (kv.StartsWith("name=", StringComparison.OrdinalIgnoreCase))
                return kv["name=".Length..].Trim('"');
        }
        return string.Empty;
    }

    private static bool IsImage(byte[] data) =>
        data.Length > 4 && ((data[0] == 0xFF && data[1] == 0xD8) || (data[0] == 0x89 && data[1] == 0x50 && data[2] == 0x4E && data[3] == 0x47));

    /// <summary>Листовые значения XML/JSON по имени без учёта регистра и пространства имён (первое вхождение).</summary>
    private static IReadOnlyDictionary<string, string> ReadFields(string? text)
    {
        var fields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var trimmed = text?.Trim();
        if (string.IsNullOrEmpty(trimmed))
            return fields;
        try
        {
            if (trimmed.StartsWith('<'))
            {
                foreach (var element in XDocument.Parse(trimmed).Descendants().Where(e => !e.HasElements))
                    fields.TryAdd(element.Name.LocalName, element.Value.Trim());
            }
            else if (trimmed.StartsWith('{'))
            {
                using var doc = JsonDocument.Parse(trimmed);
                CollectJson(doc.RootElement, fields, 0);
            }
        }
        catch (Exception ex) when (ex is XmlException or JsonException)
        {
            // Нечитаемое тело — как пустое: решение примут по HTTP-коду.
        }
        return fields;
    }

    private static void CollectJson(JsonElement element, Dictionary<string, string> fields, int depth)
    {
        if (depth > 12 || element.ValueKind != JsonValueKind.Object)
            return;
        foreach (var property in element.EnumerateObject())
        {
            switch (property.Value.ValueKind)
            {
                case JsonValueKind.Object:
                    CollectJson(property.Value, fields, depth + 1);
                    break;
                case JsonValueKind.String:
                    fields.TryAdd(property.Name, property.Value.GetString() ?? string.Empty);
                    break;
                case JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False:
                    fields.TryAdd(property.Name, property.Value.GetRawText());
                    break;
            }
        }
    }
}
