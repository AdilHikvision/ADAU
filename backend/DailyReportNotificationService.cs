using Backend.Domain.Entities;

/// <summary>Генерирует broadcast-уведомление о посещаемости за прошедший день каждую ночь в 00:30 UTC.</summary>
public sealed class DailyReportNotificationService(
    INotificationService notificationService,
    ILogger<DailyReportNotificationService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("DailyReportNotificationService started.");
        while (!stoppingToken.IsCancellationRequested)
        {
            var now = DateTime.UtcNow;
            // Next fire at 00:30 UTC
            var nextFire = now.Date.AddDays(1).AddMinutes(30);
            var delay = nextFire - now;
            if (delay < TimeSpan.Zero) delay = TimeSpan.Zero;

            try { await Task.Delay(delay, stoppingToken); }
            catch (OperationCanceledException) { break; }

            try { await GenerateAsync(stoppingToken); }
            catch (Exception ex) { logger.LogError(ex, "Error generating daily attendance report notification."); }
        }
    }

    private async Task GenerateAsync(CancellationToken ct)
    {
        var yesterday = DateTime.UtcNow.Date.AddDays(-1);
        var date = yesterday.ToString("dd.MM.yyyy");

        static string N(string key, object? p = null) =>
            System.Text.Json.JsonSerializer.Serialize(new { k = key, p });

        // Уведомление сообщает только то, что отчёт за день составлен: строка со сводкой
        // «присутствовало / отсутствовало» убрана — цифры смотрят в самом отчёте.
        await notificationService.CreateAsync(
            NotificationTypes.DailyReport,
            N("notifications.titles.dailyReport", new { date }),
            string.Empty,
            ct: ct);

        logger.LogInformation("Daily report notification sent for {Date}.", date);
    }
}
