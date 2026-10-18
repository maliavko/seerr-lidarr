import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement, isValidElement, type ReactElement } from 'react';
import { loadClient, renderClient } from './musicTestSupport';

// The search page (F2-D-71, F2-R-9, F2-R-11): the type it reads from the
// address and sends, the end test it asks of useDiscover, the pills it offers
// and the address a press pushes. SWR gives the pages; the router records its
// pushes; the page's tree is read for the pills' props, as the pills' own test
// reads the buttons.
type Kind = 'movie' | 'tv' | 'music' | 'person';
type Page = { page: number; totalPages: number; totalResults: number };

const unload = () => {
  for (const key of Object.keys(require.cache)) {
    if (
      key.includes('/src/hooks/useDiscover') ||
      key.includes('/src/components/Search/')
    ) {
      delete require.cache[key];
    }
  }
};

const show = async ({
  query,
  kindsShown,
  pages = [],
}: {
  query: Record<string, string | string[]>;
  kindsShown: Kind[];
  pages?: Page[];
}) => {
  unload();
  const keys: (string | null)[] = [];
  const pushes: unknown[] = [];
  const replaces: unknown[] = [];
  const swr = require.resolve('swr/infinite');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(swr);
  require.cache[swr]!.exports = {
    __esModule: true,
    default: (
      getKey: (i: number, previous: unknown) => string[] | string | null
    ) => {
      // the search page's list keys are ['search-page-list', address]
      const addressOf = (i: number) => {
        const key = getKey(i, null);

        return Array.isArray(key) ? key[1] : key;
      };

      keys.push(addressOf(0));
      return {
        data: pages.map((p, i) => ({
          ...p,
          results: [],
          requestedUrl: addressOf(i) ?? undefined,
        })),
        error: undefined,
        size: Math.max(pages.length, 1),
        setSize: () => {},
        isValidating: false,
        mutate: () => {},
      };
    },
  };

  const Search = loadClient<{ default: () => ReactElement }>(
    'components/Search/index'
  ).default;
  const { SettingsContext } = loadClient<{
    SettingsContext: React.Context<{ currentSettings: object }>;
  }>('context/SettingsContext');
  const Pills = loadClient<{ default: unknown }>(
    'components/Search/SearchTypePills'
  ).default;

  let tree: ReactElement | undefined;
  const html = await renderClient((RouterContext) => {
    const Probe = () => {
      tree = Search();
      return tree;
    };
    const Router = RouterContext as React.Context<unknown>;

    return createElement(
      Router.Provider,
      {
        value: {
          query,
          pathname: '/search',
          asPath: '/search',
          push: (address: unknown) => pushes.push(address),
          replace: (address: unknown) => replaces.push(address),
        },
      },
      createElement(
        SettingsContext.Provider,
        { value: { currentSettings: { kindsShown } } },
        createElement(Probe)
      )
    );
  });

  let pills: ReactElement<{
    kindsShown: Kind[];
    selected?: Kind;
    onSelect: (type?: Kind) => void;
  }> | null = null;
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (isValidElement(node)) {
      if (node.type === Pills) {
        pills = node as never;
      }
      walk((node.props as { children?: unknown }).children);
    }
  };
  walk(tree);

  return { html, keys, pushes, replaces, pills: pills! };
};

describe('the search page', () => {
  it('sends the type of ?type= where it is shown, and none for All', async () => {
    const shown: Kind[] = ['movie', 'tv', 'music', 'person'];

    assert.equal(
      (
        await show({
          query: { query: 'abba', type: 'music' },
          kindsShown: shown,
        })
      ).keys[0],
      '/api/v1/search?page=1&query=abba&type=music'
    );
    assert.equal(
      (await show({ query: { query: 'abba' }, kindsShown: shown })).keys[0],
      '/api/v1/search?page=1&query=abba'
    );
  });

  it('reads an unknown type, and one not shown, as All', async () => {
    assert.equal(
      (
        await show({
          query: { query: 'abba', type: 'album' },
          kindsShown: ['music'],
        })
      ).keys[0],
      '/api/v1/search?page=1&query=abba'
    );
    assert.equal(
      (
        await show({
          query: { query: 'abba', type: 'movie' },
          kindsShown: ['music'],
        })
      ).keys[0],
      '/api/v1/search?page=1&query=abba'
    );
  });

  it('offers the pills of the kinds shown only, marking the type chosen', async () => {
    const { pills } = await show({
      query: { query: 'abba', type: 'music' },
      kindsShown: ['music'],
    });

    assert.deepEqual(pills.props.kindsShown, ['music']);
    assert.equal(pills.props.selected, 'music');

    const all = await show({
      query: { query: 'abba' },
      kindsShown: ['movie', 'person'],
    });
    assert.deepEqual(all.pills.props.kindsShown, ['movie', 'person']);
    assert.equal(all.pills.props.selected, undefined);
    assert.match(all.html, /data-testid="search-type-movie"/);
    assert.doesNotMatch(all.html, /data-testid="search-type-music"/);
  });

  it('pushes (not replaces) the address with the query kept and the type set, All removing it', async () => {
    const shown = await show({
      query: { query: 'abba', type: 'tv' },
      kindsShown: ['movie', 'tv', 'music'],
    });

    shown.pills.props.onSelect('music');
    shown.pills.props.onSelect(undefined);

    assert.deepEqual(shown.pushes, [
      { pathname: '/search', query: { query: 'abba', type: 'music' } },
      { pathname: '/search', query: { query: 'abba' } },
    ]);
    assert.deepEqual(shown.replaces, []);
  });

  it('ends only at the last page by the page count: a short page before it shows loading, not the no-results state', async () => {
    const html = (
      await show({
        query: { query: 'abba' },
        kindsShown: ['movie', 'tv'],
        pages: [{ page: 1, totalPages: 5, totalResults: 3 }],
      })
    ).html;

    assert.doesNotMatch(html, /No Results/i);

    const end = (
      await show({
        query: { query: 'abba' },
        kindsShown: ['movie', 'tv'],
        pages: [{ page: 1, totalPages: 1, totalResults: 0 }],
      })
    ).html;

    assert.match(end, /No Results/i);
  });
});
