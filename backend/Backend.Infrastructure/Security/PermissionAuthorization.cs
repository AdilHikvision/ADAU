using System.Security.Claims;
using Backend.Application.Security;
using Backend.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Backend.Infrastructure.Security;

/// <summary>
/// Сервис, возвращающий объединение permission'ов по всем ролям, в которых состоит пользователь.
/// Admin неявно получает ВСЕ permission'ы (минуя таблицу role_permissions) — это обеспечивает,
/// что Admin всегда может всё, даже если запись в БД была случайно удалена.
/// </summary>
public interface IPermissionService
{
    Task<IReadOnlySet<string>> GetPermissionsForUserAsync(ClaimsPrincipal user, CancellationToken ct = default);
    Task<IReadOnlySet<string>> GetPermissionsForRolesAsync(IEnumerable<string> roles, CancellationToken ct = default);
    Task<IReadOnlyCollection<string>> GetPermissionsForRoleAsync(string roleName, CancellationToken ct = default);
    Task SetPermissionsForRoleAsync(string roleName, IEnumerable<string> permissions, CancellationToken ct = default);
    /// <summary>Сбросить кэш permission'ов всех ролей. Вызывается после правки в /api/roles/{name}/permissions.</summary>
    void InvalidateCache();
}

public sealed class PermissionService(AppDbContext dbContext, IMemoryCache cache) : IPermissionService
{
    private const string CacheKey = "RolePermissions:All";

    private async Task<Dictionary<string, HashSet<string>>> LoadAllAsync(CancellationToken ct)
    {
        if (cache.TryGetValue(CacheKey, out Dictionary<string, HashSet<string>>? cached) && cached is not null)
            return cached;

        var rows = await dbContext.RolePermissions.AsNoTracking().ToListAsync(ct);
        var grouped = rows
            .GroupBy(r => r.RoleName, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(
                g => g.Key,
                g => g.Select(x => x.Permission).ToHashSet(StringComparer.OrdinalIgnoreCase),
                StringComparer.OrdinalIgnoreCase);

        cache.Set(CacheKey, grouped, TimeSpan.FromMinutes(5));
        return grouped;
    }

    public async Task<IReadOnlySet<string>> GetPermissionsForRolesAsync(IEnumerable<string> roles, CancellationToken ct = default)
    {
        var roleList = roles.Where(r => !string.IsNullOrWhiteSpace(r)).ToArray();
        if (roleList.Length == 0)
            return new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // Admin shortcut — всегда полный набор, минуя таблицу.
        if (roleList.Any(r => string.Equals(r, SystemRoles.Admin, StringComparison.OrdinalIgnoreCase)))
            return new HashSet<string>(Permissions.All, StringComparer.OrdinalIgnoreCase);

        var all = await LoadAllAsync(ct);
        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var role in roleList)
        {
            if (all.TryGetValue(role, out var perms))
                result.UnionWith(perms);
        }
        return result;
    }

    public Task<IReadOnlySet<string>> GetPermissionsForUserAsync(ClaimsPrincipal user, CancellationToken ct = default)
    {
        var roles = user.FindAll(ClaimTypes.Role).Select(c => c.Value).ToArray();
        return GetPermissionsForRolesAsync(roles, ct);
    }

    public async Task<IReadOnlyCollection<string>> GetPermissionsForRoleAsync(string roleName, CancellationToken ct = default)
    {
        if (string.Equals(roleName, SystemRoles.Admin, StringComparison.OrdinalIgnoreCase))
            return Permissions.All;

        var all = await LoadAllAsync(ct);
        return all.TryGetValue(roleName, out var perms)
            ? perms.ToArray()
            : Array.Empty<string>();
    }

    public async Task SetPermissionsForRoleAsync(string roleName, IEnumerable<string> permissions, CancellationToken ct = default)
    {
        var requested = permissions
            .Where(p => !string.IsNullOrWhiteSpace(p))
            .Where(Permissions.All.Contains)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var existing = await dbContext.RolePermissions
            .Where(r => r.RoleName == roleName)
            .ToListAsync(ct);

        var toRemove = existing
            .Where(e => !requested.Contains(e.Permission, StringComparer.OrdinalIgnoreCase))
            .ToList();
        var existingKeys = existing.Select(e => e.Permission).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var toAdd = requested
            .Where(p => !existingKeys.Contains(p))
            .Select(p => new Domain.Entities.RolePermission { RoleName = roleName, Permission = p })
            .ToList();

        if (toRemove.Count > 0) dbContext.RolePermissions.RemoveRange(toRemove);
        if (toAdd.Count > 0) dbContext.RolePermissions.AddRange(toAdd);

        if (toRemove.Count > 0 || toAdd.Count > 0)
            await dbContext.SaveChangesAsync(ct);

        InvalidateCache();
    }

    public void InvalidateCache() => cache.Remove(CacheKey);
}

public sealed class PermissionRequirement(string permission) : IAuthorizationRequirement
{
    public string Permission { get; } = permission;

    /// <summary>
    /// Разрешения, любого из которых достаточно. Имя policy вида "A|B" описывает
    /// справочник, который нужен нескольким разделам: например дерево отделов читают
    /// и кадровик, и отчёты, хотя право Departments.View есть только у первого.
    /// </summary>
    public string[] AnyOf { get; } = permission.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
}

public sealed class PermissionAuthorizationHandler : AuthorizationHandler<PermissionRequirement>
{
    protected override async Task HandleRequirementAsync(AuthorizationHandlerContext context, PermissionRequirement requirement)
    {
        if (context.User?.Identity?.IsAuthenticated != true)
            return;

        // Admin shortcut без обращения к БД.
        if (context.User.IsInRole(SystemRoles.Admin))
        {
            context.Succeed(requirement);
            return;
        }

        IPermissionService? service = null;
        if (context.Resource is HttpContext http)
            service = http.RequestServices.GetService<IPermissionService>();
        if (service is null) return;

        var perms = await service.GetPermissionsForUserAsync(context.User);
        foreach (var permission in requirement.AnyOf)
        {
            if (!perms.Contains(permission)) continue;
            context.Succeed(requirement);
            return;
        }
    }
}

/// <summary>
/// Динамический policy provider: имя policy = строка permission'а. Это позволяет писать
/// .RequirePermission(Permissions.X) без регистрации каждой policy руками.
/// Имя вида "A|B" — доступ по любому из перечисленных прав (см. PermissionRequirement.AnyOf).
/// </summary>
public sealed class PermissionPolicyProvider(IOptions<AuthorizationOptions> options)
    : IAuthorizationPolicyProvider
{
    private readonly DefaultAuthorizationPolicyProvider _fallback = new(options);

    public Task<AuthorizationPolicy?> GetPolicyAsync(string policyName)
    {
        var parts = policyName?.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries) ?? [];
        if (parts.Length > 0 && parts.All(Permissions.All.Contains))
        {
            var policy = new AuthorizationPolicyBuilder()
                .RequireAuthenticatedUser()
                .AddRequirements(new PermissionRequirement(policyName))
                .Build();
            return Task.FromResult<AuthorizationPolicy?>(policy);
        }
        return _fallback.GetPolicyAsync(policyName);
    }

    public Task<AuthorizationPolicy> GetDefaultPolicyAsync() => _fallback.GetDefaultPolicyAsync();
    public Task<AuthorizationPolicy?> GetFallbackPolicyAsync() => _fallback.GetFallbackPolicyAsync();
}

public static class PermissionEndpointExtensions
{
    /// <summary>Шорткат для .RequireAuthorization(Permissions.X) — читается как RequirePermission.</summary>
    public static TBuilder RequirePermission<TBuilder>(this TBuilder builder, string permission)
        where TBuilder : Microsoft.AspNetCore.Builder.IEndpointConventionBuilder
    {
        return Microsoft.AspNetCore.Builder.AuthorizationEndpointConventionBuilderExtensions
            .RequireAuthorization(builder, permission);
    }
}
