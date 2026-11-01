import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { staffNavFor } from '../../layout/shell.component';
import { roleLockReason, sameRoles, statusPills } from '../../features/admin/roles';
import { AdminUser, ConceptMastery } from '../../core/models/api.models';
import { AutosizeDirective, autosizeHeight } from './autosize/autosize.directive';
import { isPractised, practiceRecommendation } from './mastery/mastery-labels';

describe('composer autosize', () => {
  const base = { lineHeight: 23, paddingY: 24, borderY: 0, minRows: 3, maxHeight: 220 };

  it('starts at three lines', () => {
    expect(autosizeHeight({ ...base, scrollHeight: 47 })).toEqual({ height: 93, scroll: false });
  });
  it('grows with the content', () => {
    expect(autosizeHeight({ ...base, scrollHeight: 162 })).toEqual({ height: 162, scroll: false });
  });
  it('stops at the maximum (~8 lines) and scrolls', () => {
    expect(autosizeHeight({ ...base, scrollHeight: 600 })).toEqual({ height: 220, scroll: true });
  });

  @Component({
    imports: [AutosizeDirective],
    template: `<textarea [appAutosize]="value()" [minRows]="3" [maxHeight]="220" style="line-height: 20px; padding: 10px 0; border: 0"></textarea>`,
  })
  class Host {
    value = signal('');
  }

  it('sizes the textarea element and switches on scrolling past the cap', async () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const f = TestBed.createComponent(Host);
    await f.whenStable();
    const ta = (f.nativeElement as HTMLElement).querySelector('textarea')!;
    let scrollHeight = 40;
    Object.defineProperty(ta, 'scrollHeight', { get: () => scrollHeight });
    ta.dispatchEvent(new Event('input'));
    expect(ta.style.height).toBe('80px'); // 3 × 20 + 20 padding
    expect(ta.style.overflowY).toBe('hidden');
    scrollHeight = 900;
    ta.dispatchEvent(new Event('input'));
    expect(ta.style.height).toBe('220px');
    expect(ta.style.overflowY).toBe('auto');
    expect(ta.getAttribute('rows')).toBe('3');
  });
});

describe('attempts-based mastery labels', () => {
  const m = (conceptId: string, mastery: number, attempts: number): ConceptMastery => ({ conceptId, name: conceptId.toUpperCase(), mastery, attempts, needsWork: mastery < 0.5 });
  const concepts = [{ id: 'a', name: 'Attention' }, { id: 'b', name: 'Backprop' }, { id: 'c', name: 'Chunking' }];

  it('treats attempts === 0 as not practised (the 30 % is only a starting estimate)', () => {
    expect(isPractised(m('a', 0.3, 0))).toBe(false);
    expect(isPractised(m('a', 0.3, 1))).toBe(true);
    expect(isPractised(null)).toBe(false);
  });

  it('says "weakest topics first" only when practised topics need work', () => {
    const r = practiceRecommendation([m('a', 0.35, 3), m('b', 0.42, 7), m('c', 0.3, 0)], concepts);
    expect(r.kind).toBe('weakest');
    expect(r.title).toContain('weakest topics first');
    expect(r.text).toContain('A and B');
  });

  it('talks about untried topics when nothing practised is weak', () => {
    const r = practiceRecommendation([m('a', 0.3, 0), m('b', 0.3, 0), m('c', 0.3, 0)], concepts);
    expect(r.kind).toBe('untried');
    expect(r.title).toBe('Mixed practice · topics you haven’t tried yet');
    expect(r.title).not.toContain('weakest');
    expect(r.text).toContain('from Attention, Backprop and more');
  });

  it('falls back to keeping things fresh when everything is practised and strong', () => {
    expect(practiceRecommendation([m('a', 0.8, 4), m('b', 0.7, 4), m('c', 0.9, 2)], concepts).kind).toBe('refresh');
  });
});

describe('role-based UI', () => {
  it('shows staff navigation only for staff roles, with Hangfire for admins', () => {
    expect(staffNavFor(['Student'])).toEqual([]);
    expect(staffNavFor(['Student', 'Instructor']).map((n) => n.label)).toEqual(['Teach']);
    const admin = staffNavFor(['Student', 'Instructor', 'Admin']);
    expect(admin.map((n) => n.label)).toEqual(['Teach', 'Admin', 'Hangfire jobs']);
    expect(admin[2]).toMatchObject({ path: '/hangfire', external: true, icon: 'jobs' });
  });

  it('locks the Admin box on your own account and never allows zero roles', () => {
    const me = { id: 'u1', roles: ['Student', 'Admin'] as AdminUser['roles'] };
    expect(roleLockReason('Admin', me, 'u1', ['Student', 'Admin'])).toMatch(/your own Admin role/);
    expect(roleLockReason('Admin', me, 'someone-else', ['Student', 'Admin'])).toBeNull();
    expect(roleLockReason('Student', { id: 'u2', roles: ['Student'] }, 'u1', ['Student'])).toMatch(/at least one role/);
    expect(sameRoles(['Admin', 'Student'], ['Student', 'Admin'])).toBe(true);
  });

  it('describes account status in words', () => {
    const u: AdminUser = { id: 'x', email: 'x@y.in', displayName: 'X', roles: ['Student'], emailConfirmed: false, lockedOut: true, accountStatus: 'pending_guardian', isMinor: true, createdAt: '', lastActiveAt: null };
    expect(statusPills(u).map((p) => p.label)).toEqual(['Waiting for guardian', 'Locked', 'Email not verified', 'Under 18']);
  });
});
