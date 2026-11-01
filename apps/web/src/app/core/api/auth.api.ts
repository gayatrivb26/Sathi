import { HttpClient, HttpContext } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import {
  GuardianConsentInfo,
  GuardianDecision,
  LoginRequest,
  Me,
  PreferencesUpdate,
  ProfileUpdate,
  RegisterRequest,
  StaffInvitePreview,
} from '../models/api.models';
import { SILENT_ERROR, SKIP_AUTH_REDIRECT } from '../http/http-context';

const quiet = () => new HttpContext().set(SKIP_AUTH_REDIRECT, true).set(SILENT_ERROR, true);

/** contracts.md §5.1, §11.2 (staff invites), §11.3 (profile), §11.4 (guardian consent). */
@Injectable({ providedIn: 'root' })
export class AuthApi {
  private readonly http = inject(HttpClient);

  csrf(): Observable<void> {
    return this.http.get<void>('/api/v1/auth/csrf', { context: quiet() });
  }
  me(): Observable<Me> {
    return this.http.get<Me>('/api/v1/auth/me', { context: quiet() });
  }
  register(body: RegisterRequest): Observable<{ message: string }> {
    return this.http.post<{ message: string }>('/api/v1/auth/register', body, { context: quiet() });
  }
  verifyEmail(userId: string, token: string): Observable<void> {
    return this.http.post<void>('/api/v1/auth/verify-email', { userId, token }, { context: quiet() });
  }
  resendVerification(email: string): Observable<void> {
    return this.http.post<void>('/api/v1/auth/resend-verification', { email }, { context: quiet() });
  }
  login(body: LoginRequest): Observable<Me> {
    return this.http.post<Me>('/api/v1/auth/login', body, { context: quiet() });
  }
  logout(): Observable<void> {
    return this.http.post<void>('/api/v1/auth/logout', {}, { context: quiet() });
  }
  forgotPassword(email: string): Observable<void> {
    return this.http.post<void>('/api/v1/auth/forgot-password', { email }, { context: quiet() });
  }
  resetPassword(email: string, token: string, newPassword: string): Observable<void> {
    return this.http.post<void>('/api/v1/auth/reset-password', { email, token, newPassword }, { context: quiet() });
  }
  updatePreferences(body: PreferencesUpdate): Observable<Me> {
    return this.http.put<Me>('/api/v1/me/preferences', body);
  }
  updateProfile(body: ProfileUpdate): Observable<Me> {
    return this.http.put<Me>('/api/v1/me/profile', body, { context: new HttpContext().set(SILENT_ERROR, true) });
  }

  // §11.2 staff invites
  staffInvite(token: string): Observable<StaffInvitePreview> {
    return this.http.get<StaffInvitePreview>(`/api/v1/auth/staff-invites/${encodeURIComponent(token)}`, { context: quiet() });
  }
  acceptStaffInvite(token: string): Observable<Me> {
    return this.http.post<Me>(`/api/v1/auth/staff-invites/${encodeURIComponent(token)}/accept`, {}, { context: new HttpContext().set(SILENT_ERROR, true) });
  }

  // §11.4 guardian consent
  resendGuardianConsent(email: string): Observable<void> {
    return this.http.post<void>('/api/v1/auth/resend-guardian-consent', { email }, { context: quiet() });
  }
  guardianConsent(token: string): Observable<GuardianConsentInfo> {
    return this.http.get<GuardianConsentInfo>(`/api/v1/guardian-consent/${encodeURIComponent(token)}`, { context: quiet() });
  }
  decideGuardianConsent(token: string, decision: GuardianDecision): Observable<void> {
    return this.http.post<void>(`/api/v1/guardian-consent/${encodeURIComponent(token)}`, { decision }, { context: quiet() });
  }

  deleteMe(password: string): Observable<void> {
    return this.http.delete<void>('/api/v1/me', { body: { password }, context: new HttpContext().set(SILENT_ERROR, true) });
  }
}
