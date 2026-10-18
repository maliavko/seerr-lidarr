import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { unstable_serialize } from 'swr';
import { loadClient, renderClient } from './musicTestSupport';

// useDiscover with endByPageCount as the search page uses it (F2-D-341 (a),
// (b)): the pages and the error SWR holds are given, tagged with the address
// they were asked for; the markup carries what the hook answers.
type Page = {
  page: number;
  totalPages: number;
  totalResults: number;
  results: { id: number; mediaType: string }[];
  requestedUrl?: string;
};

const url = (query: string, page: number) =>
  `/api/v1/search?page=${page}&query=${query}`;
const page = (query: string, n: number, of: number, count: number): Page => ({
  page: n,
  totalPages: of,
  totalResults: 100,
  results: Array.from({ length: count }, (_, i) => ({
    id: n * 1000 + i + query.length * 100000,
    mediaType: 'movie',
  })),
  requestedUrl: url(query, n),
});

const configs: Record<string, unknown>[] = [];
const keyFns: ((i: number, prev: unknown) => unknown)[] = [];

const unload = () => {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/src/hooks/useDiscover')) {
      delete require.cache[key];
    }
  }
};

// what the page shows for the list of `query`, SWR holding `data` and `error`
const show = async ({
  query,
  data,
  error,
  isValidating = false,
  size = 3,
}: {
  query: string;
  data?: Page[];
  error?: unknown;
  isValidating?: boolean;
  size?: number;
}) => {
  unload();
  const sets: number[] = [];
  configs.length = 0;
  keyFns.length = 0;
  const swr = require.resolve('swr/infinite');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(swr);
  require.cache[swr]!.exports = {
    __esModule: true,
    default: (
      key: (i: number, prev: unknown) => unknown,
      config: Record<string, unknown>
    ) => {
      configs.push(config);
      keyFns.push(key);
      return {
        data,
        error,
        size,
        setSize: (n: number) => sets.push(n),
        isValidating,
        mutate: () => {},
      };
    },
  };
  let retry: (() => void) | undefined;
  const useDiscover = loadClient<{
    default: (
      endpoint: string,
      options: object,
      flags: object
    ) => {
      titles: unknown[];
      error: unknown;
      retry?: () => void;
      searchState: { kind: string; loading: boolean; reachingEnd: boolean };
    };
  }>('hooks/useDiscover').default;

  const html = await renderClient(() => {
    const Probe = () => {
      const r = useDiscover(
        '/api/v1/search',
        { query },
        { endByPageCount: true }
      );
      retry = r.retry;
      return createElement('i', {
        'data-kind': r.searchState.kind,
        'data-loading': String(r.searchState.loading),
        'data-titles': String(r.titles.length),
        'data-error': String(!!r.error),
      });
    };
    return createElement(Probe);
  });
  const read = (name: string) =>
    new RegExp(`data-${name}="([^"]*)"`).exec(html)![1];

  return {
    kind: read('kind'),
    loading: read('loading') === 'true',
    titles: Number(read('titles')),
    error: read('error') === 'true',
    retry,
    sets,
  };
};

describe('useDiscover with endByPageCount on the search page', () => {
  it('reads with a fetcher of its own and never reads a failed page again by itself', async () => {
    await show({ query: 'abba', data: [page('abba', 1, 1, 3)], size: 1 });

    assert.equal(typeof configs[0].fetcher, 'function');
    assert.equal(configs[0].shouldRetryOnError, false);
  });

  it("keeps the list's pages under keys of their own, never under the plain address a home slider's pages may be held under untagged (F2-F-1956)", async () => {
    await show({ query: 'batman', data: [page('batman', 1, 1, 3)], size: 1 });

    // the key a home TMDB search slider's useSWRInfinite gives its page 1
    const sliderKey = '/api/v1/search?page=1&query=batman';
    const key = keyFns[0](0, undefined);

    assert.notEqual(key, sliderKey);
    assert.deepEqual(key, ['search-page-list', sliderKey]);
    assert.notEqual(
      unstable_serialize(key as string[]),
      unstable_serialize(sliderKey)
    );
    // the page after a last page is none, as before
    assert.equal(keyFns[0](1, { totalPages: 1 }), null);
  });

  it('shows the titles of the query in the address', async () => {
    const r = await show({
      query: 'children',
      data: [page('children', 1, 3, 20), page('children', 2, 3, 20)],
    });

    assert.equal(r.kind, 'titles');
    assert.equal(r.titles, 40);
  });

  it("keeps no earlier key's data: the titles and the end of an earlier query landing under the current one are never shown", async () => {
    // 'chi' answered titles and 'children' is the query in the address
    const titles = await show({
      query: 'children',
      data: [page('chi', 1, 3, 20), page('chi', 2, 3, 20)],
    });

    assert.equal(titles.titles, 0);
    assert.equal(titles.kind, 'loading');
  });

  it('never shows the no-results state from the empty answer of an earlier query', async () => {
    const r = await show({
      query: 'children',
      data: [page('zz', 1, 1, 0)],
      isValidating: true,
    });

    assert.equal(r.kind, 'loading');
    assert.equal(r.loading, true);
  });

  it('never joins the page of an earlier query to the titles of the query in the address', async () => {
    const r = await show({
      query: 'children',
      data: [page('children', 1, 3, 20), page('chi', 2, 3, 20)],
    });

    assert.equal(r.titles, 20);
  });

  it("shows the no-results state for the query's own empty last page", async () => {
    const r = await show({ query: 'zz', data: [page('zz', 1, 1, 0)], size: 1 });

    assert.equal(r.kind, 'noResults');
  });

  it('gives the error of the list with the titles shown, the failed state, no toast and a retry', async () => {
    const error = Object.assign(new Error('x'), {
      requestedUrl: url('children', 3),
    });
    const r = await show({
      query: 'children',
      data: [page('children', 1, 5, 20), page('children', 2, 5, 20)],
      error,
    });

    assert.equal(r.kind, 'failed');
    assert.equal(r.titles, 40);
    assert.equal(r.error, true);
    assert.equal(typeof r.retry, 'function');
  });

  it('shows the failed state, never the no-results state, on a failed first read', async () => {
    const r = await show({
      query: 'children',
      data: undefined,
      error: Object.assign(new Error('x'), {
        requestedUrl: url('children', 1),
      }),
    });

    assert.equal(r.kind, 'failed');
    assert.equal(r.titles, 0);
  });

  it("does not show the failure of an earlier query's read for the query in the address", async () => {
    const r = await show({
      query: 'children',
      data: undefined,
      error: Object.assign(new Error('x'), { requestedUrl: url('chi', 1) }),
      isValidating: true,
    });

    assert.equal(r.kind, 'loading');
    assert.equal(r.error, false);
  });

  it('shows loading while Retry reads (the error standing), then the results', async () => {
    const error = Object.assign(new Error('x'), {
      requestedUrl: url('abba', 1),
    });
    const reading = await show({
      query: 'abba',
      data: undefined,
      error,
      isValidating: true,
    });
    const done = await show({
      query: 'abba',
      data: [page('abba', 1, 1, 7)],
      size: 1,
    });

    assert.equal(reading.kind, 'loading');
    assert.equal(done.kind, 'titles');
    assert.equal(done.titles, 7);
  });

  it('asks nothing more of the list while its last read failed, and Retry reads the failed page again', async () => {
    const error = Object.assign(new Error('x'), {
      requestedUrl: url('abba', 3),
    });
    const r = await show({
      query: 'abba',
      data: [page('abba', 1, 9, 2), page('abba', 2, 9, 2)],
      error,
    });

    assert.equal(r.kind, 'failed');
    assert.deepEqual(r.sets, []);
    // Retry asks SWR for the same size again: the failed page is read again
    r.retry!();
    assert.deepEqual(r.sets, [3]);
  });
});
