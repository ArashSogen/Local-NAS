import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock, Loader2, RefreshCw, RotateCw, XCircle } from 'lucide-react';
import { apiRequest } from '../lib/api';
import { formatBytes, formatTimestamp } from '../lib/format';
import type { ActivityLogItem, SyncJobItem } from '../types';

type FilterTab = 'ALL' | 'QUEUED' | 'ACTIVE' | 'FAILED' | 'SYNCED';

export function AdminSyncQueueView() {
  const [filter, setFilter] = useState<FilterTab>('ALL');
  const [jobs, setJobs] = useState<SyncJobItem[]>([]);
  const [errorLogs, setErrorLogs] = useState<ActivityLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setBannerError(null);
      try {
        const query = filter === 'ALL' ? '' : `?status=${filter}`;
        const [jobsRes, logsRes] = await Promise.all([
          apiRequest<{ jobs: SyncJobItem[] }>(`/api/admin/sync-jobs${query}`),
          apiRequest<{ logs: ActivityLogItem[] }>('/api/admin/logs?level=error&limit=30'),
        ]);
        setJobs(jobsRes.jobs);
        setErrorLogs(logsRes.logs);
      } catch (err) {
        setBannerError(err instanceof Error ? err.message : 'Unable to load sync queue');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [filter]
  );

  useEffect(() => {
    void load(false);
    const timer = setInterval(() => void load(true), 3000);
    return () => clearInterval(timer);
  }, [load]);

  async function handleRetry(jobId: string) {
    setBusyId(jobId);
    try {
      await apiRequest(`/api/admin/sync-jobs/${jobId}/retry`, { method: 'POST' });
      await load(true);
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setBusyId(null);
    }
  }

  async function handleCancel(jobId: string) {
    setBusyId(jobId);
    try {
      await apiRequest(`/api/admin/sync-jobs/${jobId}/cancel`, { method: 'POST' });
      await load(true);
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Cancel failed');
    } finally {
      setBusyId(null);
    }
  }

  async function handleRetryAllFailed() {
    setBusyId('ALL');
    try {
      await apiRequest('/api/admin/sync-jobs/retry-all-failed', { method: 'POST' });
      await load(false);
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Unable to retry failed jobs');
    } finally {
      setBusyId(null);
    }
  }

  const tabs: Array<{ id: FilterTab; label: string }> = [
    { id: 'ALL', label: 'All Jobs' },
    { id: 'QUEUED', label: 'Queued' },
    { id: 'ACTIVE', label: 'Uploading / Verifying' },
    { id: 'FAILED', label: 'Failed' },
    { id: 'SYNCED', label: 'Verified & Synced' },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Sync Queue &amp; Error Logs
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Monitor background rclone transfers, retry failed uploads, and inspect verification errors
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            disabled={busyId === 'ALL'}
            onClick={() => void handleRetryAllFailed()}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
          >
            <RotateCw className="w-4 h-4" />
            Retry All Failed
          </button>
          <button
            type="button"
            onClick={() => void load(false)}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
        </div>
      </div>

      {bannerError && (
        <div className="p-3.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 text-sm text-red-700 dark:text-red-300">
          {bannerError}
        </div>
      )}

      {/* Segmented filter tabs */}
      <div className="inline-flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-x-auto max-w-full">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setFilter(t.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
              filter === t.id
                ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Jobs Table */}
      <div className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">Loading sync jobs...</div>
        ) : jobs.length === 0 ? (
          <div className="p-12 text-center text-sm text-slate-500">
            No sync jobs match this filter.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50/50 dark:bg-slate-900">
                  <th className="py-2.5 pl-4 pr-3">File &amp; User</th>
                  <th className="py-2.5 px-3">State</th>
                  <th className="py-2.5 px-3 text-right">Size</th>
                  <th className="py-2.5 px-3">Attempts</th>
                  <th className="py-2.5 px-3">Error / Verification</th>
                  <th className="py-2.5 px-3">Updated</th>
                  <th className="py-2.5 pl-3 pr-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                {jobs.map((job) => (
                  <tr key={job.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-2.5 pl-4 pr-3 max-w-xs">
                      <div className="font-mono text-xs font-medium text-slate-900 dark:text-slate-100 truncate" title={job.source_relative_path}>
                        /{job.source_relative_path}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        <span>{job.username || job.user_id}</span>
                        <span className="mx-1.5" aria-hidden="true">·</span>
                        <span className="font-mono">
                          {job.local_present ? 'Staged locally' : 'Local removed'}
                        </span>
                      </div>
                    </td>

                    <td className="py-2.5 px-3 whitespace-nowrap">
                      <JobStatusText status={job.status} />
                    </td>

                    <td className="py-2.5 px-3 text-right font-mono text-xs tabular-nums text-slate-700 dark:text-slate-300 whitespace-nowrap">
                      {job.size_bytes !== undefined ? formatBytes(job.size_bytes) : '—'}
                    </td>

                    <td className="py-2.5 px-3 font-mono text-xs tabular-nums text-slate-600 dark:text-slate-400 whitespace-nowrap">
                      {job.attempts} / {job.max_attempts}
                    </td>

                    <td className="py-2.5 px-3 max-w-sm">
                      {job.last_error ? (
                        <span className="font-mono text-xs text-red-600 dark:text-red-400 break-words line-clamp-2" title={job.last_error}>
                          {job.last_error}
                        </span>
                      ) : job.verification_method ? (
                        <span className="font-mono text-xs text-emerald-700 dark:text-emerald-400">
                          Verified ({job.verification_method})
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>

                    <td className="py-2.5 px-3 font-mono text-xs tabular-nums text-slate-500 whitespace-nowrap">
                      {formatTimestamp(job.updated_at)}
                    </td>

                    <td className="py-2.5 pl-3 pr-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        {(job.status === 'FAILED' || job.status === 'CANCELLED') && Boolean(job.local_present) && (
                          <button
                            type="button"
                            disabled={busyId === job.id}
                            onClick={() => void handleRetry(job.id)}
                            className="px-2.5 py-1 text-xs font-medium text-blue-700 dark:text-blue-400 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-md cursor-pointer"
                          >
                            Retry
                          </button>
                        )}
                        {['QUEUED', 'UPLOADING', 'VERIFYING'].includes(job.status) && (
                          <button
                            type="button"
                            disabled={busyId === job.id}
                            onClick={() => void handleCancel(job.id)}
                            className="px-2.5 py-1 text-xs font-medium text-red-600 dark:text-red-400 border border-slate-200 dark:border-slate-700 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-md cursor-pointer"
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Error Logs */}
      <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Recent Error Logs ({errorLogs.length})
          </h2>
        </div>
        {errorLogs.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No error events recorded.
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {errorLogs.map((log) => (
              <div key={log.id} className="px-5 py-3 text-xs flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="font-semibold text-red-600 dark:text-red-400">{log.action}</div>
                  <p className="font-mono text-slate-700 dark:text-slate-300 mt-0.5 break-words">
                    {log.details}
                  </p>
                </div>
                <span className="font-mono text-slate-400 whitespace-nowrap shrink-0 tabular-nums">
                  {formatTimestamp(log.created_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function JobStatusText({ status }: { status: SyncJobItem['status'] }) {
  switch (status) {
    case 'SYNCED':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Synced
        </span>
      );
    case 'FAILED':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700 dark:text-red-400">
          <AlertCircle className="w-3.5 h-3.5" />
          Failed
        </span>
      );
    case 'UPLOADING':
    case 'VERIFYING':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 dark:text-blue-400">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          {status === 'VERIFYING' ? 'Verifying' : 'Uploading'}
        </span>
      );
    case 'CANCELLED':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
          <XCircle className="w-3.5 h-3.5" />
          Cancelled
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
          <Clock className="w-3.5 h-3.5" />
          Queued
        </span>
      );
  }
}
