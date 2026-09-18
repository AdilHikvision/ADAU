using System.Net;
using System.Net.Sockets;

namespace Backend.Infrastructure.Devices;

/// <summary>
/// Быстрая проверка доступности устройства перед ISAPI-запросом.
/// Windows — ARP (как и раньше), остальные ОС — TCP-подключение к порту устройства.
/// ARP (SendARP) есть только в Win32, а ICMP-ping на Linux требует root или настройки
/// net.ipv4.ping_group_range; TCP-connect работает от обычного пользователя, под которым
/// и запускается служба. Проверяется тот же порт, на который потом идёт ISAPI-запрос,
/// поэтому отказ здесь означает, что и проверка учётных данных не прошла бы.
/// </summary>
public static class DeviceReachabilityHelper
{
    /// <summary>
    /// Возвращает true, если устройство ответило. Отмена службы пробрасывается наверх,
    /// истечение <paramref name="timeout"/> — это просто «недоступно».
    /// </summary>
    public static async Task<bool> IsReachableAsync(
        string ipAddress,
        int port,
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        if (OperatingSystem.IsWindows())
        {
            return ArpReachabilityHelper.IsReachable(ipAddress);
        }

        if (string.IsNullOrWhiteSpace(ipAddress) || port <= 0 || port > 65535)
        {
            return false;
        }

        if (!IPAddress.TryParse(ipAddress.Trim(), out var ip))
        {
            return false;
        }

        using var client = new TcpClient(ip.AddressFamily);
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(timeout);

        try
        {
            await client.ConnectAsync(ip, port, timeoutCts.Token);
            return true;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return false;
        }
        catch (SocketException)
        {
            return false;
        }
    }
}
