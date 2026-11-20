import React, { useState } from 'react';
import { Check, Lock } from 'lucide-react';
import { apiRequest } from '../lib/api';
import { formatBytes, formatRelativePercent } from '../lib/format';
import type { AuthUser, StorageUsage } from '../types';

interface AccountViewProps {
  user: AuthUser;
  usage: StorageUsage;
}

export function AccountView({ user, usage }: AccountViewProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const pct = formatRelativePercent(usage.totalBytes, user.quotaBytes);

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    if (newPassword.length < 8) {
      setStatus({ type: 'error', message: 'New password must be at least 8 characters.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setStatus({ type: 'error', message: 'Passwords do not match.' });
      return;
    }

    setSaving(true);
    try {
      await apiRequest('/api/auth/change-password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setStatus({ type: 'success', message: 'Your password has been updated.' });
    } catch (err) {
      setStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'Unable to update password',
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-8">
      <div className="pb-5 border-b border-slate-200 dark:border-slate-800">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Account</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          Personal storage allocation and security credentials
        </p>
      </div>

      {/* Profile & Storage Breakdown */}
      <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-xl p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-4 pb-5 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {user.displayName}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              <span className="font-mono">{user.username}</span>
              <span className="mx-1.5" aria-hidden="true">·</span>
              <span>{user.role === 'admin' ? 'Administrator' : 'Standard User'}</span>
              <span className="mx-1.5" aria-hidden="true">·</span>
              <span className="font-mono">Namespace ID: {user.id}</span>
            </p>
          </div>
          <div className="text-right font-mono text-sm tabular-nums text-slate-900 dark:text-slate-100">
            {formatBytes(usage.totalBytes)} / {formatBytes(user.quotaBytes)} ({pct}%)
          </div>
        </div>

        <div className="mt-5">
          <div className="h-2 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
            <div
              className={`h-full ${pct >= 90 ? 'bg-red-600' : 'bg-blue-600'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="grid grid-cols-3 gap-4 mt-5 text-sm">
            <div>
              <div className="text-xs text-slate-500">Total Files</div>
              <div className="font-mono font-semibold text-slate-900 dark:text-slate-100 mt-0.5 tabular-nums">
                {usage.fileCount.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">On Local Staging Disk</div>
              <div className="font-mono font-semibold text-slate-900 dark:text-slate-100 mt-0.5 tabular-nums">
                {formatBytes(usage.stagedBytes)}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Verified In Cloud</div>
              <div className="font-mono font-semibold text-slate-900 dark:text-slate-100 mt-0.5 tabular-nums">
                {formatBytes(usage.cloudBytes)}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Change Password */}
      <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-xl p-6">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100 mb-1">
          Change Password
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-5">
          Passwords are hashed using bcrypt and never stored in plaintext.
        </p>

        <form onSubmit={handlePasswordSubmit} className="space-y-4 max-w-md">
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Current Password
            </label>
            <input
              type="password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              New Password
            </label>
            <input
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Confirm New Password
            </label>
            <input
              type="password"
              required
              minLength={8}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>

          {status && (
            <div
              className={`p-3 rounded-lg text-sm flex items-center gap-2 ${
                status.type === 'success'
                  ? 'bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300'
                  : 'bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300'
              }`}
            >
              {status.type === 'success' && <Check className="w-4 h-4 shrink-0" />}
              <span>{status.message}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors cursor-pointer"
          >
            <Lock className="w-4 h-4" />
            {saving ? 'Updating...' : 'Update Password'}
          </button>
        </form>
      </section>
    </div>
  );
}
