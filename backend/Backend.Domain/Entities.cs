namespace Backend.Domain.Entities;

public abstract class BaseEntity
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
    public DateTime? UpdatedUtc { get; set; }
}

public enum DeviceType
{
    AccessController = 1,
    Intercom = 2,
    AttendanceTerminal = 3,
    /// <summary>Контроллер лифта (этажи ISAPI = doorID, вызов — RemoteControl).</summary>
    ElevatorController = 4,
    /// <summary>Энроллер-станция (DS-K1F…): захват лиц/карт/отпечатков по ISAPI Enroller; без онлайн UserInfo как у дверного терминала.</summary>
    EnrollerStation = 5,
    /// <summary>ANPR (nömrə tanıma) kamera — parking giriş/çıxış; ISAPI Vehicle Access.</summary>
    AnprCamera = 6
}

public sealed class DeviceStatus : BaseEntity
{
    public string Code { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public ICollection<Device> Devices { get; set; } = new List<Device>();
}

public sealed class Device : BaseEntity
{
    public string DeviceIdentifier { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string IpAddress { get; set; } = string.Empty;
    public int Port { get; set; } = 8000;
    public string? Location { get; set; }
    public DeviceType DeviceType { get; set; } = DeviceType.AccessController;
    public DateTime? LastSeenUtc { get; set; }

    /// <summary>Логин для подключения к устройству. null — использовать глобальный конфиг.</summary>
    public string? Username { get; set; }
    /// <summary>Пароль для подключения к устройству. null — использовать глобальный конфиг.</summary>
    public string? Password { get; set; }

    public Guid DeviceStatusId { get; set; }
    public DeviceStatus? DeviceStatus { get; set; }
    public ICollection<AccessLevelDoor> AccessLevelDoors { get; set; } = new List<AccessLevelDoor>();

    /// <summary>
    /// Что проход через это устройство означает для табеля. Both — прежнее
    /// поведение: первое событие за день считается приходом, последнее уходом.
    /// In/Out задают, когда вход и выход разведены на разные считыватели.
    /// </summary>
    public AttendanceDirection AttendanceDirection { get; set; } = AttendanceDirection.Both;

    /// <summary>Для ANPR-камеры: снимает въезд или выезд. null — определять по открытой сессии.</summary>
    public ParkingCameraDirection? ParkingDirection { get; set; }
    /// <summary>Для ANPR-камеры: зона парковки, к которой относится проезд.</summary>
    public Guid? ParkingZoneId { get; set; }
    /// <summary>
    /// Для ANPR-камеры: номер релейного выхода, которым открывается шлагбаум.
    /// null или 0 — сервер шлагбаумом не управляет (камера открывает его сама).
    /// </summary>
    public int? BarrierOutput { get; set; }
}

/// <summary>Направление проезда, которое снимает ANPR-камера.</summary>
public enum ParkingCameraDirection
{
    Entry = 1,
    Exit = 2
}

/// <summary>
/// Что считыватель фиксирует для табеля. Значение по умолчанию — Both, поэтому
/// уже заведённые устройства продолжают работать как раньше, пока направление
/// не задано явно.
/// </summary>
public enum AttendanceDirection
{
    /// <summary>И приход, и уход: первый проход за день — приход, последний — уход.</summary>
    Both = 0,
    /// <summary>Только приход. Проход через такое устройство никогда не закрывает день.</summary>
    In = 1,
    /// <summary>Только уход. Проход через такое устройство никогда не открывает день.</summary>
    Out = 2
}

/// <summary>Компания или холдинг.</summary>
public sealed class Company : BaseEntity
{
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public ICollection<Department> Departments { get; set; } = new List<Department>();
    public ICollection<Employee> Employees { get; set; } = new List<Employee>();
    public ICollection<Visitor> Visitors { get; set; } = new List<Visitor>();
}

/// <summary>Системные настройки (режим работы, и т.д.).</summary>
public sealed class SystemSetting : BaseEntity
{
    public string Key { get; set; } = string.Empty;
    public string? Value { get; set; }
}

/// <summary>Отдел компании (древовидная структура).</summary>
public sealed class Department : BaseEntity
{
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public int SortOrder { get; set; }

    public Guid? CompanyId { get; set; }
    public Company? Company { get; set; }

    public Guid? ParentId { get; set; }
    public Department? Parent { get; set; }
    public ICollection<Department> Children { get; set; } = new List<Department>();

    public ICollection<Employee> Employees { get; set; } = new List<Employee>();
    public ICollection<Visitor> Visitors { get; set; } = new List<Visitor>();
}

/// <summary>Узел структуры ЖКХ: комплекс, корпус, подъезд, этаж — глубина произвольная,
/// как у департаментов. Жилец привязывается к листу или к любому узлу выше.</summary>
public sealed class HousingBlock : BaseEntity
{
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public int SortOrder { get; set; }

    public Guid? ParentId { get; set; }
    public HousingBlock? Parent { get; set; }
    public ICollection<HousingBlock> Children { get; set; } = new List<HousingBlock>();

    public ICollection<Employee> Residents { get; set; } = new List<Employee>();
}

/// <summary>Должность (vəzifə) — плоский справочник, назначается сотруднику.</summary>
public sealed class Position : BaseEntity
{
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public int SortOrder { get; set; }

    public ICollection<Employee> Employees { get; set; } = new List<Employee>();
}

public sealed class AccessLevel : BaseEntity
{
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }

    public ICollection<EmployeeAccessLevel> EmployeeAccessLevels { get; set; } = new List<EmployeeAccessLevel>();
    public ICollection<VisitorAccessLevel> VisitorAccessLevels { get; set; } = new List<VisitorAccessLevel>();
    public ICollection<AccessLevelDoor> Doors { get; set; } = new List<AccessLevelDoor>();
}

/// <summary>Привязка уровня доступа к двери устройства (DeviceId + DoorIndex, 0-based).</summary>
public sealed class AccessLevelDoor
{
    public Guid AccessLevelId { get; set; }
    public AccessLevel? AccessLevel { get; set; }

    public Guid DeviceId { get; set; }
    public Device? Device { get; set; }

    /// <summary>Номер двери на устройстве (0-based, dwDoorNo в Hikvision SDK).</summary>
    public int DoorIndex { get; set; }
}

/// <summary>Кто эта запись в таблице Employees. Жилец живёт здесь же, а не отдельной
/// сущностью: на устройство он уходит тем же normal user, что и работник, и пользуется
/// теми же картами, лицами, отпечатками и уровнями доступа. Отличает их только вкладка.</summary>
public enum PersonKind
{
    /// <summary>Штатный работник — режим «Компания» и обычный набор функций.</summary>
    Employee = 0,
    /// <summary>Жилец — только режим ЖКХ. В табель, смены и зарплату не попадает.</summary>
    Resident = 1,
}

public sealed class Employee : BaseEntity
{
    /// <summary>Работник или жилец. Разделение вкладок «Работники»/«Жильцы» идёт по этому полю.</summary>
    public PersonKind Kind { get; set; } = PersonKind.Employee;
    /// <summary>ЖКХ: номер квартиры. Только для Kind = Resident.</summary>
    public string? Apartment { get; set; }
    /// <summary>ЖКХ: узел структуры (корпус/подъезд). Только для Kind = Resident.</summary>
    public Guid? HousingBlockId { get; set; }
    public HousingBlock? HousingBlock { get; set; }
    public string FirstName { get; set; } = string.Empty;
    public string LastName { get; set; } = string.Empty;
    /// <summary>Идентификатор для устройств Hikvision (employeeNo, до 32 байт). Генерируется системой автоматически из Id.</summary>
    public string? EmployeeNo { get; set; }
    /// <summary>Пользовательский внешний идентификатор (таб. №), редактируется вручную в UI (метка «ID»). Не путать с внутренним Id или EmployeeNo. Nullable, необязательный, неуникальный.</summary>
    public string? ExternalId { get; set; }
    /// <summary>Пол: male, female, unknown.</summary>
    public string? Gender { get; set; }
    /// <summary>Начало периода действия (для ISAPI Valid).</summary>
    public DateTime? ValidFromUtc { get; set; }
    /// <summary>Конец периода действия (для ISAPI Valid).</summary>
    public DateTime? ValidToUtc { get; set; }
    public bool IsActive { get; set; } = true;
    /// <summary>Только учёт рабочего времени: true — время учитывается, дверь не открывается (ISAPI onlyVerify).</summary>
    public bool OnlyVerify { get; set; }

    public Guid? DepartmentId { get; set; }
    public Department? Department { get; set; }

    /// <summary>Должность (vəzifə).</summary>
    public Guid? PositionId { get; set; }
    public Position? Position { get; set; }

    public Guid? CompanyId { get; set; }
    public Company? Company { get; set; }

    /// <summary>Расписание работы сотрудника.</summary>
    public Guid? WorkScheduleId { get; set; }
    public WorkSchedule? WorkSchedule { get; set; }

    /// <summary>Включён ли портал самообслуживания для сотрудника.</summary>
    public bool SelfServiceEnabled { get; set; }
    /// <summary>Email для входа в портал самообслуживания.</summary>
    public string? SelfServiceEmail { get; set; }

    public ICollection<EmployeeAccessLevel> AccessLevels { get; set; } = new List<EmployeeAccessLevel>();
    public ICollection<Card> Cards { get; set; } = new List<Card>();
    public ICollection<Face> Faces { get; set; } = new List<Face>();
    public ICollection<Fingerprint> Fingerprints { get; set; } = new List<Fingerprint>();
    public ICollection<Iris> Irises { get; set; } = new List<Iris>();
    public ICollection<AttendanceRecord> AttendanceRecords { get; set; } = new List<AttendanceRecord>();
    public ICollection<AttendanceRequest> AttendanceRequests { get; set; } = new List<AttendanceRequest>();
    public ICollection<EmployeeDayPattern> DayPatterns { get; set; } = new List<EmployeeDayPattern>();
    public ICollection<EmployeeLeave> Leaves { get; set; } = new List<EmployeeLeave>();
}

public sealed class Visitor : BaseEntity
{
    public string FirstName { get; set; } = string.Empty;
    public string LastName { get; set; } = string.Empty;
    public string? DocumentNumber { get; set; }
    public DateTime? VisitDateUtc { get; set; }
    public DateTime? ValidFromUtc { get; set; }
    public DateTime? ValidToUtc { get; set; }
    public bool IsActive { get; set; } = true;

    public Guid? DepartmentId { get; set; }
    public Department? Department { get; set; }

    public Guid? CompanyId { get; set; }
    public Company? Company { get; set; }

    public ICollection<VisitorAccessLevel> AccessLevels { get; set; } = new List<VisitorAccessLevel>();
    public ICollection<Card> Cards { get; set; } = new List<Card>();
    public ICollection<Face> Faces { get; set; } = new List<Face>();
    public ICollection<Fingerprint> Fingerprints { get; set; } = new List<Fingerprint>();
    public ICollection<Iris> Irises { get; set; } = new List<Iris>();
}

/// <summary>Карта доступа, привязанная к сотруднику или посетителю.</summary>
public sealed class Card : BaseEntity
{
    public Guid? EmployeeId { get; set; }
    public Employee? Employee { get; set; }

    public Guid? VisitorId { get; set; }
    public Visitor? Visitor { get; set; }

    public Guid? GymCustomerId { get; set; }
    public GymCustomer? GymCustomer { get; set; }

    /// <summary>Номер карты (уникальный в системе).</summary>
    public string CardNo { get; set; } = string.Empty;
    /// <summary>Сырой номер карты (Wiegand и т.п.), опционально.</summary>
    public string? CardNumber { get; set; }
    /// <summary>Тип карты для ISAPI: normalCard, qrCode и т.д. Null = normalCard.</summary>
    public string? CardType { get; set; }
}

/// <summary>Лицо для распознавания, привязанное к сотруднику или посетителю.</summary>
public sealed class Face : BaseEntity
{
    public Guid? EmployeeId { get; set; }
    public Employee? Employee { get; set; }

    public Guid? VisitorId { get; set; }
    public Visitor? Visitor { get; set; }

    public Guid? GymCustomerId { get; set; }
    public GymCustomer? GymCustomer { get; set; }

    /// <summary>Относительный путь к файлу изображения.</summary>
    public string FilePath { get; set; } = string.Empty;
    /// <summary>FDID: 1 — видимый свет, 2 — инфракрасный.</summary>
    public int FDID { get; set; } = 1;
}

/// <summary>Отпечаток пальца, привязанный к сотруднику или посетителю.</summary>
public sealed class Fingerprint : BaseEntity
{
    public Guid? EmployeeId { get; set; }
    public Employee? Employee { get; set; }

    public Guid? VisitorId { get; set; }
    public Visitor? Visitor { get; set; }

    public Guid? GymCustomerId { get; set; }
    public GymCustomer? GymCustomer { get; set; }

    /// <summary>Шаблон отпечатка (бинарные данные).</summary>
    public byte[] TemplateData { get; set; } = Array.Empty<byte>();
    /// <summary>Индекс пальца (1–10).</summary>
    public int FingerIndex { get; set; } = 1;
}

/// <summary>Шаблон радужной оболочки, привязанный к сотруднику или посетителю.</summary>
public sealed class Iris : BaseEntity
{
    public Guid? EmployeeId { get; set; }
    public Employee? Employee { get; set; }

    public Guid? VisitorId { get; set; }
    public Visitor? Visitor { get; set; }

    public byte[] TemplateData { get; set; } = Array.Empty<byte>();
    /// <summary>Идентификатор глаза на устройстве (irisID из ISAPI).</summary>
    public int IrisIndex { get; set; } = 1;
}

public sealed class EmployeeAccessLevel
{
    public Guid EmployeeId { get; set; }
    public Employee? Employee { get; set; }

    public Guid AccessLevelId { get; set; }
    public AccessLevel? AccessLevel { get; set; }

    public DateTime GrantedFromUtc { get; set; } = DateTime.UtcNow;
    public DateTime? GrantedToUtc { get; set; }
}

// ─── Time Attendance ───────────────────────────────────────────────────────────

public enum ScheduleType { Standard, Shift, Flexible, Multi, Off }

/// <summary>Расписание работы: стандартное (9–18), сменное, гибкое или мульти-смена.</summary>
public sealed class WorkSchedule : BaseEntity
{
    public string Name { get; set; } = "";
    public ScheduleType Type { get; set; } = ScheduleType.Standard;
    /// <summary>Начало смены (для Standard и Shift).</summary>
    public TimeSpan? ShiftStart { get; set; }
    /// <summary>Конец смены (для Standard и Shift).</summary>
    public TimeSpan? ShiftEnd { get; set; }
    /// <summary>Норма часов в день (для Flexible).</summary>
    public decimal RequiredHoursPerDay { get; set; } = 8;
    /// <summary>Hex-цвет для отображения в планнере, например #6366f1.</summary>
    public string Color { get; set; } = "#6366f1";
    /// <summary>Если false — время прихода раньше ShiftStart не идёт в total hours / overtime (total отсчитывается от ShiftStart).</summary>
    public bool CountEarlyArrival { get; set; } = true;
    /// <summary>Минимальный порог за день (в минутах). Дневной overtime ниже этого порога не учитывается. 0 — без порога.</summary>
    public int OvertimeDailyThresholdMinutes { get; set; } = 0;
    /// <summary>Вычитать перерыв на обед из фактического времени.</summary>
    public bool LunchBreakDeductionEnabled { get; set; } = false;
    /// <summary>Длительность обеда в минутах (вычитается из фактического времени, если LunchBreakDeductionEnabled=true).</summary>
    public int LunchBreakMinutes { get; set; } = 30;
    /// <summary>Допустимое опоздание в минутах: приход в пределах этого порога не считается опозданием в отчётах. 0 — без допуска.</summary>
    public int LateToleranceMinutes { get; set; } = 0;
    public ICollection<Employee> Employees { get; set; } = [];
    /// <summary>Под-смены (для Multi-расписания).</summary>
    public ICollection<WorkScheduleShift> Shifts { get; set; } = new List<WorkScheduleShift>();
}

/// <summary>Под-смена в Multi-расписании.</summary>
public sealed class WorkScheduleShift : BaseEntity
{
    public Guid WorkScheduleId { get; set; }
    public WorkSchedule WorkSchedule { get; set; } = null!;
    public string Name { get; set; } = string.Empty;
    public TimeSpan ShiftStart { get; set; }
    public TimeSpan ShiftEnd { get; set; }
    /// <summary>Начало окна регистрации (check-in попадает в эту смену если время >= ValidEntryFrom).</summary>
    public TimeSpan ValidEntryFrom { get; set; }
    /// <summary>Конец окна регистрации (check-in попадает в эту смену если время <= ValidEntryTo).</summary>
    public TimeSpan ValidEntryTo { get; set; }
    public decimal RequiredHoursPerDay { get; set; } = 8m;
    public int SortOrder { get; set; }
}

/// <summary>
/// Назначение рабочего графика сотруднику на конкретную дату.
/// Уникален по (EmployeeId, Date).
/// </summary>
public sealed class EmployeeDayPattern : BaseEntity
{
    public Guid EmployeeId { get; set; }
    public Employee Employee { get; set; } = null!;
    /// <summary>Конкретная дата назначения (UTC, время = 00:00:00).</summary>
    public DateOnly Date { get; set; }
    /// <summary>Назначенный график (если null — выходной или не назначен).</summary>
    public Guid? WorkScheduleId { get; set; }
    public WorkSchedule? WorkSchedule { get; set; }
    public bool IsDayOff { get; set; }
}

public enum LeaveType { Vacation, DayOff }
public enum LeaveStatus { Pending, Approved, Rejected, Cancelled }

public sealed class EmployeeLeave : BaseEntity
{
    public Guid EmployeeId { get; set; }
    public Employee Employee { get; set; } = null!;
    public LeaveType LeaveType { get; set; }
    public bool IsPaid { get; set; } = true;
    public DateOnly StartDate { get; set; }
    public DateOnly EndDate { get; set; }
    public string? Reason { get; set; }
    public LeaveStatus Status { get; set; } = LeaveStatus.Pending;
    public string? Notes { get; set; }
    public Guid? ApprovedByUserId { get; set; }
    public DateTime? ApprovedAt { get; set; }
}

/// <summary>
/// Сырой лог успешной аутентификации с устройства. Не привязан FK к Employee — храним
/// то, что прислало устройство (employeeNoString + name), независимо от регистрации в
/// нашей таблице сотрудников. Daily-отчёт уже на чтении джоинит с Employees по
/// EmployeeNoString и фильтрует по WorkSchedule.
/// </summary>
public sealed class DeviceAuthLog : BaseEntity
{
    public Guid? DeviceId { get; set; }
    public Device? Device { get; set; }
    public string EmployeeNoString { get; set; } = "";
    public string? Name { get; set; }
    public DateTime EventTimeUtc { get; set; }
    public int Major { get; set; }
    public int Minor { get; set; }
}

/// <summary>
/// Ручная корректировка check-in/check-out за конкретный день для конкретного сотрудника.
/// Перекрывает значения, посчитанные из device_auth_logs. Уникальна по (EmployeeId, Date).
/// </summary>
public sealed class AttendanceCorrection : BaseEntity
{
    public Guid EmployeeId { get; set; }
    public Employee Employee { get; set; } = null!;
    /// <summary>UTC midnight выбранного дня.</summary>
    public DateTime DateUtc { get; set; }
    public DateTime? CheckInUtc { get; set; }
    public DateTime? CheckOutUtc { get; set; }
    public string? Comment { get; set; }
    public Guid? CorrectedByUserId { get; set; }
}

/// <summary>
/// Почасовое разрешение на отлучку («icazə»): сотрудник отпросился на несколько часов
/// в конкретный день. Уникально по (EmployeeId, Date). Если ShowInReport=true —
/// разрешение показывается в отчётах и его часы вычитаются из общего времени.
/// </summary>
public sealed class AttendancePermission : BaseEntity
{
    public Guid EmployeeId { get; set; }
    public Employee Employee { get; set; } = null!;
    public DateOnly Date { get; set; }
    public TimeSpan FromTime { get; set; }
    public TimeSpan ToTime { get; set; }
    public string? Reason { get; set; }
    /// <summary>Отображать в отчёте (и вычитать часы отсутствия из totalHours).</summary>
    public bool ShowInReport { get; set; } = true;
}

public enum AttendanceEventType { In, Out }

/// <summary>Фактическая запись прихода/ухода с устройства или добавленная вручную.</summary>
public sealed class AttendanceRecord : BaseEntity
{
    public Guid EmployeeId { get; set; }
    public Employee Employee { get; set; } = null!;
    public DateTime EventTimeUtc { get; set; }
    public AttendanceEventType EventType { get; set; }
    public Guid? DeviceId { get; set; }
    /// <summary>"device" — с устройства, "manual" — вручную после одобрения заявки.</summary>
    public string Source { get; set; } = "device";
}

public enum AttendanceRequestType { CheckIn, CheckOut, Absence, Vacation, Overtime, Correction }

/// <summary>
/// Гео-зона для регистрации входа/выхода. Если координаты сотрудника попадают в радиус
/// любой активной зоны при отправке Check-in/Check-out request — заявка авто-аппрувится.
/// Иначе уходит в Pending на решение админа.
/// </summary>
public sealed class GeoZone : BaseEntity
{
    public string Name { get; set; } = "";
    public double Latitude { get; set; }
    public double Longitude { get; set; }
    public int RadiusMeters { get; set; } = 100;
    public bool IsActive { get; set; } = true;
}
public enum AttendanceRequestStatus { Pending, Approved, Rejected }

/// <summary>Заявка сотрудника: приход/уход/отсутствие/отпуск/переработка.</summary>
public sealed class AttendanceRequest : BaseEntity
{
    public Guid EmployeeId { get; set; }
    public Employee Employee { get; set; } = null!;
    public AttendanceRequestType Type { get; set; }
    public DateTime RequestedTimeUtc { get; set; }
    public DateTime? RequestedEndTimeUtc { get; set; }
    public string? Comment { get; set; }
    public AttendanceRequestStatus Status { get; set; } = AttendanceRequestStatus.Pending;
    public Guid? ReviewedByUserId { get; set; }
    public DateTime? ReviewedAtUtc { get; set; }
    public string? ReviewComment { get; set; }
    /// <summary>Координаты, отправленные сотрудником из браузера (опционально).</summary>
    public double? Latitude { get; set; }
    public double? Longitude { get; set; }
    /// <summary>Имя GeoZone, в которую попали координаты (если попали).</summary>
    public string? GeoZoneName { get; set; }
}

public sealed class VisitorAccessLevel
{
    public Guid VisitorId { get; set; }
    public Visitor? Visitor { get; set; }

    public Guid AccessLevelId { get; set; }
    public AccessLevel? AccessLevel { get; set; }

    public DateTime GrantedFromUtc { get; set; } = DateTime.UtcNow;
    public DateTime? GrantedToUtc { get; set; }
}

// ─── Payroll ───────────────────────────────────────────────────────────────────

public enum PayrollComponentType { Allowance, Bonus, Deduction }
public enum SalaryType { Monthly, Hourly, Daily }
public enum PayrollPeriodStatus { Draft, Calculated, Approved, Paid }
public enum PayrollEntryStatus { Pending, Approved, Rejected }

/// <summary>Шаблон компонента начисления/удержания (применяется ко всем или конкретным сотрудникам).</summary>
public sealed class PayrollComponent : BaseEntity
{
    public string Name { get; set; } = "";
    public PayrollComponentType ComponentType { get; set; }
    /// <summary>true — фиксированная сумма, false — процент от базовой зарплаты.</summary>
    public bool IsFixed { get; set; } = true;
    public decimal Amount { get; set; }
    public decimal Percentage { get; set; }
    /// <summary>Применять автоматически ко всем сотрудникам при расчёте.</summary>
    public bool IsDefault { get; set; }
    public bool IsActive { get; set; } = true;
    public string? Description { get; set; }
    public ICollection<EmployeePayrollComponent> EmployeeComponents { get; set; } = [];
}

/// <summary>Конфигурация зарплаты конкретного сотрудника.</summary>
public sealed class EmployeeSalaryConfig : BaseEntity
{
    public Guid EmployeeId { get; set; }
    public Employee Employee { get; set; } = null!;
    public SalaryType SalaryType { get; set; } = SalaryType.Monthly;
    /// <summary>Базовый оклад (в месяц или в час, в зависимости от SalaryType).</summary>
    public decimal BaseAmount { get; set; }
    public string Currency { get; set; } = "AZN";
    public decimal OvertimeMultiplier { get; set; } = 1.5m;
    /// <summary>Если false — оверайт не начисляется вообще.</summary>
    public bool OvertimeEnabled { get; set; } = true;
    /// <summary>JSON: [{afterHours:0,multiplier:1.5},{afterHours:20,multiplier:2.0}] — тиры сверхурочных. Если null — используется OvertimeMultiplier.</summary>
    public string? OvertimeTiersJson { get; set; }
    /// <summary>Для Monthly: считать базу по отработанным часам, а не по дням.</summary>
    public bool PayByWorkedHours { get; set; } = false;
    /// <summary>Включить вычет за опоздания.</summary>
    public bool LatenessDeductionEnabled { get; set; } = false;
    /// <summary>"Coefficient" — % от зп (мультипликатор × hourlyRate × часы опозданий). "Fixed" — фикс сумма за каждый late-день × tier value.</summary>
    public string LatenessDeductionMode { get; set; } = "Coefficient";
    /// <summary>JSON: [{afterMinutes:5,deductionMultiplier:1.0},...]. В Coefficient режиме — мультипликатор; в Fixed режиме — фикс ₼ за late-день.</summary>
    public string? LatenessTiersJson { get; set; }
    /// <summary>Включить вычет за преждевременный уход.</summary>
    public bool EarlyLeaveDeductionEnabled { get; set; } = false;
    /// <summary>"Coefficient" или "Fixed" — аналогично lateness.</summary>
    public string EarlyLeaveDeductionMode { get; set; } = "Coefficient";
    /// <summary>JSON: те же tier-структуры что и lateness.</summary>
    public string? EarlyLeaveTiersJson { get; set; }
    public DateOnly EffectiveFrom { get; set; }
    public ICollection<EmployeePayrollComponent> Components { get; set; } = [];
}

/// <summary>Компонент зарплаты, индивидуально назначенный сотруднику (возможен override суммы).</summary>
public sealed class EmployeePayrollComponent
{
    public Guid SalaryConfigId { get; set; }
    public EmployeeSalaryConfig SalaryConfig { get; set; } = null!;
    public Guid ComponentId { get; set; }
    public PayrollComponent Component { get; set; } = null!;
    public decimal? OverrideAmount { get; set; }
    public decimal? OverridePercentage { get; set; }
}

/// <summary>Расчётный период (один календарный месяц).</summary>
public sealed class PayrollPeriod : BaseEntity
{
    public int Year { get; set; }
    public int Month { get; set; }
    /// <summary>Произвольный диапазон расчёта (если null — диапазон выводится из Year/Month как календарный месяц).</summary>
    public DateOnly? StartDate { get; set; }
    public DateOnly? EndDate { get; set; }
    public PayrollPeriodStatus Status { get; set; } = PayrollPeriodStatus.Draft;
    public DateTime? CalculatedAt { get; set; }
    public DateTime? ApprovedAt { get; set; }
    public Guid? ApprovedByUserId { get; set; }
    /// <summary>Когда часы зафиксированы как snapshot. Если null — Calculate пересчитывает из логов; иначе берёт готовые из entries.</summary>
    public DateTime? HoursConfirmedAt { get; set; }
    public string? Notes { get; set; }
    public ICollection<PayrollEntry> Entries { get; set; } = [];
}

/// <summary>Строка расчёта зарплаты для одного сотрудника за период.</summary>
public sealed class PayrollEntry : BaseEntity
{
    public Guid PeriodId { get; set; }
    public PayrollPeriod Period { get; set; } = null!;
    public Guid EmployeeId { get; set; }
    public Employee Employee { get; set; } = null!;
    public int WorkedDays { get; set; }
    public decimal WorkedHours { get; set; }
    public decimal OvertimeHours { get; set; }
    public decimal LatenessMinutes { get; set; }
    /// <summary>Сколько дней были с опозданием (нужно для Fixed-режима lateness deduction).</summary>
    public int LatenessDaysCount { get; set; }
    /// <summary>Минуты преждевременного ухода за период.</summary>
    public decimal EarlyLeaveMinutes { get; set; }
    /// <summary>Сколько дней были с преждевременным уходом.</summary>
    public int EarlyLeaveDaysCount { get; set; }
    public int AbsentDays { get; set; }
    /// <summary>Дни в периоде, в которые сотрудник должен был работать (для пропорции BasePay в Monthly).</summary>
    public int TotalWorkingDays { get; set; }
    public decimal BasePay { get; set; }
    public decimal OvertimePay { get; set; }
    public decimal AllowancesTotal { get; set; }
    public decimal BonusesTotal { get; set; }
    public decimal GrossPay { get; set; }
    public decimal DeductionsTotal { get; set; }
    /// <summary>Сумма вычета за опоздания (часть DeductionsTotal).</summary>
    public decimal LatenessDeduction { get; set; }
    /// <summary>Сумма вычета за преждевременный уход (часть DeductionsTotal).</summary>
    public decimal EarlyLeaveDeduction { get; set; }
    public decimal TaxRate { get; set; }
    public decimal TaxAmount { get; set; }
    public decimal NetPay { get; set; }
    public PayrollEntryStatus Status { get; set; } = PayrollEntryStatus.Pending;
    public string? Notes { get; set; }
    /// <summary>JSON-снимок применённых компонентов на момент расчёта.</summary>
    public string? ComponentsJson { get; set; }
    /// <summary>JSON: массив дневных OT-часов (только дни где OT > 0 и прошёл threshold). Нужен чтобы tiers применялись per-day.</summary>
    public string? OvertimeBreakdownJson { get; set; }
}

// ─── Notifications ─────────────────────────────────────────────────────────────

public static class NotificationTypes
{
    public const string DeviceOffline = "DeviceOffline";
    public const string DeviceOnline = "DeviceOnline";
    public const string ApprovalRequest = "ApprovalRequest";
    public const string ApprovalApproved = "ApprovalApproved";
    public const string ApprovalRejected = "ApprovalRejected";
    public const string DailyReport = "DailyReport";
    public const string ParkingBlacklist = "ParkingBlacklist";
    public const string ParkingFull = "ParkingFull";
    public const string ParkingDebt = "ParkingDebt";
    public const string ParkingOverstay = "ParkingOverstay";
}

/// <summary>Уведомление для пользователя. UserId = null означает broadcast всем.</summary>
public sealed class Notification : BaseEntity
{
    public Guid? UserId { get; set; }
    public string Type { get; set; } = "";
    public string Title { get; set; } = "";
    public string Body { get; set; } = "";
    public bool IsRead { get; set; }
    public string? ReferenceId { get; set; }
}

/// <summary>Запись о прочтении broadcast-уведомления конкретным пользователем.</summary>
public sealed class NotificationRead
{
    public Guid NotificationId { get; set; }
    public Guid UserId { get; set; }
    public DateTime ReadAtUtc { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// Связка роли с permission'ом. Хранится по имени роли (а не RoleId), потому что
/// имена ролей в этой системе уникальны и стабильны, а seed Admin/SecurityOperator/HrOperator
/// идёт по имени. Custom-роли тоже хранятся по имени.
/// </summary>
public sealed class RolePermission
{
    public string RoleName { get; set; } = string.Empty;
    public string Permission { get; set; } = string.Empty;
}

// ─── Gym Management module ───────────────────────────────────────────────────

public enum GymTariffKind
{
    /// <summary>Обычный абонемент.</summary>
    Membership = 1,
    /// <summary>Подарочный сертификат (продаётся, затем активируется на клиента).</summary>
    GiftCertificate = 2
}

public enum GymTariffDuration
{
    Day = 1,
    Week = 2,
    Month = 3,
    Year = 4
}

/// <summary>
/// Тариф (шаблон абонемента) модуля Gym Management. Описывает срок, цену, лимиты
/// и политики (автопродление, заморозка, перенос). Выданные клиентам абонементы —
/// отдельная сущность (следующий этап).
/// </summary>
public sealed class GymTariff : BaseEntity
{
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public GymTariffKind Kind { get; set; } = GymTariffKind.Membership;

    // Стоимость.
    public decimal Price { get; set; }
    public string Currency { get; set; } = "AZN";

    // Срок действия абонемента: день / неделя / месяц / год.
    public GymTariffDuration DurationType { get; set; } = GymTariffDuration.Month;

    // Ограничение по количеству посещений. null = безлимит.
    public int? VisitLimit { get; set; }

    // Ограничение по времени посещения (окно доступа в течение дня).
    public bool HasTimeRestriction { get; set; }
    public TimeSpan? AccessFrom { get; set; }
    public TimeSpan? AccessTo { get; set; }
    /// <summary>Битовая маска разрешённых дней недели (бит 0 = воскресенье … бит 6 = суббота). 127 = все дни.</summary>
    public int DaysOfWeekMask { get; set; } = 127;

    // Политики.
    public bool AutoRenew { get; set; }
    public bool FreezeAllowed { get; set; }
    public int FreezeMaxDays { get; set; }
    public bool TransferAllowed { get; set; }

    public bool IsActive { get; set; } = true;
    public int SortOrder { get; set; }
}

/// <summary>Клиент тренажёрного зала (модуль Gym Management).</summary>
public sealed class GymCustomer : BaseEntity
{
    public string FirstName { get; set; } = string.Empty;
    public string? LastName { get; set; }
    public string? Phone { get; set; }
    public string? Email { get; set; }
    /// <summary>"Male" / "Female" / null.</summary>
    public string? Gender { get; set; }
    public DateOnly? BirthDate { get; set; }
    public string? Notes { get; set; }
    public bool IsActive { get; set; } = true;
    /// <summary>Счётчик посещений: +1 на каждый проход; сравнивается с лимитом активного абонемента. Сбрасывается при выдаче нового абонемента.</summary>
    public int VisitCount { get; set; }
}

public enum GymMembershipStatus
{
    Active = 1,
    Frozen = 2,
    Cancelled = 3
}

/// <summary>
/// Выданный клиенту абонемент. Ключевые параметры тарифа копируются (снапшот) на момент
/// выдачи, чтобы последующее изменение/удаление тарифа не меняло уже проданный абонемент.
/// </summary>
public sealed class GymMembership : BaseEntity
{
    public Guid CustomerId { get; set; }
    public GymCustomer? Customer { get; set; }

    /// <summary>Ссылка на исходный тариф (может стать null, если тариф удалён).</summary>
    public Guid? TariffId { get; set; }
    public GymTariff? Tariff { get; set; }

    // Снапшот тарифа.
    public string TariffName { get; set; } = string.Empty;
    public decimal Price { get; set; }
    public string Currency { get; set; } = "AZN";

    public DateOnly StartDate { get; set; }
    public DateOnly EndDate { get; set; }

    public int? VisitLimit { get; set; }
    public int VisitsUsed { get; set; }

    public bool HasTimeRestriction { get; set; }
    public TimeSpan? AccessFrom { get; set; }
    public TimeSpan? AccessTo { get; set; }
    public int DaysOfWeekMask { get; set; } = 127;

    public bool FreezeAllowed { get; set; }
    public int FreezeMaxDays { get; set; }
    /// <summary>Сколько дней заморозки уже использовано (кумулятивно, против FreezeMaxDays).</summary>
    public int FrozenDaysUsed { get; set; }
    /// <summary>Дата окончания текущей заморозки. null = не заморожен.</summary>
    public DateOnly? FrozenUntil { get; set; }

    public bool TransferAllowed { get; set; }
    public bool AutoRenew { get; set; }

    public GymMembershipStatus Status { get; set; } = GymMembershipStatus.Active;
    public string? Notes { get; set; }
}

public enum GymGiftCertificateStatus
{
    Issued = 1,
    Redeemed = 2,
    Cancelled = 3
}

/// <summary>
/// Подарочный сертификат: продаётся под определённый тариф, имеет код и может быть
/// активирован (redeem) на клиента — при активации создаётся абонемент.
/// </summary>
public sealed class GymGiftCertificate : BaseEntity
{
    public string Code { get; set; } = string.Empty;

    public Guid? TariffId { get; set; }
    public GymTariff? Tariff { get; set; }
    public string TariffName { get; set; } = string.Empty;
    public decimal Price { get; set; }
    public string Currency { get; set; } = "AZN";

    public string? RecipientName { get; set; }
    /// <summary>Активировать до этой даты (null = без срока).</summary>
    public DateOnly? ValidUntil { get; set; }

    public GymGiftCertificateStatus Status { get; set; } = GymGiftCertificateStatus.Issued;

    public Guid? RedeemedByCustomerId { get; set; }
    public Guid? RedeemedMembershipId { get; set; }
    public DateTime? RedeemedUtc { get; set; }
}

public enum GymPaymentMethod
{
    Cash = 1,
    Card = 2,
    Transfer = 3
}

/// <summary>Платёж клиента зала (за абонемент и т.п.).</summary>
public sealed class GymPayment : BaseEntity
{
    public Guid CustomerId { get; set; }
    public GymCustomer? Customer { get; set; }

    /// <summary>Абонемент, за который платёж (опционально).</summary>
    public Guid? MembershipId { get; set; }
    public GymMembership? Membership { get; set; }

    public decimal Amount { get; set; }
    public string Currency { get; set; } = "AZN";
    public GymPaymentMethod Method { get; set; } = GymPaymentMethod.Cash;
    public string? Note { get; set; }
    public DateTime PaidUtc { get; set; } = DateTime.UtcNow;
}

// ─── Gym Inventory / Warehouse module ─────────────────────────────────────────

/// <summary>Поставщик товаров для склада зала.</summary>
public sealed class GymSupplier : BaseEntity
{
    public string Name { get; set; } = string.Empty;
    public string? ContactName { get; set; }
    public string? Phone { get; set; }
    public string? Email { get; set; }
    public string? Address { get; set; }
    public string? Notes { get; set; }
    public bool IsActive { get; set; } = true;
}

/// <summary>
/// Товар (номенклатура) склада. Текущий остаток <see cref="StockQuantity"/> денормализован
/// для быстрого отображения и пересчитывается из движений (<see cref="GymStockMovement"/>).
/// </summary>
public sealed class GymProduct : BaseEntity
{
    public string Name { get; set; } = string.Empty;
    /// <summary>Артикул.</summary>
    public string? Sku { get; set; }
    public string? Barcode { get; set; }
    public string? Category { get; set; }
    /// <summary>Единица измерения (шт, кг, л …).</summary>
    public string Unit { get; set; } = "pcs";
    /// <summary>Цена продажи.</summary>
    public decimal SalePrice { get; set; }
    /// <summary>Последняя себестоимость (закупочная цена).</summary>
    public decimal Cost { get; set; }
    public string Currency { get; set; } = "AZN";
    /// <summary>Текущий остаток на складе (денормализованный).</summary>
    public decimal StockQuantity { get; set; }
    /// <summary>Минимальный остаток — порог для предупреждения о низком остатке.</summary>
    public decimal MinStock { get; set; }
    public Guid? SupplierId { get; set; }
    public GymSupplier? Supplier { get; set; }
    public bool IsActive { get; set; } = true;
}

public enum GymStockMovementType
{
    /// <summary>Приход товара (ручной).</summary>
    Receipt = 1,
    /// <summary>Списание.</summary>
    WriteOff = 2,
    /// <summary>Корректировка по инвентаризации.</summary>
    Stocktake = 3,
    /// <summary>Оприходование по закупке.</summary>
    Purchase = 4,
    /// <summary>Продажа (расход через кассу).</summary>
    Sale = 5
}

/// <summary>Движение склада (журнал). Quantity со знаком: +приход / −расход.</summary>
public sealed class GymStockMovement : BaseEntity
{
    public Guid ProductId { get; set; }
    public GymProduct? Product { get; set; }
    public GymStockMovementType Type { get; set; }
    /// <summary>Изменение остатка со знаком (+/−).</summary>
    public decimal Quantity { get; set; }
    public decimal UnitCost { get; set; }
    /// <summary>Остаток товара после применения движения (снимок).</summary>
    public decimal BalanceAfter { get; set; }
    /// <summary>Причина / комментарий (для списания и т.п.).</summary>
    public string? Reason { get; set; }
    /// <summary>Ссылка на источник: номер закупки, id инвентаризации и т.п.</summary>
    public string? Reference { get; set; }
    public Guid? SupplierId { get; set; }
    public Guid? UserId { get; set; }
    public string? UserEmail { get; set; }
}

public enum GymPurchaseOrderStatus
{
    Draft = 1,
    Ordered = 2,
    Received = 3,
    Cancelled = 4
}

/// <summary>Закупка (заказ поставщику).</summary>
public sealed class GymPurchaseOrder : BaseEntity
{
    public string Number { get; set; } = string.Empty;
    public Guid? SupplierId { get; set; }
    public GymSupplier? Supplier { get; set; }
    /// <summary>Снимок имени поставщика на момент создания.</summary>
    public string SupplierName { get; set; } = string.Empty;
    public GymPurchaseOrderStatus Status { get; set; } = GymPurchaseOrderStatus.Draft;
    public DateOnly? ExpectedDate { get; set; }
    public DateTime? ReceivedUtc { get; set; }
    public string Currency { get; set; } = "AZN";
    public decimal Total { get; set; }
    public string? Notes { get; set; }
    public ICollection<GymPurchaseOrderItem> Items { get; set; } = new List<GymPurchaseOrderItem>();
}

public sealed class GymPurchaseOrderItem : BaseEntity
{
    public Guid PurchaseOrderId { get; set; }
    public GymPurchaseOrder? PurchaseOrder { get; set; }
    public Guid ProductId { get; set; }
    public GymProduct? Product { get; set; }
    /// <summary>Снимок имени товара на момент создания закупки.</summary>
    public string ProductName { get; set; } = string.Empty;
    public decimal Quantity { get; set; }
    public decimal UnitCost { get; set; }
}

public enum GymStocktakeStatus
{
    Draft = 1,
    Completed = 2,
    Cancelled = 3
}

/// <summary>Инвентаризация (сверка фактических остатков с системными).</summary>
public sealed class GymStocktake : BaseEntity
{
    public string Number { get; set; } = string.Empty;
    public GymStocktakeStatus Status { get; set; } = GymStocktakeStatus.Draft;
    public DateTime? CompletedUtc { get; set; }
    public string? Notes { get; set; }
    public ICollection<GymStocktakeItem> Items { get; set; } = new List<GymStocktakeItem>();
}

public sealed class GymStocktakeItem : BaseEntity
{
    public Guid StocktakeId { get; set; }
    public GymStocktake? Stocktake { get; set; }
    public Guid ProductId { get; set; }
    public GymProduct? Product { get; set; }
    public string ProductName { get; set; } = string.Empty;
    /// <summary>Системный остаток на момент добавления в инвентаризацию.</summary>
    public decimal ExpectedQuantity { get; set; }
    /// <summary>Фактически подсчитанный остаток.</summary>
    public decimal CountedQuantity { get; set; }
}

// ─── Gym Finance module ────────────────────────────────────────────────────────

public enum GymFinanceAccountType { Cash = 1, Bank = 2 }
public enum GymFinanceDirection { Income = 1, Expense = 2 }

/// <summary>Финансовый счёт: касса (Cash) или банковский счёт (Bank).</summary>
public sealed class GymFinanceAccount : BaseEntity
{
    public string Name { get; set; } = string.Empty;
    public GymFinanceAccountType Type { get; set; } = GymFinanceAccountType.Cash;
    public string Currency { get; set; } = "AZN";
    public decimal OpeningBalance { get; set; }
    /// <summary>Текущий баланс (денормализован): OpeningBalance + сумма движений со знаком.</summary>
    public decimal Balance { get; set; }
    public string? BankName { get; set; }
    public string? AccountNumber { get; set; }
    public bool IsActive { get; set; } = true;
}

/// <summary>Категория доходов/расходов.</summary>
public sealed class GymFinanceCategory : BaseEntity
{
    public string Name { get; set; } = string.Empty;
    public GymFinanceDirection Direction { get; set; }
    public string Color { get; set; } = "#6366f1";
    public bool IsActive { get; set; } = true;
}

/// <summary>Финансовая операция (доход или расход) по счёту.</summary>
public sealed class GymFinanceTransaction : BaseEntity
{
    public Guid AccountId { get; set; }
    public GymFinanceAccount? Account { get; set; }
    public GymFinanceDirection Direction { get; set; }
    public decimal Amount { get; set; }
    public string Currency { get; set; } = "AZN";
    public Guid? CategoryId { get; set; }
    public GymFinanceCategory? Category { get; set; }
    /// <summary>Дата операции (для группировки по периодам).</summary>
    public DateOnly OccurredOn { get; set; }
    public string? Description { get; set; }
    /// <summary>Ссылка на источник (id перевода, абонемент, закупка …).</summary>
    public string? Reference { get; set; }
    public string? CounterpartyName { get; set; }
    /// <summary>Способ: Cash / Card / Transfer (опционально).</summary>
    public string? Method { get; set; }
    /// <summary>Нога перевода между счетами — исключается из P&amp;L (доход/расход/прибыль).</summary>
    public bool IsTransfer { get; set; }
    /// <summary>Баланс счёта после операции (снимок).</summary>
    public decimal BalanceAfter { get; set; }
    public Guid? UserId { get; set; }
    public string? UserEmail { get; set; }
}

// ─── Gym POS / Checkout module ─────────────────────────────────────────────────

public enum GymSaleStatus { Completed = 1, Refunded = 2 }

/// <summary>Продажа на кассе (чек). Списывает товары со склада и заводит доход в кассу/на счёт.</summary>
public sealed class GymSale : BaseEntity
{
    public string Number { get; set; } = string.Empty;
    public Guid? CustomerId { get; set; }
    public GymCustomer? Customer { get; set; }
    /// <summary>Снимок имени клиента на момент продажи.</summary>
    public string? CustomerName { get; set; }
    public decimal Subtotal { get; set; }
    public decimal Discount { get; set; }
    public decimal Total { get; set; }
    public string Currency { get; set; } = "AZN";
    public GymPaymentMethod PaymentMethod { get; set; } = GymPaymentMethod.Cash;
    /// <summary>Финансовый счёт, на который зачислен доход (касса/банк).</summary>
    public Guid? FinanceAccountId { get; set; }
    /// <summary>Связанная финансовая операция-доход.</summary>
    public Guid? FinanceTransactionId { get; set; }
    public GymSaleStatus Status { get; set; } = GymSaleStatus.Completed;
    public DateTime SoldUtc { get; set; } = DateTime.UtcNow;
    public DateTime? RefundedUtc { get; set; }
    public string? Note { get; set; }
    public Guid? UserId { get; set; }
    public string? UserEmail { get; set; }
    public ICollection<GymSaleItem> Items { get; set; } = new List<GymSaleItem>();
}

public sealed class GymSaleItem : BaseEntity
{
    public Guid SaleId { get; set; }
    public GymSale? Sale { get; set; }
    public Guid? ProductId { get; set; }
    public GymProduct? Product { get; set; }
    /// <summary>Снимок имени товара на момент продажи.</summary>
    public string ProductName { get; set; } = string.Empty;
    public decimal Quantity { get; set; }
    public decimal UnitPrice { get; set; }
    public decimal LineTotal { get; set; }
}

// ─── Parking Management module ───────────────────────────────────────────────

/// <summary>Тип парковочного места.</summary>
public enum ParkingSpaceType
{
    /// <summary>Обычное место.</summary>
    Regular = 1,
    /// <summary>VIP-место.</summary>
    Vip = 2,
    /// <summary>Место для людей с инвалидностью.</summary>
    Disabled = 3
}

/// <summary>
/// Парковочная зона — верхний уровень иерархии модуля парковки
/// (Зона → Этаж → Ряд → Место).
/// </summary>
public sealed class ParkingZone : BaseEntity
{
    public string Name { get; set; } = string.Empty;
    /// <summary>Короткий код зоны (например "A", "P1").</summary>
    public string? Code { get; set; }
    public string? Description { get; set; }
    public bool IsActive { get; set; } = true;
    public int SortOrder { get; set; }

    public ICollection<ParkingFloor> Floors { get; set; } = new List<ParkingFloor>();
}

/// <summary>Этаж парковочной зоны.</summary>
public sealed class ParkingFloor : BaseEntity
{
    public Guid ZoneId { get; set; }
    public ParkingZone? Zone { get; set; }

    public string Name { get; set; } = string.Empty;
    /// <summary>Номер уровня; может быть отрицательным для подземных этажей (-1, -2 …).</summary>
    public int Level { get; set; }
    public bool IsActive { get; set; } = true;
    public int SortOrder { get; set; }

    public ICollection<ParkingRow> Rows { get; set; } = new List<ParkingRow>();
}

/// <summary>Ряд на этаже парковки.</summary>
public sealed class ParkingRow : BaseEntity
{
    public Guid FloorId { get; set; }
    public ParkingFloor? Floor { get; set; }

    public string Name { get; set; } = string.Empty;
    public int SortOrder { get; set; }

    public ICollection<ParkingSpace> Spaces { get; set; } = new List<ParkingSpace>();
}

/// <summary>Парковочное место — нижний уровень иерархии.</summary>
public sealed class ParkingSpace : BaseEntity
{
    public Guid RowId { get; set; }
    public ParkingRow? Row { get; set; }

    /// <summary>Номер/код места (например "A-01").</summary>
    public string Code { get; set; } = string.Empty;
    public ParkingSpaceType Type { get; set; } = ParkingSpaceType.Regular;
    public bool IsActive { get; set; } = true;
    public int SortOrder { get; set; }
    public string? Notes { get; set; }
}

/// <summary>Тип списка номеров доступа на парковку.</summary>
public enum ParkingPlateList
{
    Allow = 1,
    Block = 2
}

/// <summary>Номер в белом/чёрном списке доступа на парковку.</summary>
public sealed class ParkingPlate : BaseEntity
{
    public string Plate { get; set; } = string.Empty;
    public string PlateNormalized { get; set; } = string.Empty;
    public ParkingPlateList ListType { get; set; }
    public string? Note { get; set; }
    public bool IsActive { get; set; } = true;
    /// <summary>Причина блокировки: unpaid|violator|stolen|banned.</summary>
    public string? Category { get; set; }
    /// <summary>Дата, после которой блокировка снимается; null — бессрочно.</summary>
    public DateOnly? ValidTo { get; set; }
}

/// <summary>
/// Владелец парковочных мест: за ним закреплено N мест и любое число автомобилей из базы.
/// Машины пускают, пока заняты не все его места, — так семья или компания с двумя
/// местами и пятью машинами не поставит внутрь больше двух.
/// </summary>
public sealed class ParkingHolder : BaseEntity
{
    public string Name { get; set; } = string.Empty;
    public string? Phone { get; set; }
    /// <summary>Квартира, офис или иная привязка — для удобства поиска.</summary>
    public string? Unit { get; set; }
    /// <summary>Сколько машин владельца может находиться внутри одновременно.</summary>
    public int SpacesLimit { get; set; } = 1;
    public bool IsActive { get; set; } = true;
    public string? Notes { get; set; }

    public ICollection<ParkingVehicle> Vehicles { get; set; } = new List<ParkingVehicle>();
}

/// <summary>Сессия парковки (машина внутри) — занятость, история въездов/выездов, оплата.</summary>
public sealed class ParkingSession : BaseEntity
{
    public string Plate { get; set; } = string.Empty;
    public string PlateNormalized { get; set; } = string.Empty;
    public Guid? ZoneId { get; set; }
    public ParkingSpaceType SpaceType { get; set; } = ParkingSpaceType.Regular;
    /// <summary>Конкретное место, занятое машиной. Назначается при въезде, освобождается выездом;
    /// null — мест нужного типа не нашлось (или сессия старше этой возможности).</summary>
    public Guid? SpaceId { get; set; }
    public ParkingSpace? Space { get; set; }
    public DateTime EnteredUtc { get; set; } = DateTime.UtcNow;
    public DateTime? ExitedUtc { get; set; }
    public bool IsPaid { get; set; }
    /// <summary>Камера, распознавшая номер на въезде.</summary>
    public string? CameraName { get; set; }
    /// <summary>Фото с камеры (URL/путь).</summary>
    public string? PhotoUrl { get; set; }
    /// <summary>Вероятность распознавания номера, 0..1.</summary>
    public double? RecognitionConfidence { get; set; }
    /// <summary>Оператор (если въезд/выезд оформлен вручную).</summary>
    public string? Operator { get; set; }
    /// <summary>Начисленная стоимость (платный режим).</summary>
    public decimal? Cost { get; set; }
    /// <summary>Способ оплаты: cash|card|online|free|subscription.</summary>
    public string? PaymentMethod { get; set; }
    public DateTime? PaidUtc { get; set; }
    /// <summary>Сколько реально принято кассой. Долг = Cost − PaidAmount (доплата за просроченное окно).</summary>
    public decimal? PaidAmount { get; set; }
    /// <summary>До какого момента нужно выехать после оплаты. Позже — доплата за лишнее время.</summary>
    public DateTime? PaidUntilUtc { get; set; }
    public Guid? TariffId { get; set; }
    /// <summary>Когда зафиксирован перепростой (стоянка дольше разрешённого лимита); null — не было.</summary>
    public DateTime? OverstayUtc { get; set; }
}

/// <summary>Вид тарифа парковки.</summary>
public enum ParkingTariffKind
{
    Hourly = 1,
    Daily = 2,
    Fixed = 3
}

/// <summary>Тариф платной парковки. Часовой поддерживает ночную/выходную ставку и потолок за сутки.</summary>
public sealed class ParkingTariff : BaseEntity
{
    public string Name { get; set; } = string.Empty;
    public ParkingTariffKind Kind { get; set; } = ParkingTariffKind.Hourly;
    /// <summary>Первые X минут бесплатно.</summary>
    public int FreeMinutes { get; set; }
    public decimal PricePerHour { get; set; }
    public decimal PricePerDay { get; set; }
    public decimal FixedPrice { get; set; }
    /// <summary>Максимум за сутки (для часового); null — без потолка.</summary>
    public decimal? MaxPerDay { get; set; }
    /// <summary>Ночная ставка в час; действует в окне NightFrom–NightTo. null — нет ночного тарифа.</summary>
    public decimal? NightPricePerHour { get; set; }
    public TimeSpan? NightFrom { get; set; }
    public TimeSpan? NightTo { get; set; }
    /// <summary>Ставка в час по выходным (сб/вс); null — как обычная.</summary>
    public decimal? WeekendPricePerHour { get; set; }
    public bool IsActive { get; set; } = true;
    /// <summary>Тариф по умолчанию для расчёта на выезде.</summary>
    public bool IsDefault { get; set; }
    public int SortOrder { get; set; }
}

/// <summary>Абонемент (месяц/квартал/год) — привязан к номеру.</summary>
public sealed class ParkingSubscription : BaseEntity
{
    public string Plate { get; set; } = string.Empty;
    public string PlateNormalized { get; set; } = string.Empty;
    /// <summary>Название (напр. «Месяц», «Квартал», «Год»).</summary>
    public string Name { get; set; } = string.Empty;
    public DateOnly StartDate { get; set; }
    public DateOnly EndDate { get; set; }
    /// <summary>Лимит въездов; null — по времени действия.</summary>
    public int? EntriesLimit { get; set; }
    public int EntriesUsed { get; set; }
    /// <summary>Неограниченный доступ (игнорирует лимит въездов).</summary>
    public bool Unlimited { get; set; }
    public bool IsActive { get; set; } = true;
    public string? Notes { get; set; }
}

/// <summary>Журнал событий парковки: шлагбаум, ошибки камер/распознавания, питание, входы администраторов, тревоги.</summary>
public sealed class ParkingEvent : BaseEntity
{
    /// <summary>barrier_open|barrier_close|manual_open|camera_error|recognition_error|power_loss|admin_login|denied|alarm</summary>
    public string Type { get; set; } = string.Empty;
    public string? Message { get; set; }
    public string? Plate { get; set; }
    /// <summary>Источник: имя камеры / оператор / system.</summary>
    public string? Source { get; set; }
}

/// <summary>Жилец / арендатор здания (модуль парковки).</summary>
public sealed class ParkingResident : BaseEntity
{
    public string FullName { get; set; } = string.Empty;
    public string? Phone { get; set; }
    /// <summary>Квартира / офис / блок.</summary>
    public string? Unit { get; set; }
    public string? Notes { get; set; }
    public bool IsActive { get; set; } = true;
    public ICollection<ParkingVehicle> Vehicles { get; set; } = new List<ParkingVehicle>();
}

/// <summary>
/// Машина из белого списка: сама карточка и есть разрешение на въезд. Срок действия и зона
/// живут здесь же — отдельных пропусков больше нет, поэтому оператор заводит машину одним окном.
/// </summary>
public sealed class ParkingVehicle : BaseEntity
{
    public Guid? ResidentId { get; set; }
    public ParkingResident? Resident { get; set; }
    /// <summary>Владелец (имя).</summary>
    public string? OwnerName { get; set; }
    /// <summary>Телефон владельца.</summary>
    public string? OwnerPhone { get; set; }
    public string Plate { get; set; } = string.Empty;
    public string PlateNormalized { get; set; } = string.Empty;
    /// <summary>Марка/модель (свободный текст).</summary>
    public string? Brand { get; set; }
    public string? Color { get; set; }
    public string? Notes { get; set; }
    public bool IsActive { get; set; } = true;
    /// <summary>Страна регистрации номера (напр. AZ).</summary>
    public string? Country { get; set; }
    /// <summary>Компания владельца.</summary>
    public string? Company { get; set; }
    /// <summary>Тип: car|truck|bus|motorcycle|other.</summary>
    public string? VehicleType { get; set; }
    /// <summary>Фото автомобиля (URL/путь).</summary>
    public string? PhotoUrl { get; set; }
    /// <summary>Владелец мест: его квота ограничивает, сколько его машин стоит одновременно.</summary>
    public Guid? HolderId { get; set; }
    public ParkingHolder? Holder { get; set; }
    /// <summary>Ограничение времени стоянки в минутах; null — без ограничения.</summary>
    public int? TimeLimitMinutes { get; set; }
    /// <summary>Категория: employee|management|vip|service — для отчётов и отображения.</summary>
    public string? Category { get; set; }
    /// <summary>Дата окончания доступа (лицензии); после неё машину не пускают. null — бессрочно.</summary>
    public DateOnly? AccessValidTo { get; set; }
    /// <summary>Зона, куда разрешён въезд; null — все зоны.</summary>
    public Guid? ZoneId { get; set; }
    public ParkingZone? Zone { get; set; }
    public ICollection<ParkingPermit> Permits { get; set; } = new List<ParkingPermit>();
}

/// <summary>
/// Пропуск — прежняя форма разрешения на въезд. Сейчас доступом управляет сама карточка машины
/// (<see cref="ParkingVehicle.AccessValidTo"/> и <see cref="ParkingVehicle.ZoneId"/>), а таблица
/// оставлена ради истории: миграция перенесла из неё сроки и зоны в машины.
/// </summary>
public sealed class ParkingPermit : BaseEntity
{
    public Guid VehicleId { get; set; }
    public ParkingVehicle? Vehicle { get; set; }
    /// <summary>Зона действия; null — все зоны.</summary>
    public Guid? ZoneId { get; set; }
    public ParkingZone? Zone { get; set; }
    public DateOnly ValidFrom { get; set; }
    public DateOnly? ValidTo { get; set; }
    /// <summary>false — приостановлен вручную (независимо от дат).</summary>
    public bool IsActive { get; set; } = true;
    public string? Notes { get; set; }
}

/// <summary>Системный аудит-лог. Кто, что, когда сделал. Пишется middleware-ом + точечными вызовами.</summary>
public sealed class AuditLogEntry
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public DateTime TimestampUtc { get; set; } = DateTime.UtcNow;
    public Guid? UserId { get; set; }
    public string UserEmail { get; set; } = "";
    public string Category { get; set; } = "";       // Auth, Employees, Devices, AccessLevels, WorkSchedules, Users, Roles, System, Backup, GeoZones, Visitors, Other
    public string Action { get; set; } = "";          // Human-readable: "Created device", "Login", etc.
    public string Method { get; set; } = "";         // HTTP method (or "LOGIN" / "LOGOUT" for special events)
    public string Path { get; set; } = "";           // Request path
    public int? StatusCode { get; set; }
    public string? IpAddress { get; set; }
    public string? Description { get; set; }         // Free text — extra context (e.g. target email)
    public bool Success { get; set; } = true;
}

/// <summary>Настраиваемый критерий табеля (davamiyyət kriteriyası): каждый день попадает в один из
/// key = normal|undertime|overtime|late|early_leave|dayoff|onleave|absent. Пользователь задаёт букву и цвет отображения.</summary>
public sealed class AttendanceCriteria : BaseEntity
{
    public string Key { get; set; } = string.Empty;   // normal|undertime|overtime|late|early_leave|dayoff|onleave|absent
    public string Label { get; set; } = string.Empty;
    public string Letter { get; set; } = string.Empty; // istifadəçi dəyişir (короткая метка для часовых-нет дней)
    public string Color { get; set; } = "#6B7280";     // hex, istifadəçi dəyişir
    public string DisplayMode { get; set; } = "letter"; // letter|hours — xanada hərf yoxsa saat göstərilsin
    public bool Enabled { get; set; } = true;
    public int SortOrder { get; set; }
}
