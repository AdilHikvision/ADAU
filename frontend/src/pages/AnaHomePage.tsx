import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AppLayout } from '../components/templates'
import { apiRequest } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import './ana-home.css'

/* ═══════════════════════════════════════════════════════════════
   Ana səhifə — workforce modulunun açılış görünüşü (arkoz.html dizaynının portu).
   REAL DATA: /api/attendance/daily (bugünkü davamiyyət, son girişlər, növbələr),
   /api/leaves (məzuniyyət müraciətləri), /api/attendance/period (həftəlik statistika).
   Stil SCOPED: ana-home.css. Mətnlər i18n (anaHome.*).
   ═══════════════════════════════════════════════════════════════ */

const AV = [['#EFECFD', '#6C5CE7'], ['#EAF8F0', '#1E9B62'], ['#FEF4E6', '#D98324'], ['#E9F1FE', '#3A72CE'], ['#FDECEA', '#D9534A'], ['#F1EDFB', '#7B5BC9']]

interface DailyRow {
  employeeId: string
  employeeName: string | null
  scheduleName: string | null
  shiftStart: string | null
  shiftEnd: string | null
  checkInUtc: string | null
  isDayOff: boolean
  isAbsent: boolean
  onLeave: boolean
  lateMinutes: number | null
}
interface LeaveRow { id: string; employeeName: string; leaveType: string; startDate: string; endDate: string; status: string }
interface PeriodRow { employeeId: string; date: string; checkInUtc: string | null; isDayOff: boolean }

const svg = (d: string, color: string, size = 26) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    {d.split('|').map((p, i) => <path key={i} d={p} />)}
  </svg>
)
const IC_GROUP = 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2|M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8|M23 21v-2a4 4 0 0 0-3-3.87|M16 3.13a4 4 0 0 1 0 7.75'
const IC_CHECK = 'M22 11.08V12a10 10 0 1 1-5.93-9.14|M22 4 12 14.01l-3-3'
const IC_CLOCK = 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20|M12 6v6l4 2'
const IC_X = 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20|M15 9l-6 6|M9 9l6 6'
const ICONS: Record<string, string> = {
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10|M12 1v2|M12 21v2|M4.2 4.2l1.4 1.4|M18.4 18.4l1.4 1.4|M1 12h2|M21 12h2|M4.2 19.8l1.4-1.4|M18.4 5.6l1.4-1.4',
  noon: 'M17 18a5 5 0 0 0-10 0|M12 2v7|M4.2 10.2l1.4 1.4|M1 18h2|M21 18h2|M18.4 11.6l1.4-1.4|M23 22H1',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  scan: 'M3 7V5a2 2 0 0 1 2-2h2|M17 3h2a2 2 0 0 1 2 2v2|M21 17v2a2 2 0 0 1-2 2h-2|M7 21H5a2 2 0 0 1-2-2v-2|M8 11h.01|M16 11h.01|M9 15c1 1 2 1.5 3 1.5s2-.5 3-1.5',
  cal: 'M8 2v4|M16 2v4|M3 10h18|M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z',
  chart: 'M3 3v18h18|M18 17V9|M13 17V5|M8 17v-3',
}

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '—'

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })

export function AnaHomePage() {
  const { t, i18n } = useTranslation()
  const { token, hasPermission } = useAuth()
  // Главная собрана из данных посещаемости: роли без этих прав сервер отвечает 403,
  // поэтому запросы не отправляем — виджеты просто остаются пустыми.
  const canViewAttendance = hasPermission('Attendance.View')
  const canViewLeaves = hasPermission('Leaves.View')
  const navigate = useNavigate()
  const [daily, setDaily] = useState<DailyRow[]>([])
  const [leaves, setLeaves] = useState<LeaveRow[]>([])
  const [week, setWeek] = useState<PeriodRow[]>([])
  const [weekFrom, setWeekFrom] = useState<Date | null>(null)

  useEffect(() => {
    if (!token) return
    if (canViewAttendance)
      apiRequest<DailyRow[]>('/api/attendance/daily', { token }).then(setDaily).catch(() => setDaily([]))
    if (canViewLeaves)
      apiRequest<LeaveRow[]>('/api/leaves', { token }).then((l) => setLeaves(l.slice(0, 3))).catch(() => setLeaves([]))
    // Həftəlik statistika: cari həftə (B.e - B.)
    const now = new Date()
    const monday = new Date(now)
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7))
    const sunday = new Date(monday)
    sunday.setDate(monday.getDate() + 6)
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    setWeekFrom(monday)
    if (canViewAttendance)
      apiRequest<PeriodRow[]>(`/api/attendance/period?from=${iso(monday)}&to=${iso(sunday)}`, { token })
        .then(setWeek).catch(() => setWeek([]))
  }, [token, canViewAttendance, canViewLeaves])

  const stats = useMemo(() => {
    const workRows = daily.filter((r) => !r.isDayOff)
    const present = workRows.filter((r) => r.checkInUtc)
    const late = workRows.filter((r) => (r.lateMinutes ?? 0) > 0)
    const absent = workRows.filter((r) => r.isAbsent)
    const pct = (n: number) => (workRows.length > 0 ? Math.round((n / workRows.length) * 100) : 0)
    const recent = [...present].sort((a, b) => (b.checkInUtc! > a.checkInUtc! ? 1 : -1)).slice(0, 6)
    // Bugünkü növbələr: shiftStart–shiftEnd üzrə qruplaşdır
    const shiftMap = new Map<string, { name: string; time: string; count: number; startH: number }>()
    for (const r of workRows) {
      if (!r.shiftStart || !r.shiftEnd) continue
      const key = `${r.shiftStart}–${r.shiftEnd}`
      const cur = shiftMap.get(key)
      if (cur) cur.count++
      else shiftMap.set(key, { name: r.scheduleName ?? key, time: key, count: 1, startH: parseInt(r.shiftStart.slice(0, 2), 10) })
    }
    const shifts = Array.from(shiftMap.values()).sort((a, b) => a.startH - b.startH).slice(0, 4)
    return { total: daily.length, workCount: workRows.length, present, late, absent, pct, recent, shifts }
  }, [daily])

  const weekBars = useMemo(() => {
    if (!weekFrom) return []
    const byDate = new Map<string, Set<string>>()
    for (const r of week) {
      if (!r.checkInUtc) continue
      const d = r.date.slice(0, 10)
      if (!byDate.has(d)) byDate.set(d, new Set())
      byDate.get(d)!.add(r.employeeId)
    }
    const bars: { label: string; value: number; dim: boolean }[] = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekFrom)
      d.setDate(weekFrom.getDate() + i)
      const key = d.toISOString().slice(0, 10)
      bars.push({
        label: d.toLocaleDateString(i18n.language, { weekday: 'short' }),
        value: byDate.get(key)?.size ?? 0,
        dim: i >= 5,
      })
    }
    return bars
  }, [week, weekFrom, i18n.language])

  const weekMax = Math.max(stats.total, ...weekBars.map((b) => b.value), 1)
  const donutPresent = stats.pct(stats.present.length)
  const donutLate = stats.pct(stats.late.length)
  const donutAbsent = Math.max(0, 100 - donutPresent - donutLate)

  // Интерактивный донат: сегменты + ховер (тултип, подсветка, синхронизация с легендой).
  const donutSegs = [
    { key: 'present' as const, label: t('anaHome.kpiPresent'), count: stats.present.length, pct: donutPresent, color: '#22B573' },
    { key: 'late' as const, label: t('anaHome.kpiLate'), count: stats.late.length, pct: donutLate, color: '#E8A33D' },
    { key: 'absent' as const, label: t('anaHome.kpiAbsent'), count: stats.absent.length, pct: donutAbsent, color: '#E9736A' },
  ]
  const [donutHover, setDonutHover] = useState<{ key: 'present' | 'late' | 'absent'; x: number; y: number } | null>(null)
  const donutHoverSeg = donutHover ? donutSegs.find((s) => s.key === donutHover.key) ?? null : null
  const lastIn = stats.recent[0] ?? null

  const leaveChip = (s: string) => (s === 'Approved' ? 'green' : s === 'Rejected' ? 'red' : 'orange')
  const shiftIcon = (h: number) => (h < 12 ? 'sun' : h < 17 ? 'noon' : 'moon')
  const shiftTint: Record<string, [string, string]> = { sun: ['#FEF4E6', '#D98324'], noon: ['#E9F1FE', '#3A72CE'], moon: ['#EFECFD', '#6C5CE7'] }

  const ACTIONS = [
    { icon: 'scan', tint: '#EFECFD', color: '#6C5CE7', title: t('anaHome.actionDevices'), desc: t('anaHome.actionDevicesDesc'), to: '/monitoring' },
    { icon: 'cal', tint: '#EAF8F0', color: '#1E9B62', title: t('anaHome.actionLeave'), desc: t('anaHome.actionLeaveDesc'), to: '/work-hours' },
    { icon: 'chart', tint: '#FEF4E6', color: '#D98324', title: t('anaHome.actionReport'), desc: t('anaHome.actionReportDesc'), to: '/work-hours' },
  ]

  return (
    <AppLayout onAction={() => {}}>
      <div className="ana-root">

        {/* HERO */}
        <div className="ana-hero">
          <img className="ana-hero-img" src="/ana-hero.png" alt="" />
          <div className="ana-hero-text">
            <h1>{t('anaHome.welcome')} 👋</h1>
            <p>{t('anaHome.welcomeSub')}</p>
          </div>
          <div className="ana-hero-cards">
            <div className="ana-float">
              <span className="ic" style={{ background: '#EAF8F0' }}>{svg(IC_CHECK, '#1E9B62', 20)}</span>
              <div>
                <div className="l1">{lastIn?.checkInUtc ? fmtTime(lastIn.checkInUtc) : '—'}</div>
                <div className="l2">{lastIn ? `${lastIn.employeeName ?? '—'} · ${t('anaHome.lastCheckIn')}` : t('anaHome.lastCheckIn')}</div>
              </div>
            </div>
            <div className="ana-float">
              <span className="ic" style={{ background: '#EFECFD' }}>{svg(IC_GROUP, '#6C5CE7', 20)}</span>
              <div>
                <div className="l1">{t('anaHome.presentCount', { count: stats.present.length })}</div>
                <div className="l2">{t('anaHome.presentNow')}</div>
              </div>
            </div>
          </div>
        </div>

        {/* KPI — клик ведёт в дневной отчёт с соответствующим фильтром */}
        <div className="ana-kpis">
          {([
            { cls: 'ana-kpi', sub: 'all', icBg: '#EFECFD', ic: svg(IC_GROUP, '#6C5CE7'), lbl: t('anaHome.kpiTotal'), num: stats.total, numColor: '#252641', subText: t('anaHome.persons') },
            { cls: 'ana-kpi green', sub: 'present', icBg: '#EAF8F0', ic: svg(IC_CHECK, '#1E9B62'), lbl: t('anaHome.kpiPresent'), num: stats.present.length, numColor: '#1E9B62', subText: t('anaHome.personsPct', { pct: donutPresent }) },
            { cls: 'ana-kpi orange', sub: 'late', icBg: '#FEF4E6', ic: svg(IC_CLOCK, '#D98324'), lbl: t('anaHome.kpiLate'), num: stats.late.length, numColor: '#D98324', subText: t('anaHome.personsPct', { pct: donutLate }) },
            { cls: 'ana-kpi red', sub: 'absent', icBg: '#FDECEA', ic: svg(IC_X, '#D9534A'), lbl: t('anaHome.kpiAbsent'), num: stats.absent.length, numColor: '#D9534A', subText: t('anaHome.personsPct', { pct: stats.pct(stats.absent.length) }) },
          ] as const).map((k) => (
            <div
              key={k.sub}
              className={k.cls}
              role="button"
              tabIndex={0}
              style={{ cursor: 'pointer' }}
              title={t('anaHome.openDailyReport')}
              onClick={() => navigate(`/work-hours?tab=daily&sub=${k.sub}`)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate(`/work-hours?tab=daily&sub=${k.sub}`) }}
            >
              <div className="ana-kpi-top"><span className="ana-kpi-ic" style={{ background: k.icBg }}>{k.ic}</span></div>
              <div>
                <div className="ana-kpi-lbl">{k.lbl}</div>
                <div className="ana-kpi-num" style={{ color: k.numColor }}>{k.num}</div>
                <div className="ana-kpi-sub">{k.subText}</div>
              </div>
            </div>
          ))}
        </div>

        {/* 3-sütun */}
        <div className="ana-grid3">
          {/* Donut */}
          <div className="ana-card">
            <div className="ana-card-h"><span className="t">{t('anaHome.todayAttendance')}</span></div>
            <div className="ana-donut-wrap">
              <div
                className="ana-donut"
                onPointerMove={(e) => {
                  if (!donutHover) return
                  const rect = e.currentTarget.getBoundingClientRect()
                  const x = e.clientX - rect.left
                  const y = e.clientY - rect.top
                  setDonutHover((h) => (h ? { ...h, x, y } : h))
                }}
                onPointerLeave={() => setDonutHover(null)}
              >
                <svg viewBox="0 0 168 168" width="168" height="168" style={{ transform: 'rotate(-90deg)', display: 'block' }}>
                  {/* фоновое кольцо — видно, когда данных нет */}
                  <circle cx="84" cy="84" r="71" fill="none" stroke="#F0F0F5" strokeWidth="26" />
                  {(() => {
                    const r = 71
                    const C = 2 * Math.PI * r
                    let acc = 0
                    return donutSegs.filter((s) => s.pct > 0).map((s) => {
                      const offset = acc
                      acc += s.pct
                      const active = donutHover?.key === s.key
                      return (
                        <circle
                          key={s.key}
                          cx="84" cy="84" r={r} fill="none"
                          stroke={s.color}
                          strokeWidth={active ? 30 : 26}
                          strokeDasharray={`${(C * s.pct) / 100} ${C}`}
                          strokeDashoffset={-(C * offset) / 100}
                          tabIndex={0}
                          aria-label={`${s.label}: ${s.count} (${s.pct}%)`}
                          style={{
                            transition: 'stroke-width .15s ease, opacity .15s ease',
                            opacity: donutHover && !active ? 0.4 : 1,
                            cursor: 'pointer',
                            outline: 'none',
                          }}
                          onPointerEnter={(e) => {
                            const rect = e.currentTarget.ownerSVGElement!.getBoundingClientRect()
                            setDonutHover({ key: s.key, x: e.clientX - rect.left, y: e.clientY - rect.top })
                          }}
                          onFocus={() => setDonutHover({ key: s.key, x: 84, y: 28 })}
                          onBlur={() => setDonutHover(null)}
                        />
                      )
                    })
                  })()}
                </svg>
                <div className="hole" style={{ pointerEvents: 'none' }}>
                  {donutHoverSeg ? (
                    <>
                      <div className="n" style={{ color: donutHoverSeg.color }}>{donutHoverSeg.pct}%</div>
                      <div className="c">{donutHoverSeg.label} · {donutHoverSeg.count}</div>
                    </>
                  ) : (
                    <>
                      <div className="n">{donutPresent}%</div>
                      <div className="c">{t('anaHome.kpiPresent')}</div>
                    </>
                  )}
                </div>
                {donutHover && donutHoverSeg && (
                  <div
                    style={{
                      position: 'absolute',
                      left: Math.min(donutHover.x + 14, 150),
                      top: donutHover.y - 10,
                      transform: 'translateY(-100%)',
                      pointerEvents: 'none',
                      zIndex: 5,
                      background: '#fff',
                      border: '1px solid #ECECF3',
                      borderRadius: 10,
                      boxShadow: '0 8px 24px rgba(37,38,65,.14)',
                      padding: '6px 10px',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <div style={{ fontSize: 14, fontWeight: 800, color: '#252641', lineHeight: 1.2 }}>
                      {donutHoverSeg.count}{' '}
                      <span style={{ fontWeight: 600, color: '#8B8CA7', fontSize: 12 }}>({donutHoverSeg.pct}%)</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#8B8CA7', marginTop: 2 }}>
                      <span style={{ width: 10, height: 2.5, borderRadius: 2, background: donutHoverSeg.color, display: 'inline-block' }} />
                      {donutHoverSeg.label}
                    </div>
                  </div>
                )}
              </div>
              <div className="ana-legend">
                {donutSegs.map((s) => (
                  <div
                    className="ana-lg"
                    key={s.key}
                    onMouseEnter={() => setDonutHover({ key: s.key, x: 84, y: 28 })}
                    onMouseLeave={() => setDonutHover(null)}
                    style={{
                      background: donutHover?.key === s.key ? '#F6F6FB' : undefined,
                      borderRadius: 8,
                      transition: 'background .15s ease',
                    }}
                  >
                    <span className="dot" style={{ background: s.color }}></span>
                    <span className="nm">{s.label}</span>
                    <span className="vl">{s.count} ({s.pct}%)</span>
                  </div>
                ))}
              </div>
              <button className="ana-btn ghost" onClick={() => navigate('/work-hours')}>{t('anaHome.detailedReport')} →</button>
            </div>
          </div>

          {/* Son giriş edənlər */}
          <div className="ana-card">
            <div className="ana-card-h">
              <span className="t">{t('anaHome.recentCheckins')}</span>
              <button className="ana-link" onClick={() => navigate('/work-hours')}>{t('anaHome.viewAll')} →</button>
            </div>
            <div className="ana-thead">
              <span>{t('anaHome.colEmployee')}</span><span>{t('anaHome.colCheckIn')}</span><span className="r">{t('anaHome.colStatus')}</span>
            </div>
            {stats.recent.length === 0 && <p className="ana-empty-note">{t('anaHome.noCheckins')}</p>}
            {stats.recent.map((p, i) => (
              <div className="ana-trow" key={p.employeeId}>
                <div className="ana-person">
                  <span className="ana-av" style={{ background: AV[i % AV.length][0], color: AV[i % AV.length][1] }}>{initials(p.employeeName ?? '—')}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="nm">{p.employeeName ?? '—'}</div>
                    <div className="ps">{p.scheduleName ?? '—'}</div>
                  </div>
                </div>
                <div className="ana-time">{p.checkInUtc ? fmtTime(p.checkInUtc) : '—'}</div>
                <span className={'ana-chip ' + ((p.lateMinutes ?? 0) > 0 ? 'orange' : 'green')}>
                  {(p.lateMinutes ?? 0) > 0 ? t('anaHome.statusLate') : t('anaHome.statusPresent')}
                </span>
              </div>
            ))}
          </div>

          {/* Yeni əməkdaş */}
          <div className="ana-card ana-add">
            <div className="ana-card-h"><span className="t">{t('anaHome.addEmployeeTitle')}</span></div>
            <p className="desc">{t('anaHome.addEmployeeDesc')}</p>
            <div className="illus">{t('anaHome.addEmployeeIllustration')}</div>
            <button className="ana-btn" onClick={() => navigate('/people')}>{t('anaHome.addEmployeeBtn')} +</button>
          </div>
        </div>

        {/* ALT SIRA — 4 sütun */}
        <div className="ana-grid4">
          {/* Məzuniyyət müraciətləri */}
          <div className="ana-card ana-col">
            <div className="ana-card-h"><span className="t">{t('anaHome.leaveRequests')}</span></div>
            <div className="ana-list">
              {leaves.length === 0 && <p className="ana-empty-note">{t('anaHome.noLeaves')}</p>}
              {leaves.map((l, i) => (
                <div className="ana-leave" key={l.id}>
                  <span className="ana-av sm" style={{ background: AV[(i + 2) % AV.length][0], color: AV[(i + 2) % AV.length][1] }}>{initials(l.employeeName)}</span>
                  <div className="ana-leave-mid">
                    <div className="nm">{l.employeeName}</div>
                    <div className="ps">{t(`workHours.${l.leaveType === 'Vacation' ? 'vacation' : 'dayOffNoun'}`, { defaultValue: l.leaveType })} · {l.startDate} – {l.endDate}</div>
                  </div>
                  <span className={'ana-chip ' + leaveChip(l.status)}>{t(`workHours.status.${l.status}`, { defaultValue: l.status })}</span>
                </div>
              ))}
            </div>
            <button className="ana-link foot" onClick={() => navigate('/work-hours')}>{t('anaHome.viewAll')} →</button>
          </div>

          {/* Bugünkü növbələr */}
          <div className="ana-card ana-col">
            <div className="ana-card-h"><span className="t">{t('anaHome.todayShifts')}</span></div>
            <div className="ana-list">
              {stats.shifts.length === 0 && <p className="ana-empty-note">{t('anaHome.noShifts')}</p>}
              {stats.shifts.map((s) => {
                const ic = shiftIcon(s.startH)
                return (
                  <div className="ana-shift" key={s.time}>
                    <span className="ana-sq" style={{ background: shiftTint[ic][0] }}>{svg(ICONS[ic], shiftTint[ic][1], 20)}</span>
                    <div className="ana-shift-mid">
                      <div className="nm">{s.name}</div>
                      <div className="ps">{s.time}</div>
                    </div>
                    <span className="ana-shift-cnt">{t('anaHome.peopleCount', { count: s.count })}</span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Sürətli əməliyyatlar */}
          <div className="ana-card ana-col">
            <div className="ana-card-h"><span className="t">{t('anaHome.quickActions')}</span></div>
            <div className="ana-list">
              {ACTIONS.map((a) => (
                <button className="ana-action" key={a.title} onClick={() => navigate(a.to)}>
                  <span className="ana-sq" style={{ background: a.tint }}>{svg(ICONS[a.icon], a.color, 20)}</span>
                  <div className="ana-action-mid">
                    <div className="nm">{a.title}</div>
                    <div className="ps">{a.desc}</div>
                  </div>
                  <span className="ana-chev">›</span>
                </button>
              ))}
            </div>
          </div>

          {/* Bu həftəlik statistika */}
          <div className="ana-card ana-col">
            <div className="ana-card-h"><span className="t">{t('anaHome.weeklyStats')}</span></div>
            <div className="ana-chart">
              <div className="ana-yaxis">
                <span>{weekMax}</span><span>{Math.round(weekMax * 2 / 3)}</span><span>{Math.round(weekMax / 3)}</span><span>0</span>
              </div>
              <div className="ana-bars">
                {weekBars.map((w) => (
                  <div className="ana-bar-col" key={w.label}>
                    <div className="ana-bar-track">
                      {/* Цвет задаётся классом, а не inline-стилем: иначе :hover из CSS
                          не смог бы его перебить без !important. */}
                      <div className={`ana-bar${w.dim ? ' dim' : ''}`} style={{ height: (w.value / weekMax * 100) + '%' }}>
                        <span className="ana-bar-tip">{w.value}</span>
                      </div>
                    </div>
                    <span className="ana-bar-lbl">{w.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

      </div>
    </AppLayout>
  )
}
