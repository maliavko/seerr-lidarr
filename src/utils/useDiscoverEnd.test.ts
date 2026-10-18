import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { loadClient, renderClient } from './musicTestSupport';

// useDiscover's end of results and empty state with and without endByPageCount
// (F2-D-71): what the search page changes and every other caller keeps. The
// pages SWR holds are given; the markup carries what the hook answers.
type Page = {
  page: number;
  totalPages: number;
  totalResults: number;
  results: { id: number; mediaType: string }[];
};

const results = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: from + i, mediaType: 'movie' }));

// the hook is loaded anew for each answer of SWR
const unload = () => {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/src/hooks/useDiscover')) {
      delete require.cache[key];
    }
  }
};
let lastConfig: Record<string, unknown> = {};
const answer = async (
  pages: Page[],
  endByPageCount?: boolean
): Promise<{ end: boolean; empty: boolean }> => {
  unload();
  // SWR gives the pages: the module's exports are replaced in the require cache
  const swr = require.resolve('swr/infinite');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(swr);
  require.cache[swr]!.exports = {
    __esModule: true,
    default: (_key: unknown, config: Record<string, unknown>) => {
      lastConfig = config;
      return {
        // the search page's fetcher tags each page with the address it was asked
        data: pages.map((p, i) => ({ ...p, requestedUrl: `/x?page=${i + 1}` })),
        error: undefined,
        size: pages.length,
        setSize: () => {},
        isValidating: false,
        mutate: () => {},
      };
    },
  };
  type Hook = (
    endpoint: string,
    options?: object,
    flags?: object
  ) => { isReachingEnd: boolean; isEmpty: boolean };
  const useDiscover = loadClient<{ default: Hook }>(
    'hooks/useDiscover'
  ).default;

  const html = await renderClient(() => {
    const Probe = () => {
      const r = useDiscover('/x', {}, endByPageCount ? { endByPageCount } : {});
      return createElement('i', {
        'data-end': String(r.isReachingEnd),
        'data-empty': String(r.isEmpty),
      });
    };
    return createElement(Probe);
  });

  return {
    end: /data-end="true"/.test(html),
    empty: /data-empty="true"/.test(html),
  };
};

const page = (n: number, of: number, count: number, total = 1000): Page => ({
  page: n,
  totalPages: of,
  totalResults: total,
  results: results(n * 100, count),
});

describe('useDiscover with endByPageCount', () => {
  it('does not end on a short page before the last page', async () => {
    assert.deepEqual(await answer([page(1, 5, 3)], true), {
      end: false,
      empty: false,
    });
  });

  it('does not end on totalResults reached before the last page', async () => {
    assert.equal((await answer([page(1, 5, 20, 20)], true)).end, false);
  });

  it('does not show the empty state on an emptied page before the last page', async () => {
    assert.deepEqual(await answer([page(1, 4, 0)], true), {
      end: false,
      empty: false,
    });
  });

  it('ends on the last page by the page count, short or not, and is empty only with no titles', async () => {
    assert.deepEqual(await answer([page(1, 1, 0)], true), {
      end: true,
      empty: true,
    });
    assert.deepEqual(await answer([page(1, 2, 0), page(2, 2, 3)], true), {
      end: true,
      empty: false,
    });
    assert.deepEqual(await answer([page(1, 2, 0), page(2, 2, 0)], true), {
      end: true,
      empty: true,
    });
  });
});

describe('useDiscover without endByPageCount', () => {
  it("keeps the global fetcher and SWR's own error retry: nothing of the search page's", async () => {
    await answer([page(1, 5, 3)]);

    assert.equal('fetcher' in lastConfig, false);
    assert.equal('shouldRetryOnError' in lastConfig, false);
  });

  it('keeps its end test: a short page ends it, and no title is empty', async () => {
    assert.equal((await answer([page(1, 5, 3)])).end, true);
    assert.deepEqual(await answer([page(1, 4, 0)]), { end: true, empty: true });
  });

  it('keeps its end test: totalResults reached ends it', async () => {
    assert.equal((await answer([page(1, 5, 20, 20)])).end, true);
  });

  it('keeps its end test: full pages with more to come do not end it', async () => {
    assert.equal((await answer([page(1, 5, 20, 1000)])).end, false);
  });
});
