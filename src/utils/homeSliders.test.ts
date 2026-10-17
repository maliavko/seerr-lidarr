import { DiscoverSliderType as T } from '@server/constants/discover';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createElement } from 'react';
import { loadClient, renderClient } from './musicTestSupport';

// The menu and the home page's sliders under the kinds shown (F2-D-122,
// F2-D-211; F2-R-1, F2-R-7, F2-R-10). SWR is replaced by a table of answers by
// key (a value is its data, an Error its failure, absent is loading); the keys
// asked are recorded, and the components are rendered to markup.
type Component = (props: never) => React.ReactNode;
type Kind = 'movie' | 'tv' | 'music' | 'person';

const ALL: Kind[] = ['movie', 'tv', 'music', 'person'];
const ADMIN = { id: 1, permissions: 2 };

const swr = require.resolve('swr');
const swrInfinite = require.resolve('swr/infinite');
const inView = require.resolve('react-intersection-observer');
const asked: string[] = [];

const unload = () => {
  for (const key of Object.keys(require.cache)) {
    if (
      key.includes('/src/components/') ||
      key.includes('/src/pages/discover/') ||
      key.includes('/src/hooks/')
    ) {
      delete require.cache[key];
    }
  }
};

interface Options {
  props?: Record<string, unknown>;
  kindsShown?: Kind[];
  pathname?: string;
  settings?: Record<string, unknown>;
  // useSWRInfinite: the pages' totalResults decide whether it goes on loading
  size?: number;
}

const render = async (
  modulePath: string,
  answers: Record<string, unknown>,
  {
    props = {},
    kindsShown = ALL,
    pathname = '/',
    settings = {},
    size = 2,
  }: Options = {}
) => {
  unload();
  asked.length = 0;
  const all = { '/api/v1/auth/me': ADMIN, ...answers };

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(swr);
  require.cache[swr]!.exports = {
    __esModule: true,
    default: (key: string | null) => {
      if (key && key !== '/api/v1/auth/me') {
        asked.push(key);
      }
      const answer = key ? all[key as keyof typeof all] : undefined;
      const failed = answer instanceof Error;

      return {
        data: failed ? undefined : answer,
        error: failed ? new Error('500') : undefined,
        mutate: () => {},
      };
    },
    useSWRConfig: () => ({ mutate: () => {} }),
    mutate: () => {},
  };
  // a card reads its title once it is in view: every card is
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(inView);
  require.cache[inView]!.exports = {
    __esModule: true,
    useInView: () => ({ ref: () => {}, inView: true }),
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(swrInfinite);
  require.cache[swrInfinite]!.exports = {
    __esModule: true,
    default: (getKey: (index: number, previous: unknown) => string | null) => {
      const pages: unknown[] = [];
      let error: Error | undefined;

      for (let index = 0; index < size; index++) {
        const key = getKey(index, pages[index - 1] ?? null);
        if (!key) {
          break;
        }
        asked.push(key);
        const answer = all[key as keyof typeof all];
        if (answer instanceof Error) {
          error = answer;
        }
        if (answer === undefined || answer instanceof Error) {
          break;
        }
        pages.push(answer);
      }

      return {
        data: pages.length ? pages : undefined,
        error,
        size,
        setSize: () => {},
      };
    },
  };

  const Component = loadClient<{ default: Component }>(modulePath).default;
  const { SettingsContext } = loadClient<{
    SettingsContext: React.Context<{ currentSettings: object }>;
  }>('context/SettingsContext');

  return renderClient((RouterContext) =>
    createElement(
      (RouterContext as React.Context<unknown> & { Provider: never }).Provider,
      {
        value: {
          query: {},
          pathname,
          asPath: pathname,
          push: () => {},
          replace: () => {},
          events: { on: () => {}, off: () => {} },
        },
      } as never,
      createElement(
        SettingsContext.Provider,
        { value: { currentSettings: { kindsShown, ...settings } } },
        createElement(Component as never, props as never)
      )
    )
  );
};

afterEach(unload);

const movie = (id: number) => ({
  id,
  mediaType: 'movie',
  title: `Movie ${id}`,
});
const tv = (id: number) => ({ id, mediaType: 'tv', name: `Show ${id}` });
const person = (id: number) => ({
  id,
  mediaType: 'person',
  name: `Person ${id}`,
});
const artist = (id: string) => ({
  id,
  mediaType: 'artist',
  name: `Artist ${id}`,
});
const page = (results: unknown[], totalResults = results.length) => ({
  page: 1,
  totalPages: 1,
  totalResults,
  results,
});

describe('the menu (F2-R-1, F2-D-211)', () => {
  const hrefs = (html: string) =>
    [...html.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]);
  const menus = [
    { name: 'sidebar', path: 'components/Layout/Sidebar' },
    { name: 'mobile menu', path: 'components/Layout/MobileMenu' },
  ];

  for (const menu of menus) {
    describe(`the ${menu.name}`, () => {
      const props = {
        open: true,
        setClosed: () => {},
        pendingRequestsCount: 0,
        openIssuesCount: 0,
        revalidateIssueCount: () => {},
        revalidateRequestsCount: () => {},
      };
      const links = async (kindsShown: Kind[], pathname = '/') =>
        hrefs(await render(menu.path, {}, { props, kindsShown, pathname }))
          // the sidebar is drawn twice (mobile drawer and desktop)
          .filter((h) => h.startsWith('/discover/') || h === '/requests');

      it('shows Movies, Series and Music, Music right after Series, while every kind is shown', async () => {
        const shown = await links(ALL);

        assert.ok(
          shown.slice(0, 3).join() ===
            ['/discover/movies', '/discover/tv', '/discover/music'].join(),
          shown.join()
        );
      });

      it('shows Music only while music is shown', async () => {
        assert.ok(
          !(await links(['movie', 'tv', 'person'])).includes('/discover/music')
        );
        assert.ok((await links(['music'])).includes('/discover/music'));
        assert.ok(!(await links([])).includes('/discover/music'));
      });

      it('shows Movies only while movies are, and Series only while series are', async () => {
        const moviesOnly = await links(['movie', 'person']);
        assert.ok(moviesOnly.includes('/discover/movies'));
        assert.ok(!moviesOnly.includes('/discover/tv'));

        const seriesOnly = await links(['tv', 'person']);
        assert.ok(!seriesOnly.includes('/discover/movies'));
        assert.ok(seriesOnly.includes('/discover/tv'));

        const musicOnly = await links(['music']);
        assert.ok(!musicOnly.includes('/discover/movies'));
        assert.ok(!musicOnly.includes('/discover/tv'));
      });

      it('stands Music where Series would stand when Series is hidden, and keeps the items of no kind', async () => {
        const shown = await links(['movie', 'music', 'person']);

        assert.deepEqual(
          shown.slice(0, 2),
          ['/discover/movies', '/discover/music'],
          shown.join()
        );
        assert.ok((await links([])).includes('/requests'));
      });
    });
  }

  it('labels the item Music, in the sidebar', async () => {
    const html = await render(
      'components/Layout/Sidebar',
      {},
      {
        props: {
          open: false,
          setClosed: () => {},
          pendingRequestsCount: 0,
          openIssuesCount: 0,
          revalidateIssueCount: () => {},
          revalidateRequestsCount: () => {},
        },
      }
    );

    assert.match(
      html,
      /<a[^>]*href="\/discover\/music"[^>]*>[\s\S]*?<\/svg>Music<\/a>/
    );
  });

  it('shows the three music sliders, in Customize Discover, under their titles', async () => {
    for (const [type, title] of [
      [T.RECENTLY_ADDED_MUSIC, 'Recently Added Music'],
      [T.RECENT_MUSIC_REQUESTS, 'Recent Music Requests'],
      [T.POPULAR_ALBUMS, 'Popular Albums'],
    ] as const) {
      const html = await render(
        'components/Discover/DiscoverSliderEdit',
        {},
        {
          props: {
            slider: { id: 1, type, enabled: false, isBuiltIn: true },
            onEnable: () => {},
            onDelete: () => {},
            onPositionUpdate: () => {},
            disableUpButton: false,
            disableDownButton: false,
            children: null,
          },
        }
      );

      assert.match(
        html,
        new RegExp(`class="w-7/12 truncate md:w-full">${title}<`)
      );
    }
  });

  it('marks the Music item active on /discover/music, in the sidebar', async () => {
    const html = await render(
      'components/Layout/Sidebar',
      {},
      {
        props: {
          open: false,
          setClosed: () => {},
          pendingRequestsCount: 0,
          openIssuesCount: 0,
          revalidateIssueCount: () => {},
          revalidateRequestsCount: () => {},
        },
        pathname: '/discover/music',
      }
    );
    const music = html.match(/<a[^>]*href="\/discover\/music"[^>]*>/)?.[0];
    const series = html.match(/<a[^>]*href="\/discover\/tv"[^>]*>/)?.[0];

    assert.ok(music?.includes('from-indigo-600'), music);
    assert.ok(!series?.includes('from-indigo-600'), series);
  });
});

describe('the Discover page (the home page)', () => {
  const slidersUrl = '/api/v1/settings/discover';
  let nextId = 1;
  const row = (type: T, enabled = true, extra = {}) => ({
    id: nextId++,
    type,
    enabled,
    isBuiltIn: true,
    order: nextId,
    ...extra,
  });
  const home = async (sliders: unknown[], kindsShown: Kind[]) =>
    render('components/Discover', { [slidersUrl]: sliders }, { kindsShown });

  it('fetches and shows a slider while a kind it declares is shown, and not one of no kind shown', async () => {
    const sliders = [
      row(T.POPULAR_MOVIES),
      row(T.POPULAR_TV),
      row(T.RECENTLY_ADDED_MUSIC),
      row(T.POPULAR_ALBUMS),
    ];

    await home(sliders, ['movie', 'person']);
    assert.ok(asked.some((k) => k.startsWith('/api/v1/discover/movies')));
    assert.ok(!asked.some((k) => k.startsWith('/api/v1/discover/tv')));
    assert.ok(!asked.some((k) => k.startsWith('/api/v1/music/')));

    asked.length = 0;
    await home(sliders, ['tv', 'person']);
    assert.ok(!asked.some((k) => k.startsWith('/api/v1/discover/movies')));
    assert.ok(asked.some((k) => k.startsWith('/api/v1/discover/tv')));

    asked.length = 0;
    await home(sliders, ['music']);
    assert.ok(!asked.some((k) => k.startsWith('/api/v1/discover')));
    assert.ok(asked.includes('/api/v1/music/recentlyadded'));
    assert.ok(asked.includes('/api/v1/music/popular'));
  });

  it('fetches nothing and shows no slider where no kind is shown', async () => {
    const html = await home(
      [
        row(T.POPULAR_MOVIES),
        row(T.TRENDING),
        row(T.RECENT_REQUESTS),
        row(T.TMDB_SEARCH, true, { data: 'x', title: 'Mine' }),
        row(T.RECENTLY_ADDED_MUSIC),
      ],
      []
    );

    assert.deepEqual(asked, [slidersUrl]);
    assert.doesNotMatch(html, /slider-title/);
  });

  it('renders the three music sliders with their titles, enabled, in the saved order, and none disabled', async () => {
    const html = await render(
      'components/Discover',
      {
        [slidersUrl]: [
          row(T.POPULAR_ALBUMS),
          row(T.RECENT_MUSIC_REQUESTS),
          row(T.RECENTLY_ADDED_MUSIC),
        ],
        '/api/v1/music/recentlyadded': { results: [] },
        '/api/v1/music/popular': { results: [] },
      },
      { kindsShown: ['music'] }
    );
    const at = [
      'Popular Albums',
      'Recent Music Requests',
      'Recently Added Music',
    ].map((t) => html.indexOf(`<span>${t}</span>`));

    assert.ok(at[0] > 0 && at[0] < at[1] && at[1] < at[2], at.join());
    assert.ok(
      asked.includes(
        '/api/v1/request?filter=all&take=20&sort=added&skip=0&mediaType=music'
      )
    );

    asked.length = 0;
    const off = await render(
      'components/Discover',
      {
        [slidersUrl]: [
          row(T.POPULAR_ALBUMS, false),
          row(T.RECENT_MUSIC_REQUESTS, false),
          row(T.RECENTLY_ADDED_MUSIC, false),
        ],
      },
      { kindsShown: ['music'] }
    );
    assert.deepEqual(asked, [slidersUrl]);
    assert.doesNotMatch(off, /slider-title/);
  });

  it('applies the kinds shown to the items of a Trending slider and of a TMDB Search slider, and leaves one out where it keeps no item it draws a card for (F2-D-211)', async () => {
    const trending = '/api/v1/discover/trending?page=1';
    const search = '/api/v1/search?page=1&query=abc';
    const sliders = [
      row(T.TRENDING),
      row(T.TMDB_SEARCH, true, { id: 900, data: 'abc', title: 'Mine' }),
    ];
    const answers = (items: unknown[]) => ({
      [slidersUrl]: sliders,
      [trending]: page(items),
      [search]: page(items),
    });

    // only movies come, and movies are not shown: both are left out
    const dropped = await render('components/Discover', answers([movie(1)]), {
      kindsShown: ['person', 'music'],
    });
    assert.doesNotMatch(dropped, /slider-title/);

    // a movie is dropped and an artist kept, and a slider draws no card for an
    // artist: both are left out (F2-D-211)
    const artistsOnly = await render(
      'components/Discover',
      answers([movie(1), artist('a')]),
      { kindsShown: ['person', 'music'] }
    );
    assert.doesNotMatch(artistsOnly, /slider-title/);

    // a person comes beside it, and person is shown: it draws a card, so both
    // stand
    const kept = await render(
      'components/Discover',
      answers([movie(1), artist('a'), person(3)]),
      { kindsShown: ['person', 'music'] }
    );
    assert.match(kept, />Mine</);
    assert.match(kept, />Trending</);
  });

  it('shows the three media servers sliders and Trending of movies and series as before where every kind is shown', async () => {
    await home(
      [
        row(T.RECENTLY_ADDED),
        row(T.RECENT_REQUESTS),
        row(T.PLEX_WATCHLIST),
        row(T.TRENDING),
      ],
      ALL
    );

    assert.ok(
      asked.includes(
        '/api/v1/media?filter=allavailable&take=20&sort=mediaAdded'
      )
    );
    assert.ok(
      asked.includes('/api/v1/request?filter=all&take=10&sort=added&skip=0')
    );
    assert.ok(asked.includes('/api/v1/discover/watchlist'));
    assert.ok(asked.includes('/api/v1/discover/trending?page=1'));
  });
});

describe('the Trending slider and the TMDB Search slider (MediaSlider, dropHiddenKinds)', () => {
  const path = 'components/MediaSlider';
  const url = '/api/v1/discover/trending?page=1';
  const props = (extra = {}) => ({
    sliderKey: 'trending',
    title: 'Trending',
    url: '/api/v1/discover/trending',
    dropHiddenKinds: true,
    ...extra,
  });
  const has = (html: string, what: string) => html.includes(what);

  it('drops only the items whose kind is not shown, and keeps the others', async () => {
    const html = await render(
      path,
      { [url]: page([movie(1), tv(2), person(3)]) },
      { props: props(), kindsShown: ['tv', 'person'] }
    );

    assert.ok(!has(html, 'href="/movie/1"'), 'the movie is dropped');
    assert.ok(has(html, 'href="/tv/2"'), 'the series stays');
    assert.ok(has(html, 'href="/person/3"'), 'the person stays');
  });

  it('keeps every item while every kind is shown, as today', async () => {
    const html = await render(
      path,
      { [url]: page([movie(1), tv(2), person(3)]) },
      { props: props() }
    );

    assert.ok(has(html, 'href="/movie/1"'));
    assert.ok(has(html, 'href="/tv/2"'));
    assert.ok(has(html, 'href="/person/3"'));
  });

  it('does not drop without the prop (the sliders of one kind never mix)', async () => {
    const html = await render(
      path,
      { [url]: page([movie(1), tv(2)]) },
      { props: props({ dropHiddenKinds: undefined }), kindsShown: ['tv'] }
    );

    assert.ok(has(html, 'href="/movie/1"'));
  });

  it('is left out once loaded where its source gave items and every one was dropped', async () => {
    const html = await render(
      path,
      { [url]: page([movie(1), movie(2)]) },
      { props: props(), kindsShown: ['music'] }
    );

    assert.doesNotMatch(html, /slider-header/);
  });

  it('is left out where the items kept are of a shown kind its slider draws no card for (an artist in Trending) and an item was dropped (F2-D-211)', async () => {
    const html = await render(
      path,
      { [url]: page([movie(1), artist('a-1')]) },
      { props: props(), kindsShown: ['music'] }
    );

    assert.doesNotMatch(html, /slider-header/);
  });

  it('stands where an item kept is one its slider draws a card for, an artist beside it (F2-D-211)', async () => {
    const html = await render(
      path,
      { [url]: page([movie(1), artist('a-1'), person(2)]) },
      { props: props(), kindsShown: ['person', 'music'] }
    );

    assert.match(html, /slider-header/);
  });

  it('is not left out where its source gave no item, and shows as today', async () => {
    const html = await render(
      path,
      { [url]: page([]) },
      { props: props(), kindsShown: ['music'] }
    );

    assert.match(html, /slider-header/);
  });

  for (const [setting, mediaInfo] of [
    ['hideAvailable', { status: 5 }],
    ['hideBlocklisted', { status: 6 }],
    ['hideRequested', { hasActiveRequest: true }],
  ] as const) {
    it(`stands where ${setting}, not the kinds shown, emptied it (every kind shown)`, async () => {
      const html = await render(
        path,
        { [url]: page([{ ...movie(1), mediaInfo }]) },
        { props: props(), settings: { [setting]: true } }
      );

      assert.ok(!has(html, 'href="/movie/1"'), 'the item is hidden by setting');
      assert.match(html, /slider-header/);
    });
  }

  for (const [setting, mediaInfo] of [
    ['hideAvailable', { status: 5 }],
    ['hideBlocklisted', { status: 6 }],
    ['hideRequested', { hasActiveRequest: true }],
  ] as const) {
    it(`reads the items as loaded, before ${setting}: a movie it hides still counts as kept (tv not shown), so the slider stands (F2-D-211, F2-F-1136)`, async () => {
      const html = await render(
        path,
        { [url]: page([{ ...movie(1), mediaInfo }, artist('a-1')]) },
        {
          props: props(),
          kindsShown: ['movie', 'person', 'music'],
          settings: { [setting]: true },
        }
      );

      assert.ok(!has(html, 'href="/movie/1"'), 'the item is hidden by setting');
      assert.match(html, /slider-header/);
    });
  }

  it('shows as it does while loading: not left out before an answer', async () => {
    const html = await render(
      path,
      {},
      { props: props(), kindsShown: ['music'] }
    );

    assert.match(html, /slider-header/);
  });

  it('is not left out while it still goes on loading pages that may hold an item of a kind shown', async () => {
    const html = await render(
      path,
      { [url]: page([movie(1), movie(2)], 100) },
      { props: props(), kindsShown: ['tv'], size: 1 }
    );

    assert.match(html, /slider-header/);
  });
});

describe('the Recently Added slider', () => {
  const path = 'components/Discover/RecentlyAddedSlider';
  const url = '/api/v1/media?filter=allavailable&take=20&sort=mediaAdded';
  const media = (id: number, mediaType: string) => ({
    id,
    tmdbId: 100 + id,
    mediaType,
  });
  const results = (items: unknown[]) => ({ [url]: { results: items } });

  it('drops the items of kinds not shown and keeps the rest', async () => {
    await render(path, results([media(1, 'movie'), media(2, 'tv')]), {
      kindsShown: ['tv', 'person'],
    });

    assert.ok(!asked.includes('/api/v1/movie/101'));
    assert.ok(asked.includes('/api/v1/tv/102'));
  });

  it('shows every item while every kind is shown', async () => {
    await render(path, results([media(1, 'movie'), media(2, 'tv')]));

    assert.ok(asked.includes('/api/v1/movie/101'));
    assert.ok(asked.includes('/api/v1/tv/102'));
  });

  it('is left out where its source gave none, as today', async () => {
    assert.doesNotMatch(await render(path, results([])), /slider-title/);
  });

  it('is left out once loaded where its items were all dropped, stands where one was kept, and shows while loading', async () => {
    assert.doesNotMatch(
      await render(path, results([media(1, 'movie')]), { kindsShown: ['tv'] }),
      /slider-title/
    );
    assert.match(
      await render(path, results([media(1, 'movie')]), {
        kindsShown: ['movie'],
      }),
      /slider-title/
    );
    assert.match(
      await render(path, {}, { kindsShown: ['tv'] }),
      /slider-title/
    );
  });
});

describe('the Recent Requests slider', () => {
  const path = 'components/Discover/RecentRequestsSlider';
  const url = '/api/v1/request?filter=all&take=10&sort=added&skip=0';
  const request = (id: number, type: string, extra = {}) => ({
    id,
    type,
    status: 2,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    media: { id, tmdbId: 200 + id, mediaType: type, ...extra },
    requestedBy: { id: 1 },
  });
  const answer = (...results: unknown[]) => ({
    [url]: { results, serviceErrors: { radarr: [], sonarr: [] } },
  });
  const music = (id: number) =>
    request(id, 'music', { musicBrainzId: `mb-${id}`, musicKind: 'album' });

  it('drops the requests of kinds not shown, by the request type, and keeps the rest', async () => {
    await render(
      path,
      answer(request(1, 'movie'), request(2, 'tv'), music(3)),
      { kindsShown: ['tv', 'person'] }
    );

    assert.ok(!asked.includes('/api/v1/movie/201'));
    assert.ok(asked.includes('/api/v1/tv/202'));
    assert.ok(!asked.some((k) => k.startsWith('/api/v1/music/album/mb-3')));
  });

  it('keeps a music request while music is shown and shows every kind while every kind is shown', async () => {
    await render(path, answer(request(1, 'movie'), request(2, 'tv'), music(3)));

    assert.ok(asked.includes('/api/v1/movie/201'));
    assert.ok(asked.includes('/api/v1/tv/202'));
    assert.ok(asked.some((k) => k.startsWith('/api/v1/music/album/mb-3')));
  });

  it('is left out once loaded where every request was dropped, stands where one was kept, and shows while loading', async () => {
    assert.doesNotMatch(
      await render(path, answer(music(3)), { kindsShown: ['movie'] }),
      /slider-title/
    );
    assert.match(
      await render(path, answer(music(3), request(1, 'movie')), {
        kindsShown: ['movie'],
      }),
      /slider-title/
    );
    assert.match(
      await render(path, {}, { kindsShown: ['movie'] }),
      /slider-title/
    );
  });
});

describe('the Watchlist slider', () => {
  const path = 'components/Discover/PlexWatchlistSlider';
  const url = '/api/v1/discover/watchlist';
  const item = (tmdbId: number, mediaType: string) => ({
    tmdbId,
    mediaType,
    ratingKey: `rk-${tmdbId}`,
  });
  const answer = (...results: unknown[]) => ({
    [url]: { page: 1, totalPages: 1, totalResults: results.length, results },
  });
  const user = {
    ...ADMIN,
    settings: { watchlistSyncMovies: true, watchlistSyncTv: true },
  };

  it('drops the items of kinds not shown and keeps the rest', async () => {
    await render(
      path,
      { ...answer(item(11, 'movie'), item(12, 'tv')), '/api/v1/auth/me': user },
      { kindsShown: ['movie', 'person'] }
    );

    assert.ok(asked.includes('/api/v1/movie/11'));
    assert.ok(!asked.includes('/api/v1/tv/12'));
  });

  it('is left out once loaded where its items were all dropped, and keeps its empty state where its source gave none', async () => {
    const withUser = { '/api/v1/auth/me': user };

    assert.doesNotMatch(
      await render(
        path,
        { ...answer(item(11, 'movie')), ...withUser },
        { kindsShown: ['tv'] }
      ),
      /slider-title/
    );
    assert.match(
      await render(path, { ...answer(), ...withUser }, { kindsShown: ['tv'] }),
      /Plex Watchlist/
    );
    assert.match(
      await render(path, { ...answer(item(11, 'movie')), ...withUser }),
      /slider-title/
    );
  });
});
