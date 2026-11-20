import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  FolderOpen,
  HardDrive,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Settings,
  Sun,
  User as UserIcon,
  Users,
  X,
} from 'lucide-react';
import { AccountView } from './components/AccountView';
import { AdminOverviewView } from './components/AdminOverviewView';
import { AdminSettingsView } from './components/AdminSettingsView';
import { AdminSyncQueueView } from './components/AdminSyncQueueView';
import { AdminUsersView } from './components/AdminUsersView';
import { ForcePasswordChangeView, LoginView } from './components/AuthViews';
import { FileBrowserView } from './components/FileBrowserView';
import { apiRequest, setClientAuthTokens } from './lib/api';
import { formatBytes, formatRelativePercent } from './lib/format';
import type { AuthUser, ClientRuntimeConfig, StorageUsage } from './types';

type ActiveTab =
  | 'files'
  | 'account'
  | 'admin-overview'
  | 'admin-queue'
  | 'admin-users'
  | 'admin-settings';

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [usage, setUsage] = useState<StorageUsage>({
    totalBytes: 0,
    stagedBytes: 0,
    cloudBytes: 0,
    fileCount: 0,
  });
  const [runtime, setRuntime] = useState<ClientRuntimeConfig>({
    maxUploadSize: 1024 * 1024 * 1024,
    uploadChunkSize: 4 * 1024 * 1024,
  });
  const [booting, setBooting] = useState(true);
  const [activeTab, setActiveTab] = useState<ActiveTab>('files');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem('vaultstage_theme') === 'dark';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) root.classList.add('dark');
    else root.classList.remove('dark');
    try {
      localStorage.setItem('vaultstage_theme', darkMode ? 'dark' : 'light');
    } catch {
      // ignore
    }
  }, [darkMode]);

  const hydrateSession = useCallback(async () => {
    try {
      const data = await apiRequest<{
        user: AuthUser;
        usage: StorageUsage;
        csrfToken: string;
        runtime: ClientRuntimeConfig;
      }>('/api/auth/me');
      setClientAuthTokens(data.csrfToken);
      setUser(data.user);
      setUsage(data.usage);
      setRuntime(data.runtime);
    } catch {
      setUser(null);
      setClientAuthTokens(null, null);
    } finally {
      setBooting(false);
    }
  }, []);

  useEffect(() => {
    void hydrateSession();
  }, [hydrateSession]);

  async function handleLogout() {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    setClientAuthTokens(null, null);
    setUser(null);
    setActiveTab('files');
  }

  if (booting) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 text-sm text-slate-500">
        Loading VaultStage NAS...
      </div>
    );
  }

  if (!user) {
    return (
      <LoginView
        onSuccess={({ user: u, usage: us, runtime: rt }) => {
          setUser(u);
          setUsage(us);
          setRuntime(rt);
          setActiveTab('files');
        }}
      />
    );
  }

  if (user.mustChangePassword) {
    return (
      <ForcePasswordChangeView
        username={user.username}
        onChanged={() => {
          setUser((prev) => (prev ? { ...prev, mustChangePassword: false } : prev));
        }}
        onLogout={() => void handleLogout()}
      />
    );
  }

  const quotaPct = formatRelativePercent(usage.totalBytes, user.quotaBytes);

  const userNav: Array<{ id: ActiveTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'files', label: 'My Files', icon: FolderOpen },
    { id: 'account', label: 'Account', icon: UserIcon },
  ];

  const adminNav: Array<{ id: ActiveTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'admin-overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'admin-queue', label: 'Sync Queue', icon: Activity },
    { id: 'admin-users', label: 'Users & Quotas', icon: Users },
    { id: 'admin-settings', label: 'System Settings', icon: Settings },
  ];

  const sidebarContent = (
    <div className="h-full flex flex-col bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800">
      {/* Brand */}
      <div className="h-16 px-5 flex items-center justify-between border-b border-slate-200 dark:border-slate-800 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 flex items-center justify-center shrink-0">
            <HardDrive className="w-4 h-4" />
          </div>
          <span className="font-semibold text-base tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap">
            VaultStage NAS
          </span>
        </div>
        <button
          type="button"
          onClick={() => setMobileNavOpen(false)}
          className="lg:hidden p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
        <div>
          <div className="px-2.5 mb-1.5 text-xs font-medium text-slate-400">Personal Storage</div>
          <div className="space-y-0.5">
            {userNav.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setActiveTab(item.id);
                    setMobileNavOpen(false);
                  }}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
                    active
                      ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {user.role === 'admin' && (
          <div>
            <div className="px-2.5 mb-1.5 text-xs font-medium text-slate-400">Administration</div>
            <div className="space-y-0.5">
              {adminNav.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileNavOpen(false);
                    }}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
                      active
                        ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300'
                        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </nav>

      {/* Quota & Account Footer */}
      <div className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-4 shrink-0">
        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-slate-500 dark:text-slate-400">Storage Quota</span>
            <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300">
              {quotaPct}%
            </span>
          </div>
          <div className="h-1.5 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
            <div
              className={`h-full ${quotaPct >= 90 ? 'bg-red-600' : 'bg-blue-600'}`}
              style={{ width: `${quotaPct}%` }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
            <span>{formatBytes(usage.totalBytes)}</span>
            <span>{formatBytes(user.quotaBytes)}</span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
              {user.displayName}
            </div>
            <div className="text-xs text-slate-500 truncate font-mono">{user.username}</div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setDarkMode((d) => !d)}
              title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-white rounded-lg cursor-pointer"
            >
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={() => void handleLogout()}
              title="Sign out"
              className="p-1.5 text-slate-500 hover:text-red-600 rounded-lg cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 sticky top-0 h-screen">{sidebarContent}</aside>

      {/* Mobile Drawer */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-50 lg:hidden bg-slate-950/50 flex"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setMobileNavOpen(false);
          }}
        >
          <div className="w-64 h-full">{sidebarContent}</div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Mobile top header */}
        <header className="lg:hidden h-14 px-4 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between sticky top-0 z-30">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            className="p-2 -ml-2 text-slate-600 dark:text-slate-300 cursor-pointer"
            aria-label="Open navigation"
          >
            <Menu className="w-5 h-5" />
          </button>
          <span className="font-semibold text-sm text-slate-900 dark:text-slate-100">
            VaultStage NAS
          </span>
          <button
            type="button"
            onClick={() => setDarkMode((d) => !d)}
            className="p-2 -mr-2 text-slate-500 cursor-pointer"
            aria-label="Toggle theme"
          >
            {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </header>

        <main className="flex-1 px-5 sm:px-8 py-6 max-w-7xl w-full mx-auto">
          {activeTab === 'files' && (
            <FileBrowserView runtime={runtime} onUsageChange={setUsage} />
          )}
          {activeTab === 'account' && <AccountView user={user} usage={usage} />}
          {activeTab === 'admin-overview' && user.role === 'admin' && (
            <AdminOverviewView onNavigate={(t) => setActiveTab(t)} />
          )}
          {activeTab === 'admin-queue' && user.role === 'admin' && <AdminSyncQueueView />}
          {activeTab === 'admin-users' && user.role === 'admin' && (
            <AdminUsersView currentUserId={user.id} />
          )}
          {activeTab === 'admin-settings' && user.role === 'admin' && <AdminSettingsView />}
        </main>
      </div>
    </div>
  );
}
