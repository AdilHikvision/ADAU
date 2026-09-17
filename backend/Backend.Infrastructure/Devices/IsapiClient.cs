using System.Net;
using System.Net.Http.Headers;
using System.Text;

namespace Backend.Infrastructure.Devices;

/// <summary>Ответ ISAPI «как есть»: байты тела и Content-Type (multipart с картинками нельзя читать строкой).</summary>
/// <param name="StatusCode">HTTP-код; 0 — ответа не было (сеть или таймаут).</param>
public sealed record IsapiRawResponse(bool Success, int StatusCode, byte[] Body, string? ContentType, bool TimedOut, string? Error);

/// <summary>HTTP-клиент для ISAPI Hikvision с Digest Auth. Поддерживает GET, POST, PUT, multipart/form-data.</summary>
public sealed class IsapiClient
{
    private readonly string _ipAddress;
    private readonly int[] _ports;
    private readonly NetworkCredential _credential;
    private readonly TimeSpan _timeout;

    public IsapiClient(string ipAddress, int devicePort, string username, string password, TimeSpan? timeout = null)
    {
        if (string.IsNullOrWhiteSpace(ipAddress))
            throw new ArgumentException("IP address is required.", nameof(ipAddress));
        if (string.IsNullOrWhiteSpace(password))
            throw new ArgumentException("Password is required.", nameof(password));

        _ipAddress = ipAddress.Trim();
        _ports = IsapiPortHelper.GetPortsToTry(devicePort);
        _credential = new NetworkCredential(
            string.IsNullOrWhiteSpace(username) ? "admin" : username.Trim(),
            password);
        _timeout = timeout ?? TimeSpan.FromSeconds(12);
    }

    /// <summary>Выполняет GET-запрос. Пробует порты по очереди. Возвращает (успех, тело ответа, сообщение об ошибке).</summary>
    public async Task<(bool Success, string? Content, string? Error)> GetAsync(
        string path,
        CancellationToken cancellationToken = default)
    {
        string? lastError = null;
        foreach (var port in _ports)
        {
            var (success, content, error, isAuthError) = await TryRequestAsync(
                port,
                path,
                HttpMethod.Get,
                null,
                cancellationToken);
            if (success)
                return (true, content, null);
            if (isAuthError)
                return (false, null, error);
            lastError = error;
        }
        return (false, null, lastError ?? "Устройство недоступно или не поддерживает запрос.");
    }

    /// <summary>Выполняет POST с JSON. path должен включать ?format=json при необходимости.</summary>
    public async Task<(bool Success, string? Content, string? Error)> PostJsonAsync(
        string path,
        string jsonBody,
        CancellationToken cancellationToken = default)
    {
        return await PostAsync(path, jsonBody, "application/json", cancellationToken);
    }

    /// <summary>Выполняет POST с произвольным телом и Content-Type.</summary>
    public async Task<(bool Success, string? Content, string? Error)> PostAsync(
        string path,
        string body,
        string contentType,
        CancellationToken cancellationToken = default)
    {
        string? lastError = null;
        foreach (var port in _ports)
        {
            var (success, content, error, isAuthError) = await TryRequestAsync(
                port,
                path,
                HttpMethod.Post,
                new StringContent(body, Encoding.UTF8, contentType),
                cancellationToken);
            if (success)
                return (true, content, null);
            if (isAuthError)
                return (false, null, error);
            lastError = error;
        }
        return (false, null, lastError ?? "Устройство недоступно или не поддерживает запрос.");
    }

    /// <summary>Выполняет PUT с JSON.</summary>
    public async Task<(bool Success, string? Content, string? Error)> PutJsonAsync(
        string path,
        string jsonBody,
        CancellationToken cancellationToken = default)
    {
        return await PutAsync(path, jsonBody, "application/json", cancellationToken);
    }

    /// <summary>Выполняет DELETE с опциональным телом (некоторые устройства ожидают DELETE вместо PUT).</summary>
    public async Task<(bool Success, string? Content, string? Error)> DeleteAsync(
        string path,
        string? body = null,
        string? contentType = null,
        CancellationToken cancellationToken = default)
    {
        string? lastError = null;
        foreach (var port in _ports)
        {
            // Новый StringContent на каждый порт: после SendAsync контент запроса освобождается, повторное использование даёт ObjectDisposedException.
            HttpContent? content = body != null && contentType != null
                ? new StringContent(body, Encoding.UTF8, contentType)
                : null;
            var (success, c, error, isAuthError) = await TryRequestAsync(port, path, HttpMethod.Delete, content, cancellationToken);
            if (success) return (true, c, null);
            if (isAuthError) return (false, null, error);
            lastError = error;
        }
        return (false, null, lastError ?? "Устройство недоступно или не поддерживает запрос.");
    }

    /// <summary>Выполняет PUT с произвольным телом и Content-Type.</summary>
    public async Task<(bool Success, string? Content, string? Error)> PutAsync(
        string path,
        string body,
        string contentType,
        CancellationToken cancellationToken = default)
    {
        string? lastError = null;
        foreach (var port in _ports)
        {
            var (success, content, error, isAuthError) = await TryRequestAsync(
                port,
                path,
                HttpMethod.Put,
                new StringContent(body, Encoding.UTF8, contentType),
                cancellationToken);
            if (success)
                return (true, content, null);
            if (isAuthError)
                return (false, null, error);
            lastError = error;
        }
        return (false, null, lastError ?? "Устройство недоступно или не поддерживает запрос.");
    }

    /// <summary>Скачивает бинарные данные (изображение и т.п.) с Digest Auth.</summary>
    public async Task<(bool Success, byte[]? Data, string? Error)> GetBytesAsync(
        string path,
        CancellationToken cancellationToken = default)
    {
        foreach (var port in _ports)
        {
            var scheme = port == 443 ? "https" : "http";
            var pathTrimmed = path.TrimStart('/');
            var uri = new Uri($"{scheme}://{_ipAddress}:{port}/{pathTrimmed}");

            using var handler = new HttpClientHandler
            {
                Credentials = _credential,
                PreAuthenticate = false,
                AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate
            };
            if (scheme == "https")
                handler.ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;

            using var client = new HttpClient(handler, disposeHandler: true) { Timeout = _timeout };
            try
            {
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                cts.CancelAfter(_timeout);
                using var request = new HttpRequestMessage(HttpMethod.Get, uri);
                request.Headers.ConnectionClose = true;
                using var response = await client.SendAsync(request, cts.Token);
                if (response.StatusCode == HttpStatusCode.Unauthorized)
                    return (false, null, "Неверный логин или пароль.");
                if (!response.IsSuccessStatusCode)
                    return (false, null, $"HTTP {(int)response.StatusCode}.");
                var data = await response.Content.ReadAsByteArrayAsync(cts.Token);
                return (true, data, null);
            }
            catch (OperationCanceledException) { return (false, null, "Таймаут."); }
            catch (HttpRequestException ex) { return (false, null, ex.InnerException?.Message ?? "Ошибка сети."); }
            catch (Exception ex) { return (false, null, ex.Message); }
        }
        return (false, null, "Устройство недоступно.");
    }

    /// <summary>Скачивает бинарные данные по полному URL с Digest Auth (для URL вроде http://device/LOCALS/pic/...).</summary>
    public async Task<(bool Success, byte[]? Data, string? Error)> GetBytesFromUrlAsync(
        string fullUrl,
        CancellationToken cancellationToken = default)
    {
        var uri = new Uri(fullUrl);
        var scheme = uri.Scheme;

        using var handler = new HttpClientHandler
        {
            Credentials = _credential,
            PreAuthenticate = false,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate
        };
        if (scheme == "https")
            handler.ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;

        using var client = new HttpClient(handler, disposeHandler: true) { Timeout = _timeout };
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cts.CancelAfter(_timeout);
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            request.Headers.ConnectionClose = true;
            using var response = await client.SendAsync(request, cts.Token);
            if (!response.IsSuccessStatusCode)
                return (false, null, $"HTTP {(int)response.StatusCode}.");
            var data = await response.Content.ReadAsByteArrayAsync(cts.Token);
            return (true, data, null);
        }
        catch (OperationCanceledException) { return (false, null, "Таймаут."); }
        catch (HttpRequestException ex) { return (false, null, ex.InnerException?.Message ?? "Ошибка сети."); }
        catch (Exception ex) { return (false, null, ex.Message); }
    }

    /// <summary>Выполняет multipart/form-data с указанным HTTP методом. partsFactory создаёт свежие HttpContent на каждую попытку.</summary>
    public async Task<(bool Success, string? Content, string? Error)> MultipartAsync(
        HttpMethod method,
        string path,
        Func<Dictionary<string, (HttpContent Content, string? FileName)>> partsFactory,
        CancellationToken cancellationToken = default)
    {
        string? lastError = null;
        foreach (var port in _ports)
        {
            var parts = partsFactory();
            var (success, content, error, isAuthError) = await TryMultipartAsync(port, path, method, parts, cancellationToken);
            if (success)
                return (true, content, null);
            if (isAuthError)
                return (false, null, error);
            lastError = error;
        }
        return (false, null, lastError ?? "Устройство недоступно или не поддерживает запрос.");
    }

    /// <summary>POST multipart/form-data с фабрикой.</summary>
    public Task<(bool Success, string? Content, string? Error)> PostMultipartAsync(
        string path,
        Func<Dictionary<string, (HttpContent Content, string? FileName)>> partsFactory,
        CancellationToken cancellationToken = default)
        => MultipartAsync(HttpMethod.Post, path, partsFactory, cancellationToken);

    /// <summary>PUT multipart/form-data с фабрикой.</summary>
    public Task<(bool Success, string? Content, string? Error)> PutMultipartAsync(
        string path,
        Func<Dictionary<string, (HttpContent Content, string? FileName)>> partsFactory,
        CancellationToken cancellationToken = default)
        => MultipartAsync(HttpMethod.Put, path, partsFactory, cancellationToken);

    /// <summary>
    /// Запрос с сырым ответом. Следующий порт пробуется, только если к текущему не удалось подключиться:
    /// повтор долгого блокирующего запроса (захват на станции регистрации) на другом порту запустил бы захват заново.
    /// Отмена <paramref name="cancellationToken"/> пробрасывается как <see cref="OperationCanceledException"/>.
    /// </summary>
    public async Task<IsapiRawResponse> SendRawAsync(
        HttpMethod method,
        string path,
        string? body,
        string? contentType,
        CancellationToken cancellationToken = default)
    {
        IsapiRawResponse? lastConnectionError = null;
        foreach (var port in _ports)
        {
            var scheme = port == 443 ? "https" : "http";
            var uri = new Uri($"{scheme}://{_ipAddress}:{port}/{path.TrimStart('/')}");

            using var handler = new HttpClientHandler
            {
                Credentials = _credential,
                PreAuthenticate = false,
                AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate
            };
            if (scheme == "https")
                handler.ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;

            using var client = new HttpClient(handler, disposeHandler: true) { Timeout = Timeout.InfiniteTimeSpan };
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cts.CancelAfter(_timeout);

            try
            {
                using var request = new HttpRequestMessage(method, uri);
                request.Headers.ConnectionClose = true;
                if (body != null)
                    request.Content = new StringContent(body, Encoding.UTF8, contentType ?? "application/xml");

                using var response = await client.SendAsync(request, cts.Token);
                var bytes = await response.Content.ReadAsByteArrayAsync(cts.Token);
                var status = (int)response.StatusCode;
                var mediaType = response.Content.Headers.ContentType?.ToString();
                if (response.IsSuccessStatusCode)
                    return new IsapiRawResponse(true, status, bytes, mediaType, false, null);

                var error = response.StatusCode switch
                {
                    HttpStatusCode.Unauthorized => "Неверный логин или пароль.",
                    HttpStatusCode.Forbidden => "Доступ запрещён.",
                    HttpStatusCode.NotFound => "Endpoint не найден (404).",
                    _ => $"HTTP {status}."
                };
                return new IsapiRawResponse(false, status, bytes, mediaType, false, error);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                return new IsapiRawResponse(false, 0, [], null, true, "Таймаут.");
            }
            catch (HttpRequestException ex) when (ex.HttpRequestError == HttpRequestError.ConnectionError)
            {
                lastConnectionError = new IsapiRawResponse(false, 0, [], null, false, ex.InnerException?.Message ?? ex.Message);
            }
            catch (HttpRequestException ex)
            {
                return new IsapiRawResponse(false, 0, [], null, false, ex.InnerException?.Message ?? "Ошибка сети.");
            }
        }
        return lastConnectionError ?? new IsapiRawResponse(false, 0, [], null, false, "Устройство недоступно.");
    }

    /// <summary>Обратная совместимость: POST multipart с готовым словарём.</summary>
    public Task<(bool Success, string? Content, string? Error)> PostMultipartAsync(
        string path,
        IReadOnlyDictionary<string, (HttpContent Content, string? FileName)> parts,
        CancellationToken cancellationToken = default)
        => PostMultipartAsync(path, () => new Dictionary<string, (HttpContent Content, string? FileName)>(parts), cancellationToken);

    private async Task<(bool Success, string? Content, string? Error, bool IsAuthError)> TryRequestAsync(
        int port,
        string path,
        HttpMethod method,
        HttpContent? content,
        CancellationToken cancellationToken)
    {
        var scheme = port == 443 ? "https" : "http";
        var pathTrimmed = path.TrimStart('/');
        var uri = new Uri($"{scheme}://{_ipAddress}:{port}/{pathTrimmed}");

        using var handler = new HttpClientHandler
        {
            Credentials = _credential,
            PreAuthenticate = false,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate
        };
        if (scheme == "https")
            handler.ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;

        using var client = new HttpClient(handler, disposeHandler: true) { Timeout = _timeout };

        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cts.CancelAfter(_timeout);

            using var request = new HttpRequestMessage(method, uri);
            request.Headers.ConnectionClose = true;
            request.Headers.Accept.ParseAdd("application/json");
            request.Headers.Accept.ParseAdd("application/xml");
            if (content != null)
                request.Content = content;

            using var response = await client.SendAsync(request, cts.Token);

            if (response.StatusCode == HttpStatusCode.Unauthorized)
                return (false, null, "Неверный логин или пароль.", true);
            if (response.StatusCode == HttpStatusCode.Forbidden)
                return (false, null, "Доступ запрещён.", true);
            if (response.StatusCode == HttpStatusCode.NotFound)
                return (false, null, "Endpoint не найден (404).", false);
            if (!response.IsSuccessStatusCode)
            {
                var errBody = await response.Content.ReadAsStringAsync(cts.Token);
                var errTrimmed = errBody?.Trim() ?? "";
                var errSnippet = errTrimmed.Length > 500 ? errTrimmed[..500] + "..." : errTrimmed;
                var errMsg = string.IsNullOrWhiteSpace(errTrimmed)
                    ? $"HTTP {(int)response.StatusCode}."
                    : $"HTTP {(int)response.StatusCode}: {errSnippet}";
                return (false, null, errMsg, false);
            }

            var body = await response.Content.ReadAsStringAsync(cts.Token);
            return (true, body, null, false);
        }
        catch (OperationCanceledException)
        {
            return (false, null, "Таймаут.", false);
        }
        catch (HttpRequestException ex)
        {
            return (false, null, ex.InnerException?.Message ?? "Ошибка сети.", false);
        }
        catch (Exception ex)
        {
            return (false, null, ex.Message, false);
        }
    }

    private async Task<(bool Success, string? Content, string? Error, bool IsAuthError)> TryMultipartAsync(
        int port,
        string path,
        HttpMethod method,
        IReadOnlyDictionary<string, (HttpContent Content, string? FileName)> parts,
        CancellationToken cancellationToken)
    {
        var scheme = port == 443 ? "https" : "http";
        var pathTrimmed = path.TrimStart('/');
        var uri = new Uri($"{scheme}://{_ipAddress}:{port}/{pathTrimmed}");

        var credCache = new CredentialCache();
        credCache.Add(new Uri($"{scheme}://{_ipAddress}:{port}"), "Digest", _credential);

        using var handler = new HttpClientHandler
        {
            Credentials = credCache,
            PreAuthenticate = true,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate
        };
        if (scheme == "https")
            handler.ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;

        using var client = new HttpClient(handler, disposeHandler: true) { Timeout = TimeSpan.FromSeconds(30) };

        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cts.CancelAfter(TimeSpan.FromSeconds(25));

            // Warm up Digest Auth with a lightweight GET so .NET caches the nonce.
            // Without this, multipart body streams can't be re-sent after a 401 challenge,
            // causing "ResponseEnded" errors.
            var warmUpUri = new Uri($"{scheme}://{_ipAddress}:{port}/ISAPI/System/deviceInfo");
            using (var warmUp = new HttpRequestMessage(HttpMethod.Get, warmUpUri))
            {
                try { using var _ = await client.SendAsync(warmUp, cts.Token); } catch { /* ignore */ }
            }

            var boundary = $"----HikBoundary{Guid.NewGuid():N}";
            var content = new MultipartFormDataContent(boundary);
            content.Headers.Remove("Content-Type");
            content.Headers.TryAddWithoutValidation("Content-Type", $"multipart/form-data; boundary={boundary}");

            foreach (var (name, (partContent, fileName)) in parts)
            {
                content.Add(partContent);
                // Hikvision firmware requires unquoted name/filename in Content-Disposition.
                // .NET always quotes them per RFC 2183. Override with raw header value.
                partContent.Headers.Remove("Content-Disposition");
                if (!string.IsNullOrEmpty(fileName))
                    partContent.Headers.TryAddWithoutValidation("Content-Disposition",
                        $"form-data; name={name}; filename={fileName}");
                else
                    partContent.Headers.TryAddWithoutValidation("Content-Disposition",
                        $"form-data; name={name}");
            }

            // Debug: log multipart part headers (not body to avoid consuming streams)
            var partInfo = new StringBuilder();
            partInfo.AppendLine($"[ISAPI-MP] {method} {uri}  ContentType={content.Headers.ContentType}");
            foreach (var part in content)
            {
                var disp = part.Headers.ContentDisposition?.ToString() ?? "?";
                var ct = part.Headers.ContentType?.ToString() ?? "?";
                var len = part.Headers.ContentLength ?? -1;
                partInfo.AppendLine($"  Part: {disp}  CT={ct}  Len={len}");
            }
            Console.Error.WriteLine(partInfo.ToString());

            var request = new HttpRequestMessage(method, uri);
            request.Headers.ConnectionClose = true;
            request.Content = content;

            using var response = await client.SendAsync(request, cts.Token);

            if (response.StatusCode == HttpStatusCode.Unauthorized)
                return (false, null, "Неверный логин или пароль.", true);
            if (response.StatusCode == HttpStatusCode.Forbidden)
                return (false, null, "Доступ запрещён.", true);
            if (response.StatusCode == HttpStatusCode.NotFound)
                return (false, null, "Endpoint не найден (404).", false);
            if (!response.IsSuccessStatusCode)
            {
                var errBody = await response.Content.ReadAsStringAsync(cts.Token);
                var errTrimmed = errBody?.Trim() ?? "";
                var errSnippet = errTrimmed.Length > 500 ? errTrimmed[..500] + "..." : errTrimmed;
                return (false, null, string.IsNullOrWhiteSpace(errTrimmed) ? $"HTTP {(int)response.StatusCode}: {errSnippet}" : $"HTTP {(int)response.StatusCode}: {errSnippet}", false);
            }

            var body = await response.Content.ReadAsStringAsync(cts.Token);
            return (true, body, null, false);
        }
        catch (OperationCanceledException)
        {
            return (false, null, "Таймаут.", false);
        }
        catch (HttpRequestException ex)
        {
            return (false, null, ex.InnerException?.Message ?? "Ошибка сети.", false);
        }
        catch (Exception ex)
        {
            return (false, null, ex.Message, false);
        }
    }
}
