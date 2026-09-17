using System.Net.Sockets;
using Backend.Infrastructure.Persistence;
using MailKit.Net.Smtp;
using MailKit.Security;
using Microsoft.EntityFrameworkCore;
using MimeKit;

public sealed class EmailService(IServiceScopeFactory scopeFactory, ILogger<EmailService> logger) : IEmailService
{
    /// <summary>Ответ SMTP-сервера ждём столько; иначе запрос из UI «висит» до сетевого таймаута.</summary>
    private static readonly TimeSpan SmtpTimeout = TimeSpan.FromSeconds(15);

    /// <summary>Порты implicit SSL (SMTPS): TLS поднимается сразу при подключении, без STARTTLS.</summary>
    private static readonly int[] ImplicitSslPorts = [465, 8465];

    private const string NotConfiguredMessage =
        "SMTP is disabled or not configured — check Settings → Email (Enabled, Host, From address).";

    private async Task<SmtpSettings?> LoadSettingsAsync(CancellationToken ct)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var keys = new[] { "Smtp:Host", "Smtp:Port", "Smtp:Username", "Smtp:Password", "Smtp:FromAddress", "Smtp:FromName", "Smtp:EnableSsl", "Smtp:Enabled" };
        var rows = await db.SystemSettings.AsNoTracking().Where(x => keys.Contains(x.Key)).ToListAsync(ct);
        var map = rows.ToDictionary(x => x.Key, x => x.Value ?? "");

        if (!map.TryGetValue("Smtp:Enabled", out var enabled) || !string.Equals(enabled, "true", StringComparison.OrdinalIgnoreCase))
            return null;
        if (!map.TryGetValue("Smtp:Host", out var host) || string.IsNullOrWhiteSpace(host))
            return null;
        if (!map.TryGetValue("Smtp:FromAddress", out var fromAddr) || string.IsNullOrWhiteSpace(fromAddr))
            return null;

        return new SmtpSettings
        {
            Host = host,
            Port = int.TryParse(map.GetValueOrDefault("Smtp:Port"), out var p) ? p : 587,
            Username = map.GetValueOrDefault("Smtp:Username", ""),
            Password = map.GetValueOrDefault("Smtp:Password", ""),
            FromAddress = map.GetValueOrDefault("Smtp:FromAddress", ""),
            FromName = map.GetValueOrDefault("Smtp:FromName", "ProjectX"),
            EnableSsl = string.Equals(map.GetValueOrDefault("Smtp:EnableSsl", "true"), "true", StringComparison.OrdinalIgnoreCase)
        };
    }

    public async Task SendAsync(string to, string subject, string htmlBody, CancellationToken cancellationToken = default)
    {
        var cfg = await LoadSettingsAsync(cancellationToken);
        // Раньше здесь стоял тихий return: вызывающий получал «успех», а письма не было.
        // Теперь ненастроенный SMTP — такая же ошибка отправки, как и отказ сервера.
        if (cfg is null)
        {
            logger.LogWarning("SMTP not configured or disabled — email to {To} was NOT sent: {Subject}", to, subject);
            throw new InvalidOperationException(NotConfiguredMessage);
        }

        try
        {
            await SendCoreAsync(cfg, to, subject, htmlBody, cancellationToken);
            logger.LogInformation("Email sent to {To}: {Subject}", to, subject);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to send email to {To}: {Subject}", to, subject);
            throw new InvalidOperationException($"Failed to send email: {Describe(ex, cfg)}", ex);
        }
    }

    public async Task<EmailTestResult> TestConnectionAsync(string to, SmtpTestOptions? options = null, CancellationToken cancellationToken = default)
    {
        var cfg = options is null
            ? await LoadSettingsAsync(cancellationToken)
            : ToSmtpSettings(options);
        if (cfg is null)
            return new EmailTestResult(false, NotConfiguredMessage);
        try
        {
            await SendCoreAsync(cfg, to, "ProjectX SMTP Test", "<p>SMTP connection test successful.</p>", cancellationToken);
            return new EmailTestResult(true);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "SMTP test failed");
            return new EmailTestResult(false, $"SMTP send failed: {Describe(ex, cfg)}");
        }
    }

    /// <summary>Одна точка отправки для боевых писем и для теста — настройки применяются одинаково.</summary>
    private static async Task SendCoreAsync(SmtpSettings cfg, string to, string subject, string htmlBody, CancellationToken ct)
    {
        var msg = new MimeMessage();
        msg.From.Add(new MailboxAddress(cfg.FromName, cfg.FromAddress));
        msg.To.Add(MailboxAddress.Parse(to));
        msg.Subject = subject;
        msg.Body = new BodyBuilder { HtmlBody = htmlBody }.ToMessageBody();

        using var client = new SmtpClient { Timeout = (int)SmtpTimeout.TotalMilliseconds };

        // Timeout у MailKit ограничивает отдельную операцию сокета, а не всю отправку целиком,
        // поэтому общий бюджет держим на токене.
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(SmtpTimeout);
        try
        {
            await client.ConnectAsync(cfg.Host, cfg.Port, SecurityFor(cfg), timeout.Token);
            // Пустой логин — сервер без аутентификации (внутренний релей): AUTH не шлём вовсе.
            if (!string.IsNullOrWhiteSpace(cfg.Username))
                await client.AuthenticateAsync(cfg.Username, cfg.Password, timeout.Token);
            await client.SendAsync(msg, timeout.Token);
            await client.DisconnectAsync(true, timeout.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new TimeoutException($"server {cfg.Host}:{cfg.Port} did not respond within {SmtpTimeout.TotalSeconds:0} s");
        }
    }

    /// <summary>
    /// Как поднимать TLS: на 465 сервер ждёт TLS сразу при подключении (implicit SSL),
    /// на 587/25 — открытый сокет с последующим STARTTLS.
    /// </summary>
    private static SecureSocketOptions SecurityFor(SmtpSettings cfg)
    {
        if (!cfg.EnableSsl)
            return SecureSocketOptions.None;
        return ImplicitSslPorts.Contains(cfg.Port)
            ? SecureSocketOptions.SslOnConnect
            : SecureSocketOptions.StartTls;
    }

    private static SmtpSettings? ToSmtpSettings(SmtpTestOptions options)
    {
        if (!options.Enabled || string.IsNullOrWhiteSpace(options.Host) || string.IsNullOrWhiteSpace(options.FromAddress))
            return null;
        // Значения приходят прямо из формы (тест возможен до сохранения) — чистим так же, как при сохранении.
        return new SmtpSettings
        {
            Host = options.Host.Trim(),
            Port = options.Port > 0 ? options.Port : 587,
            Username = options.Username?.Trim() ?? "",
            Password = options.Password ?? "",
            FromAddress = options.FromAddress.Trim(),
            FromName = string.IsNullOrWhiteSpace(options.FromName) ? "ProjectX" : options.FromName.Trim(),
            EnableSsl = options.EnableSsl
        };
    }

    /// <summary>Текст ошибки для UI: разворачиваем ошибки MailKit в подсказку, что именно чинить.</summary>
    private static string Describe(Exception ex, SmtpSettings cfg) => ex switch
    {
        AuthenticationException =>
            $"authentication rejected by {cfg.Host} — check username and password (for Gmail/Microsoft use an app password).",
        SslHandshakeException =>
            $"TLS handshake with {cfg.Host}:{cfg.Port} failed — port {cfg.Port} expects "
            + $"{(ImplicitSslPorts.Contains(cfg.Port) ? "STARTTLS (try 587)" : "implicit SSL (try 465)")}, or the certificate is untrusted.",
        SmtpCommandException smtp => $"server rejected {smtp.ErrorCode} ({smtp.StatusCode}): {smtp.Message}",
        SmtpProtocolException => $"SMTP protocol error with {cfg.Host}:{cfg.Port}: {ex.Message}",
        SocketException => $"cannot reach {cfg.Host}:{cfg.Port}: {ex.Message}",
        { InnerException: not null } => ex.InnerException.Message,
        _ => ex.Message
    };

    private sealed class SmtpSettings
    {
        public string Host { get; init; } = "";
        public int Port { get; init; } = 587;
        public string Username { get; init; } = "";
        public string Password { get; init; } = "";
        public string FromAddress { get; init; } = "";
        public string FromName { get; init; } = "ProjectX";
        public bool EnableSsl { get; init; } = true;
    }
}
