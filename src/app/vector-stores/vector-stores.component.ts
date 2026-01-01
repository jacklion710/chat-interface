import { Component, signal, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { VectorStoresService } from './vector-stores.service';

export interface VectorStore {
  id: string;
  name: string;
  status: string;
  file_counts: {
    in_progress: number;
    completed: number;
    failed: number;
    cancelled: number;
    total: number;
  };
  created_at: number;
}

export interface VectorStoreFile {
  id: string;
  object: string;
  status: string;
  vector_store_id: string;
  created_at: number;
  file_id?: string;
  filename?: string;
  bytes?: number;
}

@Component({
  selector: 'app-vector-stores',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './vector-stores.component.html',
  styleUrl: './vector-stores.component.css'
})
export class VectorStoresComponent implements OnDestroy {
  vectorStores = signal<VectorStore[]>([]);
  selectedStore = signal<VectorStore | null>(null);
  storeFiles = signal<VectorStoreFile[]>([]);
  isLoading = signal(false);
  error = signal<string | null>(null);
  newStoreName = signal('');
  isCreatingStore = signal(false);
  isUploadingFile = signal(false);
  queuedFiles = signal<File[]>([]);
  isDragOver = signal(false);
  isPolling = signal(false);

  private pollIntervalId: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;

  constructor(private vectorStoresService: VectorStoresService) {
    this.loadVectorStores();
  }

  ngOnDestroy() {
    this.stopPolling();
  }

  async loadVectorStores(showLoading = true) {
    if (showLoading) {
      this.isLoading.set(true);
    }
    this.error.set(null);
    try {
      const stores = await this.vectorStoresService.listVectorStores();
      this.vectorStores.set(stores);
      this.syncSelectedStoreFromList(stores);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load vector stores');
    } finally {
      if (showLoading) {
        this.isLoading.set(false);
      }
    }
  }

  async createVectorStore() {
    const name = this.newStoreName().trim();
    if (!name || this.isCreatingStore()) {
      return;
    }

    this.isCreatingStore.set(true);
    this.error.set(null);
    try {
      const store = await this.vectorStoresService.createVectorStore(name);
      this.vectorStores.update(stores => [store, ...stores]);
      this.newStoreName.set('');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to create vector store');
    } finally {
      this.isCreatingStore.set(false);
    }
  }

  async selectStore(store: VectorStore) {
    this.selectedStore.set(store);
    await this.loadStoreFiles(store.id, true);
    this.startPollingIfNeeded();
  }

  async loadStoreFiles(storeId: string, showLoading = true) {
    if (showLoading) {
      this.isLoading.set(true);
    }
    this.error.set(null);
    try {
      const files = await this.vectorStoresService.listStoreFiles(storeId);
      this.storeFiles.set(files);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load files');
    } finally {
      if (showLoading) {
        this.isLoading.set(false);
      }
    }
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.addFilesToQueue(Array.from(input.files));
    }
  }

  onDragOver(event: DragEvent) {
    event.preventDefault();
    this.isDragOver.set(true);
  }

  onDragLeave(event: DragEvent) {
    event.preventDefault();
    this.isDragOver.set(false);
  }

  onDrop(event: DragEvent) {
    event.preventDefault();
    this.isDragOver.set(false);
    const files = event.dataTransfer?.files ? Array.from(event.dataTransfer.files) : [];
    if (files.length > 0) {
      this.addFilesToQueue(files);
    }
  }

  addFilesToQueue(files: File[]) {
    const existing = new Set(this.queuedFiles().map((f) => `${f.name}:${f.size}:${f.lastModified}`));
    const next = files.filter((f) => !existing.has(`${f.name}:${f.size}:${f.lastModified}`));
    if (next.length === 0) {
      return;
    }
    this.queuedFiles.update((q) => [...q, ...next]);
  }

  removeQueuedFile(index: number) {
    this.queuedFiles.update((q) => q.filter((_, i) => i !== index));
  }

  clearQueuedFiles() {
    this.queuedFiles.set([]);
    if (typeof document !== 'undefined') {
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement | null;
      if (fileInput) {
        fileInput.value = '';
      }
    }
  }

  async uploadQueuedFiles() {
    const store = this.selectedStore();
    const files = this.queuedFiles();
    if (!store || files.length === 0 || this.isUploadingFile()) {
      return;
    }

    this.isUploadingFile.set(true);
    this.error.set(null);
    try {
      const uploaded = await this.vectorStoresService.uploadFiles(store.id, files);

      if (uploaded.length > 0) {
        const existingIds = new Set(this.storeFiles().map((f) => f.id));
        this.storeFiles.update((current) => [
          ...uploaded.filter((f) => !existingIds.has(f.id)),
          ...current,
        ]);
      }

      this.clearQueuedFiles();

      // Re-fetch files + stores after a short delay so new items & counts appear even if indexing is still in progress.
      setTimeout(() => {
        this.loadStoreFiles(store.id, false);
        this.loadVectorStores(false);
        this.startPollingIfNeeded();
      }, 750);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to upload file');
    } finally {
      this.isUploadingFile.set(false);
    }
  }

  private hasInProgressFiles(): boolean {
    return this.storeFiles().some((f) => f.status === 'in_progress');
  }

  private hasInProgressWork(): boolean {
    const store = this.selectedStore();
    const countInProgress = store?.file_counts?.in_progress ?? 0;
    return this.hasInProgressFiles() || countInProgress > 0;
  }

  private startPollingIfNeeded() {
    if (typeof window === 'undefined') {
      return;
    }

    const store = this.selectedStore();
    if (!store) {
      this.stopPolling();
      return;
    }

    if (!this.hasInProgressWork()) {
      this.stopPolling();
      return;
    }

    if (this.pollIntervalId) {
      return;
    }

    this.isPolling.set(true);
    this.pollIntervalId = setInterval(() => this.pollOnce(), 3000);
    this.pollOnce();
  }

  private stopPolling() {
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
    this.isPolling.set(false);
  }

  private async pollOnce() {
    const store = this.selectedStore();
    if (!store || this.pollInFlight) {
      return;
    }

    this.pollInFlight = true;
    try {
      await this.loadStoreFiles(store.id, false);
      await this.loadVectorStores(false);
    } finally {
      this.pollInFlight = false;
      if (!this.hasInProgressWork()) {
        this.stopPolling();
      }
    }
  }

  private syncSelectedStoreFromList(stores: VectorStore[]) {
    const selected = this.selectedStore();
    if (!selected) {
      return;
    }
    const latest = stores.find((s) => s.id === selected.id);
    if (latest) {
      this.selectedStore.set(latest);
    }
  }

  async deleteFile(fileId: string) {
    if (!confirm('Are you sure you want to remove this file from the vector store?')) {
      return;
    }

    const store = this.selectedStore();
    if (!store) {
      return;
    }

    this.isLoading.set(true);
    this.error.set(null);
    try {
      await this.vectorStoresService.deleteFile(store.id, fileId);
      await this.loadStoreFiles(store.id);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to delete file');
    } finally {
      this.isLoading.set(false);
    }
  }

  async deleteStore(storeId: string) {
    if (!confirm('Are you sure you want to delete this vector store? This action cannot be undone.')) {
      return;
    }

    this.isLoading.set(true);
    this.error.set(null);
    try {
      await this.vectorStoresService.deleteVectorStore(storeId);
      this.vectorStores.update(stores => stores.filter(s => s.id !== storeId));
      if (this.selectedStore()?.id === storeId) {
        this.selectedStore.set(null);
        this.storeFiles.set([]);
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to delete vector store');
    } finally {
      this.isLoading.set(false);
    }
  }

  formatDate(timestamp: number): string {
    return new Date(timestamp * 1000).toLocaleString();
  }

  formatBytes(bytes?: number): string {
    if (!bytes || bytes <= 0) {
      return '';
    }
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    const display = unitIndex === 0 ? `${Math.round(value)}` : value.toFixed(1);
    return `${display} ${units[unitIndex]}`;
  }

  getStatusColor(status: string): string {
    switch (status) {
      case 'completed':
        return 'text-green-600 dark:text-green-400';
      case 'in_progress':
        return 'text-yellow-600 dark:text-yellow-400';
      case 'failed':
        return 'text-red-600 dark:text-red-400';
      default:
        return 'text-gray-600 dark:text-gray-400';
    }
  }
}

