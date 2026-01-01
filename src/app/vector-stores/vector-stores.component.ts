import { Component, signal, effect } from '@angular/core';
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
}

@Component({
  selector: 'app-vector-stores',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './vector-stores.component.html',
  styleUrl: './vector-stores.component.css'
})
export class VectorStoresComponent {
  vectorStores = signal<VectorStore[]>([]);
  selectedStore = signal<VectorStore | null>(null);
  storeFiles = signal<VectorStoreFile[]>([]);
  isLoading = signal(false);
  error = signal<string | null>(null);
  newStoreName = signal('');
  isCreatingStore = signal(false);
  isUploadingFile = signal(false);
  selectedFile: File | null = null;

  constructor(private vectorStoresService: VectorStoresService) {
    this.loadVectorStores();
  }

  async loadVectorStores() {
    this.isLoading.set(true);
    this.error.set(null);
    try {
      const stores = await this.vectorStoresService.listVectorStores();
      this.vectorStores.set(stores);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load vector stores');
    } finally {
      this.isLoading.set(false);
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
    await this.loadStoreFiles(store.id);
  }

  async loadStoreFiles(storeId: string) {
    this.isLoading.set(true);
    this.error.set(null);
    try {
      const files = await this.vectorStoresService.listStoreFiles(storeId);
      this.storeFiles.set(files);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load files');
    } finally {
      this.isLoading.set(false);
    }
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.selectedFile = input.files[0];
    }
  }

  async uploadFile() {
    const store = this.selectedStore();
    if (!store || !this.selectedFile || this.isUploadingFile()) {
      return;
    }

    this.isUploadingFile.set(true);
    this.error.set(null);
    try {
      await this.vectorStoresService.uploadFile(store.id, this.selectedFile);
      await this.loadStoreFiles(store.id);
      this.selectedFile = null;
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      if (fileInput) {
        fileInput.value = '';
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to upload file');
    } finally {
      this.isUploadingFile.set(false);
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

