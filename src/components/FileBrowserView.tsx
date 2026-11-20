import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowUpFromLine,
  CheckCircle2,
  ChevronRight,
  Clock,
  Cloud,
  Download,
  Eye,
  File as FileIcon,
  Folder,
  FolderPlus,
  HardDrive,
  Info,
  Loader2,
  MoveRight,
  Pause,
  Play,
  RefreshCw,
  RotateCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { apiRequest, fetchAuthenticatedBlob } from '../lib/api';
import {
  formatBytes,
  formatTimestamp,
  humanizeFileStatus,
  isPreviewableMime,
} from '../lib/format';
import { runChunkedUpload } from '../lib/uploader';
import type {
  ActiveClientUpload,
  ClientRuntimeConfig,
  FileItem,
  FolderItem,
  StorageUsage,
  SyncJobItem,
} from '../types';

interface FileBrowserViewProps {
  runtime: ClientRuntimeConfig;
  onUsageChange: (usage: StorageUsage) => void;
}

export function FileBrowserView({ runtime, onUsageChange }: FileBrowserViewProps) {
  const [currentFolder, setCurrentFolder] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  // Active client chunked uploads
  const [uploads, setUploads] = useState<ActiveClientUpload[]>([]);
  const pausedIdsRef = useRef<Set<string>>(new Set());
  const cancelledIdsRef = useRef<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Modals
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);

  const [moveFile, setMoveFile] = useState<FileItem | null>(null);
  const [moveName, setMoveName] = useState('');
  const [moveTargetFolder, setMoveTargetFolder] = useState('');
  const [allFolders, setAllFolders] = useState<FolderItem[]>([]);

  const [deleteTarget, setDeleteTarget] = useState<
    { type: 'file'; item: FileItem } | { type: 'folder'; item: FolderItem } | null
  >(null);

  const [detailTarget, setDetailTarget] = useState<{
    file: FileItem;
    jobs: SyncJobItem[];
  } | null>(null);

  const [previewTarget, setPreviewTarget] = useState<{
    file: FileItem;
    objectUrl?: string;
    textContent?: string;
    storageSource?: string | null;
    loading: boolean;
    error?: string;
  } | null>(null);

  const fetchListing = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (currentFolder) params.set('folder', currentFolder);
        if (searchQuery.trim()) params.set('q', searchQuery.trim());

        const data = await apiRequest<{
          folderPath: string;
          folders: FolderItem[];
          files: FileItem[];
          usage: StorageUsage;
        }>(`/api/files?${params.toString()}`);

        setFolders(data.folders);
        setFiles(data.files);
        onUsageChange(data.usage);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load files');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [currentFolder, searchQuery, onUsageChange]
  );

  useEffect(() => {
    void fetchListing(false);
  }, [fetchListing]);

  // Poll automatically while any file is actively syncing or queued
  useEffect(() => {
    const hasPending = files.some((f) =>
      ['STAGED', 'QUEUED', 'UPLOADING', 'VERIFYING'].includes(f.status)
    );
    if (!hasPending) return;
    const timer = setInterval(() => {
      void fetchListing(true);
    }, 1500);
    return () => clearInterval(timer);
  }, [files, fetchListing]);

  // Clean up preview blob URL on close
  useEffect(() => {
    return () => {
      if (previewTarget?.objectUrl) {
        URL.revokeObjectURL(previewTarget.objectUrl);
      }
    };
  }, [previewTarget?.objectUrl]);

  const startUploadTask = useCallback(
    async (task: ActiveClientUpload) => {
      const localId = task.localId;
      pausedIdsRef.current.delete(localId);
      cancelledIdsRef.current.delete(localId);

      setUploads((prev) =>
        prev.map((u) => (u.localId === localId ? { ...u, state: 'uploading', error: undefined } : u))
      );

      const result = await runChunkedUpload(
        task.file,
        task.folderPath,
        runtime.uploadChunkSize,
        {
          onInit: (uploadId) => {
            setUploads((prev) =>
              prev.map((u) => (u.localId === localId ? { ...u, uploadId } : u))
            );
          },
          onProgress: (uploadedBytes) => {
            setUploads((prev) =>
              prev.map((u) => (u.localId === localId ? { ...u, uploadedBytes } : u))
            );
          },
          onStateChange: (state, errMsg) => {
            setUploads((prev) =>
              prev.map((u) =>
                u.localId === localId ? { ...u, state, error: errMsg } : u
              )
            );
          },
          isPaused: () => pausedIdsRef.current.has(localId),
          isCancelled: () => cancelledIdsRef.current.has(localId),
        },
        task.uploadId
      );

      if (result) {
        void fetchListing(true);
      }
    },
    [runtime.uploadChunkSize, fetchListing]
  );

  const enqueueFilesForUpload = useCallback(
    (fileList: FileList | File[]) => {
      const items = Array.from(fileList);
      if (items.length === 0) return;

      const newTasks: ActiveClientUpload[] = items.map((file) => ({
        localId: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        fileName: file.name,
        folderPath: currentFolder,
        sizeBytes: file.size,
        uploadedBytes: 0,
        state: 'uploading',
        file,
      }));

      setUploads((prev) => [...newTasks, ...prev]);

      for (const task of newTasks) {
        void startUploadTask(task);
      }
    },
    [currentFolder, startUploadTask]
  );

  function handlePauseUpload(localId: string) {
    pausedIdsRef.current.add(localId);
    setUploads((prev) =>
      prev.map((u) => (u.localId === localId ? { ...u, state: 'paused' } : u))
    );
  }

  function handleResumeUpload(task: ActiveClientUpload) {
    void startUploadTask(task);
  }

  function handleCancelUpload(localId: string) {
    cancelledIdsRef.current.add(localId);
    pausedIdsRef.current.delete(localId);
    setUploads((prev) =>
      prev.map((u) => (u.localId === localId ? { ...u, state: 'cancelled' } : u))
    );
  }

  function clearFinishedUploads() {
    setUploads((prev) => prev.filter((u) => u.state === 'uploading' || u.state === 'paused' || u.state === 'completing'));
  }

  async function handleCreateFolder(e: React.FormEvent) {
    e.preventDefault();
    setModalError(null);
    try {
      await apiRequest('/api/files/folders', {
        method: 'POST',
        body: { parentPath: currentFolder, name: newFolderName.trim() },
      });
      setNewFolderName('');
      setNewFolderOpen(false);
      await fetchListing(false);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : 'Unable to create folder');
    }
  }

  async function openMoveModal(file: FileItem) {
    setModalError(null);
    setMoveFile(file);
    setMoveName(file.name);
    setMoveTargetFolder(file.folderPath);
    try {
      const data = await apiRequest<{ folders: FolderItem[] }>('/api/files/folders');
      setAllFolders(data.folders);
    } catch {
      setAllFolders([]);
    }
  }

  async function handleSaveMove(e: React.FormEvent) {
    e.preventDefault();
    if (!moveFile) return;
    setModalError(null);
    try {
      await apiRequest(`/api/files/${moveFile.id}`, {
        method: 'PATCH',
        body: { name: moveName.trim(), targetFolder: moveTargetFolder },
      });
      setMoveFile(null);
      await fetchListing(false);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : 'Unable to move or rename file');
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setModalError(null);
    try {
      if (deleteTarget.type === 'file') {
        await apiRequest(`/api/files/${deleteTarget.item.id}`, { method: 'DELETE' });
      } else {
        await apiRequest(`/api/files/folders/${deleteTarget.item.id}`, { method: 'DELETE' });
      }
      setDeleteTarget(null);
      await fetchListing(false);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : 'Unable to delete item');
    }
  }

  async function handleDownload(file: FileItem) {
    try {
      const { blob } = await fetchAuthenticatedBlob(`/api/files/${file.id}/download`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    }
  }

  async function handlePreview(file: FileItem) {
    if (previewTarget?.objectUrl) {
      URL.revokeObjectURL(previewTarget.objectUrl);
    }
    const kind = isPreviewableMime(file.mimeType);
    if (!kind) {
      await handleInspect(file);
      return;
    }

    setPreviewTarget({ file, loading: true });
    try {
      const { blob, storageSource } = await fetchAuthenticatedBlob(
        `/api/files/${file.id}/download?inline=1`
      );
      if (kind === 'text') {
        const text = await blob.text();
        setPreviewTarget({
          file,
          textContent: text.slice(0, 200_000),
          storageSource,
          loading: false,
        });
      } else {
        const objectUrl = URL.createObjectURL(blob);
        setPreviewTarget({
          file,
          objectUrl,
          storageSource,
          loading: false,
        });
      }
    } catch (err) {
      setPreviewTarget({
        file,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load preview',
      });
    }
  }

  async function handleInspect(file: FileItem) {
    try {
      const data = await apiRequest<{ file: FileItem; jobs: SyncJobItem[] }>(
        `/api/files/${file.id}`
      );
      setDetailTarget(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load file details');
    }
  }

  async function handleRetryFile(file: FileItem) {
    try {
      await apiRequest(`/api/files/${file.id}/retry`, { method: 'POST' });
      await fetchListing(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retry sync');
    }
  }

  const breadcrumbs = currentFolder ? currentFolder.split('/') : [];

  return (
    <div
      className="relative min-h-[calc(100vh-4rem)] flex flex-col"
      onDragOver={(e) => {
        e.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragActive(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          enqueueFilesForUpload(e.dataTransfer.files);
        }
      }}
    >
      {/* Drag-and-drop overlay */}
      {dragActive && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-6"
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragActive(false);
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
              enqueueFilesForUpload(e.dataTransfer.files);
            }
          }}
        >
          <div className="bg-white dark:bg-slate-900 border-2 border-dashed border-blue-600 rounded-xl px-12 py-10 text-center max-w-md">
            <ArrowUpFromLine className="w-10 h-10 text-blue-600 mx-auto mb-3" />
            <p className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Drop files to stage into {currentFolder ? `/${currentFolder}` : 'root'}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Chunked upload to local disk, then verified sync to cloud drive
            </p>
          </div>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) {
            enqueueFilesForUpload(e.target.files);
            e.target.value = '';
          }
        }}
      />

      {/* Contextual Workspace Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-slate-200 dark:border-slate-800">
        {/* Breadcrumbs */}
        <nav aria-label="Folder breadcrumbs" className="flex items-center gap-1.5 text-sm min-w-0">
          <button
            type="button"
            onClick={() => {
              setCurrentFolder('');
              setSearchQuery('');
            }}
            className={`font-medium transition-colors cursor-pointer whitespace-nowrap ${
              currentFolder === '' && !searchQuery
                ? 'text-slate-900 dark:text-slate-100'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            My Files
          </button>
          {breadcrumbs.map((seg, idx) => {
            const pathToHere = breadcrumbs.slice(0, idx + 1).join('/');
            const isLast = idx === breadcrumbs.length - 1;
            return (
              <React.Fragment key={pathToHere}>
                <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                <button
                  type="button"
                  onClick={() => {
                    setCurrentFolder(pathToHere);
                    setSearchQuery('');
                  }}
                  className={`truncate max-w-44 cursor-pointer transition-colors ${
                    isLast
                      ? 'font-medium text-slate-900 dark:text-slate-100'
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  {seg}
                </button>
              </React.Fragment>
            );
          })}
          {searchQuery.trim() && (
            <>
              <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
              <span className="text-slate-600 dark:text-slate-300 truncate">
                Search: &ldquo;{searchQuery.trim()}&rdquo;
              </span>
            </>
          )}
        </nav>

        {/* Search + Primary Actions */}
        <div className="flex items-center gap-2.5 flex-wrap">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search your files..."
              className="pl-9 pr-3 py-2 text-sm w-56 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>

          <button
            type="button"
            onClick={() => {
              setModalError(null);
              setNewFolderName('');
              setNewFolderOpen(true);
            }}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <FolderPlus className="w-4 h-4" />
            New Folder
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <Upload className="w-4 h-4" />
            Upload Files
          </button>
        </div>
      </div>

      {/* Active Upload Queue Panel */}
      {uploads.length > 0 && (
        <div className="mt-5 border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
              Upload Transfers ({uploads.length})
            </span>
            <button
              type="button"
              onClick={clearFinishedUploads}
              className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 cursor-pointer"
            >
              Clear finished
            </button>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-56 overflow-y-auto">
            {uploads.map((u) => {
              const pct = u.sizeBytes > 0 ? Math.min(100, Math.round((u.uploadedBytes / u.sizeBytes) * 100)) : 100;
              return (
                <div key={u.localId} className="px-4 py-3 flex items-center gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2 text-xs mb-1.5">
                      <span className="font-medium text-slate-900 dark:text-slate-100 truncate">
                        {u.fileName}
                      </span>
                      <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400 shrink-0">
                        {u.state === 'done'
                          ? 'Staged · Queued for cloud sync'
                          : u.state === 'completing'
                          ? 'Finalizing checksum...'
                          : u.state === 'error'
                          ? u.error || 'Upload failed'
                          : u.state === 'cancelled'
                          ? 'Cancelled'
                          : `${formatBytes(u.uploadedBytes)} / ${formatBytes(u.sizeBytes)} (${pct}%)`}
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-150 ${
                          u.state === 'error'
                            ? 'bg-red-600'
                            : u.state === 'done'
                            ? 'bg-emerald-600'
                            : 'bg-blue-600'
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {u.state === 'uploading' && (
                      <button
                        type="button"
                        onClick={() => handlePauseUpload(u.localId)}
                        title="Pause upload"
                        className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-white rounded cursor-pointer"
                      >
                        <Pause className="w-4 h-4" />
                      </button>
                    )}
                    {(u.state === 'paused' || u.state === 'error') && (
                      <button
                        type="button"
                        onClick={() => handleResumeUpload(u)}
                        title="Resume upload"
                        className="p-1.5 text-blue-600 hover:text-blue-700 rounded cursor-pointer"
                      >
                        <Play className="w-4 h-4" />
                      </button>
                    )}
                    {(u.state === 'uploading' || u.state === 'paused') && (
                      <button
                        type="button"
                        onClick={() => handleCancelUpload(u.localId)}
                        title="Cancel upload"
                        className="p-1.5 text-slate-400 hover:text-red-600 rounded cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 p-3.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 text-sm text-red-700 dark:text-red-300 flex items-center justify-between">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Main File & Folder Table */}
      <div className="mt-5 flex-1 border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
          <div className="flex items-center gap-2">
            <span>{folders.length} folder{folders.length === 1 ? '' : 's'}</span>
            <span aria-hidden="true">·</span>
            <span>{files.length} file{files.length === 1 ? '' : 's'}</span>
            <span aria-hidden="true">·</span>
            <span>Drag files anywhere to upload</span>
          </div>
          <button
            type="button"
            onClick={() => void fetchListing(false)}
            className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>

        {loading ? (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-11 px-4 flex items-center gap-4 animate-pulse">
                <div className="w-4 h-4 rounded bg-slate-200 dark:bg-slate-800" />
                <div className="h-3.5 w-52 rounded bg-slate-200 dark:bg-slate-800" />
                <div className="ml-auto h-3.5 w-24 rounded bg-slate-200 dark:bg-slate-800" />
              </div>
            ))}
          </div>
        ) : folders.length === 0 && files.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-20 px-6 text-center">
            <HardDrive className="w-10 h-10 text-slate-300 dark:text-slate-700 mb-3" />
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {searchQuery.trim() ? 'No matching files found' : 'This folder is empty'}
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-md">
              {searchQuery.trim()
                ? 'Try a different search term or clear the filter.'
                : 'Upload files to stage them on local disk. Once verified in the cloud drive, the local staging copy is automatically removed.'}
            </p>
            {!searchQuery.trim() && (
              <div className="mt-5 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors cursor-pointer"
                >
                  <Upload className="w-4 h-4" />
                  Upload Files
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setModalError(null);
                    setNewFolderName('');
                    setNewFolderOpen(true);
                  }}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                >
                  <FolderPlus className="w-4 h-4" />
                  Create Folder
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50/50 dark:bg-slate-900">
                  <th className="py-2.5 pl-4 pr-3">Name</th>
                  <th className="py-2.5 px-3">Pipeline Status</th>
                  <th className="py-2.5 px-3">Location</th>
                  <th className="py-2.5 px-3 text-right">Size</th>
                  <th className="py-2.5 px-3">Updated</th>
                  <th className="py-2.5 pl-3 pr-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                {folders.map((folder) => (
                  <tr
                    key={folder.id}
                    className="h-11 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
                  >
                    <td className="py-2 pl-4 pr-3">
                      <button
                        type="button"
                        onClick={() => {
                          setCurrentFolder(folder.path);
                          setSearchQuery('');
                        }}
                        className="flex items-center gap-2.5 font-medium text-slate-900 dark:text-slate-100 hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer text-left"
                      >
                        <Folder className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
                        <span className="truncate max-w-xs">{folder.name}</span>
                      </button>
                    </td>
                    <td className="py-2 px-3 text-xs text-slate-400">Folder</td>
                    <td className="py-2 px-3 text-xs text-slate-400">—</td>
                    <td className="py-2 px-3 text-right font-mono text-xs text-slate-400">—</td>
                    <td className="py-2 px-3 font-mono text-xs text-slate-500 dark:text-slate-400">
                      {formatTimestamp(folder.updatedAt)}
                    </td>
                    <td className="py-2 pl-3 pr-4 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          setModalError(null);
                          setDeleteTarget({ type: 'folder', item: folder });
                        }}
                        title="Delete folder"
                        className="p-1.5 text-slate-400 hover:text-red-600 rounded transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}

                {files.map((file) => {
                  const previewKind = isPreviewableMime(file.mimeType);
                  return (
                    <tr
                      key={file.id}
                      className="h-11 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
                    >
                      <td className="py-2 pl-4 pr-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <FileIcon className="w-4 h-4 text-slate-400 shrink-0" />
                          <div className="min-w-0">
                            <button
                              type="button"
                              onClick={() => void handlePreview(file)}
                              className="font-medium text-slate-900 dark:text-slate-100 hover:text-blue-600 dark:hover:text-blue-400 truncate max-w-xs block cursor-pointer text-left"
                              title={file.relativePath}
                            >
                              {file.name}
                            </button>
                            {searchQuery.trim() && file.folderPath && (
                              <span className="text-xs text-slate-400 block truncate max-w-xs">
                                /{file.folderPath}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>

                      <td className="py-2 px-3 whitespace-nowrap">
                        <FileStatusInline file={file} />
                      </td>

                      <td className="py-2 px-3 whitespace-nowrap text-xs text-slate-600 dark:text-slate-400">
                        {file.localPresent && file.cloudPresent
                          ? 'Staging · Cloud'
                          : file.cloudPresent
                          ? 'Cloud'
                          : file.localPresent
                          ? 'Staging Disk'
                          : '—'}
                      </td>

                      <td className="py-2 px-3 text-right font-mono text-xs text-slate-700 dark:text-slate-300 whitespace-nowrap tabular-nums">
                        {formatBytes(file.sizeBytes)}
                      </td>

                      <td className="py-2 px-3 font-mono text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap tabular-nums">
                        {formatTimestamp(file.updatedAt)}
                      </td>

                      <td className="py-2 pl-3 pr-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          {file.status === 'FAILED' && file.localPresent && (
                            <button
                              type="button"
                              onClick={() => void handleRetryFile(file)}
                              title="Retry cloud sync"
                              className="p-1.5 text-amber-600 hover:text-amber-700 rounded transition-colors cursor-pointer"
                            >
                              <RotateCw className="w-4 h-4" />
                            </button>
                          )}
                          {previewKind && (
                            <button
                              type="button"
                              onClick={() => void handlePreview(file)}
                              title="Preview file"
                              className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-white rounded transition-colors cursor-pointer"
                            >
                              <Eye className="w-4 h-4" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleDownload(file)}
                            title="Download file"
                            className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-white rounded transition-colors cursor-pointer"
                          >
                            <Download className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleInspect(file)}
                            title="Details & checksum"
                            className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-white rounded transition-colors cursor-pointer"
                          >
                            <Info className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void openMoveModal(file)}
                            title="Rename or move"
                            className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-white rounded transition-colors cursor-pointer"
                          >
                            <MoveRight className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setModalError(null);
                              setDeleteTarget({ type: 'file', item: file });
                            }}
                            title="Delete file"
                            className="p-1.5 text-slate-400 hover:text-red-600 rounded transition-colors cursor-pointer"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
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

      {/* New Folder Modal */}
      {newFolderOpen && (
        <ModalShell title="Create Folder" onClose={() => setNewFolderOpen(false)}>
          <form onSubmit={handleCreateFolder} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Folder name
              </label>
              <input
                type="text"
                autoFocus
                required
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="e.g. Backups 2026"
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
              <p className="text-xs text-slate-500 mt-1.5">
                Created inside <code className="font-mono">/{currentFolder}</code>
              </p>
            </div>
            {modalError && <p className="text-sm text-red-600 dark:text-red-400">{modalError}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setNewFolderOpen(false)}
                className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg cursor-pointer"
              >
                Create
              </button>
            </div>
          </form>
        </ModalShell>
      )}

      {/* Rename / Move Modal */}
      {moveFile && (
        <ModalShell title="Rename or Move File" onClose={() => setMoveFile(null)}>
          <form onSubmit={handleSaveMove} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                File name
              </label>
              <input
                type="text"
                required
                value={moveName}
                onChange={(e) => setMoveName(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Destination folder
              </label>
              <select
                value={moveTargetFolder}
                onChange={(e) => setMoveTargetFolder(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                <option value="">/ (Root)</option>
                {allFolders.map((f) => (
                  <option key={f.id} value={f.path}>
                    /{f.path}
                  </option>
                ))}
              </select>
            </div>
            {modalError && <p className="text-sm text-red-600 dark:text-red-400">{modalError}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setMoveFile(null)}
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

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <ModalShell
          title={`Delete ${deleteTarget.type === 'folder' ? 'Folder' : 'File'}`}
          onClose={() => setDeleteTarget(null)}
        >
          <p className="text-sm text-slate-600 dark:text-slate-300 mb-4">
            Permanently delete{' '}
            <span className="font-mono font-medium text-slate-900 dark:text-slate-100">
              {deleteTarget.item.name}
            </span>{' '}
            from both local staging and the cloud drive?
            {deleteTarget.type === 'folder' && ' All nested files inside this folder will be removed.'}
          </p>
          {modalError && <p className="text-sm text-red-600 dark:text-red-400 mb-4">{modalError}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDeleteTarget(null)}
              className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-lg cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleConfirmDelete()}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer"
            >
              Delete Permanently
            </button>
          </div>
        </ModalShell>
      )}

      {/* File Details & Sync History Modal */}
      {detailTarget && (
        <ModalShell title={detailTarget.file.name} onClose={() => setDetailTarget(null)} wide>
          <div className="space-y-5 text-sm">
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 border-b border-slate-200 dark:border-slate-800 pb-4">
              <div>
                <dt className="text-xs text-slate-500">Path</dt>
                <dd className="font-mono text-xs text-slate-900 dark:text-slate-100 mt-0.5 break-all">
                  /{detailTarget.file.relativePath}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Pipeline State</dt>
                <dd className="mt-0.5">
                  <FileStatusInline file={detailTarget.file} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Size</dt>
                <dd className="font-mono text-xs text-slate-900 dark:text-slate-100 mt-0.5">
                  {formatBytes(detailTarget.file.sizeBytes)} ({detailTarget.file.sizeBytes.toLocaleString()} bytes)
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Verification</dt>
                <dd className="font-mono text-xs text-slate-900 dark:text-slate-100 mt-0.5">
                  {detailTarget.file.verificationMethod
                    ? `${detailTarget.file.verificationMethod} · ${formatTimestamp(detailTarget.file.verifiedAt)}`
                    : 'Not yet verified'}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-slate-500">SHA-256 Checksum</dt>
                <dd className="font-mono text-xs text-slate-700 dark:text-slate-300 mt-0.5 break-all">
                  {detailTarget.file.sha256 || 'Pending'}
                </dd>
              </div>
              {detailTarget.file.lastError && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-red-600 dark:text-red-400">Last Error</dt>
                  <dd className="font-mono text-xs text-red-700 dark:text-red-300 mt-0.5 break-words">
                    {detailTarget.file.lastError}
                  </dd>
                </div>
              )}
            </dl>

            <div>
              <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
                Sync Job History
              </h3>
              {detailTarget.jobs.length === 0 ? (
                <p className="text-xs text-slate-500">No sync jobs recorded yet.</p>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg">
                  {detailTarget.jobs.map((job) => (
                    <div key={job.id} className="px-3 py-2 text-xs flex items-center justify-between gap-4">
                      <div>
                        <span className="font-medium text-slate-900 dark:text-slate-100">
                          {job.status}
                        </span>
                        <span className="text-slate-400 mx-1.5">·</span>
                        <span className="font-mono text-slate-500">
                          Attempt {job.attempts}/{job.max_attempts}
                        </span>
                        {job.verification_method && (
                          <>
                            <span className="text-slate-400 mx-1.5">·</span>
                            <span className="font-mono text-slate-500">{job.verification_method}</span>
                          </>
                        )}
                        {job.last_error && (
                          <p className="text-red-600 dark:text-red-400 mt-0.5 font-mono">
                            {job.last_error}
                          </p>
                        )}
                      </div>
                      <span className="font-mono text-slate-400 shrink-0">
                        {formatTimestamp(job.updated_at)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </ModalShell>
      )}

      {/* Inline File Preview Modal */}
      {previewTarget && (
        <ModalShell
          title={previewTarget.file.name}
          subtitle={
            previewTarget.storageSource
              ? `Streamed from ${previewTarget.storageSource === 'cloud' ? 'Cloud Drive' : 'Local Staging'} · ${formatBytes(previewTarget.file.sizeBytes)}`
              : formatBytes(previewTarget.file.sizeBytes)
          }
          onClose={() => {
            if (previewTarget.objectUrl) URL.revokeObjectURL(previewTarget.objectUrl);
            setPreviewTarget(null);
          }}
          wide
        >
          {previewTarget.loading ? (
            <div className="py-16 flex items-center justify-center gap-2 text-sm text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" />
              Streaming file...
            </div>
          ) : previewTarget.error ? (
            <div className="p-4 rounded-lg bg-red-50 dark:bg-red-950/50 text-sm text-red-700 dark:text-red-300">
              {previewTarget.error}
            </div>
          ) : previewTarget.textContent !== undefined ? (
            <pre className="p-4 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs font-mono text-slate-800 dark:text-slate-200 overflow-auto max-h-[60vh] whitespace-pre-wrap break-words">
              {previewTarget.textContent}
            </pre>
          ) : previewTarget.objectUrl ? (
            <div className="flex justify-center">
              {isPreviewableMime(previewTarget.file.mimeType) === 'image' && (
                <img
                  src={previewTarget.objectUrl}
                  alt={previewTarget.file.name}
                  referrerPolicy="no-referrer"
                  className="max-h-[60vh] rounded-lg object-contain border border-slate-200 dark:border-slate-800"
                />
              )}
              {isPreviewableMime(previewTarget.file.mimeType) === 'pdf' && (
                <iframe
                  src={previewTarget.objectUrl}
                  title={previewTarget.file.name}
                  className="w-full h-[65vh] rounded-lg border border-slate-200 dark:border-slate-800"
                />
              )}
              {isPreviewableMime(previewTarget.file.mimeType) === 'video' && (
                <video
                  src={previewTarget.objectUrl}
                  controls
                  className="max-h-[60vh] w-full rounded-lg bg-black"
                />
              )}
              {isPreviewableMime(previewTarget.file.mimeType) === 'audio' && (
                <audio src={previewTarget.objectUrl} controls className="w-full my-6" />
              )}
            </div>
          ) : null}

          <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800 flex justify-end">
            <button
              type="button"
              onClick={() => void handleDownload(previewTarget.file)}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg cursor-pointer"
            >
              <Download className="w-4 h-4" />
              Download
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}

function FileStatusInline({ file }: { file: FileItem }) {
  const label = humanizeFileStatus(file.status);
  if (file.status === 'SYNCED') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
        <Cloud className="w-3.5 h-3.5 shrink-0" />
        <span>{label}</span>
      </span>
    );
  }
  if (file.status === 'FAILED') {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700 dark:text-red-400"
        title={file.lastError || 'Sync failed; local copy preserved'}
      >
        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
        <span>{label}</span>
      </span>
    );
  }
  if (file.status === 'UPLOADING' || file.status === 'VERIFYING') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 dark:text-blue-400">
        <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
        <span>{label}</span>
      </span>
    );
  }
  if (file.status === 'STAGED' || file.status === 'QUEUED') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
        <Clock className="w-3.5 h-3.5 shrink-0" />
        <span>{label}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-400">
      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
      <span>{label}</span>
    </span>
  );
}

export function ModalShell({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`w-full ${
          wide ? 'max-w-2xl' : 'max-w-md'
        } bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden`}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100 truncate">
              {title}
            </h2>
            {subtitle && (
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-mono">
                {subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
