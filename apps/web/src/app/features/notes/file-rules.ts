import { DocumentItem } from '../../core/models/api.models';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // contracts.md §5.5
export const ACCEPT = '.pdf,.docx,.md,.markdown,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain';
const ALLOWED_EXT = ['pdf', 'docx', 'md', 'markdown', 'txt'];

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Client-side pre-check (the server re-validates type, magic bytes and size). Returns an error or null. */
export function validateFile(file: { name: string; size: number }): string | null {
  const ext = extOf(file.name);
  if (!ALLOWED_EXT.includes(ext)) {
    if (ext === 'doc') return 'Old Word (.doc) files aren’t supported. Save it as .docx or PDF and try again.';
    if (ext === 'pptx' || ext === 'ppt') return 'Slides aren’t supported yet. Export them as PDF and try again.';
    return 'That file type isn’t supported. Use PDF, Word (.docx), Markdown or text.';
  }
  if (file.size === 0) return 'This file is empty.';
  if (file.size > MAX_UPLOAD_BYTES) return `This file is ${formatBytes(file.size)} — the limit is 25 MB.`;
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

const FAILED_TEXT: Record<string, string> = {
  INGEST_NO_TEXT: 'Could not read text',
  INGEST_PARSE_FAILED: 'Could not open the file',
  INGEST_UNSUPPORTED_TYPE: 'Unsupported file',
  INGEST_INDEX_FAILED: 'Could not index the file',
};

/** "Ready · 42 passages", "Creating search index · 70%", … */
export function stageText(d: Pick<DocumentItem, 'stage' | 'status' | 'progressPercent' | 'passageCount' | 'errorCode'>): string {
  switch (d.stage) {
    case 'queued':
      return 'Queued · starting soon';
    case 'parsing':
      return `Reading your file · ${d.progressPercent}%`;
    case 'indexing':
      return `Creating search index · ${d.progressPercent}%`;
    case 'ready':
      return `Ready · ${d.passageCount ?? 0} passage${d.passageCount === 1 ? '' : 's'}`;
    case 'failed':
      return FAILED_TEXT[d.errorCode ?? ''] ?? 'Processing failed';
  }
}

export function isTerminal(d: Pick<DocumentItem, 'status'>): boolean {
  return d.status === 'ready' || d.status === 'failed';
}
