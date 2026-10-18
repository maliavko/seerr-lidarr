import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SEARCH_READ_TIMEOUT_MS,
  isErrorOfList,
  makeSearchFetcher,
  pagesOfList,
  searchListKey,
  searchPageState,
  type TaggedPage,
} from './searchState';

// F2-D-341 (a), (b): what the search page shows is decided from the list of the
// query and type in its address alone. The answers are given deliberately slow
// and out of order; each test is one the work could fail.
const url = (query: string, page: number, type?: string) =>
  `/api/v1/search?page=${page}&query=${encodeURIComponent(query)}${
    type ? `&type=${type}` : ''
  }`;

const pageOf = (
  query: string,
  page: number,
  totalPages: number,
  type?: string
): TaggedPage => ({ page, totalPages, requestedUrl: url(query, page, type) });

// the addresses of the list of a query and type
const listOf = (query: string, type?: string) => (i: number) =>
  url(query, i + 1, type);

describe('makeSearchFetcher', () => {
  it('reads with the 30 seconds timeout and tags the answer with its address', async () => {
    const seen: { url: string; timeout: number }[] = [];
    const fetcher = makeSearchFetcher(async (u, config) => {
      seen.push({ url: u, ...config });
      return { data: { page: 1, totalPages: 2, results: [] } };
    });

    assert.equal(SEARCH_READ_TIMEOUT_MS, 30000);
    assert.deepEqual(await fetcher(url('abba', 1)), {
      page: 1,
      totalPages: 2,
      results: [],
      requestedUrl: url('abba', 1),
    });
    assert.deepEqual(seen, [{ url: url('abba', 1), timeout: 30000 }]);
  });

  it("reads the address inside the list's key and tags the answer and the error with the address (F2-F-1956)", async () => {
    const seen: string[] = [];
    const fetcher = makeSearchFetcher(async (u) => {
      seen.push(u);
      if (u.includes('bad')) {
        throw new Error('x');
      }
      return { data: { page: 1, totalPages: 1, results: [] } };
    });
    const ok = await fetcher(searchListKey(url('batman', 1)));
    const failure = await fetcher(searchListKey(url('bad', 1))).catch((e) => e);

    assert.deepEqual(seen, [url('batman', 1), url('bad', 1)]);
    assert.equal(ok.requestedUrl, url('batman', 1));
    assert.equal(failure.requestedUrl, url('bad', 1));
  });

  it('tags the error of an error answer, a network error and a timeout with its address', async () => {
    for (const failure of [
      Object.assign(new Error('Request failed with status code 500'), {
        response: { status: 500 },
      }),
      Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }),
      Object.assign(new Error('timeout of 30000ms exceeded'), {
        code: 'ECONNABORTED',
      }),
    ]) {
      const fetcher = makeSearchFetcher(async () => {
        throw failure;
      });

      await assert.rejects(
        () => fetcher(url('abba', 2)),
        (e: unknown) =>
          e === failure &&
          (e as { requestedUrl?: string }).requestedUrl === url('abba', 2)
      );
    }
  });

  it('tags each answer with its own address however the answers come in', async () => {
    const waiting: Record<
      string,
      (v: { data: Record<string, unknown> }) => void
    > = {};
    const fetcher = makeSearchFetcher(
      (u) =>
        new Promise((resolve) => {
          waiting[u] = resolve;
        })
    );
    const first = fetcher(url('chi', 1));
    const second = fetcher(url('children', 1));

    // the later query answers first
    waiting[url('children', 1)]({ data: { page: 1, totalPages: 1 } });
    waiting[url('chi', 1)]({ data: { page: 1, totalPages: 1 } });

    assert.equal((await second).requestedUrl, url('children', 1));
    assert.equal((await first).requestedUrl, url('chi', 1));
  });
});

describe('pagesOfList', () => {
  it('keeps the pages asked for the list, in order', () => {
    const pages = [pageOf('abba', 1, 3), pageOf('abba', 2, 3)];

    assert.deepEqual(pagesOfList(pages, listOf('abba')), pages);
  });

  it('keeps nothing of the pages of an earlier query that land under the current one', () => {
    // the answer of the earlier query 'chi' lands after (and before) that of
    // 'children', which is the query in the address
    assert.deepEqual(
      pagesOfList([pageOf('chi', 1, 4)], listOf('children')),
      []
    );
    assert.deepEqual(
      pagesOfList(
        [pageOf('chi', 1, 4), pageOf('children', 2, 4)],
        listOf('children')
      ),
      []
    );
  });

  it("never joins an earlier query's page to the list of the query in the address", () => {
    const own = pageOf('children', 1, 4);

    assert.deepEqual(
      pagesOfList([own, pageOf('chi', 2, 4)], listOf('children')),
      [own]
    );
    assert.deepEqual(
      pagesOfList(
        [own, pageOf('chi', 2, 4), pageOf('children', 3, 4)],
        listOf('children')
      ),
      [own]
    );
  });

  it('keeps nothing of another type of the same query', () => {
    assert.deepEqual(
      pagesOfList([pageOf('abba', 1, 1, 'music')], listOf('abba')),
      []
    );
    assert.deepEqual(
      pagesOfList([pageOf('abba', 1, 1)], listOf('abba', 'music')),
      []
    );
  });

  it('stops at a page that is missing', () => {
    const first = pageOf('abba', 1, 3);

    assert.deepEqual(
      pagesOfList([first, undefined, pageOf('abba', 3, 3)], listOf('abba')),
      [first]
    );
    assert.deepEqual(pagesOfList(undefined, listOf('abba')), []);
  });
});

describe('isErrorOfList', () => {
  const failed = (query: string, page: number, type?: string) =>
    Object.assign(new Error('x'), { requestedUrl: url(query, page, type) });

  it("is the list's where the error was asked for one of its pages", () => {
    assert.equal(isErrorOfList(failed('abba', 1), listOf('abba'), 3), true);
    assert.equal(isErrorOfList(failed('abba', 3), listOf('abba'), 3), true);
  });

  it("is not the list's where it was asked for another query, another type or a page beyond", () => {
    assert.equal(isErrorOfList(failed('chi', 1), listOf('children'), 3), false);
    assert.equal(
      isErrorOfList(failed('abba', 1, 'music'), listOf('abba'), 3),
      false
    );
    assert.equal(isErrorOfList(failed('abba', 4), listOf('abba'), 3), false);
  });

  it("is none where there is no error, and the list's where the error carries no address", () => {
    assert.equal(isErrorOfList(undefined, listOf('abba'), 3), false);
    assert.equal(isErrorOfList(new Error('x'), listOf('abba'), 3), true);
  });
});

describe('searchPageState', () => {
  const none: TaggedPage[] = [];

  it('shows loading while the list of the query in the box loads, whatever an earlier query answered', () => {
    // an earlier query's empty last page lands: pagesOfList leaves nothing
    const pages = pagesOfList([pageOf('chi', 1, 1)], listOf('children'));

    assert.deepEqual(
      searchPageState({ pages, titles: 0, failed: false, loadingMore: true }),
      { kind: 'loading', loading: true, reachingEnd: false }
    );
  });

  it('never brings the no-results state from the answer of an earlier query', () => {
    // the list of 'children' is still loading; the earlier query 'chi' ended
    // on page 1 of 1 with no title
    const state = searchPageState({
      pages: pagesOfList([pageOf('chi', 1, 1)], listOf('children')),
      titles: 0,
      failed: false,
      loadingMore: false,
    });

    assert.notEqual(state.kind, 'noResults');
  });

  it('shows the no-results state only on the last page of the list itself with no title', () => {
    assert.equal(
      searchPageState({
        pages: [pageOf('zzz', 1, 1)],
        titles: 0,
        failed: false,
        loadingMore: false,
      }).kind,
      'noResults'
    );
    assert.equal(
      searchPageState({
        pages: [pageOf('zzz', 1, 4)],
        titles: 0,
        failed: false,
        loadingMore: true,
      }).kind,
      'loading'
    );
    assert.equal(
      searchPageState({
        pages: [pageOf('zzz', 1, 1)],
        titles: 3,
        failed: false,
        loadingMore: false,
      }).kind,
      'titles'
    );
  });

  it('shows the titles of the list, with loading placeholders only while a page is read and the end is not reached', () => {
    assert.deepEqual(
      searchPageState({
        pages: [pageOf('abba', 1, 3)],
        titles: 20,
        failed: false,
        loadingMore: true,
      }),
      { kind: 'titles', loading: true, reachingEnd: false }
    );
    assert.deepEqual(
      searchPageState({
        pages: [pageOf('abba', 3, 3)],
        titles: 20,
        failed: false,
        loadingMore: true,
      }),
      { kind: 'titles', loading: false, reachingEnd: true }
    );
  });

  it('shows the failed state on a failed first read, never the no-results state or loading', () => {
    assert.deepEqual(
      searchPageState({
        pages: none,
        titles: 0,
        failed: true,
        loadingMore: false,
      }),
      { kind: 'failed', loading: false, reachingEnd: true }
    );
  });

  it('shows the failed state on a failed further read, the titles already shown staying for the page', () => {
    // a list at its last page by count with titles, then a failure: still failed
    for (const pages of [
      [pageOf('abba', 1, 3)],
      [pageOf('abba', 3, 3)],
      [pageOf('zzz', 1, 1)],
    ]) {
      const state = searchPageState({
        pages,
        titles: 20,
        failed: true,
        loadingMore: false,
      });

      assert.equal(state.kind, 'failed');
      assert.equal(state.reachingEnd, true);
    }
  });

  it('never shows the no-results state on a failure, even with no title and the last page', () => {
    assert.equal(
      searchPageState({
        pages: [pageOf('zzz', 1, 1)],
        titles: 0,
        failed: true,
        loadingMore: false,
      }).kind,
      'failed'
    );
  });

  it('shows loading on a Retry (no longer failed, the read going on), then the results', () => {
    assert.equal(
      searchPageState({
        pages: none,
        titles: 0,
        failed: false,
        loadingMore: true,
      }).kind,
      'loading'
    );
    assert.equal(
      searchPageState({
        pages: [pageOf('abba', 1, 3)],
        titles: 20,
        failed: false,
        loadingMore: false,
      }).kind,
      'titles'
    );
  });
});
