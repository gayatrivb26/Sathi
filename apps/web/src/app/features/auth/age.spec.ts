import { ageBand, ageOn, isoDate, parseIsoDate } from './age';

const on = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
};

describe('age rules (contracts.md §11.4)', () => {
  it('counts whole years and treats the birthday itself as the new age', () => {
    expect(ageOn('2008-10-22', on('2026-10-22'))).toBe(18);
    expect(ageOn('2008-10-23', on('2026-10-22'))).toBe(17);
    expect(ageOn('2008-11-01', on('2026-10-22'))).toBe(17);
  });

  it('handles 29 February birthdays', () => {
    expect(ageOn('2008-02-29', on('2026-02-28'))).toBe(17);
    expect(ageOn('2008-02-29', on('2026-03-01'))).toBe(18);
  });

  it('bands learners: too young (< 8), minor (< 18), adult', () => {
    const today = on('2026-10-22');
    expect(ageBand('2019-01-01', today)).toBe('too-young');
    expect(ageBand('2018-10-22', today)).toBe('minor'); // exactly 8
    expect(ageBand('2012-03-14', today)).toBe('minor');
    expect(ageBand('2008-10-22', today)).toBe('adult');
    expect(ageBand('1990-05-01', today)).toBe('adult');
  });

  it('rejects impossible and future dates', () => {
    expect(parseIsoDate('2010-02-30')).toBeNull();
    expect(parseIsoDate('22/10/2010')).toBeNull();
    expect(ageBand('2010-13-01', on('2026-10-22'))).toBe('invalid');
    expect(ageBand('2027-01-01', on('2026-10-22'))).toBe('future');
    expect(ageBand('1800-01-01', on('2026-10-22'))).toBe('invalid');
  });

  it('formats a local date for the date input', () => {
    expect(isoDate(on('2026-03-05'))).toBe('2026-03-05');
  });
});
