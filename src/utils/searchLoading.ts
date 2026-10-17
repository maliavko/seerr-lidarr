// How the search page loads page by page and reads its type (F2-D-71): pure
// helpers, so that each can fail a test. useDiscover calls the first one where
// its option endByPageCount is on (the search page only); every other page
// that loads page by page keeps the hook's own end-of-results test.
import type { KindShown } from '@server/lib/kindsShown';

// The least number of titles a load must add before the next page is left to
// the scroll.
export const MIN_TITLES_PER_LOAD = 20;

export const SEARCH_TYPES: readonly KindShown[] = [
  'movie',
  'tv',
  'music',
  'person',
];

interface PageOfResults {
  page: number;
  totalPages: number;
}

// The end of the results is reached once the last page loaded is the last page
// by the source's page count: never a short or an empty page, never totalResults.
export const isEndByPageCount = (
  pages: readonly (PageOfResults | undefined)[] | undefined
): boolean => {
  const last = pages?.[pages.length - 1];

  return !!last && last.page >= last.totalPages;
};

// What the search page's load-on keeps between renders (F2-D-71): the list it
// belongs to, the titles shown when the current run began and when the last
// load settled, the number of pages that settled load had (each settled load
// is read once) and the size the helper last asked for a load-on.
export interface LoadMark {
  key: string;
  runStart: number;
  lastSettled: number;
  pagesRead: number;
  asked?: number;
}

export const newLoadMark = (key = ''): LoadMark => ({
  key,
  runStart: 0,
  lastSettled: 0,
  pagesRead: 0,
});

interface LoadStepInput {
  // the list's key: the endpoint and its options
  key: string;
  // the hook's size, in pages
  size: number;
  // the pages as loaded, a page not yet loaded as undefined
  pages: readonly (PageOfResults | undefined)[] | undefined;
  // the titles shown
  titles: number;
  // whether a load is outstanding (or the list failed)
  outstanding: boolean;
  mark: LoadMark;
}

// One step of the load-on, from what the hook has at a render to the mark it
// keeps and the size to set, if any. A run is the first load or a load a
// scroll asked, with the pages loaded on after it, and its 20 titles are
// counted over the whole run: from 0 at the first load, from the titles shown
// before it for a load a scroll asked.
export const searchLoadStep = ({
  key,
  size,
  pages,
  titles,
  outstanding,
  mark,
}: LoadStepInput): { mark: LoadMark; size?: number } => {
  const current = mark.key === key ? mark : newLoadMark(key);

  if (
    outstanding ||
    !pages ||
    pages.length === 0 ||
    pages.length === current.pagesRead
  ) {
    return { mark: current };
  }

  // this load is the helper's own load-on where its size is the one asked
  const ownLoadOn = current.asked !== undefined && size === current.asked;
  const runStart = ownLoadOn ? current.runStart : current.lastSettled;
  const loadOn =
    !isEndByPageCount(pages) && titles - runStart < MIN_TITLES_PER_LOAD;
  const settled = {
    key,
    runStart,
    lastSettled: titles,
    pagesRead: pages.length,
  };

  return loadOn
    ? { mark: { ...settled, asked: size + 1 }, size: size + 1 }
    : { mark: settled };
};

// The type the search page sends: ?type= where it is movie, tv, music or person
// and among the kinds shown, otherwise none (All).
export const readSearchType = (
  value: string | string[] | undefined,
  kindsShown: readonly string[]
): KindShown | undefined =>
  typeof value === 'string' &&
  (SEARCH_TYPES as readonly string[]).includes(value) &&
  kindsShown.includes(value)
    ? (value as KindShown)
    : undefined;

// The address a press of a pill pushes: the page's query kept and type set, or
// removed for All.
export const searchTypeQuery = (
  query: Record<string, string | string[] | undefined>,
  type: KindShown | undefined
): Record<string, string | string[] | undefined> => {
  const rest = { ...query };
  delete rest.type;

  return type ? { ...rest, type } : rest;
};

// The address a new search typed on /search replaces the page's with, whole:
// the page's pathname and query with the new text and no type, so that the
// search starts on All.
export const newSearchAddress = (
  address: {
    pathname: string;
    query: Record<string, string | string[] | undefined>;
  },
  text: string
): {
  pathname: string;
  query: Record<string, string | string[] | undefined>;
} => ({
  pathname: address.pathname,
  query: { ...searchTypeQuery(address.query, undefined), query: text },
});
