import { apiRequest } from './api';
import type { FileItem } from '../types';

export interface UploadProgressCallbacks {
  onInit?: (uploadId: string) => void;
  onProgress: (uploadedBytes: number) => void;
  onStateChange: (state: 'uploading' | 'completing' | 'done' | 'error' | 'cancelled', error?: string) => void;
  isPaused: () => boolean;
  isCancelled: () => boolean;
}

/**
 * Executes a chunked, resumable upload for a File object.
 * Supports pause/resume, automatic transient chunk retry, and server offset reconciliation.
 */
export async function runChunkedUpload(
  file: File,
  folderPath: string,
  defaultChunkSize: number,
  callbacks: UploadProgressCallbacks,
  existingUploadId?: string
): Promise<FileItem | null> {
  let uploadId = existingUploadId;
  let chunkSize = defaultChunkSize;
  let offset = 0;

  try {
    if (!uploadId) {
      const init = await apiRequest<{
        uploadId: string;
        chunkSize: number;
        receivedBytes: number;
      }>('/api/uploads/init', {
        method: 'POST',
        body: {
          folderPath,
          fileName: file.name,
          sizeBytes: file.size,
          mimeType: file.type || 'application/octet-stream',
        },
      });
      uploadId = init.uploadId;
      chunkSize = init.chunkSize || defaultChunkSize;
      offset = init.receivedBytes || 0;
      callbacks.onInit?.(uploadId);
    } else {
      // Resume from server's last committed byte offset
      const status = await apiRequest<{ receivedBytes: number }>(`/api/uploads/${uploadId}`);
      offset = status.receivedBytes || 0;
    }

    callbacks.onProgress(offset);

    // Handle zero-byte files cleanly without needing a chunk PUT
    while (offset < file.size) {
      if (callbacks.isCancelled()) {
        await apiRequest(`/api/uploads/${uploadId}`, { method: 'DELETE' }).catch(() => {});
        callbacks.onStateChange('cancelled');
        return null;
      }

      if (callbacks.isPaused()) {
        return null;
      }

      const end = Math.min(offset + chunkSize, file.size);
      const chunkBlob = file.slice(offset, end);

      let attempts = 0;
      let chunkSent = false;
      while (!chunkSent) {
        try {
          const res = await apiRequest<{ receivedBytes: number }>(
            `/api/uploads/${uploadId}/chunk?offset=${offset}`,
            {
              method: 'PUT',
              body: chunkBlob,
              headers: {
                'Content-Type': 'application/octet-stream',
                'X-Upload-Offset': String(offset),
              },
            }
          );
          offset = res.receivedBytes;
          callbacks.onProgress(offset);
          chunkSent = true;
        } catch (err) {
          attempts++;
          if (attempts >= 3 || callbacks.isCancelled()) {
            throw err;
          }
          // Re-check server offset before retrying chunk
          await new Promise((r) => setTimeout(r, 400 * attempts));
          try {
            const status = await apiRequest<{ receivedBytes: number }>(`/api/uploads/${uploadId}`);
            offset = status.receivedBytes;
            callbacks.onProgress(offset);
            if (offset >= end) {
              chunkSent = true;
            }
          } catch {
            // proceed with retry
          }
        }
      }
    }

    if (callbacks.isCancelled()) {
      await apiRequest(`/api/uploads/${uploadId}`, { method: 'DELETE' }).catch(() => {});
      callbacks.onStateChange('cancelled');
      return null;
    }

    callbacks.onStateChange('completing');
    const completed = await apiRequest<{ file: FileItem }>(`/api/uploads/${uploadId}/complete`, {
      method: 'POST',
    });
    callbacks.onProgress(file.size);
    callbacks.onStateChange('done');
    return completed.file;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed';
    callbacks.onStateChange('error', message);
    return null;
  }
}
