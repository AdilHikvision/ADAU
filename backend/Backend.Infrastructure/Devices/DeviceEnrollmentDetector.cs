using System.Collections.Concurrent;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;
using Backend.Domain.Entities;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace Backend.Infrastructure.Devices;

/// <summary>
/// Станция регистрации или нет. Тип в базе часто остаётся «Контроллер» (устройство добавлено из поиска),
/// а имя и серийник модели не содержат — тогда спрашиваем модель у самого устройства (GET /ISAPI/System/deviceInfo).
/// </summary>
public sealed class DeviceEnrollmentDetector(IConfiguration configuration, ILogger<DeviceEnrollmentDetector> logger)
{
    /// <summary>Модель устройства не меняется; неудачный запрос повторяем быстро — устройство могло быть офлайн.</summary>
    private static readonly TimeSpan ModelCacheTtl = TimeSpan.FromHours(6);
    private static readonly TimeSpan FailedLookupTtl = TimeSpan.FromMinutes(1);

    private readonly ConcurrentDictionary<string, (string? Model, DateTime CheckedUtc)> _models = new();

    public async Task<bool> IsEnrollerAsync(Device device, CancellationToken cancellationToken)
    {
        if (DeviceEnrollmentProfile.UseEnrollerCaptureFlow(device))
            return true;
        var model = await GetModelAsync(device, cancellationToken);
        return DeviceEnrollmentProfile.LooksLikeHikvisionEnroller(model, null);
    }

    /// <summary>Модель из deviceInfo (например DS-K1F600U-D6E-F); null — устройство не ответило.</summary>
    public async Task<string?> GetModelAsync(Device device, CancellationToken cancellationToken)
    {
        var key = $"{device.IpAddress}:{device.Port}";
        if (_models.TryGetValue(key, out var cached)
            && DateTime.UtcNow - cached.CheckedUtc < (cached.Model is null ? FailedLookupTtl : ModelCacheTtl))
            return cached.Model;

        string? model = null;
        try
        {
            var client = CreateClient(device);
            var (ok, content, error) = await client.GetAsync("ISAPI/System/deviceInfo", cancellationToken);
            if (ok)
                model = ParseModel(content);
            else
                logger.LogDebug("deviceInfo for {Device} ({Key}) failed: {Error}", device.Name, key, error);
        }
        catch (ArgumentException ex)
        {
            logger.LogDebug(ex, "deviceInfo for {Device}: bad connection settings", device.Name);
        }

        _models[key] = (model, DateTime.UtcNow);
        if (model is not null)
            logger.LogInformation("Device {Device} ({Key}) model: {Model}", device.Name, key, model);
        return model;
    }

    private static string? ParseModel(string? content)
    {
        var text = content?.Trim();
        if (string.IsNullOrEmpty(text)) return null;
        try
        {
            if (text.StartsWith('<'))
                return XDocument.Parse(text).Descendants()
                    .FirstOrDefault(e => e.Name.LocalName.Equals("model", StringComparison.OrdinalIgnoreCase))?.Value.Trim();
            if (text.StartsWith('{'))
            {
                using var doc = JsonDocument.Parse(text);
                var root = doc.RootElement.TryGetProperty("DeviceInfo", out var info) ? info : doc.RootElement;
                return root.TryGetProperty("model", out var m) ? m.GetString()?.Trim() : null;
            }
        }
        catch (Exception ex) when (ex is XmlException or JsonException)
        {
            // Нечитаемый ответ — модель неизвестна.
        }
        return null;
    }

    private IsapiClient CreateClient(Device device)
    {
        var username = configuration["Hikvision:Username"] ?? "admin";
        var password = (configuration["Hikvision:Password"] ?? "").Trim();
        if (string.IsNullOrEmpty(password)) password = "12345";
        return new IsapiClient(
            device.IpAddress, device.Port,
            string.IsNullOrWhiteSpace(device.Username) ? username : device.Username,
            string.IsNullOrWhiteSpace(device.Password) ? password : device.Password,
            TimeSpan.FromSeconds(8));
    }
}
