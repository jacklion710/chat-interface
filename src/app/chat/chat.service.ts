import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Message } from './chat.component';

interface OpenAIRequest {
  model: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
  }>;
  stream?: boolean;
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
  }>;
}

export interface VectorStoreOption {
  id: string;
  name?: string;
}

export type AssistantCitation = {
  fileId: string;
  vectorStoreId?: string;
  vectorStoreFileId?: string;
  filename?: string;
  bytes?: number;
  quote?: string;
};

export type ChatReply = {
  reply: string;
  citations: AssistantCitation[];
};

@Injectable({
  providedIn: 'root'
})
export class ChatService {
  private http = inject(HttpClient);
  private apiUrl = '/api/chat';
  private assistantsChatUrl = '/api/assistants/chat';
  private vectorStoresUrl = '/api/vector-stores';

  private selectedVectorStoreId: string | null = null;
  private threadId: string | null = null;

  setVectorStore(vectorStoreId: string | null) {
    this.selectedVectorStoreId = vectorStoreId;
    this.threadId = null;
  }

  getVectorStoreId(): string | null {
    return this.selectedVectorStoreId;
  }

  resetThread() {
    this.threadId = null;
  }

  async listVectorStores(): Promise<VectorStoreOption[]> {
    const response = await firstValueFrom(
      this.http.get<{ data: VectorStoreOption[] }>(this.vectorStoresUrl),
    );
    return response.data || [];
  }

  async sendMessage(userPrompt: string, messages: Message[]): Promise<ChatReply> {
    const requestBody: OpenAIRequest = {
      model: 'gpt-3.5-turbo',
      messages: messages.map(msg => ({
        role: msg.role,
        content: msg.content
      }))
    };

    try {
      const vectorStoreId = this.selectedVectorStoreId;
      if (vectorStoreId) {
        const response = await firstValueFrom(
          this.http.post<{
            reply: string;
            threadId: string;
            citations?: Array<{ fileId: string; filename?: string; bytes?: number; quote?: string }>;
          }>(this.assistantsChatUrl, {
            prompt: userPrompt,
            vectorStoreId,
            threadId: this.threadId,
          }),
        );
        this.threadId = response.threadId;
        return { reply: response.reply, citations: response.citations ?? [] };
      }

      const response = await firstValueFrom(
        this.http.post<OpenAIResponse>(this.apiUrl, requestBody, {
          headers: new HttpHeaders({
            'Content-Type': 'application/json'
          })
        })
      );

      if (response.choices && response.choices.length > 0) {
        return { reply: response.choices[0].message.content, citations: [] };
      }

      throw new Error('No response from API');
    } catch (error: any) {
      console.error('Chat service error:', error);
      
      if (error?.status === 429) {
        throw new Error('Rate limit exceeded. Please wait a moment before sending another message.');
      }
      
      if (error?.error?.error) {
        const errorMessage = error.error.error;
        if (typeof errorMessage === 'string') {
          throw new Error(errorMessage);
        }
        if (errorMessage?.message) {
          throw new Error(errorMessage.message);
        }
      }
      
      if (error?.error) {
        if (typeof error.error === 'string') {
          throw new Error(error.error);
        }
        if (error.error?.message) {
          throw new Error(error.error.message);
        }
      }
      
      if (error?.message) {
        throw new Error(error.message);
      }
      
      if (error instanceof Error) {
        throw error;
      }
      
      throw new Error('Failed to communicate with chat service');
    }
  }
}

