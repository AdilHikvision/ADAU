using ClosedXML.Excel;
using QuestPDF.Fluent;
using QuestPDF.Helpers;
using QuestPDF.Infrastructure;
using Backend.Domain.Entities;
using Backend.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

// ── shared data types ─────────────────────────────────────────────────────────

public sealed record AttendancePeriodRow(
    Guid EmployeeId,
    string EmployeeName,
    string? Department,
    DateOnly Date,
    string? ScheduleName,
    string? ShiftStart,
    string? ShiftEnd,
    DateTime? CheckInUtc,
    DateTime? CheckOutUtc,
    double TotalHours,
    int? LateMinutes,
    bool Corrected,
    double NormHours,
    double OvertimeHours,
    int? EarlyLeaveMinutes,
    bool IsDayOff,
    bool IsAbsent,
    bool OnLeave,
    string? LeaveType)
{
    /// <summary>Human-readable day status, shared by the Excel and PDF reports.</summary>
    public string StatusLabel =>
        IsDayOff ? "Day off"
        : OnLeave ? (LeaveType == "DayOff" ? "Day off (leave)" : "On leave")
        : IsAbsent ? "Absent"
        : CheckInUtc.HasValue ? "Present" : "";
}

/// <summary>
/// Колонки отчёта по посещаемости. Ключи общие для таблицы в интерфейсе, Excel,
/// PDF и письма: что администратор скрыл в таблице, не попадает и в выгрузки.
///
/// Ключ <c>shift</c> в таблице — одна колонка «Смена», в Excel и PDF он разворачивается
/// в пару «начало / конец». Ключи, которых на конкретной поверхности нет (например,
/// <c>norm</c> в Excel), там просто не участвуют.
/// </summary>
public static class AttendanceColumns
{
    public const string Employee = "employee";
    public const string Department = "department";
    public const string Date = "date";
    public const string Schedule = "schedule";
    public const string Shift = "shift";
    public const string CheckIn = "checkIn";
    public const string CheckOut = "checkOut";
    public const string Hours = "hours";
    public const string Norm = "norm";
    public const string Overtime = "overtime";
    public const string Late = "late";
    public const string Early = "early";
    public const string Status = "status";
    public const string Corrected = "corrected";

    public static readonly string[] All =
    [
        Employee, Department, Date, Schedule, Shift, CheckIn, CheckOut,
        Hours, Norm, Overtime, Late, Early, Status, Corrected,
    ];

    /// <summary>
    /// Разбирает список видимых колонок. Пусто, null или ни одного известного ключа —
    /// показываем всё: так ведут себя и старые клиенты, которые параметр не шлют.
    /// </summary>
    public static IReadOnlySet<string> Parse(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return All.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var known = raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(k => All.Contains(k, StringComparer.OrdinalIgnoreCase))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        return known.Count == 0 ? All.ToHashSet(StringComparer.OrdinalIgnoreCase) : known;
    }

    public static IReadOnlySet<string> Parse(IEnumerable<string>? keys) =>
        Parse(keys is null ? null : string.Join(',', keys));
}

public sealed record SchedulePlannerRow(
    string EmployeeName,
    string? Department,
    DateOnly Date,
    string? ScheduleName,
    string? ShiftStart,
    string? ShiftEnd,
    bool IsDayOff,
    string? LeaveType,
    string? Color,
    string? ScheduleType);

// Строка месячного табеля (İş vaxtının aylıq uçotu): дни месяца → (часы, ключ критерия).
public sealed record MonthlyTabelCell(double Hours, string Key);
public sealed record MonthlyTabelRow(
    string No,
    string ExternalId,
    string Fullname,
    string Position,
    string Department,
    Dictionary<int, MonthlyTabelCell> Days,
    int TotalDays,
    int TotalHours,
    int ExtraDays,
    int ExtraHours);

/// <summary>Стиль критерия табеля (из attendance_criteria, с дефолтами для отсутствующих ключей).</summary>
public sealed record TabelCritStyle(string Key, string Label, string Letter, string Color, string DisplayMode, bool Enabled);

/// <summary>Строка отчёта по проездам парковки (въезд/выезд, стоимость, оплата).</summary>
public sealed record ParkingSessionRow(
    string Plate,
    string? ZoneName,
    DateTime EnteredUtc,
    DateTime? ExitedUtc,
    int? DurationMinutes,
    bool IsPaid,
    decimal? Cost,
    string? PaymentMethod,
    DateTime? PaidUtc,
    decimal? PaidAmount,
    bool Overstay,
    string? CameraName,
    string? Operator)
{
    /// <summary>Выехал, стоимость начислена, оплаты не было.</summary>
    /// <summary>Недобор: начислено больше, чем принято кассой.</summary>
    public decimal DebtAmount => Math.Max(0m, (Cost ?? 0m) - (PaidAmount ?? 0m));
    public bool IsDebt => ExitedUtc.HasValue && DebtAmount > 0m;

    public string StatusLabel =>
        !ExitedUtc.HasValue ? "Inside"
        : IsDebt ? ((PaidAmount ?? 0m) > 0m ? "Underpaid" : "Unpaid")
        : Cost > 0 ? "Paid"
        : "Free";
}

public sealed record PayrollReportRow(
    string EmployeeName,
    string? EmployeeNo,
    string? Department,
    double WorkedDays,
    double WorkedHours,
    double OvertimeHours,
    int AbsentDays,
    decimal BasePay,
    decimal OvertimePay,
    decimal AllowancesTotal,
    decimal BonusesTotal,
    decimal GrossPay,
    decimal DeductionsTotal,
    decimal TaxAmount,
    decimal NetPay);

// ── Excel helpers ─────────────────────────────────────────────────────────────

public static class ExcelReportBuilder
{
    /// <summary>
    /// Колонки задаются описаниями, а не индексами: скрытая колонка просто выпадает
    /// из списка, и заголовки, данные, итоги и ширины сдвигаются сами.
    /// </summary>
    private sealed record XlCol(
        string Key,
        string Header,
        Action<IXLCell, AttendancePeriodRow, string> Write,
        double? MinWidth = null,
        Func<IReadOnlyList<AttendancePeriodRow>, double>? Sum = null);

    public static byte[] BuildAttendance(
        IReadOnlyList<AttendancePeriodRow> rows,
        DateTime from, DateTime to, string? employeeFilter,
        IReadOnlySet<string>? visibleColumns = null)
    {
        const string Brand = "#6e56cf";       // фирменный фиолетовый (Violet Aurora)
        const string BrandSoft = "#f0edfa";
        const string Line = "#e4e1ee";
        const string Muted = "#6e6980";

        var visible = visibleColumns ?? AttendanceColumns.Parse((string?)null);

        static string Hhmm(DateTime? utc) => utc.HasValue
            ? TimeZoneInfo.ConvertTimeFromUtc(utc.Value, TimeZoneInfo.Local).ToString("HH:mm") : "";

        // Опоздание и ранний уход считаются в минутах, но в отчётах их смотрят в часах —
        // так же, как часы и сверхурочные рядом и как в расчёте зарплаты.
        var all = new List<XlCol>
        {
            new(AttendanceColumns.Employee, "Employee", (c, r, _) =>
            {
                c.Value = r.EmployeeName;
                c.Style.Font.Bold = true;
            }, MinWidth: 22),

            new(AttendanceColumns.Department, "Department", (c, r, _) =>
            {
                c.Value = r.Department ?? "";
                c.Style.Font.FontColor = XLColor.FromHtml(Muted);
            }),

            new(AttendanceColumns.Date, "Date", (c, r, _) =>
            {
                c.Value = r.Date.ToDateTime(TimeOnly.MinValue);
                c.Style.DateFormat.Format = "dd.MM.yyyy";
                c.Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Center;
                if (r.Date.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday)
                    c.Style.Font.FontColor = XLColor.FromHtml("#8e77e8");
            }),

            new(AttendanceColumns.Schedule, "Schedule", (c, r, _) => c.Value = r.ScheduleName ?? ""),

            // Ключ shift разворачивается в две колонки.
            new(AttendanceColumns.Shift, "Shift Start", (c, r, _) =>
            {
                c.Value = r.ShiftStart ?? "";
                c.Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Center;
            }),
            new(AttendanceColumns.Shift, "Shift End", (c, r, _) =>
            {
                c.Value = r.ShiftEnd ?? "";
                c.Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Center;
            }),

            new(AttendanceColumns.CheckIn, "Check In", (c, r, _) =>
            {
                c.Value = Hhmm(r.CheckInUtc);
                c.Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Center;
            }, MinWidth: 11),

            new(AttendanceColumns.CheckOut, "Check Out", (c, r, _) =>
            {
                c.Value = Hhmm(r.CheckOutUtc);
                c.Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Center;
            }, MinWidth: 11),

            new(AttendanceColumns.Hours, "Hours", (c, r, _) =>
            {
                c.Value = r.TotalHours;
                c.Style.NumberFormat.Format = "0.00";
                c.Style.Font.Bold = true;
            }, Sum: rs => rs.Sum(x => x.TotalHours)),

            new(AttendanceColumns.Norm, "Norm", (c, r, _) =>
            {
                c.Value = r.NormHours > 0 ? (double?)r.NormHours : null;
                c.Style.NumberFormat.Format = "0.00";
                c.Style.Font.FontColor = XLColor.FromHtml(Muted);
            }, Sum: rs => rs.Sum(x => x.NormHours)),

            new(AttendanceColumns.Overtime, "Overtime", (c, r, _) =>
            {
                c.Value = r.OvertimeHours > 0 ? (double?)r.OvertimeHours : null;
                c.Style.NumberFormat.Format = "0.00";
                c.Style.Font.FontColor = XLColor.FromHtml(Brand);
            }, Sum: rs => rs.Sum(x => x.OvertimeHours)),

            new(AttendanceColumns.Late, "Late (h)", (c, r, _) =>
            {
                c.Value = r.LateMinutes.HasValue ? (double?)(r.LateMinutes.Value / 60.0) : null;
                c.Style.NumberFormat.Format = "0.00";
                if (r.LateMinutes > 0)
                {
                    c.Style.Font.FontColor = XLColor.FromHtml("#dc2637");
                    c.Style.Font.Bold = true;
                }
            }, Sum: rs => rs.Sum(x => (x.LateMinutes ?? 0) / 60.0)),

            new(AttendanceColumns.Early, "Early (h)", (c, r, _) =>
            {
                c.Value = r.EarlyLeaveMinutes.HasValue ? (double?)(r.EarlyLeaveMinutes.Value / 60.0) : null;
                c.Style.NumberFormat.Format = "0.00";
                if (r.EarlyLeaveMinutes > 0)
                    c.Style.Font.FontColor = XLColor.FromHtml("#ea580c");
            }, Sum: rs => rs.Sum(x => (x.EarlyLeaveMinutes ?? 0) / 60.0)),

            // Статус — цветной «чип»: заливка + цвет текста по состоянию дня.
            new(AttendanceColumns.Status, "Status", (c, r, rowBg) =>
            {
                var (stBg, stFg) = r.IsDayOff || (r.OnLeave && r.LeaveType == "DayOff") ? ("#eceaf2", Muted)
                    : r.OnLeave ? ("#fdf5e2", "#c07207")
                    : r.IsAbsent ? ("#fdeeef", "#dc2637")
                    : r.CheckInUtc.HasValue ? ("#e7f8f0", "#0e9f6e")
                    : (rowBg, "#16131f");
                c.Value = r.StatusLabel;
                c.Style.Fill.BackgroundColor = XLColor.FromHtml(stBg);
                c.Style.Font.FontColor = XLColor.FromHtml(stFg);
                c.Style.Font.Bold = true;
                c.Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Center;
            }, MinWidth: 14),

            new(AttendanceColumns.Corrected, "Corrected", (c, r, _) =>
            {
                c.Value = r.Corrected ? "Yes" : "";
                c.Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Center;
            }),
        };

        var cols = all.Where(c => visible.Contains(c.Key)).ToList();
        // Все колонки сняты — печатать пустой лист не из чего, оставляем набор по умолчанию.
        if (cols.Count == 0) cols = all;
        int nCols = cols.Count;

        using var wb = new XLWorkbook();
        var ws = wb.Worksheets.Add("Work Hours");
        ws.ShowGridLines = false;

        // Title block
        ws.Range(1, 1, 1, nCols).Merge();
        ws.Cell(1, 1).Value = "Work Hours Report";
        ws.Cell(1, 1).Style.Font.Bold = true;
        ws.Cell(1, 1).Style.Font.FontSize = 16;
        ws.Cell(1, 1).Style.Font.FontColor = XLColor.FromHtml(Brand);

        ws.Range(2, 1, 2, nCols).Merge();
        ws.Cell(2, 1).Value =
            $"Period: {from:dd.MM.yyyy} – {to:dd.MM.yyyy}"
            + (string.IsNullOrWhiteSpace(employeeFilter) ? "" : $"    ·    Employee: {employeeFilter}")
            + $"    ·    Generated: {DateTime.Now:dd.MM.yyyy HH:mm}";
        ws.Cell(2, 1).Style.Font.FontColor = XLColor.FromHtml(Muted);
        ws.Cell(2, 1).Style.Font.FontSize = 10;

        // Header row
        int headerRow = 4;
        for (int i = 0; i < nCols; i++)
        {
            var cell = ws.Cell(headerRow, i + 1);
            cell.Value = cols[i].Header;
            cell.Style.Font.Bold = true;
            cell.Style.Font.FontColor = XLColor.White;
            cell.Style.Fill.BackgroundColor = XLColor.FromHtml(Brand);
            cell.Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Center;
            cell.Style.Alignment.Vertical = XLAlignmentVerticalValues.Center;
        }
        ws.Row(headerRow).Height = 24;

        // Data
        int row = headerRow + 1;
        foreach (var r in rows)
        {
            bool weekend = r.Date.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday;
            bool zebra = (row - headerRow) % 2 == 0;
            string rowBg = weekend ? "#f4f2fb" : (zebra ? "#faf9fd" : "#ffffff");
            ws.Range(row, 1, row, nCols).Style.Fill.BackgroundColor = XLColor.FromHtml(rowBg);

            for (int i = 0; i < nCols; i++)
                cols[i].Write(ws.Cell(row, i + 1), r, rowBg);
            row++;
        }

        // Summary row
        if (rows.Count > 0)
        {
            ws.Range(row, 1, row, nCols).Style.Fill.BackgroundColor = XLColor.FromHtml(BrandSoft);
            ws.Range(row, 1, row, nCols).Style.Border.TopBorder = XLBorderStyleValues.Medium;
            ws.Range(row, 1, row, nCols).Style.Border.TopBorderColor = XLColor.FromHtml(Brand);
            ws.Cell(row, 1).Value = "TOTAL";
            ws.Cell(row, 1).Style.Font.Bold = true;
            ws.Cell(row, 1).Style.Font.FontColor = XLColor.FromHtml(Brand);
            for (int i = 0; i < nCols; i++)
            {
                if (cols[i].Sum is null) continue;
                var cell = ws.Cell(row, i + 1);
                cell.Value = cols[i].Sum!(rows);
                cell.Style.Font.Bold = true;
                cell.Style.NumberFormat.Format = "0.00";
            }
            ws.Row(row).Height = 20;
        }

        // Сетка: тонкие линии внутри таблицы.
        var tableRange = ws.Range(headerRow, 1, Math.Max(row, headerRow + 1), nCols);
        tableRange.Style.Border.InsideBorder = XLBorderStyleValues.Thin;
        tableRange.Style.Border.InsideBorderColor = XLColor.FromHtml(Line);
        tableRange.Style.Border.OutsideBorder = XLBorderStyleValues.Thin;
        tableRange.Style.Border.OutsideBorderColor = XLColor.FromHtml(Line);

        ws.SheetView.FreezeRows(headerRow);
        if (rows.Count > 0)
            ws.Range(headerRow, 1, row - 1, nCols).SetAutoFilter();

        ws.Columns().AdjustToContents();
        for (int i = 0; i < nCols; i++)
            if (cols[i].MinWidth is double w)
                ws.Column(i + 1).Width = Math.Max(ws.Column(i + 1).Width, w);

        using var ms = new MemoryStream();
        wb.SaveAs(ms);
        return ms.ToArray();
    }

    public static byte[] BuildPayroll(
        IReadOnlyList<PayrollReportRow> rows,
        int year, int month, string periodStatus)
    {
        using var wb = new XLWorkbook();
        var ws = wb.Worksheets.Add("Payroll");

        ws.Cell("A1").Value = $"Payroll Report — {month:D2}/{year}";
        ws.Cell("A1").Style.Font.Bold = true;
        ws.Cell("A1").Style.Font.FontSize = 14;
        ws.Cell("A2").Value = $"Status: {periodStatus}";

        int headerRow = 4;
        string[] headers = ["Employee", "No.", "Department", "Worked Days", "Worked H", "OT Hours",
            "Absent", "Base Pay", "OT Pay", "Allowances", "Bonuses", "Gross", "Deductions", "Tax", "Net Pay"];
        for (int i = 0; i < headers.Length; i++)
        {
            var cell = ws.Cell(headerRow, i + 1);
            cell.Value = headers[i];
            cell.Style.Font.Bold = true;
            cell.Style.Fill.BackgroundColor = XLColor.FromHtml("#6e56cf");
            cell.Style.Font.FontColor = XLColor.White;
            cell.Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Center;
        }

        string numFmt = "#,##0.00";
        int row = headerRow + 1;
        foreach (var r in rows)
        {
            ws.Cell(row, 1).Value = r.EmployeeName;
            ws.Cell(row, 2).Value = r.EmployeeNo ?? "";
            ws.Cell(row, 3).Value = r.Department ?? "";
            ws.Cell(row, 4).Value = r.WorkedDays;
            ws.Cell(row, 5).Value = r.WorkedHours;
            ws.Cell(row, 5).Style.NumberFormat.Format = "0.0";
            ws.Cell(row, 6).Value = r.OvertimeHours;
            ws.Cell(row, 6).Style.NumberFormat.Format = "0.0";
            ws.Cell(row, 7).Value = r.AbsentDays;
            ws.Cell(row, 8).Value = r.BasePay; ws.Cell(row, 8).Style.NumberFormat.Format = numFmt;
            ws.Cell(row, 9).Value = r.OvertimePay; ws.Cell(row, 9).Style.NumberFormat.Format = numFmt;
            ws.Cell(row, 10).Value = r.AllowancesTotal; ws.Cell(row, 10).Style.NumberFormat.Format = numFmt;
            ws.Cell(row, 11).Value = r.BonusesTotal; ws.Cell(row, 11).Style.NumberFormat.Format = numFmt;
            ws.Cell(row, 12).Value = r.GrossPay; ws.Cell(row, 12).Style.NumberFormat.Format = numFmt;
            ws.Cell(row, 13).Value = r.DeductionsTotal; ws.Cell(row, 13).Style.NumberFormat.Format = numFmt;
            ws.Cell(row, 14).Value = r.TaxAmount; ws.Cell(row, 14).Style.NumberFormat.Format = numFmt;
            ws.Cell(row, 15).Value = r.NetPay; ws.Cell(row, 15).Style.NumberFormat.Format = numFmt;
            ws.Cell(row, 15).Style.Font.Bold = true;
            row++;
        }

        // Totals
        if (rows.Count > 0)
        {
            int[] sumCols = [8, 9, 10, 11, 12, 13, 14, 15];
            ws.Cell(row, 1).Value = "TOTAL";
            ws.Cell(row, 1).Style.Font.Bold = true;
            ws.Cell(row, 4).Value = rows.Sum(r => r.WorkedDays);
            ws.Cell(row, 5).Value = rows.Sum(r => r.WorkedHours);
            ws.Cell(row, 5).Style.NumberFormat.Format = "0.0";
            foreach (int col in sumCols)
            {
                var val = col switch
                {
                    8 => rows.Sum(r => r.BasePay),
                    9 => rows.Sum(r => r.OvertimePay),
                    10 => rows.Sum(r => r.AllowancesTotal),
                    11 => rows.Sum(r => r.BonusesTotal),
                    12 => rows.Sum(r => r.GrossPay),
                    13 => rows.Sum(r => r.DeductionsTotal),
                    14 => rows.Sum(r => r.TaxAmount),
                    15 => rows.Sum(r => r.NetPay),
                    _ => 0m
                };
                ws.Cell(row, col).Value = val;
                ws.Cell(row, col).Style.NumberFormat.Format = numFmt;
                ws.Cell(row, col).Style.Font.Bold = true;
            }
            ws.Row(row).Style.Fill.BackgroundColor = XLColor.FromHtml("#f0f0f0");
        }

        ws.Columns().AdjustToContents();
        using var ms = new MemoryStream();
        wb.SaveAs(ms);
        return ms.ToArray();
    }

    public static byte[] BuildSchedulePlanner(
        IReadOnlyList<SchedulePlannerRow> rows, DateOnly from, DateOnly to)
    {
        using var wb = new XLWorkbook();
        var ws = wb.Worksheets.Add("Schedule Planner");

        ws.Cell("A1").Value = "Schedule Planner";
        ws.Cell("A1").Style.Font.Bold = true;
        ws.Cell("A1").Style.Font.FontSize = 14;
        ws.Cell("A2").Value = $"Period: {from:dd.MM.yyyy} – {to:dd.MM.yyyy}";

        var dates = new List<DateOnly>();
        for (var d = from; d <= to; d = d.AddDays(1)) dates.Add(d);

        var employees = rows.GroupBy(r => r.EmployeeName)
            .Select(g => new { Name = g.Key, Dept = g.First().Department, ByDate = g.ToDictionary(x => x.Date) })
            .OrderBy(x => x.Name).ToList();

        int headerRow = 4;
        ws.Cell(headerRow, 1).Value = "Employee";
        ws.Cell(headerRow, 2).Value = "Department";
        for (int i = 0; i < dates.Count; i++)
        {
            var c = ws.Cell(headerRow, 3 + i);
            c.Value = dates[i].ToString("dd MMM");
            var isWeekend = dates[i].DayOfWeek == DayOfWeek.Saturday || dates[i].DayOfWeek == DayOfWeek.Sunday;
            c.Style.Font.FontColor = isWeekend ? XLColor.FromHtml("#dc2626") : XLColor.White;
            c.Style.Fill.BackgroundColor = isWeekend ? XLColor.FromHtml("#fef2f2") : XLColor.FromHtml("#6e56cf");
            c.Style.Font.Bold = true;
            c.Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Center;
        }
        ws.Cell(headerRow, 1).Style.Fill.BackgroundColor = XLColor.FromHtml("#6e56cf");
        ws.Cell(headerRow, 1).Style.Font.FontColor = XLColor.White;
        ws.Cell(headerRow, 1).Style.Font.Bold = true;
        ws.Cell(headerRow, 2).Style.Fill.BackgroundColor = XLColor.FromHtml("#6e56cf");
        ws.Cell(headerRow, 2).Style.Font.FontColor = XLColor.White;
        ws.Cell(headerRow, 2).Style.Font.Bold = true;

        int row = headerRow + 1;
        foreach (var emp in employees)
        {
            ws.Cell(row, 1).Value = emp.Name;
            ws.Cell(row, 1).Style.Font.Bold = true;
            ws.Cell(row, 2).Value = emp.Dept ?? "";
            ws.Cell(row, 2).Style.Font.FontColor = XLColor.FromHtml("#666666");
            for (int i = 0; i < dates.Count; i++)
            {
                var cell = ws.Cell(row, 3 + i);
                if (!emp.ByDate.TryGetValue(dates[i], out var cellRow))
                {
                    cell.Value = "";
                    continue;
                }
                if (cellRow.IsDayOff)
                {
                    cell.Value = "OFF";
                    cell.Style.Fill.BackgroundColor = XLColor.FromHtml("#fee2e2");
                    cell.Style.Font.FontColor = XLColor.FromHtml("#dc2626");
                    cell.Style.Font.Bold = true;
                }
                else
                {
                    var schedShort = string.IsNullOrEmpty(cellRow.ScheduleName)
                        ? "—"
                        : (cellRow.ScheduleName.Length > 14 ? cellRow.ScheduleName.Substring(0, 14) + "…" : cellRow.ScheduleName);
                    var times = (cellRow.ShiftStart is null && cellRow.ShiftEnd is null)
                        ? cellRow.ScheduleType ?? ""
                        : $"{cellRow.ShiftStart ?? "—"}–{cellRow.ShiftEnd ?? "—"}";
                    cell.Value = string.IsNullOrEmpty(times) ? schedShort : $"{schedShort}\n{times}";
                    cell.Style.Alignment.WrapText = true;
                    if (!string.IsNullOrEmpty(cellRow.Color))
                    {
                        try
                        {
                            cell.Style.Fill.BackgroundColor = XLColor.FromHtml(cellRow.Color + "22");
                            cell.Style.Font.FontColor = XLColor.FromHtml(cellRow.Color);
                        }
                        catch { }
                    }
                }
                cell.Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Center;
                cell.Style.Alignment.Vertical = XLAlignmentVerticalValues.Center;
                cell.Style.Border.OutsideBorder = XLBorderStyleValues.Thin;
                cell.Style.Border.OutsideBorderColor = XLColor.FromHtml("#e5e7eb");
            }
            row++;
        }

        ws.Column(1).Width = 22;
        ws.Column(2).Width = 16;
        for (int i = 0; i < dates.Count; i++) ws.Column(3 + i).Width = 11;
        ws.SheetView.FreezeColumns(2);
        ws.SheetView.FreezeRows(headerRow);

        using var ms = new MemoryStream();
        wb.SaveAs(ms);
        return ms.ToArray();
    }

    // Ячейка табеля: часы (displayMode=hours) или буква критерия; цвет/заливка из критерия.
    static (string Text, string Color) TabelCellContent(MonthlyTabelCell cell, IReadOnlyDictionary<string, TabelCritStyle> crit)
    {
        crit.TryGetValue(cell.Key, out var c);
        var color = c?.Color ?? "#6B7280";
        var letter = c?.Letter ?? "";
        var mode = c?.DisplayMode == "hours" ? "hours" : "letter";
        var text = mode == "hours"
            ? (cell.Hours > 0 ? cell.Hours.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture) : letter)
            : (letter.Length > 0 ? letter : (cell.Hours > 0 ? cell.Hours.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture) : ""));
        return (text, color);
    }

    // Светлая заливка из hex-цвета критерия (смешение с белым, как #RRGGBB22 в UI).
    static XLColor TabelTint(string hex)
    {
        try
        {
            var c = System.Drawing.ColorTranslator.FromHtml(hex);
            static int Mix(int ch) => ch + (int)((255 - ch) * 0.85);
            return XLColor.FromArgb(Mix(c.R), Mix(c.G), Mix(c.B));
        }
        catch { return XLColor.White; }
    }

    public static byte[] BuildMonthlyTabel(
        IReadOnlyList<MonthlyTabelRow> rows,
        int year, int month,
        IReadOnlyDictionary<string, TabelCritStyle> crit)
    {
        int daysInMonth = DateTime.DaysInMonth(year, month);
        using var wb = new XLWorkbook();
        var ws = wb.Worksheets.Add("Tabel");

        ws.Cell("A1").Value = $"İş vaxtının aylıq uçotu — Tabel — {year:D4}-{month:D2}";
        ws.Cell("A1").Style.Font.Bold = true;
        ws.Cell("A1").Style.Font.FontSize = 14;

        int headerRow = 3;
        var headers = new List<string> { "S/S", "Tab. №", "Soyadı, adı, atasının adı", "Vəzifəsi", "Struktur bölməsi" };
        for (int d = 1; d <= daysInMonth; d++) headers.Add(d.ToString());
        headers.AddRange(["Cəmi gün", "Cəmi saat", "Əlavə gün", "Əlavə saat"]);
        for (int i = 0; i < headers.Count; i++)
        {
            var cell = ws.Cell(headerRow, i + 1);
            cell.Value = headers[i];
            cell.Style.Font.Bold = true;
            cell.Style.Fill.BackgroundColor = XLColor.FromHtml("#6e56cf");
            cell.Style.Font.FontColor = XLColor.White;
            cell.Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Center;
        }
        // Выходные (сб/вс) в шапке — приглушённая заливка.
        for (int d = 1; d <= daysInMonth; d++)
        {
            var dow = new DateTime(year, month, d).DayOfWeek;
            if (dow == DayOfWeek.Saturday || dow == DayOfWeek.Sunday)
                ws.Cell(headerRow, 5 + d).Style.Fill.BackgroundColor = XLColor.FromHtml("#8e77e8");
        }

        int row = headerRow + 1;
        int idx = 1;
        foreach (var r in rows)
        {
            ws.Cell(row, 1).Value = idx++;
            ws.Cell(row, 2).Value = r.ExternalId;
            ws.Cell(row, 3).Value = r.Fullname;
            ws.Cell(row, 4).Value = r.Position;
            ws.Cell(row, 5).Value = r.Department;
            for (int d = 1; d <= daysInMonth; d++)
            {
                var cell = ws.Cell(row, 5 + d);
                cell.Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Center;
                if (!r.Days.TryGetValue(d, out var dayCell)) continue;
                var (text, color) = TabelCellContent(dayCell, crit);
                cell.Value = text;
                cell.Style.Font.Bold = true;
                cell.Style.Font.FontColor = XLColor.FromHtml(color);
                cell.Style.Fill.BackgroundColor = TabelTint(color);
            }
            ws.Cell(row, 5 + daysInMonth + 1).Value = r.TotalDays;
            ws.Cell(row, 5 + daysInMonth + 2).Value = r.TotalHours;
            ws.Cell(row, 5 + daysInMonth + 3).Value = r.ExtraDays;
            ws.Cell(row, 5 + daysInMonth + 4).Value = r.ExtraHours;
            row++;
        }

        // Итого по колонке "Cəmi saat".
        if (rows.Count > 0)
        {
            ws.Cell(row, 3).Value = "TOTAL";
            ws.Cell(row, 3).Style.Font.Bold = true;
            ws.Cell(row, 5 + daysInMonth + 2).Value = rows.Sum(r => r.TotalHours);
            ws.Cell(row, 5 + daysInMonth + 2).Style.Font.Bold = true;
            ws.Row(row).Style.Fill.BackgroundColor = XLColor.FromHtml("#f0f0f0");
        }

        // Легенда критериев.
        int legendRow = row + 2;
        ws.Cell(legendRow, 1).Value = "Kodların izahı:";
        ws.Cell(legendRow, 1).Style.Font.Bold = true;
        int lr = legendRow + 1;
        foreach (var c in crit.Values.Where(c => c.Enabled).OrderBy(c => c.Key))
        {
            ws.Cell(lr, 1).Value = c.Letter.Length > 0 ? c.Letter : "S";
            ws.Cell(lr, 1).Style.Font.Bold = true;
            ws.Cell(lr, 1).Style.Font.FontColor = XLColor.FromHtml(c.Color);
            ws.Cell(lr, 1).Style.Fill.BackgroundColor = TabelTint(c.Color);
            ws.Cell(lr, 1).Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Center;
            ws.Cell(lr, 2).Value = c.Label + (c.DisplayMode == "hours" ? " (saat)" : "");
            lr++;
        }

        ws.Column(1).Width = 5;
        ws.Column(2).Width = 10;
        ws.Column(3).Width = 28;
        ws.Column(4).Width = 16;
        ws.Column(5).Width = 16;
        for (int d = 1; d <= daysInMonth; d++) ws.Column(5 + d).Width = 4.5;
        for (int i = 1; i <= 4; i++) ws.Column(5 + daysInMonth + i).Width = 9;
        ws.SheetView.FreezeColumns(3);
        ws.SheetView.FreezeRows(headerRow);

        using var ms = new MemoryStream();
        wb.SaveAs(ms);
        return ms.ToArray();
    }

    /// <summary>Отчёт по проездам парковки: сводка сверху, построчная расшифровка ниже.</summary>
    public static byte[] BuildParkingSessions(
        IReadOnlyList<ParkingSessionRow> rows,
        DateOnly from, DateOnly to)
    {
        using var wb = new XLWorkbook();
        var ws = wb.Worksheets.Add("Parking");

        ws.Cell("A1").Value = $"Parking report — {from:yyyy-MM-dd} … {to:yyyy-MM-dd}";
        ws.Cell("A1").Style.Font.Bold = true;
        ws.Cell("A1").Style.Font.FontSize = 14;

        var closed = rows.Where(r => r.ExitedUtc.HasValue).ToList();
        var summary = new (string Label, string Value)[]
        {
            ("Entries", rows.Count.ToString()),
            ("Exits", closed.Count.ToString()),
            ("Still inside", rows.Count(r => !r.ExitedUtc.HasValue).ToString()),
            ("Avg duration, min", closed.Count > 0 ? Math.Round(closed.Average(r => r.DurationMinutes ?? 0)).ToString() : "0"),
            ("Revenue", rows.Sum(r => r.PaidAmount ?? 0m).ToString("0.00")),
            ("Debt", rows.Sum(r => r.DebtAmount).ToString("0.00")),
            ("Overstays", rows.Count(r => r.Overstay).ToString()),
        };
        for (int i = 0; i < summary.Length; i++)
        {
            ws.Cell(2, i + 1).Value = summary[i].Label;
            ws.Cell(2, i + 1).Style.Font.Bold = true;
            ws.Cell(2, i + 1).Style.Font.FontColor = XLColor.FromHtml("#6e56cf");
            ws.Cell(3, i + 1).Value = summary[i].Value;
        }

        int headerRow = 5;
        string[] headers = ["Plate", "Zone", "Entered", "Exited", "Duration, min", "Camera", "Operator", "Status", "Cost", "Payment", "Overstay"];
        for (int i = 0; i < headers.Length; i++)
        {
            var cell = ws.Cell(headerRow, i + 1);
            cell.Value = headers[i];
            cell.Style.Font.Bold = true;
            cell.Style.Fill.BackgroundColor = XLColor.FromHtml("#6e56cf");
            cell.Style.Font.FontColor = XLColor.White;
        }

        int row = headerRow + 1;
        foreach (var r in rows)
        {
            ws.Cell(row, 1).Value = r.Plate;
            ws.Cell(row, 2).Value = r.ZoneName ?? "";
            ws.Cell(row, 3).Value = r.EnteredUtc.ToLocalTime().ToString("yyyy-MM-dd HH:mm");
            ws.Cell(row, 4).Value = r.ExitedUtc?.ToLocalTime().ToString("yyyy-MM-dd HH:mm") ?? "";
            ws.Cell(row, 5).Value = r.DurationMinutes ?? 0;
            ws.Cell(row, 6).Value = r.CameraName ?? "";
            ws.Cell(row, 7).Value = r.Operator ?? "";
            ws.Cell(row, 8).Value = r.StatusLabel;
            ws.Cell(row, 9).Value = r.Cost ?? 0m;
            ws.Cell(row, 10).Value = r.PaymentMethod ?? "";
            ws.Cell(row, 11).Value = r.Overstay ? "yes" : "";
            // Долг выделяем цветом — иначе строка теряется среди оплаченных.
            if (r.IsDebt)
            {
                ws.Cell(row, 8).Style.Font.FontColor = XLColor.FromHtml("#dc2637");
                ws.Cell(row, 8).Style.Font.Bold = true;
            }
            if (r.Overstay) ws.Cell(row, 11).Style.Font.FontColor = XLColor.FromHtml("#c07207");
            row++;
        }

        if (rows.Count > 0)
        {
            ws.Cell(row, 8).Value = "TOTAL";
            ws.Cell(row, 8).Style.Font.Bold = true;
            ws.Cell(row, 9).Value = rows.Sum(r => r.Cost ?? 0m);
            ws.Cell(row, 9).Style.Font.Bold = true;
            ws.Row(row).Style.Fill.BackgroundColor = XLColor.FromHtml("#f0f0f0");
        }

        ws.Columns().AdjustToContents();
        ws.SheetView.FreezeRows(headerRow);

        using var ms = new MemoryStream();
        wb.SaveAs(ms);
        return ms.ToArray();
    }
}

// ── PDF helpers ───────────────────────────────────────────────────────────────

public static class PdfReportBuilder
{
    static readonly string PrimaryHex = "#6e56cf";

    /// <summary>
    /// Как и в Excel, колонки описаны списком: скрытая просто не попадает в него,
    /// и ширины, заголовки, ячейки и строка итогов перестраиваются автоматически.
    /// </summary>
    private sealed record PdfCol(
        string Key,
        string Header,
        float Width,
        bool Relative,
        Action<IContainer, AttendancePeriodRow> Write,
        Func<IReadOnlyList<AttendancePeriodRow>, string>? Sum = null,
        string? SumColor = null);

    public static byte[] BuildAttendance(
        IReadOnlyList<AttendancePeriodRow> rows,
        DateTime from, DateTime to, string? employeeFilter,
        IReadOnlySet<string>? visibleColumns = null)
    {
        const string Line = "#ecebf4";
        const string Ink = "#1a1a2e";
        const string Muted = "#6e6980";

        var visible = visibleColumns ?? AttendanceColumns.Parse((string?)null);

        static string Hhmm(DateTime? utc) => utc.HasValue
            ? TimeZoneInfo.ConvertTimeFromUtc(utc.Value, TimeZoneInfo.Local).ToString("HH:mm") : "—";

        var all = new List<PdfCol>
        {
            new(AttendanceColumns.Employee, "Employee", 3, true, (c, r) =>
                c.Text(r.EmployeeName).FontSize(7.5f).SemiBold().FontColor(Ink)),

            new(AttendanceColumns.Department, "Department", 2, true, (c, r) =>
                c.Text(r.Department ?? "").FontSize(7.5f).FontColor(Muted)),

            new(AttendanceColumns.Date, "Date", 52, false, (c, r) =>
                c.AlignCenter().Text(r.Date.ToString("dd.MM.yy")).FontSize(7.5f)
                    .FontColor(r.Date.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday ? "#8e77e8" : Ink)),

            new(AttendanceColumns.Schedule, "Schedule", 2, true, (c, r) =>
                c.Text(r.ScheduleName ?? "").FontSize(7.5f).FontColor(Ink)),

            // Ключ shift разворачивается в две колонки.
            new(AttendanceColumns.Shift, "Shift S", 38, false, (c, r) =>
                c.AlignCenter().Text(r.ShiftStart ?? "").FontSize(7.5f).FontColor(Muted)),
            new(AttendanceColumns.Shift, "Shift E", 38, false, (c, r) =>
                c.AlignCenter().Text(r.ShiftEnd ?? "").FontSize(7.5f).FontColor(Muted)),

            new(AttendanceColumns.CheckIn, "In", 38, false, (c, r) =>
                c.AlignCenter().Text(Hhmm(r.CheckInUtc)).FontSize(7.5f).FontColor(Ink)),

            new(AttendanceColumns.CheckOut, "Out", 38, false, (c, r) =>
                c.AlignCenter().Text(Hhmm(r.CheckOutUtc)).FontSize(7.5f).FontColor(Ink)),

            new(AttendanceColumns.Hours, "Hours", 36, false, (c, r) =>
                c.AlignRight().Text(r.TotalHours > 0 ? r.TotalHours.ToString("0.00") : "")
                    .FontSize(7.5f).Bold().FontColor(Ink),
                Sum: rs => rs.Sum(x => x.TotalHours).ToString("0.00")),

            new(AttendanceColumns.Norm, "Norm", 36, false, (c, r) =>
                c.AlignRight().Text(r.NormHours > 0 ? r.NormHours.ToString("0.00") : "")
                    .FontSize(7.5f).FontColor(Muted),
                Sum: rs => rs.Sum(x => x.NormHours).ToString("0.00")),

            new(AttendanceColumns.Overtime, "OT", 36, false, (c, r) =>
                c.AlignRight().Text(r.OvertimeHours > 0 ? r.OvertimeHours.ToString("0.00") : "")
                    .FontSize(7.5f).FontColor(PrimaryHex),
                Sum: rs => rs.Sum(x => x.OvertimeHours).ToString("0.00"), SumColor: PrimaryHex),

            // Опоздание и ранний уход — в часах, как соседние колонки часов.
            new(AttendanceColumns.Late, "Late h", 36, false, (c, r) =>
                c.AlignRight().Text(r.LateMinutes > 0 ? (r.LateMinutes!.Value / 60.0).ToString("0.00") : "")
                    .FontSize(7.5f).Bold().FontColor(r.LateMinutes > 0 ? "#dc2637" : Ink),
                Sum: rs => rs.Sum(x => (x.LateMinutes ?? 0) / 60.0).ToString("0.00"), SumColor: "#dc2637"),

            new(AttendanceColumns.Early, "Early h", 36, false, (c, r) =>
                c.AlignRight().Text(r.EarlyLeaveMinutes > 0 ? (r.EarlyLeaveMinutes!.Value / 60.0).ToString("0.00") : "")
                    .FontSize(7.5f).FontColor("#ea580c"),
                Sum: rs => rs.Sum(x => (x.EarlyLeaveMinutes ?? 0) / 60.0).ToString("0.00"), SumColor: "#ea580c"),

            new(AttendanceColumns.Status, "Status", 58, false, (c, r) =>
                c.AlignCenter().Text(r.StatusLabel).FontSize(7.5f).SemiBold().FontColor(
                    r.IsDayOff || (r.OnLeave && r.LeaveType == "DayOff") ? Muted
                    : r.OnLeave ? "#c07207"
                    : r.IsAbsent ? "#dc2637"
                    : r.CheckInUtc.HasValue ? "#0e9f6e"
                    : Ink)),

            new(AttendanceColumns.Corrected, "Corr.", 32, false, (c, r) =>
                c.AlignCenter().Text(r.Corrected ? "Yes" : "").FontSize(7.5f).FontColor(Muted)),
        };

        var cols = all.Where(c => visible.Contains(c.Key)).ToList();
        if (cols.Count == 0) cols = all;

        // Фон «чипа» статуса зависит от строки, поэтому он берётся отдельно от текста.
        static string StatusBg(AttendancePeriodRow r, string rowBg) =>
            r.IsDayOff || (r.OnLeave && r.LeaveType == "DayOff") ? "#eceaf2"
            : r.OnLeave ? "#fdf5e2"
            : r.IsAbsent ? "#fdeeef"
            : r.CheckInUtc.HasValue ? "#e7f8f0"
            : rowBg;

        var doc = Document.Create(container =>
        {
            container.Page(page =>
            {
                page.Size(PageSizes.A4.Landscape());
                page.Margin(1.5f, Unit.Centimetre);
                page.DefaultTextStyle(t => t.FontSize(8).FontFamily("Arial"));

                page.Header().Column(col =>
                {
                    col.Item().Row(r =>
                    {
                        r.RelativeItem().Column(left =>
                        {
                            left.Item().Text("Work Hours Report")
                                .FontSize(16).Bold().FontColor(PrimaryHex);
                            left.Item().Text($"Period: {from:dd.MM.yyyy} – {to:dd.MM.yyyy}"
                                    + (string.IsNullOrWhiteSpace(employeeFilter) ? "" : $"   ·   Employee: {employeeFilter}"))
                                .FontSize(9).FontColor(Muted);
                        });
                        r.AutoItem().AlignBottom().Text($"Generated: {DateTime.Now:dd.MM.yyyy HH:mm}")
                            .FontSize(7.5f).FontColor("#a09aaf");
                    });
                    col.Item().PaddingTop(6).LineHorizontal(1.5f).LineColor(PrimaryHex);
                });

                page.Content().PaddingTop(8).Table(table =>
                {
                    table.ColumnsDefinition(c =>
                    {
                        foreach (var col in cols)
                        {
                            if (col.Relative) c.RelativeColumn(col.Width);
                            else c.ConstantColumn(col.Width);
                        }
                    });

                    table.Header(h =>
                    {
                        foreach (var col in cols)
                        {
                            h.Cell().Background(PrimaryHex).PaddingVertical(4).PaddingHorizontal(3)
                                .Text(col.Header).FontColor("#ffffff").Bold().FontSize(7.5f);
                        }
                    });

                    // Ячейка с нижней волосяной линией — таблица читается без плотной сетки.
                    IContainer Body(string bg) => table.Cell()
                        .Background(bg)
                        .BorderBottom(0.5f).BorderColor(Line)
                        .PaddingVertical(3).PaddingHorizontal(3);

                    bool alt = false;
                    foreach (var r in rows)
                    {
                        bool weekend = r.Date.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday;
                        string bg = weekend ? "#f4f2fb" : (alt ? "#faf9fd" : "#ffffff");
                        alt = !alt;

                        foreach (var col in cols)
                        {
                            var cellBg = col.Key == AttendanceColumns.Status ? StatusBg(r, bg) : bg;
                            col.Write(Body(cellBg), r);
                        }
                    }

                    // Summary
                    if (rows.Count > 0)
                    {
                        IContainer Total() => table.Cell()
                            .Background("#f0edfa")
                            .BorderTop(1).BorderColor(PrimaryHex)
                            .PaddingVertical(4).PaddingHorizontal(3);

                        for (int i = 0; i < cols.Count; i++)
                        {
                            var col = cols[i];
                            if (i == 0)
                            {
                                Total().Text("TOTAL").Bold().FontSize(7.5f).FontColor(PrimaryHex);
                                continue;
                            }
                            if (col.Sum is null)
                            {
                                Total();
                                continue;
                            }
                            Total().AlignRight().Text(col.Sum(rows)).Bold().FontSize(7.5f)
                                .FontColor(col.SumColor ?? Ink);
                        }
                    }
                });

                page.Footer().Row(r =>
                {
                    r.RelativeItem().Text("ProjectX · Work Hours").FontSize(7).FontColor("#a09aaf");
                    r.AutoItem().Text(x =>
                    {
                        x.Span("Page ").FontSize(7).FontColor("#888888");
                        x.CurrentPageNumber().FontSize(7);
                        x.Span(" of ").FontSize(7);
                        x.TotalPages().FontSize(7);
                    });
                });
            });
        });

        using var ms = new MemoryStream();
        doc.GeneratePdf(ms);
        return ms.ToArray();
    }

    public static byte[] BuildPayroll(
        IReadOnlyList<PayrollReportRow> rows,
        int year, int month, string periodStatus)
    {
        var monthName = new System.Globalization.CultureInfo("en-US").DateTimeFormat.GetMonthName(month);

        var doc = Document.Create(container =>
        {
            container.Page(page =>
            {
                page.Size(PageSizes.A4.Landscape());
                page.Margin(1.5f, Unit.Centimetre);
                page.DefaultTextStyle(t => t.FontSize(8).FontFamily("Arial"));

                page.Header().Column(col =>
                {
                    col.Item().Text($"Payroll Report — {monthName} {year}")
                        .FontSize(16).Bold().FontColor(PrimaryHex);
                    col.Item().Text($"Status: {periodStatus} · Generated: {DateTime.Now:dd.MM.yyyy HH:mm}")
                        .FontSize(9).FontColor("#555555");
                    col.Item().PaddingTop(4).LineHorizontal(1).LineColor(PrimaryHex);
                });

                page.Content().PaddingTop(8).Table(table =>
                {
                    table.ColumnsDefinition(c =>
                    {
                        c.RelativeColumn(3); // Employee
                        c.ConstantColumn(40); // No.
                        c.RelativeColumn(2); // Dept
                        c.ConstantColumn(35); // WDays
                        c.ConstantColumn(35); // WH
                        c.ConstantColumn(35); // OT
                        c.ConstantColumn(60); // Base
                        c.ConstantColumn(55); // Alw+Bon
                        c.ConstantColumn(55); // Gross
                        c.ConstantColumn(45); // Ded
                        c.ConstantColumn(45); // Tax
                        c.ConstantColumn(60); // Net
                    });

                    table.Header(h =>
                    {
                        foreach (var hdr in new[] { "Employee", "No.", "Department", "Days", "Hours",
                            "OT Hrs", "Base Pay", "Alw+Bon", "Gross", "Deduct", "Tax", "Net Pay" })
                        {
                            h.Cell().Background(PrimaryHex).Padding(3)
                                .Text(hdr).FontColor("#ffffff").Bold().FontSize(7.5f);
                        }
                    });

                    bool alt = false;
                    foreach (var r in rows)
                    {
                        string bg = alt ? "#f8f8ff" : "#ffffff";
                        alt = !alt;

                        table.Cell().Background(bg).Padding(3).Text(r.EmployeeName).FontSize(7.5f);
                        table.Cell().Background(bg).Padding(3).Text(r.EmployeeNo ?? "").FontSize(7.5f);
                        table.Cell().Background(bg).Padding(3).Text(r.Department ?? "").FontSize(7.5f);
                        table.Cell().Background(bg).Padding(3).AlignRight().Text(r.WorkedDays.ToString("0.0")).FontSize(7.5f);
                        table.Cell().Background(bg).Padding(3).AlignRight().Text(r.WorkedHours.ToString("0.0")).FontSize(7.5f);
                        table.Cell().Background(bg).Padding(3).AlignRight().Text(r.OvertimeHours.ToString("0.0")).FontSize(7.5f);
                        table.Cell().Background(bg).Padding(3).AlignRight().Text(r.BasePay.ToString("N2")).FontSize(7.5f);
                        table.Cell().Background(bg).Padding(3).AlignRight()
                            .Text((r.AllowancesTotal + r.BonusesTotal).ToString("N2")).FontSize(7.5f);
                        table.Cell().Background(bg).Padding(3).AlignRight().Text(r.GrossPay.ToString("N2")).Bold().FontSize(7.5f);
                        table.Cell().Background(bg).Padding(3).AlignRight().Text(r.DeductionsTotal.ToString("N2")).FontSize(7.5f);
                        table.Cell().Background(bg).Padding(3).AlignRight().Text(r.TaxAmount.ToString("N2")).FontSize(7.5f);
                        table.Cell().Background(bg).Padding(3).AlignRight()
                            .Text(r.NetPay.ToString("N2")).Bold().FontColor("#16a34a").FontSize(7.5f);
                    }

                    // Totals row
                    if (rows.Count > 0)
                    {
                        table.Cell().ColumnSpan(3).Background("#f0f0f0").Padding(3).Text("TOTAL").Bold().FontSize(7.5f);
                        table.Cell().Background("#f0f0f0").Padding(3).AlignRight()
                            .Text(rows.Sum(r => r.WorkedDays).ToString("0.0")).Bold().FontSize(7.5f);
                        table.Cell().Background("#f0f0f0").Padding(3).AlignRight()
                            .Text(rows.Sum(r => r.WorkedHours).ToString("0.0")).Bold().FontSize(7.5f);
                        table.Cell().Background("#f0f0f0").Padding(3).AlignRight()
                            .Text(rows.Sum(r => r.OvertimeHours).ToString("0.0")).Bold().FontSize(7.5f);
                        table.Cell().Background("#f0f0f0").Padding(3).AlignRight()
                            .Text(rows.Sum(r => r.BasePay).ToString("N2")).Bold().FontSize(7.5f);
                        table.Cell().Background("#f0f0f0").Padding(3).AlignRight()
                            .Text((rows.Sum(r => r.AllowancesTotal) + rows.Sum(r => r.BonusesTotal)).ToString("N2")).Bold().FontSize(7.5f);
                        table.Cell().Background("#f0f0f0").Padding(3).AlignRight()
                            .Text(rows.Sum(r => r.GrossPay).ToString("N2")).Bold().FontSize(7.5f);
                        table.Cell().Background("#f0f0f0").Padding(3).AlignRight()
                            .Text(rows.Sum(r => r.DeductionsTotal).ToString("N2")).Bold().FontSize(7.5f);
                        table.Cell().Background("#f0f0f0").Padding(3).AlignRight()
                            .Text(rows.Sum(r => r.TaxAmount).ToString("N2")).Bold().FontSize(7.5f);
                        table.Cell().Background("#f0f0f0").Padding(3).AlignRight()
                            .Text(rows.Sum(r => r.NetPay).ToString("N2")).Bold().FontColor("#16a34a").FontSize(7.5f);
                    }
                });

                page.Footer().AlignRight()
                    .Text(x =>
                    {
                        x.Span("Page ").FontSize(7).FontColor("#888888");
                        x.CurrentPageNumber().FontSize(7);
                        x.Span(" of ").FontSize(7);
                        x.TotalPages().FontSize(7);
                    });
            });
        });

        using var ms = new MemoryStream();
        doc.GeneratePdf(ms);
        return ms.ToArray();
    }

    public static byte[] BuildSchedulePlanner(
        IReadOnlyList<SchedulePlannerRow> rows, DateOnly from, DateOnly to)
    {
        var dates = new List<DateOnly>();
        for (var d = from; d <= to; d = d.AddDays(1)) dates.Add(d);

        var employees = rows.GroupBy(r => r.EmployeeName)
            .Select(g => new { Name = g.Key, Dept = g.First().Department, ByDate = g.ToDictionary(x => x.Date) })
            .OrderBy(x => x.Name).ToList();

        var doc = Document.Create(container =>
        {
            container.Page(page =>
            {
                page.Size(PageSizes.A3.Landscape());
                page.Margin(1f, Unit.Centimetre);
                page.DefaultTextStyle(t => t.FontSize(7).FontFamily("Arial"));

                page.Header().Column(col =>
                {
                    col.Item().Text("Schedule Planner").FontSize(14).Bold().FontColor(PrimaryHex);
                    col.Item().Text($"Period: {from:dd.MM.yyyy} – {to:dd.MM.yyyy}").FontSize(8).FontColor("#555555");
                    col.Item().PaddingTop(4).LineHorizontal(1).LineColor(PrimaryHex);
                });

                page.Content().PaddingTop(6).Table(table =>
                {
                    table.ColumnsDefinition(c =>
                    {
                        c.ConstantColumn(110); // Employee
                        c.ConstantColumn(70);  // Department
                        foreach (var _ in dates) c.RelativeColumn(1);
                    });

                    table.Header(h =>
                    {
                        h.Cell().Background(PrimaryHex).Padding(2).Text("Employee").FontColor("#ffffff").Bold().FontSize(7);
                        h.Cell().Background(PrimaryHex).Padding(2).Text("Department").FontColor("#ffffff").Bold().FontSize(7);
                        foreach (var d in dates)
                        {
                            var isWeekend = d.DayOfWeek == DayOfWeek.Saturday || d.DayOfWeek == DayOfWeek.Sunday;
                            h.Cell().Background(isWeekend ? "#fef2f2" : PrimaryHex)
                                .Padding(2).AlignCenter().Text(d.ToString("dd"))
                                .FontColor(isWeekend ? "#dc2626" : "#ffffff").Bold().FontSize(7);
                        }
                    });

                    bool alt = false;
                    foreach (var emp in employees)
                    {
                        var rowBg = alt ? "#fafafa" : "#ffffff"; alt = !alt;
                        table.Cell().Background(rowBg).Padding(3).Text(emp.Name).Bold().FontSize(7);
                        table.Cell().Background(rowBg).Padding(3).Text(emp.Dept ?? "—").FontColor("#666666").FontSize(7);
                        foreach (var d in dates)
                        {
                            if (!emp.ByDate.TryGetValue(d, out var cellRow))
                            {
                                table.Cell().Background(rowBg).Padding(2).Text("");
                                continue;
                            }
                            if (cellRow.IsDayOff)
                            {
                                table.Cell().Background("#fee2e2").Padding(2).AlignCenter()
                                    .Text("OFF").FontColor("#dc2626").Bold().FontSize(6.5f);
                            }
                            else
                            {
                                var color = string.IsNullOrEmpty(cellRow.Color) ? "#6366f1" : cellRow.Color;
                                var sched = string.IsNullOrEmpty(cellRow.ScheduleName) ? "—" : cellRow.ScheduleName!;
                                var schedShort = sched.Length > 10 ? sched.Substring(0, 10) + "…" : sched;
                                var times = (cellRow.ShiftStart is null && cellRow.ShiftEnd is null)
                                    ? (cellRow.ScheduleType ?? "")
                                    : $"{cellRow.ShiftStart ?? "—"}-{cellRow.ShiftEnd ?? "—"}";
                                string bg;
                                try { bg = color + "22"; } catch { bg = rowBg; }
                                table.Cell().Background(bg).Padding(2).Column(col =>
                                {
                                    col.Item().AlignCenter().Text(schedShort).FontColor(color).Bold().FontSize(6.5f);
                                    if (!string.IsNullOrEmpty(times))
                                        col.Item().AlignCenter().Text(times).FontColor(color).FontSize(6);
                                });
                            }
                        }
                    }
                });

                page.Footer().AlignRight().Text(x =>
                {
                    x.Span("Page ").FontSize(7).FontColor("#888888");
                    x.CurrentPageNumber().FontSize(7);
                    x.Span(" of ").FontSize(7);
                    x.TotalPages().FontSize(7);
                });
            });
        });

        using var ms = new MemoryStream();
        doc.GeneratePdf(ms);
        return ms.ToArray();
    }

    // Светлый фон из hex-цвета критерия (аналог #RRGGBB22 в UI).
    static string TabelTintHex(string hex)
    {
        try
        {
            var c = System.Drawing.ColorTranslator.FromHtml(hex);
            static int Mix(int ch) => ch + (int)((255 - ch) * 0.85);
            return $"#{Mix(c.R):X2}{Mix(c.G):X2}{Mix(c.B):X2}";
        }
        catch { return "#ffffff"; }
    }

    public static byte[] BuildMonthlyTabel(
        IReadOnlyList<MonthlyTabelRow> rows,
        int year, int month,
        IReadOnlyDictionary<string, TabelCritStyle> crit)
    {
        int daysInMonth = DateTime.DaysInMonth(year, month);

        var doc = Document.Create(container =>
        {
            container.Page(page =>
            {
                page.Size(PageSizes.A3.Landscape());
                page.Margin(1.0f, Unit.Centimetre);
                page.DefaultTextStyle(t => t.FontSize(7).FontFamily("Arial"));

                page.Header().Column(col =>
                {
                    col.Item().Text("İş vaxtının aylıq uçotu — Tabel")
                        .FontSize(14).Bold().FontColor(PrimaryHex);
                    col.Item().Text($"Dövr: {year:D4}-{month:D2}")
                        .FontSize(9).FontColor("#555555");
                    col.Item().PaddingTop(4).LineHorizontal(1).LineColor(PrimaryHex);
                });

                page.Content().PaddingTop(8).Column(content =>
                {
                    content.Item().Table(table =>
                    {
                        table.ColumnsDefinition(c =>
                        {
                            c.ConstantColumn(20);  // S/S
                            c.ConstantColumn(44);  // Tab №
                            c.RelativeColumn(4);   // Name
                            c.RelativeColumn(2);   // Position
                            c.RelativeColumn(2);   // Department
                            for (int d = 0; d < daysInMonth; d++) c.ConstantColumn(19);
                            c.ConstantColumn(30);  // Cəmi gün
                            c.ConstantColumn(32);  // Cəmi saat
                            c.ConstantColumn(30);  // Əlavə gün
                            c.ConstantColumn(32);  // Əlavə saat
                        });

                        table.Header(h =>
                        {
                            void Head(string txt, string bg = "#6e56cf")
                                => h.Cell().Background(bg).Padding(2).AlignCenter()
                                    .Text(txt).FontColor("#ffffff").Bold().FontSize(6.5f);
                            Head("S/S"); Head("Tab.№"); Head("Soyadı, adı, atasının adı"); Head("Vəzifəsi"); Head("Şöbə");
                            for (int d = 1; d <= daysInMonth; d++)
                            {
                                var dow = new DateTime(year, month, d).DayOfWeek;
                                Head(d.ToString(), dow == DayOfWeek.Saturday || dow == DayOfWeek.Sunday ? "#8e77e8" : "#6e56cf");
                            }
                            Head("C.gün"); Head("C.saat"); Head("Ə.gün"); Head("Ə.saat");
                        });

                        bool alt = false;
                        int idx = 1;
                        foreach (var r in rows)
                        {
                            string bg = alt ? "#f8f8ff" : "#ffffff";
                            alt = !alt;
                            table.Cell().Background(bg).Padding(2).AlignCenter().Text(idx++.ToString()).FontSize(6.5f);
                            table.Cell().Background(bg).Padding(2).Text(r.ExternalId).FontSize(6.5f);
                            table.Cell().Background(bg).Padding(2).Text(r.Fullname).FontSize(6.5f);
                            table.Cell().Background(bg).Padding(2).Text(r.Position).FontSize(6.5f);
                            table.Cell().Background(bg).Padding(2).Text(r.Department).FontSize(6.5f);
                            for (int d = 1; d <= daysInMonth; d++)
                            {
                                if (!r.Days.TryGetValue(d, out var dayCell))
                                {
                                    table.Cell().Background(bg).Padding(2).Text("");
                                    continue;
                                }
                                crit.TryGetValue(dayCell.Key, out var cs);
                                var color = cs?.Color ?? "#6B7280";
                                var letter = cs?.Letter ?? "";
                                var mode = cs?.DisplayMode == "hours" ? "hours" : "letter";
                                var text = mode == "hours"
                                    ? (dayCell.Hours > 0 ? dayCell.Hours.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture) : letter)
                                    : (letter.Length > 0 ? letter : (dayCell.Hours > 0 ? dayCell.Hours.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture) : ""));
                                table.Cell().Background(TabelTintHex(color)).Padding(2).AlignCenter()
                                    .Text(text).FontColor(color).Bold().FontSize(6.5f);
                            }
                            table.Cell().Background(bg).Padding(2).AlignCenter().Text(r.TotalDays.ToString()).FontSize(6.5f);
                            table.Cell().Background(bg).Padding(2).AlignCenter().Text(r.TotalHours.ToString()).Bold().FontSize(6.5f);
                            table.Cell().Background(bg).Padding(2).AlignCenter().Text(r.ExtraDays.ToString()).FontSize(6.5f);
                            table.Cell().Background(bg).Padding(2).AlignCenter().Text(r.ExtraHours.ToString()).FontSize(6.5f);
                        }
                    });

                    // Легенда критериев.
                    content.Item().PaddingTop(10).Row(rowc =>
                    {
                        rowc.AutoItem().Text("Kodların izahı:  ").Bold().FontSize(7);
                        foreach (var c in crit.Values.Where(c => c.Enabled).OrderBy(c => c.Key))
                        {
                            rowc.AutoItem().PaddingRight(10).Text(t =>
                            {
                                t.Span((c.Letter.Length > 0 ? c.Letter : "S") + " ").FontColor(c.Color).Bold().FontSize(7);
                                t.Span(c.Label + (c.DisplayMode == "hours" ? " (saat)" : "")).FontSize(7).FontColor("#555555");
                            });
                        }
                    });
                });

                page.Footer().AlignRight().Text(x =>
                {
                    x.Span("Page ").FontSize(7).FontColor("#888888");
                    x.CurrentPageNumber().FontSize(7);
                    x.Span(" of ").FontSize(7);
                    x.TotalPages().FontSize(7);
                });
            });
        });

        using var ms = new MemoryStream();
        doc.GeneratePdf(ms);
        return ms.ToArray();
    }
/// <summary>Отчёт по проездам парковки: сводка и построчная расшифровка с пометкой долгов.</summary>
    public static byte[] BuildParkingSessions(
        IReadOnlyList<ParkingSessionRow> rows,
        DateOnly from, DateOnly to)
    {
        var closed = rows.Where(r => r.ExitedUtc.HasValue).ToList();
        var revenue = rows.Sum(r => r.PaidAmount ?? 0m);
        var debt = rows.Sum(r => r.DebtAmount);

        var doc = Document.Create(container =>
        {
            container.Page(page =>
            {
                page.Size(PageSizes.A4.Landscape());
                page.Margin(1.5f, Unit.Centimetre);
                page.DefaultTextStyle(t => t.FontSize(8).FontFamily("Arial"));

                page.Header().Column(col =>
                {
                    col.Item().Text($"Parking report — {from:yyyy-MM-dd} … {to:yyyy-MM-dd}")
                        .FontSize(16).Bold().FontColor(PrimaryHex);
                    col.Item().Text($"Entries: {rows.Count} · Exits: {closed.Count} · Inside: {rows.Count(r => !r.ExitedUtc.HasValue)} · Revenue: {revenue:0.00} · Debt: {debt:0.00} · Overstays: {rows.Count(r => r.Overstay)}")
                        .FontSize(9).FontColor("#555555");
                    col.Item().Text($"Generated: {DateTime.Now:dd.MM.yyyy HH:mm}").FontSize(8).FontColor("#888888");
                    col.Item().PaddingTop(4).LineHorizontal(1).LineColor(PrimaryHex);
                });

                page.Content().PaddingTop(8).Table(table =>
                {
                    table.ColumnsDefinition(c =>
                    {
                        c.RelativeColumn(2);   // Plate
                        c.RelativeColumn(2);   // Zone
                        c.ConstantColumn(85);  // Entered
                        c.ConstantColumn(85);  // Exited
                        c.ConstantColumn(45);  // Duration
                        c.RelativeColumn(2);   // Camera
                        c.ConstantColumn(55);  // Status
                        c.ConstantColumn(50);  // Cost
                        c.ConstantColumn(50);  // Payment
                    });

                    table.Header(h =>
                    {
                        foreach (var hdr in new[] { "Plate", "Zone", "Entered", "Exited", "Min", "Camera", "Status", "Cost", "Payment" })
                        {
                            h.Cell().Background(PrimaryHex).Padding(3)
                                .Text(hdr).FontColor("#ffffff").Bold().FontSize(7.5f);
                        }
                    });

                    bool alt = false;
                    foreach (var r in rows)
                    {
                        // Долг подсвечиваем строкой целиком, перепростой — только длительностью.
                        string bg = r.IsDebt ? "#fdeeef" : (alt ? "#f8f8ff" : "#ffffff");
                        alt = !alt;

                        table.Cell().Background(bg).Padding(3).Text(r.Plate).Bold().FontSize(7.5f);
                        table.Cell().Background(bg).Padding(3).Text(r.ZoneName ?? "").FontSize(7.5f);
                        table.Cell().Background(bg).Padding(3).Text(r.EnteredUtc.ToLocalTime().ToString("dd.MM HH:mm")).FontSize(7.5f);
                        table.Cell().Background(bg).Padding(3).Text(r.ExitedUtc?.ToLocalTime().ToString("dd.MM HH:mm") ?? "—").FontSize(7.5f);
                        table.Cell().Background(bg).Padding(3).Text(r.DurationMinutes?.ToString() ?? "—")
                            .FontColor(r.Overstay ? "#c07207" : "#1e293b").FontSize(7.5f);
                        table.Cell().Background(bg).Padding(3).Text(r.CameraName ?? r.Operator ?? "").FontSize(7.5f);
                        table.Cell().Background(bg).Padding(3).Text(r.StatusLabel)
                            .FontColor(r.IsDebt ? "#dc2637" : "#1e293b").Bold().FontSize(7.5f);
                        table.Cell().Background(bg).Padding(3).Text((r.Cost ?? 0m).ToString("0.00")).FontSize(7.5f);
                        table.Cell().Background(bg).Padding(3).Text(r.PaymentMethod ?? "").FontSize(7.5f);
                    }
                });

                page.Footer().AlignRight().Text(x =>
                {
                    x.Span("Page ").FontSize(7).FontColor("#888888");
                    x.CurrentPageNumber().FontSize(7);
                    x.Span(" of ").FontSize(7);
                    x.TotalPages().FontSize(7);
                });
            });
        });

        using var ms = new MemoryStream();
        doc.GeneratePdf(ms);
        return ms.ToArray();
    }
}
