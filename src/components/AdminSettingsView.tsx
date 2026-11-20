import React, { useCallback, useEffect, useState } from 'react';
import { Check, Cloud, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { apiRequest } from '../lib/api';
import type { AdminSettingsData, CloudHealth } from '../types';

const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

export function AdminSettingsView() {
  const [data, setData] = useState<AdminSettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [cloudTest, setCloudTest] = useState<CloudHealth | null>(null);
  const [testingCloud, setTestingCloud] = useState(false);
  const [reconciling, setReconciling] = useState(false);

  // Editable runtime fields
  const [maxUploadMb, setMaxUploadMb] = useState('1024');
  const [defaultQuotaGb, setDefaultQuotaGb] = useState('5');
  const [chunkSizeMb, setChunkSizeMb] = useState('4');
  const [syncConcurrency, setSyncConcurrency] = useState('2');
  const [syncRetryLimit, setSyncRetryLimit] = useState('3');
  const [syncRetryBackoff, setSyncRetryBackoff] = useState('5000');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<AdminSettingsData>('/api/admin/settings');
      setData(res);
      setMaxUploadMb(String(Math.round(res.runtime.maxUploadSize / MIB)));
      setDefaultQuotaGb(String(Number((res.runtime.defaultUserQuota / GIB).toFixed(2))));
      setChunkSizeMb(String(Math.max(1, Math.round(res.runtime.uploadChunkSize / MIB))));
      setSyncConcurrency(String(res.runtime.syncConcurrency));
      setSyncRetryLimit(String(res.runtime.syncRetryLimit));
      setSyncRetryBackoff(String(res.runtime.syncRetryBackoff));
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to load system settings',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      await apiRequest('/api/admin/settings', {
        method: 'PATCH',
        body: {
          maxUploadSize: Math.max(1, Number(maxUploadMb)) * MIB,
          defaultUserQuota: Math.max(0.1, Number(defaultQuotaGb)) * GIB,
          uploadChunkSize: Math.max(1, Math.min(64, Number(chunkSizeMb))) * MIB,
          syncConcurrency: Math.max(1, Math.min(16, Number(syncConcurrency))),
          syncRetryLimit: Math.max(1, Math.min(20, Number(syncRetryLimit))),
          syncRetryBackoff: Math.max(100, Number(syncRetryBackoff)),
        },
      });
      setFeedback({ type: 'success', text: 'Runtime settings saved and applied immediately.' });
      await load();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to save settings',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleTestCloud() {
    setTestingCloud(true);
    try {
      const res = await apiRequest<{ health: CloudHealth }>('/api/admin/test-cloud', {
        method: 'POST',
      });
      setCloudTest(res.health);
    } catch (err) {
      setCloudTest({
        ok: false,
        engine: 'unconfigured',
        remoteName: 'unknown',
        remoteType: 'unknown',
        message: err instanceof Error ? err.message : 'Cloud test failed',
      });
    } finally {
      setTestingCloud(false);
    }
  }

  async function handleReconcile() {
    setReconciling(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ report: Record<string, number> }>('/api/admin/reconcile', {
        method: 'POST',
      });
      const r = res.report;
      setFeedback({
        type: 'success',
        text: `Reconciliation complete: ${r.requeuedInterruptedJobs} interrupted jobs recovered, ${r.cleanedOrphanTempFiles} temp files removed, ${r.cleanedVerifiedLocalFiles} verified local files cleaned.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Reconciliation failed',
      });
    } finally {
      setReconciling(false);
    }
  }

  if (loading && !data) {
    return <div className="p-8 text-sm text-slate-500">Loading settings...</div>;
  }

  return (
    <div className="max-w-4xl space-y-8">
      <div className="pb-5 border-b border-slate-200 dark:border-slate-800">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          System Settings &amp; Storage Configuration
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          Adjust runtime transfer limits and inspect active Hard Disk and Cloud Drive mounts
        </p>
      </div>

      {feedback && (
        <div
          className={`p-3.5 rounded-lg text-sm flex items-center gap-2 ${
            feedback.type === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300'
              : 'bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300'
          }`}
        >
          {feedback.type === 'success' && <Check className="w-4 h-4 shrink-0" />}
          <span>{feedback.text}</span>
        </div>
      )}

      {/* Read-only active storage config (no secrets) */}
      {data && (
        <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Active Storage &amp; Cloud Configuration (Read-Only)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Configured via environment variables and mounted volumes. Credentials and secrets are never exposed.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={testingCloud}
                onClick={() => void handleTestCloud()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg cursor-pointer whitespace-nowrap"
              >
                <Cloud className="w-3.5 h-3.5" />
                {testingCloud ? 'Testing...' : 'Test Cloud Remote'}
              </button>
              <button
                type="button"
                disabled={reconciling}
                onClick={() => void handleReconcile()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg cursor-pointer whitespace-nowrap"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${reconciling ? 'animate-spin' : ''}`} />
                Run Crash Reconciliation
              </button>
            </div>
          </div>

          {cloudTest && (
            <div
              className={`mt-4 p-3 rounded-lg text-xs font-mono ${
                cloudTest.ok
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300'
                  : 'bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300'
              }`}
            >
              {cloudTest.ok ? 'OK: ' : 'ERROR: '}
              {cloudTest.message}
            </div>
          )}

          <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4 mt-5 text-sm">
            <div>
              <dt className="text-xs text-slate-500">Hard Disk Staging Path (HARD_DISK_PATH)</dt>
              <dd className="font-mono text-xs text-slate-900 dark:text-slate-100 mt-1 break-all">
                {data.activeConfig.hardDiskPath}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Cloud Remote Target (CLOUD_REMOTE)</dt>
              <dd className="font-mono text-xs text-slate-900 dark:text-slate-100 mt-1 break-all">
                {data.activeConfig.cloudRemote}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">rclone Config Mount (RCLONE_CONFIG_PATH)</dt>
              <dd className="font-mono text-xs text-slate-900 dark:text-slate-100 mt-1 break-all">
                {data.activeConfig.rcloneConfigPath} (
                {data.activeConfig.rcloneConfigExists ? 'present' : 'missing'})
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Remote Backend &amp; Driver Engine</dt>
              <dd className="font-mono text-xs text-slate-900 dark:text-slate-100 mt-1">
                {data.activeConfig.rcloneRemoteName} · type={data.activeConfig.rcloneRemoteType} ·
                engine={data.activeConfig.cloudDriverEngine}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Database Path (DATABASE_URL)</dt>
              <dd className="font-mono text-xs text-slate-900 dark:text-slate-100 mt-1 break-all">
                {data.activeConfig.databasePath}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Session Security</dt>
              <dd className="font-mono text-xs text-slate-900 dark:text-slate-100 mt-1 flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                TTL {data.activeConfig.sessionTtlHours}h · CSRF &amp; Rate Limiting Active
              </dd>
            </div>
          </dl>
        </section>
      )}

      {/* Runtime-safe editable settings */}
      <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-xl p-6">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
          Runtime Pipeline &amp; Quota Defaults
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 mb-5">
          Changes take effect immediately without restarting the server or interrupting active syncs.
        </p>

        <form onSubmit={handleSave} className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Max Upload Size (MiB)
              </label>
              <input
                type="number"
                min="1"
                required
                value={maxUploadMb}
                onChange={(e) => setMaxUploadMb(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Default New-User Quota (GiB)
              </label>
              <input
                type="number"
                step="0.5"
                min="0.1"
                required
                value={defaultQuotaGb}
                onChange={(e) => setDefaultQuotaGb(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Upload Chunk Size (MiB)
              </label>
              <input
                type="number"
                min="1"
                max="64"
                required
                value={chunkSizeMb}
                onChange={(e) => setChunkSizeMb(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Sync Worker Concurrency (1–16)
              </label>
              <input
                type="number"
                min="1"
                max="16"
                required
                value={syncConcurrency}
                onChange={(e) => setSyncConcurrency(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Sync Retry Limit (1–20)
              </label>
              <input
                type="number"
                min="1"
                max="20"
                required
                value={syncRetryLimit}
                onChange={(e) => setSyncRetryLimit(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Base Retry Backoff (ms)
              </label>
              <input
                type="number"
                min="100"
                max="300000"
                required
                value={syncRetryBackoff}
                onChange={(e) => setSyncRetryBackoff(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors cursor-pointer"
            >
              <Save className="w-4 h-4" />
              {saving ? 'Saving...' : 'Save Runtime Settings'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
