import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AppLayout } from '../components/templates'
import { Button } from '../components/atoms'
import { PageHeader, Modal } from '../components/organisms'
import { Pagination, usePageReset, pageSlice } from '../components/molecules'
import { apiRequest } from '../lib/api'
import { useAuth } from '../auth/AuthContext'

interface AttendanceRequest {
  id: string
  employeeId: string
  employeeName: string
  type: string
  requestedTimeUtc: string
  requestedEndTimeUtc: string | null
  comment: string | null
  status: string
  reviewedByUserId: string | null
  reviewedAtUtc: string | null
  reviewComment: string | null
  createdUtc: string
  latitude: number | null
  longitude: number | null
  geoZoneName: string | null
}

const TYPE_KEYS: Record<string, string> = {
  CheckIn: 'approvals.typeOptions.checkIn',
  CheckOut: 'approvals.typeOptions.checkOut',
  Absence: 'approvals.typeOptions.absence',
  Vacation: 'approvals.typeOptions.vacation',
  Overtime: 'approvals.typeOptions.overtime',
}

const STATUS_COLORS: Record<string, string> = {
  Pending: 'text-amber-600 bg-amber-50',
  Approved: 'text-green-600 bg-green-50',
  Rejected: 'text-red-600 bg-red-50',
}

const STATUS_KEYS: Record<string, string> = {
  Pending: 'approvals.statusOptions.pending',
  Approved: 'approvals.statusOptions.approved',
  Rejected: 'approvals.statusOptions.rejected',
}

function formatDT(iso: string) {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

function formatT(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function AttendanceApprovalsPage() {
  const { t } = useTranslation()
  const { token } = useAuth()
  const [requests, setRequests] = useState<AttendanceRequest[]>([])
  const [loading, setLoading] = useState(false)
  const [filterStatus, setFilterStatus] = useState('Pending')
  const [filterType, setFilterType] = useState('')
  // Смена фильтра статуса/типа возвращает список на первую страницу.
  const [page, setPage] = usePageReset(`${filterStatus}|${filterType}`)

  const [reviewModal, setReviewModal] = useState<{ id: string; action: 'approve' | 'reject' } | null>(null)
  const [reviewComment, setReviewComment] = useState('')
  const [reviewLoading, setReviewLoading] = useState(false)

  const load = async () => {
    if (!token) return
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (filterStatus) params.set('status', filterStatus)
      const data = await apiRequest<AttendanceRequest[]>(`/api/attendance-requests?${params}`, { token })
      setRequests(filterType ? data.filter(r => r.type === filterType) : data)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [token, filterStatus, filterType])

  const handleReview = async () => {
    if (!reviewModal) return
    setReviewLoading(true)
    try {
      await apiRequest(`/api/attendance-requests/${reviewModal.id}/${reviewModal.action}`, {
        method: 'PUT', token,
        body: JSON.stringify({ comment: reviewComment || null }),
      })
      setReviewModal(null)
      setReviewComment('')
      await load()
    } finally {
      setReviewLoading(false)
    }
  }

  return (
    <AppLayout onAction={() => {}}>
      <div className="flex-1 overflow-y-auto bg-background-light pb-20 md:pb-0">
        <div className="p-6 md:p-10 space-y-6">
          <PageHeader
            className="p-0 border-none shadow-none bg-transparent"
            title={t('approvals.title')}
            description={t('approvals.description')}
          />

          <div className="bg-surface rounded-2xl p-5 shadow-sm flex flex-wrap gap-4 items-end">
            <div className="space-y-1">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('common.status')}</label>
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="rounded-xl bg-background-light border-none px-3 py-2 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
              >
                <option value="">{t('common.all')}</option>
                <option value="Pending">{t('approvals.statusOptions.pending')}</option>
                <option value="Approved">{t('approvals.statusOptions.approved')}</option>
                <option value="Rejected">{t('approvals.statusOptions.rejected')}</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('common.type')}</label>
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
                className="rounded-xl bg-background-light border-none px-3 py-2 text-sm font-bold text-text-dark focus:ring-2 focus:ring-primary/20 outline-none"
              >
                <option value="">{t('approvals.allTypes')}</option>
                <option value="CheckIn">{t('approvals.typeOptions.checkIn')}</option>
                <option value="CheckOut">{t('approvals.typeOptions.checkOut')}</option>
                <option value="Absence">{t('approvals.typeOptions.absence')}</option>
                <option value="Vacation">{t('approvals.typeOptions.vacation')}</option>
                <option value="Overtime">{t('approvals.typeOptions.overtime')}</option>
              </select>
            </div>
          </div>

          <div className="bg-surface rounded-2xl shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-border">
              <p className="text-xs font-black text-text-light uppercase tracking-widest">{t('approvals.requestCount', { count: requests.length })}</p>
            </div>
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <span className="spinner-ring text-3xl text-primary" aria-hidden="true" />
              </div>
            ) : requests.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2 text-text-light">
                <span className="material-symbols-outlined text-4xl">inbox</span>
                <p className="text-sm">{t('approvals.emptyState')}</p>
              </div>
            ) : (() => {
              const paged = pageSlice(requests, page)
              return (
              <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] font-black text-text-light uppercase tracking-widest border-b border-border">
                      <th className="px-5 py-3 text-left">{t('approvals.columns.employee')}</th>
                      <th className="px-5 py-3 text-left">{t('common.type')}</th>
                      <th className="px-5 py-3 text-left">{t('approvals.columns.requestedTime')}</th>
                      <th className="px-5 py-3 text-left">{t('approvals.columns.location')}</th>
                      <th className="px-5 py-3 text-left">{t('approvals.columns.comment')}</th>
                      <th className="px-5 py-3 text-left">{t('common.status')}</th>
                      <th className="px-5 py-3 text-left">{t('common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.rows.map((r) => {
                      const statusColor = STATUS_COLORS[r.status] ?? 'text-text-light bg-background-light'
                      const statusKey = STATUS_KEYS[r.status]
                      const statusLabel = statusKey ? t(statusKey) : r.status
                      const typeKey = TYPE_KEYS[r.type]
                      const typeLabel = typeKey ? t(typeKey) : r.type
                      return (
                        <tr key={r.id} className="border-b border-border last:border-none hover:bg-background-light transition-colors">
                          <td className="px-5 py-3 font-bold text-text-dark">{r.employeeName}</td>
                          <td className="px-5 py-3 text-text-dark">{typeLabel}</td>
                          {/* У почасовой отлучки есть конец интервала — согласующему нужны обе границы. */}
                          <td className="px-5 py-3 text-text-light">
                            {r.requestedEndTimeUtc
                              ? `${formatDT(r.requestedTimeUtc)}–${formatT(r.requestedEndTimeUtc)}`
                              : formatDT(r.requestedTimeUtc)}
                          </td>
                          <td className="px-5 py-3 text-xs">
                            {r.latitude != null && r.longitude != null ? (
                              <div className="space-y-0.5">
                                {r.geoZoneName && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold text-green-700 bg-green-50">
                                    <span className="material-symbols-outlined text-[12px]">verified</span>
                                    {r.geoZoneName}
                                  </span>
                                )}
                                <a
                                  href={`https://www.openstreetmap.org/?mlat=${r.latitude}&mlon=${r.longitude}#map=18/${r.latitude}/${r.longitude}`}
                                  target="_blank" rel="noreferrer"
                                  className="block font-mono text-text-light hover:text-primary"
                                  title={t('approvals.openInOsm')}
                                >
                                  {r.latitude.toFixed(5)}, {r.longitude.toFixed(5)}
                                </a>
                              </div>
                            ) : (
                              <span className="text-text-light">—</span>
                            )}
                          </td>
                          <td className="px-5 py-3 text-text-light text-xs max-w-[240px] truncate">{r.comment ?? '—'}</td>
                          <td className="px-5 py-3">
                            <span className={`text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full ${statusColor}`}>
                              {statusLabel}
                            </span>
                          </td>
                          <td className="px-5 py-3">
                            {r.status === 'Pending' && (
                              <div className="flex gap-2">
                                <button
                                  onClick={() => { setReviewModal({ id: r.id, action: 'approve' }); setReviewComment('') }}
                                  className="text-[10px] font-black uppercase tracking-wider text-green-600 hover:text-green-700 bg-green-50 hover:bg-green-100 px-2.5 py-1 rounded-lg transition-colors"
                                >
                                  {t('approvals.approve')}
                                </button>
                                <button
                                  onClick={() => { setReviewModal({ id: r.id, action: 'reject' }); setReviewComment('') }}
                                  className="text-[10px] font-black uppercase tracking-wider text-red-600 hover:text-red-700 bg-red-50 hover:bg-red-100 px-2.5 py-1 rounded-lg transition-colors"
                                >
                                  {t('approvals.reject')}
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <Pagination page={paged.page} totalPages={paged.totalPages} total={requests.length} onPage={setPage} />
              </>
              )
            })()}
          </div>
        </div>
      </div>

      <Modal
        isOpen={!!reviewModal}
        onClose={() => setReviewModal(null)}
        title={reviewModal?.action === 'approve' ? t('approvals.approveRequest') : t('approvals.rejectRequest')}
      >
        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <label className="block text-[10px] font-black text-text-light uppercase tracking-widest">{t('approvals.commentOptional')}</label>
            <textarea
              value={reviewComment}
              onChange={(e) => setReviewComment(e.target.value)}
              rows={3}
              placeholder={t('approvals.reasonPlaceholder')}
              className="w-full rounded-xl bg-background-light border-none px-4 py-2.5 text-sm text-text-dark focus:ring-2 focus:ring-primary/20 outline-none resize-none"
            />
          </div>
          <div className="flex gap-3">
            <Button variant="outline" fullWidth onClick={() => setReviewModal(null)}>{t('common.cancel')}</Button>
            <Button
              fullWidth
              isLoading={reviewLoading}
              className={reviewModal?.action === 'reject' ? 'bg-red-500 hover:bg-red-600 shadow-red-200' : ''}
              onClick={handleReview}
            >
              {reviewModal?.action === 'approve' ? t('approvals.approve') : t('approvals.reject')}
            </Button>
          </div>
        </div>
      </Modal>
    </AppLayout>
  )
}
