import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import type {
  MusicBrainzRelease,
  MusicBrainzReleaseGroup,
} from '@server/api/musicbrainz';
import MusicBrainzAPI, {
  getMusicBrainz,
  getMusicBrainzUserAgent,
} from '@server/api/musicbrainz';
import cacheManager from '@server/lib/cache';
import { getAppVersion } from '@server/utils/appVersion';
import type {
  AxiosAdapter,
  AxiosInstance,
  InternalAxiosRequestConfig,
} from 'axios';

// MusicBrainz's answers, recorded from musicbrainz.org/ws/2 (fmt=json)
function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(
      join(__dirname, 'musicbrainz.fixtures', `${name}.json`),
      'utf8'
    )
  ) as T;
}

interface ReleaseGroupPage {
  'release-group-count': number;
  'release-group-offset': number;
  'release-groups': MusicBrainzReleaseGroup[];
}

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const MONITORED_RELEASE = '839966ab-7612-447c-b805-2a36b3e18aa5';
const FIRST_RELEASE = 'fba5f8fe-c6c8-4511-8562-c9febf482674';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

interface Call {
  url: string;
  params: Record<string, unknown>;
  headers: Record<string, unknown>;
  at: number;
}

// Replaces what the client sends over the wire: the requests it makes are
// recorded after its interceptors and its rate limit, and answered by respond.
function wire(
  client: MusicBrainzAPI,
  respond: (call: Call) => { status?: number; data: unknown }
): Call[] {
  const calls: Call[] = [];
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    const call: Call = {
      url: config.url ?? '',
      params: { ...config.params },
      headers: config.headers.toJSON() as Record<string, unknown>,
      at: Date.now(),
    };
    calls.push(call);

    const { status = 200, data } = respond(call);
    const response = {
      data,
      status,
      statusText: String(status),
      headers: {},
      config,
    };

    if (status >= 400) {
      throw Object.assign(
        new Error(`Request failed with status code ${status}`),
        { response }
      );
    }

    return response;
  };

  (client as unknown as { axios: AxiosInstance }).axios.defaults.adapter =
    adapter;

  return calls;
}

const pages = [
  fixture<ReleaseGroupPage>('release-groups-page1'),
  fixture<ReleaseGroupPage>('release-groups-page2'),
  fixture<ReleaseGroupPage>('release-groups-page3'),
];

const answerPages = (call: Call) => ({
  data: pages[Number(call.params.offset) / 100],
});

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    return e as Error;
  }
  throw new assert.AssertionError({ message: 'expected a rejection' });
}

describe('the MusicBrainz client', () => {
  beforeEach(() => cacheManager.getCache('musicbrainz').flush());

  it('is one shared instance for the whole server', () => {
    assert.strictEqual(getMusicBrainz(), getMusicBrainz());
    assert.ok(getMusicBrainz() instanceof MusicBrainzAPI);
  });

  it('names Seerr in its User-Agent on every request, and asks for JSON', async () => {
    const client = new MusicBrainzAPI();
    const calls = wire(client, answerPages);

    await client.getArtistAlbums(RADIOHEAD);

    assert.strictEqual(
      getMusicBrainzUserAgent(),
      `Seerr/${getAppVersion()} ( https://github.com/seerr-team/seerr )`
    );
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.strictEqual(call.headers['User-Agent'], getMusicBrainzUserAgent());
      assert.strictEqual(call.params.fmt, 'json');
    }
  });

  it('times a request out after 10 seconds', () => {
    const client = new MusicBrainzAPI();

    assert.strictEqual(
      (client as unknown as { axios: AxiosInstance }).axios.defaults.timeout,
      10000
    );
  });

  it('keeps two concurrent calls a second apart', async () => {
    const client = new MusicBrainzAPI();
    const calls = wire(client, () => ({
      data: fixture<MusicBrainzRelease>('release-first-official'),
    }));

    await Promise.all([
      client.getRelease(MONITORED_RELEASE),
      client.getRelease(FIRST_RELEASE),
    ]);

    assert.strictEqual(calls.length, 2);
    assert.ok(
      calls[1].at - calls[0].at >= 950,
      `the second request went ${calls[1].at - calls[0].at} ms after the first`
    );
  });

  describe('getArtistAlbums', () => {
    it('browses the release groups of the artist, 100 a page, at most 3 pages', async () => {
      const client = new MusicBrainzAPI();
      const calls = wire(client, answerPages);

      await client.getArtistAlbums(RADIOHEAD);

      // 388 release groups are there, and only three pages are read
      assert.strictEqual(pages[0]['release-group-count'], 388);
      assert.deepStrictEqual(
        calls.map((call) => [call.url, call.params]),
        [0, 100, 200].map((offset) => [
          '/release-group',
          { artist: RADIOHEAD, type: 'album', limit: 100, offset, fmt: 'json' },
        ])
      );
    });

    it('keeps only primary type Album with no secondary type', async () => {
      const client = new MusicBrainzAPI();
      wire(client, answerPages);

      const albums = await client.getArtistAlbums(RADIOHEAD);
      const everything = pages.flatMap((page) => page['release-groups']);

      // the browse holds compilations, live albums, remixes and interviews
      assert.ok(
        everything.some((group) => (group['secondary-types'] ?? []).length > 0)
      );
      assert.ok(albums.length > 0);
      for (const album of albums) {
        assert.strictEqual(album['primary-type'], 'Album');
        assert.deepStrictEqual(album['secondary-types'], []);
      }
      assert.strictEqual(
        albums.length,
        everything.filter(
          (group) =>
            group['primary-type'] === 'Album' &&
            group['secondary-types']?.length === 0
        ).length
      );
      // the studio albums of Radiohead, by first release date
      assert.deepStrictEqual(
        albums.map((album) => album.title),
        [
          'Pablo Honey',
          'The Bends',
          'Radiotick Tracks 2',
          'OK Computer',
          'Kid A',
          'Amnesiac',
          'Hail to the Thief',
          'In Rainbows',
          'The King of Limbs',
          'A Moon Shaped Pool',
        ]
      );
    });

    it('leaves out a release group of another primary type', async () => {
      const client = new MusicBrainzAPI();
      wire(client, () => ({
        data: {
          'release-group-count': 3,
          'release-group-offset': 0,
          'release-groups': [
            {
              id: 'a',
              title: 'An album',
              'primary-type': 'Album',
              'secondary-types': [],
            },
            {
              id: 'b',
              title: 'An EP',
              'primary-type': 'EP',
              'secondary-types': [],
            },
            {
              id: 'c',
              title: 'No type',
              'primary-type': null,
              'secondary-types': [],
            },
          ],
        },
      }));

      assert.deepStrictEqual(
        (await client.getArtistAlbums(RADIOHEAD)).map((album) => album.id),
        ['a']
      );
    });

    it('orders by first release date, undated last, and keeps the order of equal dates', async () => {
      const client = new MusicBrainzAPI();
      const album = (id: string, date?: string) => ({
        id,
        title: id,
        'primary-type': 'Album',
        'secondary-types': [],
        ...(date !== undefined ? { 'first-release-date': date } : {}),
      });
      wire(client, () => ({
        data: {
          'release-group-count': 6,
          'release-group-offset': 0,
          'release-groups': [
            album('undated-1'),
            album('late', '2016-05-08'),
            album('empty-date', ''),
            album('year-only', '1997'),
            album('early', '1997-05-21'),
            album('same-day', '1997-05-21'),
          ],
        },
      }));

      assert.deepStrictEqual(
        (await client.getArtistAlbums(RADIOHEAD)).map((a) => a.id),
        ['year-only', 'early', 'same-day', 'late', 'undated-1', 'empty-date']
      );
    });

    it('stops at a page that is not full', async () => {
      const client = new MusicBrainzAPI();
      const calls = wire(client, () => ({
        data: {
          'release-group-count': 1,
          'release-group-offset': 0,
          'release-groups': [
            {
              id: 'a',
              title: 'A',
              'primary-type': 'Album',
              'secondary-types': [],
            },
          ],
        },
      }));

      assert.strictEqual((await client.getArtistAlbums(RADIOHEAD)).length, 1);
      assert.strictEqual(calls.length, 1);
    });

    it('does not ask for a page after the last one, when that one is full', async () => {
      const client = new MusicBrainzAPI();
      const calls = wire(client, () => ({
        data: {
          'release-group-count': 100,
          'release-group-offset': 0,
          'release-groups': Array.from({ length: 100 }, (_, i) => ({
            id: `album-${i}`,
            title: `Album ${i}`,
            'primary-type': 'Album',
            'secondary-types': [],
          })),
        },
      }));

      assert.strictEqual((await client.getArtistAlbums(RADIOHEAD)).length, 100);
      assert.strictEqual(calls.length, 1);
    });

    it('answers an empty list for an artist with no release group', async () => {
      const client = new MusicBrainzAPI();
      wire(client, () => ({
        data: {
          'release-group-count': 0,
          'release-group-offset': 0,
          'release-groups': [],
        },
      }));

      assert.deepStrictEqual(await client.getArtistAlbums(UNKNOWN_ID), []);
    });

    it('keeps its answer 24 hours in the musicbrainz cache', async () => {
      const client = new MusicBrainzAPI();
      const calls = wire(client, answerPages);
      const cache = cacheManager.getCache('musicbrainz');

      assert.strictEqual(cache.id, 'musicbrainz');

      const first = await client.getArtistAlbums(RADIOHEAD);
      const second = await client.getArtistAlbums(RADIOHEAD);

      assert.strictEqual(calls.length, 3);
      assert.deepStrictEqual(second, first);
      assert.strictEqual(cache.getStats().keys, 3);

      const [key] = [
        ...(
          cache.data as unknown as { cache: { keys(): Iterable<string> } }
        ).cache.keys(),
      ];
      const remaining = (cache.data.getTtl(key) ?? 0) - Date.now();

      assert.ok(remaining > 86400 * 1000 - 5000 && remaining <= 86400 * 1000);
    });

    it('throws a [MusicBrainz] error with the cause when a page fails', async () => {
      const client = new MusicBrainzAPI();
      wire(client, (call) =>
        Number(call.params.offset) === 100
          ? { status: 503, data: { error: 'busy' } }
          : answerPages(call)
      );

      const error = await rejection(client.getArtistAlbums(RADIOHEAD));

      assert.strictEqual(
        error.message,
        '[MusicBrainz] Failed to retrieve release groups: Request failed with status code 503'
      );
      assert.ok(error.cause instanceof Error);
    });
  });

  describe('getRelease', () => {
    it('reads a release with its recordings and answers its media and tracks', async () => {
      const client = new MusicBrainzAPI();
      const recorded = fixture<MusicBrainzRelease>('release-monitored');
      const calls = wire(client, () => ({ data: recorded }));

      const release = await client.getRelease(MONITORED_RELEASE);

      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].url, `/release/${MONITORED_RELEASE}`);
      assert.deepStrictEqual(calls[0].params, {
        inc: 'recordings',
        fmt: 'json',
      });
      assert.deepStrictEqual(release, recorded);
      assert.strictEqual(release.status, 'Official');
      assert.deepStrictEqual(
        release.media?.map((medium) => [
          medium.position,
          medium.tracks?.length,
        ]),
        [
          [1, 6],
          [2, 6],
          [3, 11],
          [4, 43],
          [5, 23],
          [6, 2],
        ]
      );
    });

    it('keeps its answer, and asks again for another release', async () => {
      const client = new MusicBrainzAPI();
      const calls = wire(client, () => ({
        data: fixture<MusicBrainzRelease>('release-first-official'),
      }));

      await client.getRelease(FIRST_RELEASE);
      await client.getRelease(FIRST_RELEASE);
      assert.strictEqual(calls.length, 1);

      await client.getRelease(MONITORED_RELEASE);
      assert.strictEqual(calls.length, 2);
    });

    it('throws a [MusicBrainz] error with the cause for a release it does not know', async () => {
      const client = new MusicBrainzAPI();
      wire(client, () => ({
        status: 404,
        data: fixture('release-unknown'),
      }));

      const error = await rejection(client.getRelease(UNKNOWN_ID));

      assert.strictEqual(
        error.message,
        '[MusicBrainz] Failed to retrieve release: Request failed with status code 404'
      );
      assert.ok(error.cause instanceof Error);
    });
  });
});
