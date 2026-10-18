// What the search page shows, and how it reads its pages (F2-D-341 (a), (b)):
// pure helpers, so that each can fail a test. The page's useDiscover (option
// endByPageCount) tags every page and every error with the address it was
// asked for, keeps only what belongs to the list of the query and type in the
// page's address, and the page shows what searchPageState answers from that
// list alone: an answer that lands for another query or type is never shown
// over, joined to or in place of it, nor brings the no-results state.
import { isEndByPageCount } from './searchLoading';

// A search read gives up after this long without an answer.
export const SEARCH_READ_TIMEOUT_MS = 30000;

// A page of the search as the search page's fetcher gives it: the answer with
// the address it was asked for.
export interface TaggedPage {
  page: number;
  totalPages: number;
  requestedUrl?: string;
}

// The key the search page's list keeps its pages under in SWR's cache: the
// address inside an array, never the address alone, so that a page another
// reader of that address (a home TMDB search slider's, Create Slider's
// preview) holds under the plain address is never the search page's page - it
// is read, and tagged, by the search page's own fetcher (F2-F-1956).
export type SearchListKey = readonly ['search-page-list', string];

export const searchListKey = (url: string): SearchListKey => [
  'search-page-list',
  url,
];

const urlOfKey = (key: string | SearchListKey): string =>
  typeof key === 'string' ? key : key[1];

// The search page's fetcher: reads one address (given as the list's key or as
// the address) through `get` (axios.get's shape) with the timeout, and tags the
// answer, or the error it fails with, with that address.
export const makeSearchFetcher =
  (
    get: (
      url: string,
      config: { timeout: number }
    ) => Promise<{ data: Record<string, unknown> }>,
    timeout = SEARCH_READ_TIMEOUT_MS
  ) =>
  async (
    key: string | SearchListKey
  ): Promise<Record<string, unknown> & TaggedPage> => {
    const url = urlOfKey(key);

    try {
      const response = await get(url, { timeout });

      return { ...response.data, requestedUrl: url } as Record<
        string,
        unknown
      > &
        TaggedPage;
    } catch (e) {
      const error = (
        e !== null && typeof e === 'object' ? e : new Error(String(e))
      ) as { requestedUrl?: string };

      error.requestedUrl = url;
      throw error;
    }
  };

// The pages of the list whose addresses are `expected(0)`, `expected(1)`...:
// the pages as SWR holds them, from the first, up to the first that is missing
// or was asked for another address (another query or type, or a page out of
// its place).
export const pagesOfList = <P extends TaggedPage>(
  pages: readonly (P | undefined)[] | undefined,
  expected: (pageIndex: number) => string
): P[] => {
  const kept: P[] = [];

  for (let i = 0; i < (pages?.length ?? 0); i += 1) {
    const page = pages![i];

    if (!page || page.requestedUrl !== expected(i)) {
      break;
    }

    kept.push(page);
  }

  return kept;
};

// Whether an error is the list's: it was asked for one of the list's first
// `size` addresses (an error that carries no address is the list's own, SWR
// giving the errors of the current key only).
export const isErrorOfList = (
  error: unknown,
  expected: (pageIndex: number) => string,
  size: number
): boolean => {
  if (!error) {
    return false;
  }

  const url = (error as { requestedUrl?: string }).requestedUrl;

  if (url === undefined) {
    return true;
  }

  for (let i = 0; i < Math.max(size, 1); i += 1) {
    if (expected(i) === url) {
      return true;
    }
  }

  return false;
};

export type SearchPageKind = 'loading' | 'titles' | 'noResults' | 'failed';

export interface SearchPageState {
  kind: SearchPageKind;
  // whether the list shows its loading placeholders
  loading: boolean;
  // whether nothing more is to be loaded (the end, or a failure)
  reachingEnd: boolean;
}

// What the search page shows, from the list of the query and type in its
// address alone: its pages (pagesOfList), the titles shown of them, whether its
// last read failed (and no read is going on: a Retry shows loading) and
// whether a further page is being read.
export const searchPageState = ({
  pages,
  titles,
  failed,
  loadingMore,
}: {
  pages: readonly TaggedPage[];
  titles: number;
  failed: boolean;
  loadingMore: boolean;
}): SearchPageState => {
  if (failed) {
    return { kind: 'failed', loading: false, reachingEnd: true };
  }

  const end = isEndByPageCount(pages);

  if (titles === 0 && end) {
    return { kind: 'noResults', loading: false, reachingEnd: true };
  }

  if (titles === 0) {
    return { kind: 'loading', loading: true, reachingEnd: end };
  }

  return { kind: 'titles', loading: loadingMore && !end, reachingEnd: end };
};
