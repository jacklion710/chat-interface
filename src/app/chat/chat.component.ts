import { Component, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from './chat.service';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.css'
})
export class ChatComponent {
  messages = signal<Message[]>([]);
  inputMessage = signal('');
  isLoading = signal(false);
  error = signal<string | null>(null);

  constructor(private chatService: ChatService) {
    effect(() => {
      if (this.messages().length === 0) {
        this.scrollToBottom();
      }
    });
  }

  async sendMessage() {
    const message = this.inputMessage().trim();
    if (!message || this.isLoading()) {
      return;
    }

    const userMessage: Message = {
      role: 'user',
      content: message,
      timestamp: new Date()
    };

    this.messages.update(msgs => [...msgs, userMessage]);
    this.inputMessage.set('');
    this.error.set(null);
    this.isLoading.set(true);

    try {
      const response = await this.chatService.sendMessage(this.messages());
      
      const assistantMessage: Message = {
        role: 'assistant',
        content: response,
        timestamp: new Date()
      };

      this.messages.update(msgs => [...msgs, assistantMessage]);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to send message');
      console.error('Error sending message:', err);
    } finally {
      this.isLoading.set(false);
      setTimeout(() => this.scrollToBottom(), 100);
    }
  }

  onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  onInput(event: Event) {
    const textarea = event.target as HTMLTextAreaElement;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }

  scrollToBottom() {
    if (typeof document === 'undefined') {
      return;
    }
    setTimeout(() => {
      const chatContainer = document.querySelector('.chat-messages');
      if (chatContainer) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }
    }, 0);
  }

  clearChat() {
    this.messages.set([]);
    this.error.set(null);
  }
}

