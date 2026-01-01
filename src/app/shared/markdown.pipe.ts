import { Pipe, PipeTransform, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

@Pipe({
  name: 'markdown',
  standalone: true,
  pure: true,
})
export class MarkdownPipe implements PipeTransform {
  private readonly sanitizer = inject(DomSanitizer);
  private readonly cache = new Map<string, SafeHtml>();

  transform(value: string | null | undefined): SafeHtml {
    const text = value ?? '';
    const cached = this.cache.get(text);
    if (cached) {
      return cached;
    }

    const rendered = this.render(text);
    if (this.cache.size > 200) {
      this.cache.clear();
    }
    this.cache.set(text, rendered);
    return rendered;
  }

  private render(text: string): SafeHtml {
    if (typeof window === 'undefined') {
      const escaped = this.escapeHtml(text).replace(/\n/g, '<br />');
      return this.sanitizer.bypassSecurityTrustHtml(escaped);
    }

    const rawHtml = marked.parse(text, { gfm: true, breaks: true }) as string;
    const cleanHtml = DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } });
    return this.sanitizer.bypassSecurityTrustHtml(cleanHtml);
  }

  private escapeHtml(input: string): string {
    return input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}


