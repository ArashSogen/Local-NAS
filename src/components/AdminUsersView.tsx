import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, Pencil, Trash2, UserPlus } from 'lucide-react';
import { apiRequest } from '../lib/api';
import { formatBytes, formatRelativePercent, formatTimestamp } from '../lib/format';
import type { AdminUserItem } from '../types';
import { ModalShell } from './FileBrowserView';

const GIB = 1024 * 1024 * 1024;

export function AdminUsersView({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create user modal
  const [createOpen, setCreateOpen] = useState(false);
  const [cUsername, setCUsername] = useState('');
  const [cDisplayName, setCDisplayName] = useState('');
  const [cPassword, setCPassword] = useState('');
  const [cRole, setCRole] = useState<'user' | 'admin'>('user');
  const [cQuotaGb, setCQuotaGb] = useState('5');
  const [cMustChange, setCMustChange] = useState(true);

  // Edit user modal
  const [editUser, setEditUser] = useState<AdminUserItem | null>(null);
  const [eDisplayName, setEDisplayName] = useState('');
  const [eRole, setERole] = useState<'user' | 'admin'>('user');
  const [eQuotaGb, setEQuotaGb] = useState('5');
  const [eActive, setEActive] = useState(true);

  // Reset password modal
  const [resetUser, setResetUser] = useState<AdminUserItem | null>(null);
  const [rPassword, setRPassword] = useState('');
  const [rMustChange, setRMustChange] = useState(true);

  // Delete user modal
  const [deleteUser, setDeleteUser] = useState<AdminUserItem | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiRequest<{ users: AdminUserItem[] }>('/api/admin/users');
      setUsers(data.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load users');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setModalError(null);
    const quotaBytes = Math.max(1024 * 1024, Math.round(Number(cQuotaGb) * GIB));
    try {
      await apiRequest('/api/admin/users', {
        method: 'POST',
        body: {
          username: cUsername.trim(),
          displayName: cDisplayName.trim() || cUsername.trim(),
          password: cPassword,
          role: cRole,
          quotaBytes,
          mustChangePassword: cMustChange,
        },
      });
      setCreateOpen(false);
      setCUsername('');
      setCDisplayName('');
      setCPassword('');
      setCRole('user');
      setCQuotaGb('5');
      await loadUsers();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : 'Unable to create user');
    }
  }

  function openEdit(u: AdminUserItem) {
    setModalError(null);
    setEditUser(u);
    setEDisplayName(u.displayName);
    setERole(u.role);
    setEQuotaGb(String(Number((u.quotaBytes / GIB).toFixed(2))));
    setEActive(u.isActive);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editUser) return;
    setModalError(null);
    const quotaBytes = Math.max(1024 * 1024, Math.round(Number(eQuotaGb) * GIB));
    try {
      await apiRequest(`/api/admin/users/${editUser.id}`, {
        method: 'PATCH',
        body: {
          displayName: eDisplayName.trim(),
          role: eRole,
          isActive: eActive,
          quotaBytes,
        },
      });
      setEditUser(null);
      await loadUsers();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : 'Unable to update user');
    }
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!resetUser) return;
    setModalError(null);
    try {
      await apiRequest(`/api/admin/users/${resetUser.id}/reset-password`, {
        method: 'POST',
        body: { newPassword: rPassword, mustChangePassword: rMustChange },
      });
      setResetUser(null);
      setRPassword('');
      await loadUsers();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : 'Unable to reset password');
    }
  }

  async function handleDelete() {
    if (!deleteUser) return;
    setModalError(null);
    try {
      await apiRequest(`/api/admin/users/${deleteUser.id}`, { method: 'DELETE' });
      setDeleteUser(null);
      await loadUsers();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : 'Unable to delete user');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Users &amp; Quotas
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Each user receives an isolated staging and cloud storage namespace keyed by internal user ID
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setModalError(null);
            setCreateOpen(true);
          }}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
        >
          <UserPlus className="w-4 h-4" />
          Create User
        </button>
      </div>

      {error && (
        <div className="p-3.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">Loading accounts...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50/50 dark:bg-slate-900">
                  <th className="py-2.5 pl-4 pr-3">Account</th>
                  <th className="py-2.5 px-3">Role &amp; State</th>
                  <th className="py-2.5 px-3 text-right">Usage / Quota</th>
                  <th className="py-2.5 px-3">Last Login</th>
                  <th className="py-2.5 pl-3 pr-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                {users.map((u) => {
                  const pct = formatRelativePercent(u.usedBytes, u.quotaBytes);
                  return (
                    <tr key={u.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="py-3 pl-4 pr-3">
                        <div className="font-medium text-slate-900 dark:text-slate-100">
                          {u.displayName}
                        </div>
                        <div className="text-xs text-slate-500 font-mono">
                          {u.username} · {u.id}
                        </div>
                      </td>
                      <td className="py-3 px-3 text-xs whitespace-nowrap">
                        <span className="font-medium text-slate-800 dark:text-slate-200 capitalize">
                          {u.role}
                        </span>
                        <span className="mx-1.5 text-slate-400" aria-hidden="true">·</span>
                        <span
                          className={
                            u.isActive
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-red-600 dark:text-red-400 font-medium'
                          }
                        >
                          {u.isActive ? 'Active' : 'Disabled'}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-right whitespace-nowrap">
                        <div className="font-mono text-xs tabular-nums text-slate-900 dark:text-slate-100">
                          {formatBytes(u.usedBytes)} / {formatBytes(u.quotaBytes)} ({pct}%)
                        </div>
                        <div className="font-mono text-xs tabular-nums text-slate-500">
                          {u.fileCount} files · {formatBytes(u.stagedBytes)} staged
                        </div>
                      </td>
                      <td className="py-3 px-3 font-mono text-xs tabular-nums text-slate-500 whitespace-nowrap">
                        {formatTimestamp(u.lastLoginAt)}
                      </td>
                      <td className="py-3 pl-3 pr-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openEdit(u)}
                            title="Edit user & quota"
                            className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-white rounded cursor-pointer"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setModalError(null);
                              setResetUser(u);
                              setRPassword('');
                              setRMustChange(true);
                            }}
                            title="Reset password"
                            className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-white rounded cursor-pointer"
                          >
                            <KeyRound className="w-4 h-4" />
                          </button>
                          {u.id !== currentUserId && (
                            <button
                              type="button"
                              onClick={() => {
                                setModalError(null);
                                setDeleteUser(u);
                              }}
                              title="Delete user"
                              className="p-1.5 text-slate-400 hover:text-red-600 rounded cursor-pointer"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create User Modal */}
      {createOpen && (
        <ModalShell title="Create User" onClose={() => setCreateOpen(false)}>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                Username
              </label>
              <input
                type="text"
                required
                value={cUsername}
                onChange={(e) => setCUsername(e.target.value)}
                placeholder="e.g. alice"
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                Display Name
              </label>
              <input
                type="text"
                value={cDisplayName}
                onChange={(e) => setCDisplayName(e.target.value)}
                placeholder="e.g. Alice Chen"
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                Initial Password (min 8 chars)
              </label>
              <input
                type="password"
                required
                minLength={8}
                value={cPassword}
                onChange={(e) => setCPassword(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Role
                </label>
                <select
                  value={cRole}
                  onChange={(e) => setCRole(e.target.value as 'user' | 'admin')}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                >
                  <option value="user">Standard User</option>
                  <option value="admin">Administrator</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Quota (GiB)
                </label>
                <input
                  type="number"
                  step="0.5"
                  min="0.1"
                  required
                  value={cQuotaGb}
                  onChange={(e) => setCQuotaGb(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={cMustChange}
                onChange={(e) => setCMustChange(e.target.checked)}
                className="rounded border-slate-300"
              />
              Require password change on first login
            </label>
            {modalError && <p className="text-sm text-red-600 dark:text-red-400">{modalError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg cursor-pointer"
              >
                Create User
              </button>
            </div>
          </form>
        </ModalShell>
      )}

      {/* Edit User Modal */}
      {editUser && (
        <ModalShell title={`Edit ${editUser.username}`} onClose={() => setEditUser(null)}>
          <form onSubmit={handleEdit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                Display Name
              </label>
              <input
                type="text"
                required
                value={eDisplayName}
                onChange={(e) => setEDisplayName(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Role
                </label>
                <select
                  value={eRole}
                  onChange={(e) => setERole(e.target.value as 'user' | 'admin')}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                >
                  <option value="user">Standard User</option>
                  <option value="admin">Administrator</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Quota (GiB)
                </label>
                <input
                  type="number"
                  step="0.5"
                  min="0.1"
                  required
                  value={eQuotaGb}
                  onChange={(e) => setEQuotaGb(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={eActive}
                onChange={(e) => setEActive(e.target.checked)}
                className="rounded border-slate-300"
              />
              Account enabled (uncheck to suspend login and revoke sessions)
            </label>
            {modalError && <p className="text-sm text-red-600 dark:text-red-400">{modalError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditUser(null)}
                className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg cursor-pointer"
              >
                Save Changes
              </button>
            </div>
          </form>
        </ModalShell>
      )}

      {/* Reset Password Modal */}
      {resetUser && (
        <ModalShell title={`Reset Password for ${resetUser.username}`} onClose={() => setResetUser(null)}>
          <form onSubmit={handleResetPassword} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                New Temporary Password (min 8 chars)
              </label>
              <input
                type="password"
                required
                minLength={8}
                value={rPassword}
                onChange={(e) => setRPassword(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={rMustChange}
                onChange={(e) => setRMustChange(e.target.checked)}
                className="rounded border-slate-300"
              />
              Force password change on next login
            </label>
            {modalError && <p className="text-sm text-red-600 dark:text-red-400">{modalError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setResetUser(null)}
                className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg cursor-pointer"
              >
                Reset Password
              </button>
            </div>
          </form>
        </ModalShell>
      )}

      {/* Delete User Modal */}
      {deleteUser && (
        <ModalShell title={`Delete ${deleteUser.username}`} onClose={() => setDeleteUser(null)}>
          <p className="text-sm text-slate-600 dark:text-slate-300 mb-4">
            Deleting{' '}
            <span className="font-mono font-medium text-slate-900 dark:text-slate-100">
              {deleteUser.username}
            </span>{' '}
            will immediately cancel active syncs and permanently remove all files under their
            staging and cloud namespaces.
          </p>
          {modalError && <p className="text-sm text-red-600 dark:text-red-400 mb-4">{modalError}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDeleteUser(null)}
              className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-lg cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleDelete()}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer"
            >
              Delete User &amp; Data
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
