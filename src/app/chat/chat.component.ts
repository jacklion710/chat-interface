import { Component, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService, AssistantCitation } from './chat.service';
import { MarkdownPipe } from '../shared/markdown.pipe';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  citations?: AssistantCitation[];
}

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule, MarkdownPipe],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.css'
})
export class ChatComponent {
  messages = signal<Message[]>([]);
  inputMessage = signal('');
  isLoading = signal(false);
  error = signal<string | null>(null);
  vectorStores = signal<Array<{ id: string; name?: string }>>([]);
  selectedVectorStoreId = signal<string>(''); // '' means none
  activeCitation = signal<AssistantCitation | null>(null);
  activeCitationUrl = signal<SafeResourceUrl | null>(null);

  constructor(private chatService: ChatService, private sanitizer: DomSanitizer) {
    effect(() => {
      if (this.messages().length === 0) {
        this.scrollToBottom();
      }
    });

    this.loadVectorStores();
  }

  async loadVectorStores() {
    try {
      const stores = await this.chatService.listVectorStores();
      this.vectorStores.set(stores);
    } catch (err) {
      console.error('Failed to load vector stores:', err);
    }
  }

  onVectorStoreChange(value: string) {
    this.selectedVectorStoreId.set(value);
    this.chatService.setVectorStore(value ? value : null);
    this.clearChat();
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
      const response = await this.chatService.sendMessage(message, this.messages());
      
      const assistantMessage: Message = {
        role: 'assistant',
        content: response.reply,
        timestamp: new Date(),
        citations: response.citations,
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

  openCitation(citation: AssistantCitation) {
    const vectorStoreId = citation.vectorStoreId || this.selectedVectorStoreId();
    if (!vectorStoreId) {
      this.error.set('Source streaming is not available for this citation.');
      return;
    }

    const fileIdOrVectorStoreFileId = citation.vectorStoreFileId || citation.fileId;
    const url = `/api/vector-stores/${encodeURIComponent(vectorStoreId)}/files/${encodeURIComponent(fileIdOrVectorStoreFileId)}/content`;
    this.activeCitation.set(citation);
    this.activeCitationUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(url));
  }

  closeCitation() {
    this.activeCitation.set(null);
    this.activeCitationUrl.set(null);
  }

  getCitationDownloadUrl(citation: AssistantCitation): string {
    const vectorStoreId = citation.vectorStoreId || this.selectedVectorStoreId();
    if (!vectorStoreId) {
      return '#';
    }

    const fileIdOrVectorStoreFileId = citation.vectorStoreFileId || citation.fileId;
    return `/api/vector-stores/${encodeURIComponent(vectorStoreId)}/files/${encodeURIComponent(fileIdOrVectorStoreFileId)}/content?download=1`;
  }
}

