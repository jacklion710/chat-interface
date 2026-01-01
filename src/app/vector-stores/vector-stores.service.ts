import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { VectorStore, VectorStoreFile } from './vector-stores.component';

@Injectable({
  providedIn: 'root'
})
export class VectorStoresService {
  private http = inject(HttpClient);
  private baseUrl = '/api/vector-stores';

  async listVectorStores(): Promise<VectorStore[]> {
    try {
      const response = await firstValueFrom(
        this.http.get<{ data: VectorStore[] }>(this.baseUrl)
      );
      return response.data || [];
    } catch (error: any) {
      console.error('Error listing vector stores:', error);
      throw new Error(
        error?.error?.error?.message ||
          error?.error?.message ||
          (typeof error?.error === 'string' ? error.error : '') ||
          'Failed to list vector stores',
      );
    }
  }

  async createVectorStore(name: string): Promise<VectorStore> {
    try {
      const response = await firstValueFrom(
        this.http.post<VectorStore>(this.baseUrl, { name })
      );
      return response;
    } catch (error: any) {
      console.error('Error creating vector store:', error);
      throw new Error(
        error?.error?.error?.message ||
          error?.error?.message ||
          (typeof error?.error === 'string' ? error.error : '') ||
          'Failed to create vector store',
      );
    }
  }

  async deleteVectorStore(storeId: string): Promise<void> {
    try {
      await firstValueFrom(
        this.http.delete(`${this.baseUrl}/${storeId}`)
      );
    } catch (error: any) {
      console.error('Error deleting vector store:', error);
      throw new Error(
        error?.error?.error?.message ||
          error?.error?.message ||
          (typeof error?.error === 'string' ? error.error : '') ||
          'Failed to delete vector store',
      );
    }
  }

  async listStoreFiles(storeId: string): Promise<VectorStoreFile[]> {
    try {
      const response = await firstValueFrom(
        this.http.get<{ data: VectorStoreFile[] }>(`${this.baseUrl}/${storeId}/files`)
      );
      return response.data || [];
    } catch (error: any) {
      console.error('Error listing store files:', error);
      throw new Error(
        error?.error?.error?.message ||
          error?.error?.message ||
          (typeof error?.error === 'string' ? error.error : '') ||
          'Failed to list files',
      );
    }
  }

  async uploadFiles(storeId: string, files: File[]): Promise<VectorStoreFile[]> {
    try {
      const formData = new FormData();
      for (const file of files) {
        formData.append('files', file);
      }

      const response = await firstValueFrom(
        this.http.post<{ data: VectorStoreFile[] }>(`${this.baseUrl}/${storeId}/files`, formData)
      );
      return response.data || [];
    } catch (error: any) {
      console.error('Error uploading file:', error);
      throw new Error(
        error?.error?.error?.message ||
          error?.error?.message ||
          (typeof error?.error === 'string' ? error.error : '') ||
          'Failed to upload file',
      );
    }
  }

  async deleteFile(storeId: string, fileId: string): Promise<void> {
    try {
      await firstValueFrom(
        this.http.delete(`${this.baseUrl}/${storeId}/files/${fileId}`)
      );
    } catch (error: any) {
      console.error('Error deleting file:', error);
      throw new Error(
        error?.error?.error?.message ||
          error?.error?.message ||
          (typeof error?.error === 'string' ? error.error : '') ||
          'Failed to delete file',
      );
    }
  }
}

