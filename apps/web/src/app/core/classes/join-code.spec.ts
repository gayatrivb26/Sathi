import { formatJoinCode, isValidJoinCode, joinCodeMessage, joinCodeProblem, joinLink, normalizeJoinCode, parseEmailList, shareText } from './join-code';

describe('class join codes', () => {
  it('normalises case, spaces and dashes', () => {
    expect(normalizeJoinCode(' mndy-chrt ')).toBe('MNDYCHRT');
    expect(normalizeJoinCode('MNDY CHRT')).toBe('MNDYCHRT');
    expect(normalizeJoinCode(null)).toBe('');
  });

  it('formats as XXXX-XXXX, also while typing', () => {
    expect(formatJoinCode('mndychrt')).toBe('MNDY-CHRT');
    expect(formatJoinCode('MNDY-CHRT')).toBe('MNDY-CHRT');
    expect(formatJoinCode('mndyc')).toBe('MNDY-C');
    expect(formatJoinCode('mnd')).toBe('MND');
    expect(formatJoinCode('MNDYCHRTXX')).toBe('MNDY-CHRT');
  });

  it('validates length and the look-alike-free alphabet', () => {
    expect(joinCodeProblem('')).toBe('empty');
    expect(joinCodeProblem('ABC')).toBe('short');
    expect(joinCodeProblem('ABCD-EF2O')).toBe('chars'); // O is not used
    expect(joinCodeProblem('ABCD-EF21')).toBe('chars'); // 1 is not used
    expect(joinCodeProblem('ABCDEFGH2')).toBe('long');
    expect(isValidJoinCode('deep-lab7')).toBe(true);
    expect(joinCodeMessage('chars')).toMatch(/no 0, 1, I or O/);
  });

  it('builds the join link and a share message', () => {
    expect(joinLink('https://sathi.app/', 'deeplab7')).toBe('https://sathi.app/join?code=DEEP-LAB7');
    const text = shareText({ className: 'Lab group A', courseTitle: 'Deep Learning Lab', code: 'DEEPLAB7', origin: 'https://sathi.app' });
    expect(text).toContain('“Lab group A” (Deep Learning Lab)');
    expect(text).toContain('https://sathi.app/join?code=DEEP-LAB7');
    expect(text).toContain('enter the code DEEP-LAB7');
  });
});

describe('pasted email lists', () => {
  it('splits on commas, semicolons, spaces and new lines, de-duplicates case-insensitively', () => {
    const r = parseEmailList('asha@school.in, Rahul@School.in;rahul@school.in\npriya@school.in  ');
    expect(r.valid).toEqual(['asha@school.in', 'Rahul@School.in', 'priya@school.in']);
    expect(r.invalid).toEqual([]);
  });

  it('understands "Name <email>" and reports broken addresses', () => {
    const r = parseEmailList('Asha Verma <asha@school.in>, bad@, @nope.in, x@y');
    expect(r.valid).toEqual(['asha@school.in']);
    expect(r.invalid).toEqual(['bad@', '@nope.in', 'x@y']);
  });
});
