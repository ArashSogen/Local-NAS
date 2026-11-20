export type UserRole = 'admin' | 'user';

export type FileStatus =
  | 'RECEIVING'
  | 'STAGED'
  | 'QUEUED'
  | 'UPLOADING'
  | 'VERIFYING'
  | 'SYNCED'
  | 'FAILED';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  mustChangePassword: boolean;
  quotaBytes: number;
}

export interface StorageUsage {
  totalBytes: number;
  stagedBytes: number;
  cloudBytes: number;
  fileCount: number;
}

export interface ClientRuntimeConfig {
  maxUploadSize: number;
  uploadChunkSize: number;
}

export interface FolderItem {
  id: string;
  path: string;
  parentPath: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface FileItem {
  id: string;
  relativePath: string;
  folderPath: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string | null;
  status: FileStatus;
  localPresent: boolean;
  cloudPresent: boolean;
  verificationMethod: string | null;
  verifiedAt: string | null;
  lastError: string | null;
  generation: number;
  createdAt: string;
  updatedAt: string;
}

export interface SyncJobItem {
  id: string;
  file_id: string;
  user_id: string;
  username?: string;
  file_name?: string;
  size_bytes?: number;
  local_present?: number;
  cloud_present?: number;
  generation: number;
  source_relative_path: string;
  cloud_relative_path: string;
  status: 'QUEUED' | 'UPLOADING' | 'VERIFYING' | 'SYNCED' | 'FAILED' | 'CANCELLED';
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  last_error: string | null;
  verification_method: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActivityLogItem {
  id: number;
  user_id: string | null;
  actor_username: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: string | null;
  level: 'info' | 'warn' | 'error';
  created_at: string;
}

export interface AdminUserItem {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  mustChangePassword?: boolean;
  quotaBytes: number;
  usedBytes: number;
  stagedBytes: number;
  cloudBytes: number;
  fileCount: number;
  createdAt?: string;
  lastLoginAt: string | null;
}

export interface CloudHealth {
  ok: boolean;
  engine: 'rclone' | 'local-rclone-compat' | 'unconfigured';
  remoteName: string;
  remoteType: string;
  message: string;
}

export interface AdminOverviewData {
  stagingDisk: { totalBytes: number; fileCount: number };
  storage: {
    totalFiles: number;
    totalBytes: number;
    stagedBytes: number;
    cloudBytes: number;
    queuedFiles: number;
    activeFiles: number;
    syncedFiles: number;
    failedFiles: number;
  };
  queue: {
    queued: number;
    active: number;
    failed: number;
    synced: number;
  };
  users: AdminUserItem[];
  recentActivity: ActivityLogItem[];
  cloudHealth: CloudHealth;
}

export interface AdminSettingsData {
  runtime: {
    maxUploadSize: number;
    defaultUserQuota: number;
    uploadChunkSize: number;
    syncConcurrency: number;
    syncRetryLimit: number;
    syncRetryBackoff: number;
  };
  activeConfig: {
    hardDiskPath: string;
    cloudRemote: string;
    rcloneConfigPath: string;
    rcloneRemoteName: string;
    rcloneRemoteType: string;
    rcloneConfigExists: boolean;
    cloudDriverEngine: string;
    databasePath: string;
    sessionTtlHours: number;
    trustProxy: boolean;
  };
}

export interface ActiveClientUpload {
  localId: string;
  uploadId?: string;
  fileName: string;
  folderPath: string;
  sizeBytes: number;
  uploadedBytes: number;
  state: 'uploading' | 'paused' | 'completing' | 'done' | 'error' | 'cancelled';
  error?: string;
  file: File;
}
