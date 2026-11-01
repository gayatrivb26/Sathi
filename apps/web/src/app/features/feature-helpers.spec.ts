import { scrubMessage, scrubUrl } from '../core/errors/client-error-reporter.service';
import { passwordRules } from './auth/password-rules';
import { greeting } from './home/home.component';
import { formatBytes, stageText, validateFile } from './notes/file-rules';
import { basisSentence } from './tutor/source-list.component';
import { confidenceLabel } from './teach/grading-queue.component';

describe('notes file rules', () => {
  it('accepts PDF, Word, Markdown and text under 25 MB', () => {
    for (const name of ['a.pdf', 'b.docx', 'c.md', 'd.txt', 'E.PDF']) expect(validateFile({ name, size: 1000 })).toBeNull();
  });
  it('rejects other types, empty and oversized files with friendly reasons', () => {
    expect(validateFile({ name: 'slides.pptx', size: 10 })).toMatch(/Export them as PDF/);
    expect(validateFile({ name: 'old.doc', size: 10 })).toMatch(/\.docx/);
    expect(validateFile({ name: 'x.exe', size: 10 })).toMatch(/isn’t supported/);
    expect(validateFile({ name: 'a.pdf', size: 0 })).toMatch(/empty/);
    expect(validateFile({ name: 'a.pdf', size: 26 * 1024 * 1024 })).toMatch(/25 MB/);
  });
  it('describes each processing stage like the design', () => {
    expect(stageText({ stage: 'ready', status: 'ready', progressPercent: 100, passageCount: 42, errorCode: null })).toBe('Ready · 42 passages');
    expect(stageText({ stage: 'indexing', status: 'processing', progressPercent: 70, passageCount: null, errorCode: null })).toBe('Creating search index · 70%');
    expect(stageText({ stage: 'parsing', status: 'processing', progressPercent: 30, passageCount: null, errorCode: null })).toBe('Reading your file · 30%');
    expect(stageText({ stage: 'failed', status: 'failed', progressPercent: 30, passageCount: null, errorCode: 'INGEST_NO_TEXT' })).toBe('Could not read text');
  });
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2_480_000)).toBe('2.4 MB');
  });
});

describe('client error scrubbing', () => {
  it('never sends emails, quoted text or query strings', () => {
    const m = scrubMessage('Failed for asha@example.com with "my secret answer" at /x?token=abc');
    expect(m).not.toContain('asha@example.com');
    expect(m).not.toContain('secret answer');
    expect(m).not.toContain('token=abc');
    expect(scrubUrl('/auth/reset-password?email=a@b.c&token=t')).toBe('/auth/reset-password');
  });
  it('limits messages to 300 characters', () => {
    expect(scrubMessage('x'.repeat(1000)).length).toBe(300);
  });
});

describe('small helpers', () => {
  it('builds the answer basis sentence', () => {
    expect(basisSentence(['course', 'web'])).toBe('Answered from: your course and the web');
    expect(basisSentence(['upload', 'course', 'web'])).toBe('Answered from: your notes, your course and the web');
    expect(basisSentence([])).toBe('');
  });
  it('greets by time of day', () => {
    expect(greeting(8)).toBe('Good morning');
    expect(greeting(14)).toBe('Good afternoon');
    expect(greeting(20)).toBe('Good evening');
  });
  it('checks the password policy', () => {
    expect(passwordRules('abc').every((r) => r.ok)).toBe(false);
    expect(passwordRules('learning2025').every((r) => r.ok)).toBe(true);
  });
  it('labels grading confidence', () => {
    expect(confidenceLabel(0.41)).toBe('Low confidence');
    expect(confidenceLabel(0.66)).toBe('Medium confidence');
    expect(confidenceLabel(0.9)).toBe('High confidence');
  });
});
