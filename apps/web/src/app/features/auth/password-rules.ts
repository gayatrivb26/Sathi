import { AbstractControl, ValidationErrors } from '@angular/forms';

/** Password policy (contracts.md §5.1): min 10 chars, at least one letter and one digit. */
export function passwordRules(pw: string): { label: string; ok: boolean }[] {
  return [
    { label: 'At least 10 characters', ok: pw.length >= 10 },
    { label: 'At least one letter', ok: /\p{L}/u.test(pw) },
    { label: 'At least one number', ok: /\d/.test(pw) },
  ];
}

export function passwordPolicyValidator(control: AbstractControl): ValidationErrors | null {
  const v = String(control.value ?? '');
  return passwordRules(v).every((r) => r.ok) ? null : { passwordPolicy: true };
}
