using Backend.Domain.Entities;
using Backend.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace Backend.Infrastructure.Devices.Services;

/// <summary>
/// Сохранение в базу того, что захвачено на устройстве, — одно для терминалов и станций регистрации.
/// На устройства отсюда ничего не пишется: туда данные уходят при синхронизации профиля.
/// </summary>
public sealed class CapturedCredentialStore(
    AppDbContext dbContext,
    IConfiguration configuration,
    ILogger<CapturedCredentialStore> logger)
{
    /// <summary>Сохраняет снимок лица; прежние лица человека (и их файлы) удаляются — хранится одно.</summary>
    public async Task<Guid> SaveFaceAsync(Guid personId, string personType, byte[] image, CancellationToken cancellationToken)
    {
        var facesPath = configuration["Storage:FacesPath"]
            ?? Path.Combine(AppContext.BaseDirectory, "uploads", "faces");
        Directory.CreateDirectory(facesPath);
        var fileName = $"{Guid.NewGuid():N}.jpg";
        await File.WriteAllBytesAsync(Path.Combine(facesPath, fileName), image, cancellationToken);

        var oldFaces = personType switch
        {
            "employee" => await dbContext.Faces.Where(f => f.EmployeeId == personId).ToListAsync(cancellationToken),
            "gymcustomer" => await dbContext.Faces.Where(f => f.GymCustomerId == personId).ToListAsync(cancellationToken),
            _ => await dbContext.Faces.Where(f => f.VisitorId == personId).ToListAsync(cancellationToken),
        };
        if (oldFaces.Count > 0)
        {
            dbContext.Faces.RemoveRange(oldFaces);
            foreach (var old in oldFaces)
            {
                try
                {
                    var oldPath = Path.Combine(facesPath, old.FilePath.TrimStart('/', '\\'));
                    if (File.Exists(oldPath)) File.Delete(oldPath);
                }
                catch (Exception ex)
                {
                    logger.LogDebug(ex, "Delete old face file {FilePath}", old.FilePath);
                }
            }
        }

        var face = new Face
        {
            Id = Guid.NewGuid(),
            EmployeeId = personType == "employee" ? personId : null,
            VisitorId = personType == "visitor" ? personId : null,
            GymCustomerId = personType == "gymcustomer" ? personId : null,
            FilePath = fileName,
            FDID = 1,
            CreatedUtc = DateTime.UtcNow
        };
        dbContext.Faces.Add(face);
        await dbContext.SaveChangesAsync(cancellationToken);
        return face.Id;
    }

    public async Task<Guid> SaveFingerprintAsync(Guid personId, string personType, int fingerIndex, byte[] template, CancellationToken cancellationToken)
    {
        var fingerprint = new Fingerprint
        {
            Id = Guid.NewGuid(),
            EmployeeId = personType == "employee" ? personId : null,
            VisitorId = personType == "visitor" ? personId : null,
            GymCustomerId = personType == "gymcustomer" ? personId : null,
            TemplateData = template,
            FingerIndex = fingerIndex,
            CreatedUtc = DateTime.UtcNow
        };
        dbContext.Fingerprints.Add(fingerprint);
        await dbContext.SaveChangesAsync(cancellationToken);
        return fingerprint.Id;
    }

    /// <summary>Номер карты уникален в системе: занятый номер — ошибка, а не перепривязка.</summary>
    public async Task<(bool Success, string? Error, Guid? CardId)> SaveCardAsync(Guid personId, string personType, string cardNo, CancellationToken cancellationToken)
    {
        if (await dbContext.Cards.AnyAsync(c => c.CardNo == cardNo, cancellationToken))
            return (false, "Карта с таким номером уже зарегистрирована.", null);

        var card = new Card
        {
            Id = Guid.NewGuid(),
            EmployeeId = personType == "employee" ? personId : null,
            VisitorId = personType == "visitor" ? personId : null,
            GymCustomerId = personType == "gymcustomer" ? personId : null,
            CardNo = cardNo,
            CardNumber = null,
            CreatedUtc = DateTime.UtcNow
        };
        dbContext.Cards.Add(card);
        await dbContext.SaveChangesAsync(cancellationToken);
        return (true, null, card.Id);
    }
}
