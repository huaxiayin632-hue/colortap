import type { Project } from '../shared/models';

/** Published documents share untouched sections. Consumers only watch the parts they use. */
export function sameProjectParts(
  a: Project | null | undefined,
  b: Project,
  keys: readonly (keyof Project)[],
): boolean {
  return !!a && a.id === b.id && keys.every((key) => a[key] === b[key]);
}

/** Equality for plain project data, without serializing large unchanged branches. */
export function equalData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  return (
    keys.length === Object.keys(right).filter((key) => right[key] !== undefined).length &&
    keys.every((key) => equalData(left[key], right[key]))
  );
}
