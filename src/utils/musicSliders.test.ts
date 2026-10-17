import { MediaStatus } from '@server/constants/media';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createElement } from 'react';
import { loadClient, renderClient } from './musicTestSupport';

// The music sliders, the Discover Music page and the Similar Artists slider
// (F2-D-93; F2-R-2 to F2-R-6, F2-R-14). SWR is replaced by a table of answers
// by key (a value is its data, an Error its failure, absent is loading); the
// keys asked are recorded, and the components are rendered to markup.
type Answer = unknown;
type Component = (props: never) => React.ReactNode;

const swr = require.resolve('swr');
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

const render = async (
  modulePath: string,
  answers: Record<string, Answer>,
  props: Record<string, unknown> = {},
  kindsShown: string[] = ['music']
) => {
  unload();
  asked.length = 0;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(swr);
  require.cache[swr]!.exports = {
    __esModule: true,
    default: (key: string | null) => {
      if (key && key !== '/api/v1/auth/me') {
        asked.push(key);
      }
      const answer = key ? answers[key] : undefined;

      // an Error is a failed read; { stale, error } is a failed revalidation
      // that still holds the answer of an earlier read
      const failed = answer instanceof Error;
      const stale = (answer as { stale?: Answer } | undefined)?.stale;

      return {
        data: failed ? undefined : stale !== undefined ? stale : answer,
        error: failed || stale !== undefined ? new Error('500') : undefined,
        mutate: () => {},
      };
    },
    useSWRConfig: () => ({ mutate: () => {} }),
  };

  const Page = loadClient<{ default: Component }>(modulePath).default;
  const { SettingsContext } = loadClient<{
    SettingsContext: React.Context<{ currentSettings: object }>;
  }>('context/SettingsContext');

  return renderClient(
    () =>
      createElement(
        SettingsContext.Provider,
        { value: { currentSettings: { kindsShown } } },
        createElement(Page as never, props as never)
      ),
    { mbid: 'mb-1' }
  );
};

afterEach(unload);

const album = (
  id: string,
  title: string,
  status?: MediaStatus,
  cover?: string
) => ({
  id,
  mediaType: 'album',
  title,
  artistId: 'ar',
  artistName: `by ${title}`,
  coverUrl: cover,
  mediaInfo: status ? { status } : undefined,
});
const artist = (
  id: string,
  name: string,
  status?: MediaStatus,
  image?: string
) => ({
  id,
  mediaType: 'artist',
  name,
  imageUrl: image,
  mediaInfo: status ? { status } : undefined,
});

const NO_RESULTS = /No results\./;

const albumSliders = [
  {
    name: 'Recently Added',
    path: 'components/Discover/RecentlyAddedMusicSlider',
    url: '/api/v1/music/recentlyadded',
  },
  {
    name: 'Popular Albums',
    path: 'components/Discover/PopularAlbumsSlider',
    url: '/api/v1/music/popular',
  },
];

for (const slider of albumSliders) {
  describe(`the ${slider.name} slider`, () => {
    it('reads its route and shows an album card of each result, in the order given, with title, artist, cover and status', async () => {
      const html = await render(slider.path, {
        [slider.url]: {
          results: [
            album('b-2', 'Second', MediaStatus.AVAILABLE),
            album('b-1', 'First'),
            album('b-3', 'Third', undefined, 'https://c.example/b-3.jpg'),
          ],
        },
      });

      assert.deepEqual(asked.filter((k) => k === slider.url).length, 1);
      assert.equal((html.match(/data-testid="album-card"/g) ?? []).length, 3);
      assert.ok(
        html.indexOf('/music/album/b-2') < html.indexOf('/music/album/b-1')
      );
      assert.match(html, /href="\/music\/album\/b-2"/);
      assert.match(html, /data-testid="music-card-artist">by Second</);
      assert.match(html, /data-testid="music-card-kind">Album</);
      assert.ok(html.includes('https://c.example/b-3.jpg'));
      assert.match(html, /bg-green-500\/80/);
      assert.doesNotMatch(html, NO_RESULTS);
    });

    it('has its default title, or the title it is given', async () => {
      const answers = { [slider.url]: { results: [album('b', 'X')] } };

      assert.match(
        await render(slider.path, answers),
        new RegExp(`<span>${slider.name}</span>`)
      );
      assert.match(
        await render(slider.path, answers, { title: 'Mine' }),
        /<span>Mine<\/span>/
      );
    });

    it('shows the empty state on an empty answer and on a failed one, and not while loading', async () => {
      assert.match(
        await render(slider.path, { [slider.url]: { results: [] } }),
        NO_RESULTS
      );
      assert.match(
        await render(slider.path, { [slider.url]: new Error('500') }),
        NO_RESULTS
      );
      assert.doesNotMatch(await render(slider.path, {}), NO_RESULTS);
    });
  });
}

describe('the Recent Music Requests slider', () => {
  const path = 'components/Discover/RecentMusicRequestsSlider';
  const url =
    '/api/v1/request?filter=all&take=20&sort=added&skip=0&mediaType=music';
  const request = (
    id: number,
    kind: 'album' | 'artist',
    mbid: string,
    status: MediaStatus
  ) => ({
    id,
    type: 'music',
    status: 2,
    media: { musicBrainzId: mbid, musicKind: kind, status },
  });

  it('reads the request list of music, take 20 newest first, and shows each request as a card of its item with the media status', async () => {
    const html = await render(path, {
      [url]: {
        results: [
          request(2, 'album', 'al-1', MediaStatus.PENDING),
          request(1, 'artist', 'ar-1', MediaStatus.PARTIALLY_AVAILABLE),
        ],
      },
      '/api/v1/music/album/al-1': {
        id: 'al-1',
        title: 'Requested Album',
        artist: { id: 'ar-1', name: 'Some Artist' },
      },
      '/api/v1/music/artist/ar-1': {
        id: 'ar-1',
        name: 'Requested Artist',
      },
    });

    assert.ok(asked.includes(url));
    assert.match(html, /data-testid="album-card"/);
    assert.match(html, /data-testid="artist-card"/);
    assert.ok(
      html.indexOf('Requested Album') < html.indexOf('Requested Artist')
    );
    assert.match(html, /data-testid="music-card-artist">Some Artist</);
    assert.match(html, /href="\/music\/album\/al-1"/);
    assert.match(html, /href="\/music\/artist\/ar-1"/);
    assert.match(html, /bg-indigo-500\/80|bg-yellow-500\/80/);
    assert.match(html, /<span>Recent Music Requests<\/span>/);
    assert.doesNotMatch(html, NO_RESULTS);
  });

  it('shows the cover of a requested album and the image of a requested artist the item gives (F2-R-6)', async () => {
    const html = await render(path, {
      [url]: {
        results: [
          request(2, 'album', 'al-1', MediaStatus.PENDING),
          request(1, 'artist', 'ar-1', MediaStatus.PENDING),
        ],
      },
      '/api/v1/music/album/al-1': {
        id: 'al-1',
        title: 'Requested Album',
        coverUrl: 'https://c.example/requested-album.jpg',
      },
      '/api/v1/music/artist/ar-1': {
        id: 'ar-1',
        name: 'Requested Artist',
        imageUrl: 'https://c.example/requested-artist.jpg',
      },
    });

    assert.ok(html.includes('https://c.example/requested-album.jpg'));
    assert.ok(html.includes('https://c.example/requested-artist.jpg'));
  });

  it('has the title it is given, and the empty state on an empty answer and on a failed one', async () => {
    assert.match(
      await render(path, { [url]: { results: [] } }, { title: 'Mine' }),
      /<span>Mine<\/span>[\s\S]*No results\./
    );
    assert.match(await render(path, { [url]: new Error('500') }), NO_RESULTS);
    assert.doesNotMatch(await render(path, {}), NO_RESULTS);
  });

  it('shows a placeholder, not a card, while the item of a request is read', async () => {
    const html = await render(path, {
      [url]: {
        results: [request(1, 'album', 'al-1', MediaStatus.PENDING)],
      },
    });

    assert.doesNotMatch(html, /data-testid="album-card"/);
  });
});

describe('the Discover Music page', () => {
  const path = 'pages/discover/music';
  const all = {
    '/api/v1/music/recentlyadded': { results: [album('a', 'AddedAlbum')] },
    '/api/v1/request?filter=all&take=20&sort=added&skip=0&mediaType=music': {
      results: [],
    },
    '/api/v1/music/popular': { results: [album('p', 'PopularAlbum')] },
  };

  it('has its heading and shows the three sliders in order while music is shown', async () => {
    const html = await render(path, all);

    assert.match(html, /Discover Music/);
    const at = [
      'Recently Added',
      'Recent Music Requests',
      'Popular Albums',
    ].map((t) => html.indexOf(`<span>${t}</span>`));
    assert.ok(at[0] > 0 && at[0] < at[1] && at[1] < at[2], at.join());
    assert.deepEqual(asked, [
      '/api/v1/music/recentlyadded',
      '/api/v1/request?filter=all&take=20&sort=added&skip=0&mediaType=music',
      '/api/v1/music/popular',
    ]);
    assert.doesNotMatch(html, /discover-music-notice/);
  });

  it('keeps the page when one source fails or is empty', async () => {
    const html = await render(path, {
      ...all,
      '/api/v1/music/popular': new Error('500'),
    });

    assert.match(html, /AddedAlbum/);
    assert.match(html, /<span>Popular Albums<\/span>/);
    assert.match(html, NO_RESULTS);
  });

  it('shows only a notice, no slider and no fetch, where music is not shown', async () => {
    for (const shown of [[], ['movie', 'tv', 'person']]) {
      const html = await render(path, all, {}, shown);

      assert.match(html, /data-testid="discover-music-notice"/);
      assert.match(html, /Music is not set up/);
      assert.doesNotMatch(html, /slider-title/);
      assert.deepEqual(asked, []);
    }
  });
});

describe('the Similar Artists slider', () => {
  const path = 'components/Discover/SimilarArtistsSlider';
  const url = '/api/v1/music/artist/mb-1/similar';

  it('reads its own route and shows an artist card of each, most similar first', async () => {
    const html = await render(
      path,
      {
        [url]: {
          results: [
            artist(
              's-1',
              'Near',
              MediaStatus.AVAILABLE,
              'https://c.example/near.jpg'
            ),
            artist(
              's-2',
              'Far',
              MediaStatus.UNKNOWN,
              'https://c.example/far.jpg'
            ),
            artist('s-3', 'Last'),
          ],
        },
      },
      { mbid: 'mb-1' }
    );

    assert.deepEqual(asked, [url]);
    assert.match(html, /<span>Similar Artists<\/span>/);
    assert.equal((html.match(/data-testid="artist-card"/g) ?? []).length, 3);
    // a card with an image renders no title or link as markup, so the order is
    // read from what every card renders: its image, the last one's link
    const near = html.indexOf('https://c.example/near.jpg');
    const far = html.indexOf('https://c.example/far.jpg');
    const last = html.indexOf('href="/music/artist/s-3"');
    assert.ok(near >= 0 && far >= 0 && last >= 0);
    assert.ok(near < far && far < last);
    assert.match(html, /bg-green-500\/80/);
    assert.ok(html.includes('https://c.example/near.jpg'));
  });

  it('is left out while it loads, on an error and on an empty answer', async () => {
    for (const answers of [
      {},
      { [url]: new Error('500') },
      { [url]: { results: [] } },
      { [url]: { stale: { results: [artist('s-1', 'Near')] } } },
    ]) {
      assert.equal(await render(path, answers, { mbid: 'mb-1' }), '');
    }
  });
});

describe('the artist page', () => {
  it('shows the Similar Artists slider below its albums, read from its own fetch, and the page without it while that has no answer', async () => {
    const data = {
      id: 'mb-1',
      name: 'Artist One',
      genres: [],
      inLidarr: false,
      albums: [{ id: 'al-1', title: 'Album One', releaseDate: '2000-01-01' }],
    };
    const answers = {
      '/api/v1/music/artist/mb-1': data,
    };

    const without = await render('components/ArtistDetails', answers);
    assert.match(without, /Album One/);
    assert.doesNotMatch(without, /Similar Artists/);
    assert.ok(asked.includes('/api/v1/music/artist/mb-1/similar'));

    const withSimilar = await render('components/ArtistDetails', {
      ...answers,
      '/api/v1/music/artist/mb-1/similar': { results: [artist('s', 'Sim')] },
    });
    assert.ok(
      withSimilar.indexOf('Album One') < withSimilar.indexOf('Similar Artists')
    );
    assert.match(withSimilar, />Sim</);
  });
});
