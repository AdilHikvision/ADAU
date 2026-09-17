using Backend.Domain.Entities;
using Backend.Infrastructure.Persistence;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

/// <remarks>
/// Про <c>includeBroadcasts</c>: уведомления с <c>UserId == null</c> — это рассылка
/// администраторам и согласующим (ежедневный отчёт, парковка, устройство offline,
/// «сотрудник подал заявку»). Админ-панель их показывает, self-service — нет:
/// сотруднику адресованы только персональные уведомления об одобрении и отклонении
/// его собственных заявок. Поэтому эндпоинты /api/self-service/notifications/*
/// передают сюда <c>includeBroadcasts: false</c>.
/// </remarks>
public interface INotificationService
{
    Task CreateAsync(string type, string title, string body, Guid? userId = null, string? referenceId = null, CancellationToken ct = default);
    Task<List<AppNotificationDto>> GetForUserAsync(Guid userId, int limit = 50, bool includeBroadcasts = true, CancellationToken ct = default);
    Task<int> GetUnreadCountAsync(Guid userId, bool includeBroadcasts = true, CancellationToken ct = default);
    Task MarkReadAsync(Guid notificationId, Guid userId, bool includeBroadcasts = true, CancellationToken ct = default);
    Task MarkAllReadAsync(Guid userId, bool includeBroadcasts = true, CancellationToken ct = default);
}

public sealed record AppNotificationDto(
    Guid Id,
    string Type,
    string Title,
    string Body,
    bool IsRead,
    DateTime CreatedAtUtc,
    string? ReferenceId,
    bool IsBroadcast);

public sealed class NotificationService(IServiceScopeFactory scopeFactory, IHubContext<DevicesHub> hub) : INotificationService
{
    public async Task CreateAsync(string type, string title, string body, Guid? userId = null, string? referenceId = null, CancellationToken ct = default)
    {
        var notification = new Notification
        {
            UserId = userId,
            Type = type,
            Title = title,
            Body = body,
            ReferenceId = referenceId,
            IsRead = false,
        };

        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.Notifications.Add(notification);
        await db.SaveChangesAsync(ct);

        var dto = new AppNotificationDto(notification.Id, type, title, body, false, notification.CreatedUtc, referenceId, userId is null);

        if (userId is null)
            await hub.Clients.All.SendAsync("ReceiveNotification", dto, ct);
        else
            await hub.Clients.User(userId.ToString()!).SendAsync("ReceiveNotification", dto, ct);
    }

    public async Task<List<AppNotificationDto>> GetForUserAsync(Guid userId, int limit = 50, bool includeBroadcasts = true, CancellationToken ct = default)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var personal = await db.Notifications
            .AsNoTracking()
            .Where(n => n.UserId == userId)
            .OrderByDescending(n => n.CreatedUtc)
            .Take(limit)
            .Select(n => new AppNotificationDto(n.Id, n.Type, n.Title, n.Body, n.IsRead, n.CreatedUtc, n.ReferenceId, false))
            .ToListAsync(ct);

        if (!includeBroadcasts) return personal;

        var broadcasts = await db.Notifications
            .AsNoTracking()
            .Where(n => n.UserId == null)
            .OrderByDescending(n => n.CreatedUtc)
            .Take(limit)
            .ToListAsync(ct);

        var broadcastIds = broadcasts.Select(b => b.Id).ToList();
        var readIds = await db.NotificationReads
            .AsNoTracking()
            .Where(r => r.UserId == userId && broadcastIds.Contains(r.NotificationId))
            .Select(r => r.NotificationId)
            .ToHashSetAsync(ct);

        var broadcastDtos = broadcasts
            .Select(b => new AppNotificationDto(b.Id, b.Type, b.Title, b.Body, readIds.Contains(b.Id), b.CreatedUtc, b.ReferenceId, true));

        return personal
            .Concat(broadcastDtos)
            .OrderByDescending(n => n.CreatedAtUtc)
            .Take(limit)
            .ToList();
    }

    public async Task<int> GetUnreadCountAsync(Guid userId, bool includeBroadcasts = true, CancellationToken ct = default)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var personalUnread = await db.Notifications
            .AsNoTracking()
            .CountAsync(n => n.UserId == userId && !n.IsRead, ct);

        // Счётчик обязан считать ровно то, что попадёт в список, иначе бейдж
        // покажет число, которого пользователь у себя не найдёт.
        if (!includeBroadcasts) return personalUnread;

        var broadcastUnread = await db.Notifications
            .AsNoTracking()
            .CountAsync(n => n.UserId == null &&
                !db.NotificationReads.Any(r => r.UserId == userId && r.NotificationId == n.Id), ct);

        return personalUnread + broadcastUnread;
    }

    public async Task MarkReadAsync(Guid notificationId, Guid userId, bool includeBroadcasts = true, CancellationToken ct = default)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var notification = await db.Notifications.FindAsync([notificationId], ct);
        if (notification is null) return;

        if (notification.UserId == userId)
        {
            notification.IsRead = true;
            await db.SaveChangesAsync(ct);
        }
        // Из self-service рассылку не гасим: она сотруднику не показывалась, а
        // отметка «прочитано» скрыла бы её в админ-панели того же пользователя.
        else if (notification.UserId is null && includeBroadcasts)
        {
            var exists = await db.NotificationReads.AnyAsync(
                r => r.NotificationId == notificationId && r.UserId == userId, ct);
            if (!exists)
            {
                db.NotificationReads.Add(new NotificationRead { NotificationId = notificationId, UserId = userId });
                await db.SaveChangesAsync(ct);
            }
        }
    }

    public async Task MarkAllReadAsync(Guid userId, bool includeBroadcasts = true, CancellationToken ct = default)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        await db.Notifications
            .Where(n => n.UserId == userId && !n.IsRead)
            .ExecuteUpdateAsync(s => s.SetProperty(n => n.IsRead, true), ct);

        if (!includeBroadcasts) return;

        var broadcastIds = await db.Notifications
            .AsNoTracking()
            .Where(n => n.UserId == null)
            .Select(n => n.Id)
            .ToListAsync(ct);

        var alreadyRead = await db.NotificationReads
            .AsNoTracking()
            .Where(r => r.UserId == userId)
            .Select(r => r.NotificationId)
            .ToHashSetAsync(ct);

        var toInsert = broadcastIds
            .Where(id => !alreadyRead.Contains(id))
            .Select(id => new NotificationRead { NotificationId = id, UserId = userId })
            .ToList();

        if (toInsert.Count > 0)
        {
            db.NotificationReads.AddRange(toInsert);
            await db.SaveChangesAsync(ct);
        }
    }
}
