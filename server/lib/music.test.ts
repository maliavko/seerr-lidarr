import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { LidarrMetadataArtist } from '@server/api/lidarrmetadata';
import { getLidarrMetadata } from '@server/api/lidarrmetadata';
import type {
  MusicBrainzRelease,
  MusicBrainzReleaseGroup,
} from '@server/api/musicbrainz';
import { getMusicBrainz } from '@server/api/musicbrainz';
import type {
  LidarrAlbum,
  LidarrArtist,
  LidarrTrack,
} from '@server/api/servarr/lidarr';
import LidarrAPI from '@server/api/servarr/lidarr';
import cacheManager from '@server/lib/cache';
import {
  MusicSourceError,
  getAlbum,
  getArtist,
  isMusicConfigured,
  searchMusic,
} from '@server/lib/music';
import { getSettings } from '@server/lib/settings';
import type { AxiosInstance } from 'axios';

function load<T>(...path: string[]): T {
  return JSON.parse(readFileSync(join(__dirname, ...path), 'utf8')) as T;
}

// Lidarr's answers, recorded from the test Lidarr (lidarr-test, v3.1.0.4875)
const lidarrFixture = <T>(name: string): T =>
  load<T>('..', 'api', 'servarr', 'lidarr.fixtures', `${name}.json`);

// Lidarr's metadata service's answers, recorded from api.lidarr.audio
const metadataFixture = <T>(name: string): T =>
  load<T>(
    '..',
    'api',
    'lidarrmetadata',
    'lidarrmetadata.fixtures',
    `${name}.json`
  );

// MusicBrainz's answers, recorded from musicbrainz.org/ws/2
const musicBrainzFixture = <T>(name: string): T =>
  load<T>('..', 'api', 'musicbrainz', 'musicbrainz.fixtures', `${name}.json`);

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const OK_COMPUTER = 'b1392450-e666-3926-a536-22c65f834433';
const MONITORED_RELEASE = '839966ab-7612-447c-b805-2a36b3e18aa5';
const FIRST_OFFICIAL_RELEASE = 'fba5f8fe-c6c8-4511-8562-c9febf482674';

const server = {
  id: 1,
  name: 'Test Lidarr',
  hostname: '127.0.0.1',
  port: 18686,
  apiKey: 'test-key',
  useSsl: false,
  baseUrl: '',
  activeProfileId: 1,
  activeProfileName: 'Any',
  activeMetadataProfileId: 1,
  activeMetadataProfileName: 'Standard',
  activeDirectory: '/music',
  isDefault: true,
};

const lidarrCache = () => cacheManager.getCache('lidarr');

// the Lidarr, MusicBrainz and Lidarr metadata service calls a test saw
interface Calls {
  lidarr: string[];
  musicBrainz: string[];
  metadata: string[];
}

interface Answers {
  lookupArtists?: LidarrArtist[] | Error;
  lookupAlbums?: LidarrAlbum[] | Error;
  lookupArtistByMbid?: LidarrArtist | null | Error;
  lookupAlbumByMbid?: LidarrAlbum | null | Error;
  getArtists?: LidarrArtist[] | Error;
  getAlbums?: LidarrAlbum[] | Error;
  getTracks?: LidarrTrack[] | Error;
  // MusicBrainz, by what the client asks for
  releaseGroups?: MusicBrainzReleaseGroup[] | Error;
  releases?: Record<string, MusicBrainzRelease | Error>;
  // Lidarr's metadata service, by the artist's id: an artist, an Error, or
  // null for an id it does not know (a 404)
  metadata?: LidarrMetadataArtist | Error | null;
  // milliseconds the service takes to answer, to see calls made side by side
  metadataDelay?: number;
}

let calls: Calls;
// the most calls to Lidarr's metadata service in flight at once
let metadataInFlight = 0;
let metadataMostInFlight = 0;
const clients: LidarrAPI[] = [];

// Lidarr and MusicBrainz as the service finds them: every method of the Lidarr
// client and the wire of the shared MusicBrainz client answer from answers.
function answerWith(answers: Answers) {
  const answer = <T>(
    name: string,
    value: T | Error | undefined,
    call: string
  ) =>
    function (this: LidarrAPI) {
      clients.push(this);
      calls.lidarr.push(call);
      if (value instanceof Error) {
        return Promise.reject(value);
      }
      return Promise.resolve(value as T);
    };

  const proto = LidarrAPI.prototype;
  const spied = {
    lookupArtists: mock.method(
      proto,
      'lookupArtists',
      function (this: LidarrAPI, term: string) {
        return answer(
          'lookupArtists',
          answers.lookupArtists ?? [],
          `lookupArtists ${term}`
        ).call(this);
      }
    ),
    lookupAlbums: mock.method(
      proto,
      'lookupAlbums',
      function (this: LidarrAPI, term: string) {
        return answer(
          'lookupAlbums',
          answers.lookupAlbums ?? [],
          `lookupAlbums ${term}`
        ).call(this);
      }
    ),
    lookupArtistByMbid: mock.method(
      proto,
      'lookupArtistByMbid',
      function (this: LidarrAPI, mbid: string) {
        return answer(
          'lookupArtistByMbid',
          answers.lookupArtistByMbid ?? null,
          `lookupArtistByMbid ${mbid}`
        ).call(this);
      }
    ),
    lookupAlbumByMbid: mock.method(
      proto,
      'lookupAlbumByMbid',
      function (this: LidarrAPI, mbid: string) {
        return answer(
          'lookupAlbumByMbid',
          answers.lookupAlbumByMbid ?? null,
          `lookupAlbumByMbid ${mbid}`
        ).call(this);
      }
    ),
    getArtists: mock.method(proto, 'getArtists', function (this: LidarrAPI) {
      return answer('getArtists', answers.getArtists ?? [], 'getArtists').call(
        this
      );
    }),
    getAlbums: mock.method(
      proto,
      'getAlbums',
      function (this: LidarrAPI, options?: { artistId?: number }) {
        return answer(
          'getAlbums',
          answers.getAlbums ?? [],
          `getAlbums ${options?.artistId}`
        ).call(this);
      }
    ),
    getTracks: mock.method(
      proto,
      'getTracks',
      function (this: LidarrAPI, albumId: number) {
        return answer(
          'getTracks',
          answers.getTracks ?? [],
          `getTracks ${albumId}`
        ).call(this);
      }
    ),
  };

  // what MusicBrainz is asked, answered on the wire of the shared client
  const wire = (getMusicBrainz() as unknown as { axios: AxiosInstance }).axios;
  mock.method(
    wire,
    'get',
    async (url: string, config?: { params?: Record<string, unknown> }) => {
      calls.musicBrainz.push(
        url === '/release-group'
          ? `${url} ${config?.params?.artist} ${config?.params?.offset}`
          : url
      );

      let data: unknown;

      if (url === '/release-group') {
        const offset = Number(config?.params?.offset);
        data =
          answers.releaseGroups instanceof Error
            ? answers.releaseGroups
            : {
                'release-group-count': answers.releaseGroups?.length ?? 0,
                'release-group-offset': offset,
                'release-groups': (answers.releaseGroups ?? []).slice(
                  offset,
                  offset + 100
                ),
              };
      } else {
        data = answers.releases?.[url.replace('/release/', '')];
      }

      if (data === undefined || data instanceof Error) {
        throw data ?? new Error('Request failed with status code 404');
      }

      return { data };
    }
  );

  // what Lidarr's metadata service is asked, answered on the wire of its client
  const metadataWire = (
    getLidarrMetadata() as unknown as { axios: AxiosInstance }
  ).axios;
  mock.method(metadataWire, 'get', async (url: string) => {
    calls.metadata.push(url);
    metadataInFlight += 1;
    metadataMostInFlight = Math.max(metadataMostInFlight, metadataInFlight);

    try {
      await new Promise((resolve) =>
        setTimeout(resolve, answers.metadataDelay ?? 0)
      );
    } finally {
      metadataInFlight -= 1;
    }

    if (answers.metadata instanceof Error) {
      throw answers.metadata;
    }
    if (!answers.metadata) {
      throw Object.assign(new Error('Request failed with status code 404'), {
        response: { status: 404 },
      });
    }

    return { data: answers.metadata };
  });

  return spied;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    return e as Error;
  }
  throw new assert.AssertionError({ message: 'expected a rejection' });
}

const boom = () => new Error('Request failed with status code 500');

const held = () => lidarrFixture<LidarrArtist[]>('artists')[0];
const heldAlbums = () => lidarrFixture<LidarrAlbum[]>('albums');
const lookedUpArtist = () =>
  lidarrFixture<LidarrArtist[]>('artist-lookup-mbid')[0];
const lookedUpAlbum = () =>
  lidarrFixture<LidarrAlbum[]>('album-lookup-mbid')[0];
const radioheadMetadata = () =>
  metadataFixture<LidarrMetadataArtist>('artist-radiohead');
// the artist the test Lidarr holds after it has downloaded its covers: its own
// record and its lookup both give paths on Lidarr's disk and no overview
const heldCovered = () =>
  lidarrFixture<LidarrArtist[]>('artists-held-covers-downloaded')[0];
const lookedUpHeldCovered = () =>
  lidarrFixture<LidarrArtist[]>('artist-lookup-mbid-held-covers-downloaded')[0];
// the term lookup of 'radiohead' once the test Lidarr holds the artist and has
// downloaded its covers: the held artist answered with paths on Lidarr's disk
// and no overview, beside nine artists it does not hold
const termLookupHeldCovered = () =>
  lidarrFixture<LidarrArtist[]>('artist-lookup-term-held-covers-downloaded');
const heldAlbumLookup = () =>
  load<LidarrAlbum[]>('music.fixtures', 'album-lookup-held.json')[0];

beforeEach(() => {
  calls = { lidarr: [], musicBrainz: [], metadata: [] };
  metadataInFlight = 0;
  metadataMostInFlight = 0;
  clients.length = 0;
  getSettings().lidarr = [{ ...server }];
  lidarrCache().flush();
  cacheManager.getCache('musicbrainz').flush();
  cacheManager.getCache('lidarrmetadata').flush();
});

afterEach(() => mock.restoreAll());

describe('the music metadata service without a default Lidarr server', () => {
  it('finds no music, and calls no source', async () => {
    answerWith({});

    for (const servers of [[], [{ ...server, isDefault: false }]]) {
      getSettings().lidarr = servers;

      assert.strictEqual(isMusicConfigured(), false);
      assert.deepStrictEqual(await searchMusic('radiohead'), {
        artists: [],
        albums: [],
      });
      assert.strictEqual(await getArtist(RADIOHEAD), null);
      assert.strictEqual(await getAlbum(OK_COMPUTER), null);
    }

    assert.deepStrictEqual(calls, {
      lidarr: [],
      musicBrainz: [],
      metadata: [],
    });
  });

  it('uses the server marked default among several', async () => {
    answerWith({});
    getSettings().lidarr = [
      { ...server, id: 1, hostname: 'first', isDefault: false },
      { ...server, id: 2, hostname: 'second', isDefault: true },
    ];

    assert.strictEqual(isMusicConfigured(), true);
    await searchMusic('radiohead');

    const baseUrl = (clients[0] as unknown as { axios: AxiosInstance }).axios
      .defaults.baseURL;
    assert.strictEqual(baseUrl, 'http://second:18686/api/v1');
  });
});

describe('searchMusic', () => {
  it('looks artists and albums up by the term and answers what Lidarr found, as cards', async () => {
    answerWith({
      lookupArtists: lidarrFixture('artist-lookup-term'),
      lookupAlbums: lidarrFixture('album-lookup-term'),
    });

    const results = await searchMusic('radiohead');

    assert.deepStrictEqual(calls.lidarr.sort(), [
      'lookupAlbums radiohead',
      'lookupArtists radiohead',
    ]);
    assert.deepStrictEqual(calls.musicBrainz, []);

    const artist = results.artists[0];
    assert.strictEqual(artist.id, RADIOHEAD);
    assert.strictEqual(artist.name, 'Radiohead');
    assert.strictEqual(artist.artistType, 'Group');
    assert.strictEqual(artist.inLidarr, false);
    assert.match(artist.imageUrl ?? '', /^https:\/\/images\.lidarr\.audio\//);

    const album = results.albums[0];
    assert.strictEqual(album.id, OK_COMPUTER);
    assert.strictEqual(album.title, 'OK Computer');
    assert.deepStrictEqual(album.artist, { id: RADIOHEAD, name: 'Radiohead' });
    assert.strictEqual(album.releaseDate, '1997-05-21T00:00:00Z');
    assert.strictEqual(album.albumType, 'Album');
    assert.strictEqual(album.inLidarr, false);
    assert.match(album.coverUrl ?? '', /^https:\/\/images\.lidarr\.audio\//);
  });

  it("carries the lookup's overview in an artist's summary, and leaves it out where the lookup gives none", async () => {
    const lookup = lidarrFixture<LidarrArtist[]>('artist-lookup-term');
    const given = lookup.find((a) => a.overview);
    const none = lookup.find((a) => !a.overview);
    assert.ok(given && none);

    answerWith({
      lookupArtists: lookup,
      lookupAlbums: lidarrFixture('album-lookup-term'),
    });

    const results = await searchMusic('radiohead');
    const withOverview = results.artists.find(
      (a) => a.name === given.artistName
    );
    const without = results.artists.find((a) => a.name === none.artistName);

    assert.strictEqual(withOverview?.overview, given.overview);
    assert.match(
      withOverview?.overview ?? '',
      /^Radiohead are an English rock band/
    );
    assert.ok(without);
    assert.ok(!('overview' in without) || without.overview === undefined);
    assert.strictEqual(without.overview, undefined);
  });

  it('shows what Lidarr holds as held', async () => {
    answerWith({
      lookupArtists: [held()],
      lookupAlbums: [heldAlbumLookup()],
    });

    const results = await searchMusic('radiohead');

    assert.strictEqual(results.artists[0].inLidarr, true);
    assert.strictEqual(results.albums[0].inLidarr, true);
  });

  it('answers the first 10 artists and the first 10 albums, in Lidarr order', async () => {
    const artist = lookedUpArtist();
    const album = lookedUpAlbum();
    answerWith({
      lookupArtists: Array.from({ length: 12 }, (_, i) => ({
        ...artist,
        foreignArtistId: `artist-${i}`,
      })),
      lookupAlbums: Array.from({ length: 11 }, (_, i) => ({
        ...album,
        foreignAlbumId: `album-${i}`,
      })),
    });

    const results = await searchMusic('radiohead');

    assert.deepStrictEqual(
      results.artists.map((a) => a.id),
      Array.from({ length: 10 }, (_, i) => `artist-${i}`)
    );
    assert.deepStrictEqual(
      results.albums.map((a) => a.id),
      Array.from({ length: 10 }, (_, i) => `album-${i}`)
    );
  });

  it('answers the albums when the artist lookup fails, and the artists when the album lookup fails', async () => {
    answerWith({
      lookupArtists: boom(),
      lookupAlbums: lidarrFixture('album-lookup-term'),
    });

    const first = await searchMusic('radiohead');
    assert.deepStrictEqual(first.artists, []);
    assert.strictEqual(first.albums.length, 2);

    mock.restoreAll();
    lidarrCache().flush();
    answerWith({
      lookupArtists: lidarrFixture('artist-lookup-term'),
      lookupAlbums: boom(),
    });

    const second = await searchMusic('radiohead');
    assert.deepStrictEqual(second.albums, []);
    assert.ok(second.artists.length > 0);
  });

  it('answers no music when both lookups fail, and does not throw', async () => {
    answerWith({ lookupArtists: boom(), lookupAlbums: boom() });

    assert.deepStrictEqual(await searchMusic('radiohead'), {
      artists: [],
      albums: [],
    });
  });

  it('answers no music for a name Lidarr finds nothing for', async () => {
    answerWith({
      lookupArtists: lidarrFixture('artist-lookup-none'),
      lookupAlbums: [],
    });

    assert.deepStrictEqual(await searchMusic('zzzzqqqq'), {
      artists: [],
      albums: [],
    });
  });

  it('asks Lidarr once for the same term, keeps lookups 6 hours, and does not keep a failure', async () => {
    answerWith({
      lookupArtists: lidarrFixture('artist-lookup-term'),
      lookupAlbums: lidarrFixture('album-lookup-term'),
    });
    const set = mock.method(lidarrCache().data, 'set');

    const first = await searchMusic('radiohead');
    const second = await searchMusic('radiohead');

    assert.deepStrictEqual(second, first);
    assert.strictEqual(calls.lidarr.length, 2);
    assert.deepStrictEqual(
      set.mock.calls.map((call) => call.arguments[2]),
      [21600, 21600]
    );

    await searchMusic('thom yorke');
    assert.strictEqual(calls.lidarr.length, 4);

    mock.restoreAll();
    answerWith({ lookupArtists: boom(), lookupAlbums: boom() });
    await searchMusic('failing');
    await searchMusic('failing');
    assert.strictEqual(calls.lidarr.length, 8);
  });

  it('times its Lidarr calls out after 10 seconds, whatever the network setting says', async () => {
    answerWith({});
    const network = getSettings().network;
    const before = network.apiRequestTimeout;
    network.apiRequestTimeout = 45000;

    try {
      await searchMusic('radiohead');
    } finally {
      network.apiRequestTimeout = before;
    }

    assert.ok(clients.length > 0);
    for (const client of clients) {
      assert.strictEqual(
        (client as unknown as { axios: AxiosInstance }).axios.defaults.timeout,
        10000
      );
    }
  });
});

describe('searchMusic of a held artist', () => {
  const POSTER = 'https://example.org/own-poster.jpg';

  const metadataImage = (coverType: string) =>
    radioheadMetadata().images?.find((image) => image.CoverType === coverType)
      ?.Url;

  // the held artist of the recorded lookup, with what its entry gives replaced
  const heldEntry = (given: Partial<LidarrArtist>) => ({
    ...termLookupHeldCovered()[0],
    ...given,
  });

  const search = (artists: LidarrArtist[], metadata?: Answers['metadata']) => {
    answerWith({
      lookupArtists: artists,
      lookupAlbums: lidarrFixture('album-lookup-term'),
      metadata,
    });

    return searchMusic('radiohead');
  };

  it("takes the image and the overview of an artist the lookup answers with paths on Lidarr's disk and no overview from the metadata service, never asking a lookup by id nor an artist Lidarr does not hold", async () => {
    const lookup = termLookupHeldCovered();
    const [record, ...others] = lookup;
    // the state of the test Lidarr once it has downloaded the covers
    assert.ok(record.id);
    assert.strictEqual(record.foreignArtistId, RADIOHEAD);
    assert.ok(record.images.length > 0);
    assert.ok(
      record.images.every((image) => image.remoteUrl?.startsWith('/config/'))
    );
    assert.ok(!record.overview);
    assert.strictEqual(others.length, 9);
    assert.ok(others.every((artist) => !artist.id));
    const service = radioheadMetadata();
    assert.ok(service.overview);

    const results = await search(lookup, service);

    assert.deepStrictEqual(calls.metadata, [`/artist/${RADIOHEAD}`]);
    assert.ok(!calls.lidarr.some((call) => call.startsWith('lookupArtistBy')));
    assert.ok(!calls.lidarr.includes('getArtists'));
    assert.deepStrictEqual(calls.musicBrainz, []);
    assert.strictEqual(results.artists.length, 10);

    const [artist] = results.artists;
    assert.strictEqual(artist.id, RADIOHEAD);
    assert.strictEqual(artist.imageUrl, metadataImage('Poster'));
    assert.match(artist.imageUrl ?? '', /^https:\/\//);
    assert.strictEqual(artist.overview, service.overview);
    // the rest stays the lookup's
    assert.strictEqual(artist.name, 'Radiohead');
    assert.strictEqual(artist.artistType, 'Group');
    assert.strictEqual(artist.inLidarr, true);

    // the artists it does not hold are as the lookup gave them
    for (const other of results.artists.slice(1)) {
      assert.strictEqual(other.inLidarr, false);
      assert.strictEqual(other.imageUrl, undefined);
      assert.strictEqual(other.overview, undefined);
    }
    // the albums of search are as they were
    assert.deepStrictEqual(
      results.albums.map((a) => [a.id, a.title, a.coverUrl]),
      lidarrFixture<LidarrAlbum[]>('album-lookup-term').map((a) => [
        a.foreignAlbumId,
        a.title,
        a.images.find((i) => i.coverType === 'cover')?.remoteUrl,
      ])
    );
  });

  it('does not ask the service for a held artist whose entry gives an http(s) image and an overview', async () => {
    const results = await search(
      [
        heldEntry({
          images: [{ coverType: 'poster', url: '', remoteUrl: POSTER }],
          overview: 'Own text',
        }),
        ...termLookupHeldCovered().slice(1),
      ],
      radioheadMetadata()
    );

    assert.deepStrictEqual(calls.metadata, []);
    assert.strictEqual(results.artists[0].imageUrl, POSTER);
    assert.strictEqual(results.artists[0].overview, 'Own text');
  });

  it("asks the service for the overview alone, keeping the entry's image", async () => {
    const results = await search(
      [
        heldEntry({
          images: [{ coverType: 'poster', url: '', remoteUrl: POSTER }],
        }),
      ],
      radioheadMetadata()
    );

    assert.deepStrictEqual(calls.metadata, [`/artist/${RADIOHEAD}`]);
    assert.strictEqual(results.artists[0].imageUrl, POSTER);
    assert.strictEqual(
      results.artists[0].overview,
      radioheadMetadata().overview
    );
  });

  it("asks the service for the image alone, keeping the entry's overview", async () => {
    const results = await search(
      [heldEntry({ overview: 'Own text' })],
      radioheadMetadata()
    );

    assert.deepStrictEqual(calls.metadata, [`/artist/${RADIOHEAD}`]);
    assert.strictEqual(results.artists[0].imageUrl, metadataImage('Poster'));
    assert.strictEqual(results.artists[0].overview, 'Own text');
  });

  it("takes the poster, not another image of the service's, and passes only an http(s) URL and no empty overview", async () => {
    const service = radioheadMetadata();
    const withImages = (images: LidarrMetadataArtist['images']) => ({
      ...service,
      overview: '',
      images,
    });

    const other = await search(
      [heldEntry({})],
      withImages([
        { CoverType: 'Fanart', Url: 'https://example.org/fanart.jpg' },
        { CoverType: 'Poster', Url: 'https://example.org/poster.jpg' },
      ])
    );
    assert.strictEqual(
      other.artists[0].imageUrl,
      'https://example.org/poster.jpg'
    );
    assert.strictEqual(other.artists[0].overview, undefined);

    mock.restoreAll();
    lidarrCache().flush();
    cacheManager.getCache('lidarrmetadata').flush();
    const notUrl = await search(
      [heldEntry({})],
      withImages([
        { CoverType: 'Poster', Url: '/config/MediaCover/5/poster.jpg' },
        { CoverType: 'Fanart', Url: 'https://example.org/fanart.jpg' },
      ])
    );
    assert.strictEqual(notUrl.artists[0].imageUrl, undefined);
  });

  it('asks the held artists missing one side by side, each once', async () => {
    const entries = [1, 2, 3].map((n) =>
      heldEntry({ id: 100 + n, foreignArtistId: `held-${n}` })
    );
    // one of them gives both, one is not held
    const complete = heldEntry({
      id: 104,
      foreignArtistId: 'held-complete',
      images: [{ coverType: 'poster', url: '', remoteUrl: POSTER }],
      overview: 'Own text',
    });
    const unheld = heldEntry({
      id: undefined,
      foreignArtistId: 'not-held',
      images: [],
    });

    const results = await search([...entries, complete, unheld], {
      ...radioheadMetadata(),
    });
    // (answerWith's service delay was none; see the next test for the overlap)

    assert.deepStrictEqual(calls.metadata.sort(), [
      '/artist/held-1',
      '/artist/held-2',
      '/artist/held-3',
    ]);
    assert.strictEqual(results.artists.length, 5);
    assert.strictEqual(results.artists[4].imageUrl, undefined);
  });

  it('makes those calls at once, not one after another', async () => {
    const entries = [1, 2, 3].map((n) =>
      heldEntry({ id: 100 + n, foreignArtistId: `held-${n}` })
    );
    answerWith({
      lookupArtists: entries,
      lookupAlbums: [],
      metadata: radioheadMetadata(),
      metadataDelay: 30,
    });

    await searchMusic('radiohead');

    assert.strictEqual(calls.metadata.length, 3);
    assert.strictEqual(metadataMostInFlight, 3);
  });

  it('asks for the artists among the first 10 only', async () => {
    const entries = Array.from({ length: 12 }, (_, i) =>
      heldEntry({ id: 200 + i, foreignArtistId: `held-${i}` })
    );

    const results = await search(entries, radioheadMetadata());

    assert.strictEqual(results.artists.length, 10);
    assert.deepStrictEqual(
      calls.metadata.sort(),
      Array.from({ length: 10 }, (_, i) => `/artist/held-${i}`).sort()
    );
  });

  it("leaves a summary as the lookup gave it, and the search's other results standing, when the service fails, times out or does not know the id", async () => {
    const failures: [string, Error | null][] = [
      ['fails', boom()],
      [
        'times out',
        Object.assign(new Error('timeout of 10000ms exceeded'), {
          code: 'ECONNABORTED',
        }),
      ],
      ['does not know the id', null],
    ];

    for (const [, failure] of failures) {
      mock.restoreAll();
      lidarrCache().flush();
      cacheManager.getCache('lidarrmetadata').flush();
      calls = { lidarr: [], musicBrainz: [], metadata: [] };
      const lookup = termLookupHeldCovered();

      const results = await search(lookup, failure);

      assert.deepStrictEqual(calls.metadata, [`/artist/${RADIOHEAD}`]);
      assert.strictEqual(results.artists.length, 10);
      assert.deepStrictEqual(results.artists[0], {
        id: RADIOHEAD,
        name: 'Radiohead',
        disambiguation: undefined,
        artistType: 'Group',
        overview: undefined,
        imageUrl: undefined,
        inLidarr: true,
      });
      assert.deepStrictEqual(
        results.artists.slice(1).map((a) => a.id),
        lookup.slice(1).map((a) => a.foreignArtistId)
      );
      assert.strictEqual(results.albums.length, 2);
    }
  });

  it('leaves one failing artist as it was and gives the others what the service gave', async () => {
    const entries = [1, 2].map((n) =>
      heldEntry({ id: 100 + n, foreignArtistId: `held-${n}` })
    );
    answerWith({ lookupArtists: entries, lookupAlbums: [] });
    // the service answers one id and fails for the other
    const wire = (getLidarrMetadata() as unknown as { axios: AxiosInstance })
      .axios;
    mock.method(wire, 'get', async (url: string) => {
      if (url.endsWith('held-1')) {
        throw boom();
      }

      return { data: radioheadMetadata() };
    });

    const results = await searchMusic('radiohead');

    assert.strictEqual(results.artists[0].imageUrl, undefined);
    assert.strictEqual(results.artists[0].overview, undefined);
    assert.strictEqual(results.artists[1].imageUrl, metadataImage('Poster'));
    assert.strictEqual(
      results.artists[1].overview,
      radioheadMetadata().overview
    );
  });
});

describe('getArtist where Lidarr holds the artist', () => {
  const POSTER = 'https://example.org/own-poster.jpg';
  const FANART = 'https://example.org/own-fanart.jpg';

  // the record of a held artist with some of the three given as they are
  const recordWith = (given: {
    poster?: string;
    fanart?: string;
    overview?: string;
  }): LidarrArtist => ({
    ...heldCovered(),
    images: [
      ...(given.poster
        ? [{ coverType: 'poster', url: '', remoteUrl: given.poster }]
        : [
            {
              coverType: 'poster',
              url: '/MediaCover/5/poster.jpg',
              remoteUrl: '/config/MediaCover/5/poster.jpg',
            },
          ]),
      ...(given.fanart
        ? [{ coverType: 'fanart', url: '', remoteUrl: given.fanart }]
        : [
            {
              coverType: 'fanart',
              url: '/MediaCover/5/fanart.jpg',
              remoteUrl: '/config/MediaCover/5/fanart.jpg',
            },
          ]),
    ],
    overview: given.overview ?? '',
  });

  const metadataImage = (coverType: string) =>
    radioheadMetadata().images?.find((image) => image.CoverType === coverType)
      ?.Url;

  const metadataCalls = () => [`/artist/${RADIOHEAD}`];

  it("answers Lidarr's own record and its albums, and asks MusicBrainz for nothing", async () => {
    answerWith({
      getArtists: lidarrFixture('artists'),
      getAlbums: heldAlbums(),
      metadata: radioheadMetadata(),
    });

    const artist = await getArtist(RADIOHEAD);

    assert.deepStrictEqual(calls.lidarr, ['getArtists', 'getAlbums 3']);
    assert.deepStrictEqual(calls.musicBrainz, []);
    assert.ok(artist);
    assert.strictEqual(artist.id, RADIOHEAD);
    assert.strictEqual(artist.name, 'Radiohead');
    assert.strictEqual(artist.inLidarr, true);
    assert.strictEqual(artist.artistType, 'Group');
    assert.deepStrictEqual(
      artist.albums.map((album) => [album.id, album.title, album.inLidarr]),
      heldAlbums().map((album) => [album.foreignAlbumId, album.title, true])
    );
    // Lidarr's albums carry their own covers
    assert.match(
      artist.albums[0].coverUrl ?? '',
      /^https:\/\/images\.lidarr\.audio\//
    );
  });

  it("takes the image, the backdrop and the overview from Lidarr's metadata service for an artist whose record and lookup give paths on Lidarr's disk and no overview, and never asks the lookup", async () => {
    const record = heldCovered();
    const lookup = lookedUpHeldCovered();
    // the state of the test Lidarr once it has downloaded the covers
    for (const side of [record, lookup]) {
      assert.ok(side.images.length > 0);
      assert.ok(
        side.images.every((image) => image.remoteUrl?.startsWith('/config/'))
      );
      assert.ok(!side.overview);
    }
    const service = radioheadMetadata();
    assert.ok(service.overview);
    answerWith({
      getArtists: [record],
      getAlbums: [],
      lookupArtistByMbid: { ...lookup, artistName: 'Not the record' },
      metadata: service,
    });

    const artist = await getArtist(RADIOHEAD);

    assert.deepStrictEqual(calls.lidarr, ['getArtists', 'getAlbums 5']);
    assert.deepStrictEqual(calls.metadata, metadataCalls());
    assert.strictEqual(artist?.imageUrl, metadataImage('Poster'));
    assert.strictEqual(artist?.backdropUrl, metadataImage('Fanart'));
    assert.strictEqual(artist?.overview, service.overview);
    assert.match(artist?.imageUrl ?? '', /^https:\/\//);
    assert.match(artist?.backdropUrl ?? '', /^https:\/\//);
    assert.notStrictEqual(artist?.imageUrl, artist?.backdropUrl);
    // the rest stays the record's
    assert.strictEqual(artist?.name, 'Radiohead');
    assert.strictEqual(artist?.inLidarr, true);
    assert.strictEqual(artist?.artistType, 'Group');
  });

  it('does not ask the service where the record gives the image, the backdrop and the overview', async () => {
    answerWith({
      getArtists: [
        recordWith({ poster: POSTER, fanart: FANART, overview: 'Own text' }),
      ],
      getAlbums: [],
      metadata: radioheadMetadata(),
    });

    const artist = await getArtist(RADIOHEAD);

    assert.strictEqual(artist?.imageUrl, POSTER);
    assert.strictEqual(artist?.backdropUrl, FANART);
    assert.strictEqual(artist?.overview, 'Own text');
    assert.deepStrictEqual(calls.metadata, []);
    assert.deepStrictEqual(calls.lidarr, ['getArtists', 'getAlbums 5']);
  });

  it("asks the service for the overview alone, keeping the record's image and backdrop", async () => {
    answerWith({
      getArtists: [recordWith({ poster: POSTER, fanart: FANART })],
      getAlbums: [],
      metadata: radioheadMetadata(),
    });

    const artist = await getArtist(RADIOHEAD);

    assert.deepStrictEqual(calls.metadata, metadataCalls());
    assert.strictEqual(artist?.imageUrl, POSTER);
    assert.strictEqual(artist?.backdropUrl, FANART);
    assert.strictEqual(artist?.overview, radioheadMetadata().overview);
  });

  it("asks the service for the image alone, keeping the record's backdrop and overview", async () => {
    answerWith({
      getArtists: [recordWith({ fanart: FANART, overview: 'Own text' })],
      getAlbums: [],
      metadata: radioheadMetadata(),
    });

    const artist = await getArtist(RADIOHEAD);

    assert.deepStrictEqual(calls.metadata, metadataCalls());
    assert.strictEqual(artist?.imageUrl, metadataImage('Poster'));
    assert.strictEqual(artist?.backdropUrl, FANART);
    assert.strictEqual(artist?.overview, 'Own text');
  });

  it("asks the service for the backdrop alone, keeping the record's image and overview", async () => {
    answerWith({
      getArtists: [recordWith({ poster: POSTER, overview: 'Own text' })],
      getAlbums: [],
      metadata: radioheadMetadata(),
    });

    const artist = await getArtist(RADIOHEAD);

    assert.deepStrictEqual(calls.metadata, metadataCalls());
    assert.strictEqual(artist?.imageUrl, POSTER);
    assert.strictEqual(artist?.backdropUrl, metadataImage('Fanart'));
    assert.strictEqual(artist?.overview, 'Own text');
  });

  it("takes the poster for the image and the fanart for the backdrop, not another image of the service's", async () => {
    const service = radioheadMetadata();
    service.images = [
      { CoverType: 'Banner', Url: 'https://example.org/banner.jpg' },
      { CoverType: 'Fanart', Url: 'https://example.org/fanart.jpg' },
      { CoverType: 'Logo', Url: 'https://example.org/logo.png' },
      { CoverType: 'Poster', Url: 'https://example.org/poster.jpg' },
    ];
    answerWith({
      getArtists: [heldCovered()],
      getAlbums: [],
      metadata: service,
    });

    const artist = await getArtist(RADIOHEAD);

    assert.strictEqual(artist?.imageUrl, 'https://example.org/poster.jpg');
    assert.strictEqual(artist?.backdropUrl, 'https://example.org/fanart.jpg');
  });

  it("passes only an http(s) URL of the service's, and no empty overview", async () => {
    answerWith({
      getArtists: [heldCovered()],
      getAlbums: [],
      metadata: {
        ...radioheadMetadata(),
        overview: '',
        images: [
          { CoverType: 'Poster', Url: '/config/MediaCover/5/poster.jpg' },
          { CoverType: 'Fanart', Url: 'ftp://example.org/fanart.jpg' },
        ],
      },
    });

    const artist = await getArtist(RADIOHEAD);

    assert.strictEqual(artist?.imageUrl, undefined);
    assert.strictEqual(artist?.backdropUrl, undefined);
    assert.strictEqual(artist?.overview, undefined);
    assert.strictEqual(artist?.name, 'Radiohead');
  });

  it('asks the service once for two reads of a held artist, and keeps its answer 24 hours', async () => {
    answerWith({
      getArtists: [heldCovered()],
      getAlbums: [],
      metadata: radioheadMetadata(),
    });
    const set = mock.method(
      cacheManager.getCache('lidarrmetadata').data,
      'set'
    );

    await getArtist(RADIOHEAD);
    await getArtist(RADIOHEAD);

    assert.deepStrictEqual(calls.metadata, metadataCalls());
    assert.deepStrictEqual(
      set.mock.calls.map((call) => call.arguments[2]),
      [86400]
    );
  });

  it('leaves the artist without the three, the rest standing, when the service fails, times out or does not know the id', async () => {
    const failures: [string, Error | null][] = [
      ['fails', boom()],
      [
        'times out',
        Object.assign(new Error('timeout of 10000ms exceeded'), {
          code: 'ECONNABORTED',
        }),
      ],
      ['does not know the id', null],
    ];

    for (const [, failure] of failures) {
      lidarrCache().flush();
      cacheManager.getCache('lidarrmetadata').flush();
      mock.restoreAll();
      calls = { lidarr: [], musicBrainz: [], metadata: [] };
      answerWith({
        getArtists: [heldCovered()],
        getAlbums: heldAlbums(),
        lookupArtistByMbid: lookedUpHeldCovered(),
        metadata: failure,
      });

      const artist = await getArtist(RADIOHEAD);

      assert.deepStrictEqual(calls.metadata, metadataCalls());
      assert.strictEqual(artist?.imageUrl, undefined);
      assert.strictEqual(artist?.backdropUrl, undefined);
      assert.strictEqual(artist?.overview, undefined);
      assert.strictEqual(artist?.name, 'Radiohead');
      assert.strictEqual(artist?.inLidarr, true);
      assert.strictEqual(artist?.albums.length, heldAlbums().length);
      // the lookup of a held artist is never the fall-back
      assert.ok(!calls.lidarr.some((call) => call.startsWith('lookupArtist')));
    }
  });

  it('does not keep what the service failed or did not know, and asks again', async () => {
    for (const failure of [boom(), null]) {
      lidarrCache().flush();
      cacheManager.getCache('lidarrmetadata').flush();
      mock.restoreAll();
      calls = { lidarr: [], musicBrainz: [], metadata: [] };
      answerWith({
        getArtists: [heldCovered()],
        getAlbums: [],
        metadata: failure,
      });
      const set = mock.method(
        cacheManager.getCache('lidarrmetadata').data,
        'set'
      );

      await getArtist(RADIOHEAD);
      await getArtist(RADIOHEAD);

      assert.strictEqual(calls.metadata.length, 2);
      assert.strictEqual(set.mock.calls.length, 0);
    }
  });

  it('keeps the held records 5 minutes', async () => {
    // a record that gives all three needs no service
    answerWith({
      getArtists: [
        recordWith({ poster: POSTER, fanart: FANART, overview: 'Own text' }),
      ],
      getAlbums: heldAlbums(),
    });
    const set = mock.method(lidarrCache().data, 'set');

    await getArtist(RADIOHEAD);
    await getArtist(RADIOHEAD);

    assert.strictEqual(calls.lidarr.length, 2);
    assert.deepStrictEqual(
      set.mock.calls.map((call) => call.arguments[2]),
      [300, 300]
    );
  });

  it("answers the artist with no albums when Lidarr cannot give them, not MusicBrainz's", async () => {
    answerWith({
      getArtists: [held()],
      getAlbums: boom(),
      releaseGroups: musicBrainzFixture<{
        'release-groups': MusicBrainzReleaseGroup[];
      }>('release-groups-page1')['release-groups'],
    });

    const artist = await getArtist(RADIOHEAD);

    assert.strictEqual(artist?.name, 'Radiohead');
    assert.deepStrictEqual(artist?.albums, []);
    assert.deepStrictEqual(calls.musicBrainz, []);
  });
});

describe('getArtist where Lidarr holds other artists', () => {
  it('takes the artist of the id, not another held one', async () => {
    answerWith({
      getArtists: [held()],
      lookupArtistByMbid: { ...lookedUpArtist(), artistName: 'Muse' },
    });

    const artist = await getArtist('9c9f1380-2516-4fc9-a3e6-f9f61941d090');

    assert.strictEqual(artist?.name, 'Muse');
    assert.strictEqual(artist?.inLidarr, false);
    assert.deepStrictEqual(calls.lidarr, [
      'getArtists',
      'lookupArtistByMbid 9c9f1380-2516-4fc9-a3e6-f9f61941d090',
    ]);
  });
});

describe('getArtist where Lidarr does not hold the artist', () => {
  it("does not ask Lidarr's metadata service: its lookup gives the images and the overview", async () => {
    // even where the lookup gives neither an image nor an overview
    answerWith({
      lookupArtistByMbid: { ...lookedUpArtist(), images: [], overview: '' },
      metadata: radioheadMetadata(),
    });

    const artist = await getArtist(RADIOHEAD);

    assert.deepStrictEqual(calls.metadata, []);
    assert.strictEqual(artist?.imageUrl, undefined);
    assert.strictEqual(artist?.overview, undefined);
  });

  const groups = () =>
    [1, 2, 3].flatMap(
      (page) =>
        musicBrainzFixture<{ 'release-groups': MusicBrainzReleaseGroup[] }>(
          `release-groups-page${page}`
        )['release-groups']
    );

  it('answers its lookup, with the studio albums of MusicBrainz and their Cover Art Archive covers', async () => {
    answerWith({
      getArtists: lidarrFixture<LidarrArtist[]>('artists').filter(
        (a) => a.foreignArtistId !== RADIOHEAD
      ),
      lookupArtistByMbid: lookedUpArtist(),
      releaseGroups: groups(),
    });

    const artist = await getArtist(RADIOHEAD);

    assert.deepStrictEqual(calls.lidarr, [
      'getArtists',
      `lookupArtistByMbid ${RADIOHEAD}`,
    ]);
    assert.deepStrictEqual(calls.musicBrainz, [
      `/release-group ${RADIOHEAD} 0`,
      `/release-group ${RADIOHEAD} 100`,
      `/release-group ${RADIOHEAD} 200`,
    ]);
    assert.ok(artist);
    assert.strictEqual(artist.id, RADIOHEAD);
    assert.strictEqual(artist.name, 'Radiohead');
    assert.match(artist.overview ?? '', /^Radiohead are an English rock band/);
    assert.strictEqual(artist.inLidarr, false);
    assert.strictEqual(artist.artistType, 'Group');
    assert.match(artist.imageUrl ?? '', /^https:\/\/images\.lidarr\.audio\//);
    assert.match(
      artist.backdropUrl ?? '',
      /^https:\/\/images\.lidarr\.audio\//
    );
    assert.deepStrictEqual(
      artist.albums.map((album) => album.title),
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
    for (const album of artist.albums) {
      assert.strictEqual(album.albumType, 'Album');
      assert.deepStrictEqual(album.secondaryTypes, []);
      assert.strictEqual(album.inLidarr, false);
      assert.strictEqual(
        album.coverUrl,
        `https://coverartarchive.org/release-group/${album.id}/front-250`
      );
    }
    assert.strictEqual(artist.albums[3].id, OK_COMPUTER);
    assert.strictEqual(artist.albums[3].releaseDate, '1997-05-21');
  });

  it('keeps the lookup 6 hours', async () => {
    answerWith({ lookupArtistByMbid: lookedUpArtist() });
    const set = mock.method(lidarrCache().data, 'set');

    await getArtist(RADIOHEAD);
    await getArtist(RADIOHEAD);

    assert.strictEqual(
      calls.lidarr.filter((call) => call.startsWith('lookupArtistByMbid'))
        .length,
      1
    );
    assert.ok(set.mock.calls.some((call) => call.arguments[2] === 21600));
  });

  it('answers the artist with no albums, the rest standing, when MusicBrainz fails', async () => {
    answerWith({
      lookupArtistByMbid: lookedUpArtist(),
      releaseGroups: boom(),
    });

    const artist = await getArtist(RADIOHEAD);

    assert.strictEqual(artist?.name, 'Radiohead');
    assert.match(artist?.overview ?? '', /^Radiohead/);
    assert.deepStrictEqual(artist?.albums, []);
    assert.strictEqual(calls.musicBrainz.length, 1);
  });

  it('answers null for an id nobody answers for', async () => {
    answerWith({ lookupArtistByMbid: null });

    assert.strictEqual(
      await getArtist('00000000-0000-4000-8000-000000000000'),
      null
    );
    assert.deepStrictEqual(calls.musicBrainz, []);
  });

  it('does not keep a not-found answer', async () => {
    answerWith({ lookupArtistByMbid: null });

    await getArtist(RADIOHEAD);
    await getArtist(RADIOHEAD);

    assert.strictEqual(
      calls.lidarr.filter((call) => call.startsWith('lookupArtistByMbid'))
        .length,
      2
    );
  });

  it('is a stated error where its own metadata cannot be read', async () => {
    answerWith({ lookupArtistByMbid: boom(), releaseGroups: groups() });

    const error = await rejection(getArtist(RADIOHEAD));

    assert.ok(error instanceof MusicSourceError);
    assert.match(error.message, /^Failed to read the artist: /);
    assert.deepStrictEqual(calls.musicBrainz, []);
  });

  it('takes the lookup when the list of held artists cannot be read', async () => {
    answerWith({
      getArtists: boom(),
      lookupArtistByMbid: lookedUpArtist(),
      releaseGroups: groups(),
    });

    const artist = await getArtist(RADIOHEAD);

    assert.strictEqual(artist?.name, 'Radiohead');
    assert.strictEqual(artist?.albums.length, 10);
  });
});

describe('the images of an artist', () => {
  const image = (coverType: string, remoteUrl?: string) => ({
    coverType,
    url: `/MediaCover/x/${coverType}.jpg`,
    remoteUrl,
  });

  async function artistWith(images: ReturnType<typeof image>[]) {
    lidarrCache().flush();
    mock.restoreAll();
    answerWith({
      lookupArtistByMbid: { ...lookedUpArtist(), images },
    });

    return getArtist(RADIOHEAD);
  }

  it('is the poster, else the first image, else none; its backdrop the fanart', async () => {
    const withPoster = await artistWith([
      image('banner', 'https://example.org/banner.jpg'),
      image('poster', 'https://example.org/poster.jpg'),
      image('fanart', 'https://example.org/fanart.jpg'),
    ]);
    assert.strictEqual(withPoster?.imageUrl, 'https://example.org/poster.jpg');
    assert.strictEqual(
      withPoster?.backdropUrl,
      'https://example.org/fanart.jpg'
    );

    const withoutPoster = await artistWith([
      image('banner', 'https://example.org/banner.jpg'),
      image('clearlogo', 'https://example.org/logo.png'),
    ]);
    assert.strictEqual(
      withoutPoster?.imageUrl,
      'https://example.org/banner.jpg'
    );
    assert.strictEqual(withoutPoster?.backdropUrl, undefined);

    const none = await artistWith([]);
    assert.strictEqual(none?.imageUrl, undefined);
    assert.strictEqual(none?.backdropUrl, undefined);

    const noUrl = await artistWith([image('poster')]);
    assert.strictEqual(noUrl?.imageUrl, undefined);
  });
});

describe('the cover of an album', () => {
  async function coverOf(album: Partial<LidarrAlbum>) {
    lidarrCache().flush();
    mock.restoreAll();
    answerWith({ lookupAlbumByMbid: { ...lookedUpAlbum(), ...album } });

    return (await getAlbum(OK_COMPUTER))?.coverUrl;
  }

  it("is its Lidarr cover, else the lookup's remoteCover, else the Cover Art Archive's front image", async () => {
    assert.strictEqual(
      await coverOf({
        images: [
          {
            coverType: 'disc',
            url: '/d',
            remoteUrl: 'https://example.org/disc.jpg',
          },
          {
            coverType: 'cover',
            url: '/c',
            remoteUrl: 'https://example.org/cover.jpg',
          },
        ],
        remoteCover: 'https://example.org/remote.jpg',
      }),
      'https://example.org/cover.jpg'
    );
    assert.strictEqual(
      await coverOf({
        images: [
          {
            coverType: 'disc',
            url: '/d',
            remoteUrl: 'https://example.org/disc.jpg',
          },
        ],
        remoteCover: 'https://example.org/remote.jpg',
      }),
      'https://example.org/remote.jpg'
    );
    assert.strictEqual(
      await coverOf({ images: [], remoteCover: undefined }),
      `https://coverartarchive.org/release-group/${OK_COMPUTER}/front-250`
    );
  });
});

describe('getAlbum', () => {
  const release = () =>
    musicBrainzFixture<MusicBrainzRelease>('release-monitored');

  it('answers the title, artist, year, types and cover of the lookup', async () => {
    answerWith({
      lookupAlbumByMbid: lookedUpAlbum(),
      releases: { [MONITORED_RELEASE]: release() },
    });

    const album = await getAlbum(OK_COMPUTER);

    assert.ok(album);
    assert.strictEqual(album.id, OK_COMPUTER);
    assert.strictEqual(album.title, 'OK Computer');
    assert.deepStrictEqual(album.artist, { id: RADIOHEAD, name: 'Radiohead' });
    assert.strictEqual(album.releaseDate, '1997-05-21T00:00:00Z');
    assert.strictEqual(album.albumType, 'Album');
    assert.deepStrictEqual(album.secondaryTypes, []);
    assert.strictEqual(album.inLidarr, false);
    assert.match(album.coverUrl ?? '', /^https:\/\/images\.lidarr\.audio\//);
  });

  describe('where Lidarr holds the album', () => {
    it("answers Lidarr's tracks of it, ordered by disc and position, and asks MusicBrainz for nothing", async () => {
      const tracks = lidarrFixture<LidarrTrack[]>('tracks');
      answerWith({
        lookupAlbumByMbid: heldAlbumLookup(),
        // Lidarr answers in no order the page can rely on
        getTracks: [...tracks].reverse(),
      });

      const album = await getAlbum(OK_COMPUTER);

      assert.deepStrictEqual(calls.lidarr, [
        `lookupAlbumByMbid ${OK_COMPUTER}`,
        'getTracks 45',
      ]);
      assert.deepStrictEqual(calls.musicBrainz, []);
      assert.ok(album);
      assert.strictEqual(album.inLidarr, true);
      assert.strictEqual(album.tracks.length, 91);
      assert.deepStrictEqual(album.tracks[0], {
        disc: 1,
        position: 1,
        number: 'A1',
        title: 'Airbag',
        length: 284000,
      });
      assert.deepStrictEqual(
        album.tracks.map((t) => [t.disc, t.position]),
        [...tracks]
          .sort(
            (a, b) =>
              a.mediumNumber - b.mediumNumber ||
              a.absoluteTrackNumber - b.absoluteTrackNumber
          )
          .map((t) => [t.mediumNumber, t.absoluteTrackNumber])
      );
      // a track with no number of its own on a later disc: the number as given
      assert.ok(
        album.tracks.some(
          (t) => t.disc === 5 && t.number === '7' && t.position === 7
        )
      );
    });

    it('answers no tracks, the rest standing, when Lidarr cannot give them', async () => {
      answerWith({
        lookupAlbumByMbid: heldAlbumLookup(),
        getTracks: boom(),
        releases: { [MONITORED_RELEASE]: release() },
      });

      const album = await getAlbum(OK_COMPUTER);

      assert.strictEqual(album?.title, 'OK Computer');
      assert.deepStrictEqual(album?.tracks, []);
      assert.deepStrictEqual(calls.musicBrainz, []);
    });

    it('leaves out the length of a track Lidarr does not know', async () => {
      const tracks = lidarrFixture<LidarrTrack[]>('tracks').slice(0, 2);
      tracks[0] = { ...tracks[0], duration: 0 };
      answerWith({ lookupAlbumByMbid: heldAlbumLookup(), getTracks: tracks });

      const album = await getAlbum(OK_COMPUTER);

      assert.strictEqual(album?.tracks[0].title, 'Airbag');
      assert.strictEqual(album?.tracks[0].length, undefined);
      assert.strictEqual(album?.tracks[1].length, tracks[1].duration);
    });

    it('keeps the tracks 5 minutes', async () => {
      answerWith({
        lookupAlbumByMbid: heldAlbumLookup(),
        getTracks: lidarrFixture('tracks'),
      });
      const set = mock.method(lidarrCache().data, 'set');

      await getAlbum(OK_COMPUTER);
      await getAlbum(OK_COMPUTER);

      assert.strictEqual(calls.lidarr.length, 2);
      assert.deepStrictEqual(
        set.mock.calls.map((call) => call.arguments[2]),
        [21600, 300]
      );
    });
  });

  describe('where Lidarr does not hold the album', () => {
    it('answers the tracks of the release the lookup marks monitored', async () => {
      const lookup = lookedUpAlbum();
      assert.deepStrictEqual(
        lookup.releases
          ?.filter((r) => r.monitored)
          .map((r) => r.foreignReleaseId),
        [MONITORED_RELEASE]
      );
      answerWith({
        lookupAlbumByMbid: lookup,
        releases: { [MONITORED_RELEASE]: release() },
      });

      const album = await getAlbum(OK_COMPUTER);

      assert.deepStrictEqual(calls.lidarr, [
        `lookupAlbumByMbid ${OK_COMPUTER}`,
      ]);
      assert.deepStrictEqual(calls.musicBrainz, [
        `/release/${MONITORED_RELEASE}`,
      ]);
      assert.strictEqual(album?.tracks.length, 91);
      assert.deepStrictEqual(album?.tracks[0], {
        disc: 1,
        position: 1,
        number: 'A1',
        title: 'Airbag',
        length: 284000,
      });
      // the second medium counts from 1 again, its numbers as the release gives them
      assert.deepStrictEqual(
        album?.tracks.filter((t) => t.disc === 2).slice(0, 1),
        [
          {
            disc: 2,
            position: 1,
            number: 'C1',
            title: 'Fitter Happier',
            length: 117000,
          },
        ]
      );
      assert.deepStrictEqual(
        [...new Set(album?.tracks.map((t) => t.disc))],
        [1, 2, 3, 4, 5, 6]
      );
    });

    it('takes the first Official release where none is marked monitored', async () => {
      const lookup = lookedUpAlbum();
      lookup.releases = (lookup.releases ?? []).map((r, i) => ({
        ...r,
        monitored: false,
        status: i === 0 ? 'Bootleg' : i === 1 ? 'Official' : r.status,
      }));
      answerWith({
        lookupAlbumByMbid: lookup,
        releases: {
          [lookup.releases[1].foreignReleaseId]: musicBrainzFixture(
            'release-first-official'
          ),
        },
      });

      const album = await getAlbum(OK_COMPUTER);

      assert.deepStrictEqual(calls.musicBrainz, [
        `/release/${lookup.releases[1].foreignReleaseId}`,
      ]);
      assert.strictEqual(album?.tracks[0].title, 'Airbag');
    });

    it('takes the first release where none is monitored or Official', async () => {
      const lookup = lookedUpAlbum();
      lookup.releases = (lookup.releases ?? []).map((r) => ({
        ...r,
        monitored: false,
        status: 'Promotion',
      }));
      answerWith({
        lookupAlbumByMbid: lookup,
        releases: {
          [FIRST_OFFICIAL_RELEASE]: musicBrainzFixture(
            'release-first-official'
          ),
        },
      });

      await getAlbum(OK_COMPUTER);

      assert.strictEqual(
        lookup.releases[0].foreignReleaseId,
        FIRST_OFFICIAL_RELEASE
      );
      assert.deepStrictEqual(calls.musicBrainz, [
        `/release/${FIRST_OFFICIAL_RELEASE}`,
      ]);
    });

    it('answers no tracks, and asks MusicBrainz for nothing, for an album with no release', async () => {
      answerWith({ lookupAlbumByMbid: { ...lookedUpAlbum(), releases: [] } });

      assert.deepStrictEqual((await getAlbum(OK_COMPUTER))?.tracks, []);
      assert.deepStrictEqual(calls.musicBrainz, []);
    });

    it('leaves out the length MusicBrainz does not know', async () => {
      const recorded = release();
      assert.ok(recorded.media?.[0].tracks);
      recorded.media[0].tracks[0] = {
        ...recorded.media[0].tracks[0],
        length: null,
      };
      answerWith({
        lookupAlbumByMbid: lookedUpAlbum(),
        releases: { [MONITORED_RELEASE]: recorded },
      });

      const album = await getAlbum(OK_COMPUTER);

      assert.strictEqual(album?.tracks[0].title, 'Airbag');
      assert.strictEqual(album?.tracks[0].length, undefined);
      assert.strictEqual(album?.tracks[1].title, 'Paranoid Android');
      assert.strictEqual(album?.tracks[1].length, 383000);
    });

    it('answers no tracks, the rest standing, when MusicBrainz fails', async () => {
      answerWith({
        lookupAlbumByMbid: lookedUpAlbum(),
        releases: { [MONITORED_RELEASE]: boom() },
      });

      const album = await getAlbum(OK_COMPUTER);

      assert.strictEqual(album?.title, 'OK Computer');
      assert.deepStrictEqual(album?.artist, {
        id: RADIOHEAD,
        name: 'Radiohead',
      });
      assert.deepStrictEqual(album?.tracks, []);
    });
  });

  it('answers null for an id nobody answers for', async () => {
    answerWith({ lookupAlbumByMbid: null });

    assert.strictEqual(
      await getAlbum('00000000-0000-4000-8000-000000000000'),
      null
    );
  });

  it('is a stated error where its own metadata cannot be read', async () => {
    answerWith({ lookupAlbumByMbid: boom() });

    const error = await rejection(getAlbum(OK_COMPUTER));

    assert.ok(error instanceof MusicSourceError);
    assert.match(error.message, /^Failed to read the album: /);
  });

  it('shows an album of odd type, or of various artists, as any other', async () => {
    answerWith({
      lookupAlbumByMbid: {
        ...lookedUpAlbum(),
        albumType: 'Compilation',
        secondaryTypes: ['Live'],
        artist: undefined,
        releaseDate: undefined,
        releases: undefined,
        images: [],
        genres: undefined,
      },
    });

    const album = await getAlbum(OK_COMPUTER);

    assert.strictEqual(album?.albumType, 'Compilation');
    assert.deepStrictEqual(album?.secondaryTypes, ['Live']);
    assert.deepStrictEqual(album?.tracks, []);
    assert.deepStrictEqual(album?.genres, []);
    assert.strictEqual(album?.releaseDate, undefined);
  });
});
