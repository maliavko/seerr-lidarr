// The type last chosen by a pill press, kept for the browser tab (F2-D-341):
// one sessionStorage key, and two pure helpers over a storage they are handed,
// so that each can fail a test.
import type { KindShown } from '@server/lib/kindsShown';
import { SEARCH_TYPES } from './searchLoading';

export const KEPT_SEARCH_TYPE_KEY = 'seerr.search.type';

type KeptStorage = Pick<Storage, 'getItem' | 'setItem'>;

// A press of a pill records the type chosen for the tab: the type, or 'all'
// for All. A storage that throws or is missing records nothing.
export const recordKeptSearchType = (
  storage: KeptStorage | null | undefined,
  type: KindShown | undefined
): void => {
  try {
    storage?.setItem(KEPT_SEARCH_TYPE_KEY, type ?? 'all');
  } catch {
    // nothing is kept
  }
};

// What is kept: movie, tv, music or person as stored, else nothing (All) - for
// 'all', for nothing stored, for any other value, and for a storage that
// throws or is missing.
export const readKeptSearchType = (
  storage: KeptStorage | null | undefined
): KindShown | undefined => {
  try {
    const value = storage?.getItem(KEPT_SEARCH_TYPE_KEY);

    return (SEARCH_TYPES as readonly (string | null | undefined)[]).includes(
      value
    )
      ? (value as KindShown)
      : undefined;
  } catch {
    return undefined;
  }
};

// The tab's own storage, nothing where the browser gives none or refuses it.
export const tabStorage = (): KeptStorage | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
};
