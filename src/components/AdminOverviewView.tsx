import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react';
import { apiRequest } from '../lib/api';
import { formatBytes, formatRelativePercent, formatTimestamp } from '../lib/format';
import type { AdminOverviewData } from '../types';

export function AdminOverviewView({
  onNavigate,
}: {
  onNavigate: (tab: 'admin-queue' | 'admin-users' | 'admin-settings') => void;
}) {
  const [data, setData] = useState<AdminOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<AdminOverviewData>('/api/admin/overview');
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load dashboard overview');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    const timer = setInterval(() => void load(true), 5000);
    return () => clearInterval(timer);
  }, [load]);

  if (loading && !data) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-12 bg-slate-200 dark:bg-slate-800 rounded-lg w-72" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 bg-slate-200 dark:bg-slate-800 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            System Overview
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Staging disk footprint, cloud sync pipeline health, and per-user storage usage
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(false)}
          className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      {error && (
        <div className="p-3.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {data && (
        <>
          {/* 4-column metric strip */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Staging Hard Disk Usage
              </div>
              <div className="mt-2 text-2xl font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                {formatBytes(data.stagingDisk.totalBytes)}
              </div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                {data.stagingDisk.fileCount} local file{data.stagingDisk.fileCount === 1 ? '' : 's'} awaiting cleanup
              </div>
            </div>

            <div className="p-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Verified In Cloud Drive
              </div>
              <div className="mt-2 text-2xl font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                {formatBytes(data.storage.cloudBytes)}
              </div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                {data.storage.syncedFiles} synced · {data.storage.totalFiles} total files
              </div>
            </div>

            <div className="p-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Sync Queue
                </span>
                <button
                  type="button"
                  onClick={() => onNavigate('admin-queue')}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                >
                  Inspect
                </button>
              </div>
              <div className="mt-2 text-2xl font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                {data.queue.queued + data.queue.active}
              </div>
              <div className="mt-1 text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                {data.queue.queued} queued · {data.queue.active} active ·{' '}
                <span className={data.queue.failed > 0 ? 'text-red-600 dark:text-red-400 font-semibold' : ''}>
                  {data.queue.failed} failed
                </span>
              </div>
            </div>

            <div className="p-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Cloud Remote Health
                </span>
                <button
                  type="button"
                  onClick={() => onNavigate('admin-settings')}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                >
                  Config
                </button>
              </div>
              <div className="mt-2 flex items-center gap-2">
                {data.cloudHealth.ok ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                ) : (
                  <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0" />
                )}
                <span className="text-base font-semibold text-slate-900 dark:text-slate-100 truncate">
                  {data.cloudHealth.ok ? 'Reachable' : 'Unreachable'}
                </span>
              </div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 truncate" title={data.cloudHealth.message}>
                {data.cloudHealth.remoteName} ({data.cloudHealth.remoteType})
              </div>
            </div>
          </div>

          {/* Per-User Storage Usage Table */}
          <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Per-User Storage Allocation ({data.users.length})
              </h2>
              <button
                type="button"
                onClick={() => onNavigate('admin-users')}
                className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
              >
                Manage Users
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50/50 dark:bg-slate-900">
                    <th className="py-2.5 pl-5 pr-3">User</th>
                    <th className="py-2.5 px-3 text-right">Files</th>
                    <th className="py-2.5 px-3 text-right">Staging</th>
                    <th className="py-2.5 px-3 text-right">Cloud</th>
                    <th className="py-2.5 px-3 text-right">Total / Quota</th>
                    <th className="py-2.5 pl-3 pr-5 w-44">Utilization</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                  {data.users.map((u) => {
                    const pct = formatRelativePercent(u.usedBytes, u.quotaBytes);
                    return (
                      <tr key={u.id} className="h-11">
                        <td className="py-2 pl-5 pr-3">
                          <div className="font-medium text-slate-900 dark:text-slate-100">
                            {u.displayName}
                          </div>
                          <div className="text-xs text-slate-500">
                            <span className="font-mono">{u.username}</span>
                            <span className="mx-1.5" aria-hidden="true">·</span>
                            <span>{u.role}</span>
                            {!u.isActive && (
                              <>
                                <span className="mx-1.5" aria-hidden="true">·</span>
                                <span className="text-red-600 dark:text-red-400">Disabled</span>
                              </>
                            )}
                          </div>
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-xs tabular-nums text-slate-700 dark:text-slate-300">
                          {u.fileCount}
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-xs tabular-nums text-slate-700 dark:text-slate-300">
                          {formatBytes(u.stagedBytes)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-xs tabular-nums text-slate-700 dark:text-slate-300">
                          {formatBytes(u.cloudBytes)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-xs tabular-nums text-slate-900 dark:text-slate-100">
                          {formatBytes(u.usedBytes)} / {formatBytes(u.quotaBytes)}
                        </td>
                        <td className="py-2 pl-3 pr-5">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                              <div
                                className={`h-full ${pct >= 90 ? 'bg-red-600' : 'bg-blue-600'}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="font-mono text-xs tabular-nums text-slate-500 w-9 text-right">
                              {pct}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Recent Activity Log */}
          <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Recent System Activity
              </h2>
            </div>
            {data.recentActivity.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">No activity recorded yet.</div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.recentActivity.map((log) => (
                  <div key={log.id} className="px-5 py-3 flex items-start justify-between gap-4 text-xs">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={`font-semibold ${
                            log.level === 'error'
                              ? 'text-red-600 dark:text-red-400'
                              : log.level === 'warn'
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-slate-800 dark:text-slate-200'
                          }`}
                        >
                          {log.action}
                        </span>
                        {log.actor_username && (
                          <>
                            <span className="text-slate-400" aria-hidden="true">·</span>
                            <span className="font-mono text-slate-600 dark:text-slate-400">
                              {log.actor_username}
                            </span>
                          </>
                        )}
                      </div>
                      {log.details && (
                        <p className="text-slate-500 dark:text-slate-400 mt-0.5 break-words">
                          {log.details}
                        </p>
                      )}
                    </div>
                    <span className="font-mono text-slate-400 whitespace-nowrap shrink-0 tabular-nums">
                      {formatTimestamp(log.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
