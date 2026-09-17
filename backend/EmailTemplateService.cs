using System.Text.Json;
using System.Text.RegularExpressions;
using Backend.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

public sealed class EmailTemplateService(IServiceScopeFactory scopeFactory) : IEmailTemplateService
{
    // ── Catalogue ─────────────────────────────────────────────────────────────

    private static readonly Dictionary<string, (string Name, string Description, string[] Variables)> Catalogue = new()
    {
        ["password_reset"] = (
            "Password Reset",
            "Sent when a user requests a password reset link/token.",
            ["{{firstName}}", "{{token}}", "{{companyName}}"]),

        ["selfservice_created"] = (
            "Self-Service Account Created",
            "Sent to an employee when their self-service portal account is created with a temporary password.",
            ["{{firstName}}", "{{lastName}}", "{{email}}", "{{password}}", "{{companyName}}"]),

        ["attendance_report"] = (
            "Attendance Report",
            "Sent when a manager exports the attendance report for a period.",
            ["{{companyName}}", "{{fromDate}}", "{{toDate}}", "{{tableHead}}", "{{tableRows}}", "{{generatedAt}}"]),

        ["payroll_report"] = (
            "Payroll Report",
            "Sent when a manager exports a payroll period summary.",
            ["{{companyName}}", "{{month}}", "{{year}}", "{{status}}", "{{employeeCount}}", "{{totalGross}}", "{{totalTax}}", "{{totalNet}}", "{{tableRows}}", "{{generatedAt}}"]),
    };

    // ── Default templates ─────────────────────────────────────────────────────

    public (string Subject, string Body) GetDefault(string key) => key switch
    {
        "password_reset" => (
            "Password Reset — {{companyName}}",
            """
            <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:32px 16px">
              <h2 style="color:#1e293b;margin:0 0 8px">Password Reset</h2>
              <p style="color:#475569;margin:0 0 24px">Hello <strong>{{firstName}}</strong>,</p>
              <p style="color:#475569;margin:0 0 16px">Use the token below to reset your password. It expires shortly.</p>
              <div style="background:#f1f5f9;border-radius:12px;padding:20px;text-align:center;font-size:22px;font-weight:700;letter-spacing:4px;color:#1e293b;margin:0 0 24px">
                {{token}}
              </div>
              <p style="color:#94a3b8;font-size:12px;margin:0">If you did not request a password reset, you can ignore this email.</p>
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
              <p style="color:#cbd5e1;font-size:11px;margin:0">{{companyName}}</p>
            </div>
            """),

        "selfservice_created" => (
            "Your Self-Service Portal Access — {{companyName}}",
            """
            <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:32px 16px">
              <h2 style="color:#1e293b;margin:0 0 8px">Welcome to the Self-Service Portal</h2>
              <p style="color:#475569;margin:0 0 24px">Hello <strong>{{firstName}} {{lastName}}</strong>,</p>
              <p style="color:#475569;margin:0 0 16px">Your account has been created. Use the credentials below to sign in for the first time.</p>
              <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:10px;overflow:hidden;margin:0 0 20px">
                <tr>
                  <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;font-weight:700">Email</td>
                  <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;font-weight:600;color:#1e293b">{{email}}</td>
                </tr>
                <tr>
                  <td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;font-weight:700">Temporary Password</td>
                  <td style="padding:12px 16px;font-weight:700;font-size:18px;letter-spacing:2px;color:#1e293b">{{password}}</td>
                </tr>
              </table>
              <p style="color:#dc2626;font-weight:600;font-size:13px;margin:0 0 24px">⚠ You will be required to set a new password on your first login.</p>
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
              <p style="color:#cbd5e1;font-size:11px;margin:0">{{companyName}}</p>
            </div>
            """),

        "attendance_report" => (
            "Attendance Report {{fromDate}}–{{toDate}}",
            """
            <div style="font-family:sans-serif;max-width:960px;margin:auto;padding:32px 16px">
              <h2 style="color:#1e293b;margin:0 0 4px">{{companyName}} — Attendance Report</h2>
              <p style="color:#64748b;margin:0 0 24px">{{fromDate}} — {{toDate}}</p>
              <table style="width:100%;border-collapse:collapse;font-size:13px">
                <thead>
                  <tr style="background:#f1f5f9">
                    {{tableHead}}
                  </tr>
                </thead>
                <tbody>{{tableRows}}</tbody>
              </table>
              <p style="color:#94a3b8;font-size:11px;margin:24px 0 0">Generated by {{companyName}} · {{generatedAt}}</p>
            </div>
            """),

        "payroll_report" => (
            "Payroll Report — {{month}} {{year}}",
            """
            <div style="font-family:sans-serif;max-width:960px;margin:auto;padding:32px 16px">
              <h2 style="color:#1e293b;margin:0 0 4px">{{companyName}} — Payroll Report</h2>
              <p style="color:#64748b;margin:0 0 20px">{{month}} {{year}} · Status: <strong>{{status}}</strong></p>
              <table style="border-collapse:collapse;font-size:13px;margin:0 0 24px">
                <tr><td style="padding:4px 16px 4px 0;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:1px">Employees</td><td style="font-weight:600;color:#1e293b">{{employeeCount}}</td></tr>
                <tr><td style="padding:4px 16px 4px 0;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:1px">Total Gross</td><td style="font-weight:600;color:#1e293b">{{totalGross}}</td></tr>
                <tr><td style="padding:4px 16px 4px 0;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:1px">Total Tax</td><td style="font-weight:600;color:#1e293b">{{totalTax}}</td></tr>
                <tr><td style="padding:4px 16px 4px 0;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:1px">Total Net</td><td style="font-weight:700;color:#16a34a;font-size:15px">{{totalNet}}</td></tr>
              </table>
              <table style="width:100%;border-collapse:collapse;font-size:13px">
                <thead>
                  <tr style="background:#f1f5f9">
                    <th style="padding:9px 12px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#64748b;font-weight:700;border-bottom:2px solid #e2e8f0">Employee</th>
                    <th style="padding:9px 12px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#64748b;font-weight:700;border-bottom:2px solid #e2e8f0">Department</th>
                    <th style="padding:9px 12px;text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#64748b;font-weight:700;border-bottom:2px solid #e2e8f0">Days</th>
                    <th style="padding:9px 12px;text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#64748b;font-weight:700;border-bottom:2px solid #e2e8f0">Hours</th>
                    <th style="padding:9px 12px;text-align:right;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#64748b;font-weight:700;border-bottom:2px solid #e2e8f0">Base</th>
                    <th style="padding:9px 12px;text-align:right;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#64748b;font-weight:700;border-bottom:2px solid #e2e8f0">Gross</th>
                    <th style="padding:9px 12px;text-align:right;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#64748b;font-weight:700;border-bottom:2px solid #e2e8f0">Tax</th>
                    <th style="padding:9px 12px;text-align:right;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#64748b;font-weight:700;border-bottom:2px solid #e2e8f0">Net</th>
                  </tr>
                </thead>
                <tbody>{{tableRows}}</tbody>
              </table>
              <p style="color:#94a3b8;font-size:11px;margin:24px 0 0">Generated by {{companyName}} · {{generatedAt}}</p>
            </div>
            """),

        _ => throw new KeyNotFoundException($"Unknown email template key: {key}")
    };

    public bool Exists(string key) => Catalogue.ContainsKey(key);

    // ── Persistence helpers ───────────────────────────────────────────────────

    private static string SettingKey(string templateKey) => $"EmailTemplate:{templateKey}";

    private async Task<(string? Subject, string? Body)> LoadCustomAsync(string key, AppDbContext db, CancellationToken ct)
    {
        var row = await db.SystemSettings.AsNoTracking()
            .FirstOrDefaultAsync(x => x.Key == SettingKey(key), ct);
        if (row?.Value is null) return (null, null);
        try
        {
            var doc = JsonDocument.Parse(row.Value);
            var subject = doc.RootElement.GetProperty("subject").GetString();
            var body = doc.RootElement.GetProperty("body").GetString();
            return (subject, body);
        }
        catch { return (null, null); }
    }

    // ── Interface ─────────────────────────────────────────────────────────────

    public async Task<List<EmailTemplateDto>> GetAllAsync(CancellationToken ct = default)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var keys = Catalogue.Keys.Select(SettingKey).ToArray();
        var rows = await db.SystemSettings.AsNoTracking().Where(x => keys.Contains(x.Key)).ToListAsync(ct);
        var stored = rows.ToDictionary(x => x.Key, x => x.Value);

        return Catalogue.Select(kvp =>
        {
            var (name, desc, vars) = kvp.Value;
            var (defSubj, defBody) = GetDefault(kvp.Key);
            string subject = defSubj, body = defBody;
            bool isCustomized = false;

            if (stored.TryGetValue(SettingKey(kvp.Key), out var json) && json is not null)
            {
                try
                {
                    var doc = JsonDocument.Parse(json);
                    subject = doc.RootElement.GetProperty("subject").GetString() ?? defSubj;
                    body = doc.RootElement.GetProperty("body").GetString() ?? defBody;
                    isCustomized = true;
                }
                catch { /* use defaults */ }
            }
            return new EmailTemplateDto(kvp.Key, name, desc, subject, body, vars, isCustomized);
        }).ToList();
    }

    public async Task<EmailTemplateDto> GetAsync(string key, CancellationToken ct = default)
    {
        if (!Catalogue.TryGetValue(key, out var meta))
            throw new KeyNotFoundException($"Unknown template: {key}");

        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var (name, desc, vars) = meta;
        var (defSubj, defBody) = GetDefault(key);
        var (custSubj, custBody) = await LoadCustomAsync(key, db, ct);

        return new EmailTemplateDto(
            key, name, desc,
            custSubj ?? defSubj,
            custBody ?? defBody,
            vars,
            custSubj is not null || custBody is not null);
    }

    public async Task SaveAsync(string key, string subject, string htmlBody, CancellationToken ct = default)
    {
        if (!Catalogue.ContainsKey(key)) throw new KeyNotFoundException($"Unknown template: {key}");

        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var settingKey = SettingKey(key);
        var json = JsonSerializer.Serialize(new { subject, body = htmlBody });

        var row = await db.SystemSettings.FirstOrDefaultAsync(x => x.Key == settingKey, ct);
        if (row is null)
        {
            row = new Backend.Domain.Entities.SystemSetting { Id = Guid.NewGuid(), Key = settingKey, Value = json, CreatedUtc = DateTime.UtcNow };
            db.SystemSettings.Add(row);
        }
        else
        {
            row.Value = json;
            row.UpdatedUtc = DateTime.UtcNow;
        }
        await db.SaveChangesAsync(ct);
    }

    public async Task ResetAsync(string key, CancellationToken ct = default)
    {
        if (!Catalogue.ContainsKey(key)) throw new KeyNotFoundException($"Unknown template: {key}");

        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var row = await db.SystemSettings.FirstOrDefaultAsync(x => x.Key == SettingKey(key), ct);
        if (row is not null)
        {
            db.SystemSettings.Remove(row);
            await db.SaveChangesAsync(ct);
        }
    }

    public async Task<(string Subject, string Body)> RenderAsync(string key, Dictionary<string, string> variables, CancellationToken ct = default)
    {
        var template = await GetAsync(key, ct);
        var subject = Render(template.Subject, variables);
        var body = Render(template.HtmlBody, variables);
        return (subject, body);
    }

    private static string Render(string template, Dictionary<string, string> vars)
    {
        return Regex.Replace(template, @"\{\{(\w+)\}\}", m =>
        {
            var varName = "{{" + m.Groups[1].Value + "}}";
            return vars.TryGetValue(varName, out var val) ? val : m.Value;
        });
    }
}
