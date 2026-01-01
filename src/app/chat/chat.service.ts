import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, firstValueFrom } from 'rxjs';
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

@Injectable({
  providedIn: 'root'
})
export class ChatService {
  private http = inject(HttpClient);
  private apiUrl = '/api/chat';

  async sendMessage(messages: Message[]): Promise<string> {
    const requestBody: OpenAIRequest = {
      model: 'gpt-3.5-turbo',
      messages: messages.map(msg => ({
        role: msg.role,
        content: msg.content
      }))
    };

    try {
      const response = await firstValueFrom(
        this.http.post<OpenAIResponse>(this.apiUrl, requestBody, {
          headers: new HttpHeaders({
            'Content-Type': 'application/json'
          })
        })
      );

      if (response.choices && response.choices.length > 0) {
        return response.choices[0].message.content;
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

