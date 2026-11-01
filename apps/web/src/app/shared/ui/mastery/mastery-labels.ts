import { ConceptMastery } from '../../../core/models/api.models';

/**
 * A concept with `attempts === 0` only has the starting estimate (e.g. 30 %), not a measured score,
 * so the UI says "Not practised yet" instead of showing a percentage.
 */
export function isPractised(m: Pick<ConceptMastery, 'attempts'> | null | undefined): boolean {
  return !!m && m.attempts > 0;
}

/** Practised concepts, weakest first. */
export function weakestPractised(list: ConceptMastery[]): ConceptMastery[] {
  return list.filter((m) => isPractised(m) && m.needsWork).sort((a, b) => a.mastery - b.mastery);
}

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export interface PracticeRecommendation {
  kind: 'weakest' | 'untried' | 'refresh';
  title: string;
  text: string;
}

/**
 * Copy for the "Recommended for you" card. Only claims "weakest topics first" when the student has
 * practised topics that need work; otherwise it talks about topics they haven't tried yet.
 */
export function practiceRecommendation(mastery: ConceptMastery[], concepts: { id: string; name: string }[]): PracticeRecommendation {
  const weak = weakestPractised(mastery);
  if (weak.length) {
    return {
      kind: 'weakest',
      title: 'Mixed practice · weakest topics first',
      text: `8 questions, starting with ${joinNames(weak.slice(0, 2).map((m) => m.name))}. About 6 minutes.`,
    };
  }
  const practised = new Set(mastery.filter(isPractised).map((m) => m.conceptId));
  const untried = concepts.filter((c) => !practised.has(c.id));
  if (untried.length) {
    return {
      kind: 'untried',
      title: 'Mixed practice · topics you haven’t tried yet',
      text: `8 questions from ${untried.length > 2 ? `${untried[0].name}, ${untried[1].name} and more` : joinNames(untried.map((c) => c.name))} — a quick way to find your starting point. About 6 minutes.`,
    };
  }
  return {
    kind: 'refresh',
    title: 'Mixed practice · keep it fresh',
    text: '8 questions across your course to keep your strong topics strong. About 6 minutes.',
  };
}
