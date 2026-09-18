using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;

namespace Backend.Infrastructure.Security;

/// <summary>
/// Самоподписанный сертификат для nginx: доступ по локальной сети переводится на https.
/// Без него браузер считает страницу незащищённым контекстом и отключает камеру,
/// геолокацию и буфер обмена (см. frontend/src/lib/clipboard.ts).
///
/// PEM пишет бэкенд, а не установочный скрипт: скрипты выполняет Windows PowerShell 5.1,
/// где нет ни openssl, ни готового экспорта закрытого ключа в PEM, а .NET это умеет.
/// </summary>
public static class SelfSignedCertificateGenerator
{
    /// <summary>Имена и адреса, под которыми сервер открывают: localhost, имя машины и её адреса в сети.</summary>
    public static IReadOnlyList<string> LocalHostNames()
    {
        var names = new List<string> { "localhost", "127.0.0.1", "::1" };

        try
        {
            var hostName = Dns.GetHostName();
            if (!string.IsNullOrWhiteSpace(hostName)) names.Add(hostName);
        }
        catch { /* имя машины недоступно — хватит адресов */ }

        try
        {
            foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (nic.OperationalStatus != OperationalStatus.Up) continue;
                if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                foreach (var addr in nic.GetIPProperties().UnicastAddresses)
                {
                    if (addr.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                    names.Add(addr.Address.ToString());
                }
            }
        }
        catch { /* перечисление интерфейсов не удалось — останутся localhost и переданные вручную */ }

        return names.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>
    /// Пишет server.crt и server.key в <paramref name="outputDir"/>. Возвращает пути к ним.
    /// Существующие файлы не трогает: сертификат уже принят в браузерах, перевыпуск заставил бы
    /// принимать заново. Для перевыпуска достаточно удалить файлы и повторить установку.
    /// </summary>
    public static (string CertPath, string KeyPath) EnsureCertificate(
        string outputDir,
        IEnumerable<string>? extraHosts = null,
        int validYears = 5)
    {
        Directory.CreateDirectory(outputDir);
        var certPath = Path.Combine(outputDir, "server.crt");
        var keyPath = Path.Combine(outputDir, "server.key");
        if (File.Exists(certPath) && File.Exists(keyPath)) return (certPath, keyPath);

        var hosts = LocalHostNames().Concat(extraHosts ?? [])
            .Where(h => !string.IsNullOrWhiteSpace(h))
            .Select(h => h.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        using var rsa = RSA.Create(2048);
        var request = new CertificateRequest(
            new X500DistinguishedName("CN=ProjectX LAN"),
            rsa,
            HashAlgorithmName.SHA256,
            RSASignaturePadding.Pkcs1);

        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(
            X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, critical: true));
        // serverAuth — без него Chrome не примет сертификат даже после подтверждения.
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(
            [new Oid("1.3.6.1.5.5.7.3.1")], critical: false));

        var san = new SubjectAlternativeNameBuilder();
        foreach (var host in hosts)
        {
            if (IPAddress.TryParse(host, out var ip)) san.AddIpAddress(ip);
            else san.AddDnsName(host);
        }
        request.CertificateExtensions.Add(san.Build());

        var now = DateTimeOffset.UtcNow;
        using var certificate = request.CreateSelfSigned(now.AddDays(-1), now.AddYears(validYears));

        File.WriteAllText(certPath, certificate.ExportCertificatePem());
        File.WriteAllText(keyPath, rsa.ExportPkcs8PrivateKeyPem());
        RestrictKeyAccess(keyPath);

        return (certPath, keyPath);
    }

    /// <summary>Закрытый ключ лежит в ProgramData, куда по умолчанию читают все пользователи:
    /// оставляем доступ только SYSTEM и администраторам.</summary>
    private static void RestrictKeyAccess(string keyPath)
    {
        if (!OperatingSystem.IsWindows()) return;
        try
        {
            var info = new FileInfo(keyPath);
            var security = info.GetAccessControl();
            security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
            foreach (var sid in new[] { WellKnownSidType.LocalSystemSid, WellKnownSidType.BuiltinAdministratorsSid })
            {
                security.AddAccessRule(new FileSystemAccessRule(
                    new SecurityIdentifier(sid, null),
                    FileSystemRights.FullControl,
                    AccessControlType.Allow));
            }
            info.SetAccessControl(security);
        }
        catch { /* права не ужались — файл всё равно создан, установку не валим */ }
    }
}
