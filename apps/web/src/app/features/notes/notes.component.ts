import { DatePipe } from '@angular/common';
import { HttpEventType } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { forkJoin, interval } from 'rxjs';
import { NotesApi } from '../../core/api/notes.api';
import { ApiError, toApiError } from '../../core/http/api-error';
import { newIdempotencyKey } from '../../core/http/trace';
import { DocumentItem } from '../../core/models/api.models';
import { createLoader } from '../../core/platform/loader';
import { confirmDialog } from '../../shared/ui/dialog/confirm-dialog.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { ReferenceIdComponent } from '../../shared/ui/reference-id/reference-id.component';
import { EmptyStateComponent } from '../../shared/ui/states/empty-state.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';
import { ACCEPT, extOf, formatBytes, isTerminal, stageText, validateFile } from './file-rules';

interface LocalUpload {
  localId: string;
  file: File;
  idemKey: string;
  progress: number;
  error: ApiError | null;
}

const POLL_MS = 2000;

@Component({
  selector: 'app-notes',
  imports: [DatePipe, MatButtonModule, IconComponent, ReferenceIdComponent, SkeletonComponent, ErrorStateComponent, EmptyStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './notes.component.html',
  styleUrl: './notes.component.scss',
})
export default class NotesComponent {
  private readonly api = inject(NotesApi);
  private readonly dialog = inject(MatDialog);

  readonly accept = ACCEPT;
  readonly docs = createLoader(() => this.api.list());
  readonly uploads = signal<LocalUpload[]>([]);
  readonly rejected = signal<{ name: string; reason: string }[]>([]);
  readonly dragging = signal(false);
  readonly announce = signal('');
  readonly retrying = signal<Set<string>>(new Set());

  readonly isEmpty = computed(() => !this.uploads().length && !(this.docs.data()?.length ?? 0));
  readonly pending = computed(() => (this.docs.data() ?? []).filter((d) => !isTerminal(d)));
  readonly stageText = stageText;
  readonly formatBytes = formatBytes;

  constructor() {
    interval(POLL_MS)
      .pipe(takeUntilDestroyed(inject(DestroyRef)))
      .subscribe(() => this.poll());
  }

  // ---------- picking files
  onPick(input: HTMLInputElement): void {
    if (input.files) this.addFiles(Array.from(input.files));
    input.value = '';
  }
  onDragOver(ev: DragEvent): void {
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    this.dragging.set(true);
  }
  onDragLeave(ev: DragEvent): void {
    if (ev.currentTarget === ev.target || !(ev.currentTarget as HTMLElement).contains(ev.relatedTarget as Node)) this.dragging.set(false);
  }
  onDrop(ev: DragEvent): void {
    ev.preventDefault();
    this.dragging.set(false);
    this.addFiles(Array.from(ev.dataTransfer?.files ?? []));
  }

  addFiles(files: File[]): void {
    const bad: { name: string; reason: string }[] = [];
    for (const file of files) {
      const reason = validateFile(file);
      if (reason) {
        bad.push({ name: file.name, reason });
        continue;
      }
      const u: LocalUpload = { localId: newIdempotencyKey(), file, idemKey: newIdempotencyKey(), progress: 0, error: null };
      this.uploads.update((l) => [u, ...l]);
      this.start(u);
    }
    this.rejected.set(bad);
    if (bad.length) this.announce.set(`${bad.length} file${bad.length === 1 ? ' was' : 's were'} not added. ${bad.map((b) => `${b.name}: ${b.reason}`).join(' ')}`);
  }

  private start(u: LocalUpload): void {
    this.patchUpload(u.localId, { progress: 0, error: null });
    this.announce.set(`Uploading ${u.file.name}.`);
    this.api.upload(u.file, u.idemKey).subscribe({
      next: (ev) => {
        if (ev.type === HttpEventType.UploadProgress) {
          this.patchUpload(u.localId, { progress: ev.total ? Math.round((ev.loaded / ev.total) * 100) : 0 });
        } else if (ev.type === HttpEventType.Response && ev.body) {
          const doc = ev.body;
          this.uploads.update((l) => l.filter((x) => x.localId !== u.localId));
          this.docs.update((list) => [doc, ...list.filter((d) => d.id !== doc.id)]);
          if (!this.docs.data()) this.docs.set([doc]);
          this.announce.set(`${u.file.name} uploaded. Processing has started.`);
        }
      },
      error: (e: unknown) => {
        const err = toApiError(e);
        this.patchUpload(u.localId, { error: err });
        this.announce.set(`${u.file.name} couldn’t be uploaded. ${err.userMessage}`);
      },
    });
  }

  retryUpload(u: LocalUpload): void {
    this.start(u); // same Idempotency-Key: a duplicate request can't create two documents
  }
  dismissUpload(u: LocalUpload): void {
    this.uploads.update((l) => l.filter((x) => x.localId !== u.localId));
  }

  // ---------- processing
  private poll(): void {
    const pending = this.pending();
    if (!pending.length) return;
    forkJoin(pending.map((d) => this.api.get(d.id))).subscribe({
      next: (fresh) => {
        for (const f of fresh) {
          const old = this.docs.data()?.find((d) => d.id === f.id);
          if (old && old.status !== f.status) {
            if (f.status === 'ready') this.announce.set(`${f.fileName} is ready: ${f.passageCount} passages.`);
            if (f.status === 'failed') this.announce.set(`${f.fileName} failed. ${f.errorMessage ?? ''} Reference ${f.referenceId ?? ''}.`);
          }
        }
        const map = new Map(fresh.map((f) => [f.id, f]));
        this.docs.update((list) => list.map((d) => map.get(d.id) ?? d));
      },
      error: () => undefined, // transient: try again on the next tick
    });
  }

  retryDoc(d: DocumentItem): void {
    this.retrying.update((s) => new Set(s).add(d.id));
    this.api.retry(d.id).subscribe({
      next: (fresh) => {
        this.docs.update((list) => list.map((x) => (x.id === d.id ? fresh : x)));
        this.announce.set(`Retrying ${d.fileName}.`);
      },
      complete: () => this.clearRetrying(d.id),
      error: () => this.clearRetrying(d.id),
    });
  }
  private clearRetrying(id: string): void {
    this.retrying.update((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  }

  remove(d: DocumentItem): void {
    confirmDialog(this.dialog, {
      title: `Delete “${d.fileName}”?`,
      message: 'The file and its search passages are removed, and the tutor will stop using it. This can’t be undone.',
      confirmText: 'Delete file',
      danger: true,
    }).subscribe((ok) => {
      if (!ok) return;
      this.api.delete(d.id).subscribe(() => {
        this.docs.update((list) => list.filter((x) => x.id !== d.id));
        this.announce.set(`${d.fileName} deleted.`);
      });
    });
  }

  icon(name: string): 'file' | 'notes' {
    return extOf(name) === 'md' || extOf(name) === 'txt' ? 'notes' : 'file';
  }

  private patchUpload(localId: string, patch: Partial<LocalUpload>): void {
    this.uploads.update((l) => l.map((u) => (u.localId === localId ? { ...u, ...patch } : u)));
  }
}
