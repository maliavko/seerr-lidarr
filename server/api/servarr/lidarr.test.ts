import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';

import type { AxiosInstance } from 'axios';

import type {
  LidarrAlbum,
  LidarrArtist,
  LidarrArtistOptions,
  LidarrCommand,
  LidarrTrack,
  LidarrTrackFile,
  MetadataProfile,
} from '@server/api/servarr/lidarr';
import LidarrAPI from '@server/api/servarr/lidarr';

// Lidarr's answers, recorded once from the test Lidarr (lidarr-test, v3.1.0.4875)
function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(join(__dirname, 'lidarr.fixtures', `${name}.json`), 'utf8')
  ) as T;
}

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const OK_COMPUTER = 'b1392450-e666-3926-a536-22c65f834433';
const UNKNOWN_MBID = '00000000-0000-4000-8000-000000000000';

let instance = 0;

// each client gets a URL of its own, as the cache of getRolling is keyed by it
function buildLidarr(): LidarrAPI {
  instance += 1;
  return new LidarrAPI({
    url: `http://localhost:8686/lidarr${instance}/api/v1`,
    apiKey: 'test',
  });
}

function getAxios(lidarr: LidarrAPI): AxiosInstance {
  return (lidarr as unknown as { axios: AxiosInstance }).axios;
}

// the error axios throws for an answer with a failing status
function lidarrError(status: number, data: unknown): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    return e as Error;
  }
  throw new assert.AssertionError({ message: 'expected a rejection' });
}

describe('LidarrAPI lookup', () => {
  afterEach(() => mock.restoreAll());

  it('looks artists up by term and answers what Lidarr found', async () => {
    const lidarr = buildLidarr();
    const found = fixture<LidarrArtist[]>('artist-lookup-term');
    const get = mock.method(getAxios(lidarr), 'get', async () => ({
      data: found,
    }));

    const artists = await lidarr.lookupArtists('radiohead');

    assert.strictEqual(get.mock.callCount(), 1);
    assert.deepStrictEqual(get.mock.calls[0].arguments, [
      '/artist/lookup',
      { params: { term: 'radiohead' } },
    ]);
    assert.deepStrictEqual(artists, found);
    assert.strictEqual(artists[0].artistName, 'Radiohead');
    assert.strictEqual(artists[0].foreignArtistId, RADIOHEAD);
    assert.strictEqual(artists[0].id, undefined);
  });

  it('answers an empty list when no artist is found', async () => {
    const lidarr = buildLidarr();
    mock.method(getAxios(lidarr), 'get', async () => ({
      data: fixture('artist-lookup-none'),
    }));

    assert.deepStrictEqual(await lidarr.lookupArtists('zzzzqqqq'), []);
  });

  it('looks an artist up by MusicBrainz id with the lidarr: term', async () => {
    const lidarr = buildLidarr();
    const found = fixture<LidarrArtist[]>('artist-lookup-mbid');
    const get = mock.method(getAxios(lidarr), 'get', async () => ({
      data: found,
    }));

    const artist = await lidarr.lookupArtistByMbid(RADIOHEAD);

    assert.deepStrictEqual(get.mock.calls[0].arguments, [
      '/artist/lookup',
      { params: { term: `lidarr:${RADIOHEAD}` } },
    ]);
    assert.deepStrictEqual(artist, found[0]);
    assert.strictEqual(artist?.foreignArtistId, RADIOHEAD);
  });

  it('answers the first artist when Lidarr answers several for the id', async () => {
    const lidarr = buildLidarr();
    const found = fixture<LidarrArtist[]>('artist-lookup-term');
    mock.method(getAxios(lidarr), 'get', async () => ({ data: found }));

    assert.deepStrictEqual(
      await lidarr.lookupArtistByMbid(RADIOHEAD),
      found[0]
    );
  });

  it('answers null, not a throw, when no artist has the MusicBrainz id', async () => {
    const lidarr = buildLidarr();
    const get = mock.method(getAxios(lidarr), 'get', async () => ({
      // Lidarr's answer (200) to lidarr:<an id it does not know>
      data: fixture('artist-lookup-unknown-mbid'),
    }));

    assert.strictEqual(await lidarr.lookupArtistByMbid(UNKNOWN_MBID), null);
    assert.deepStrictEqual(get.mock.calls[0].arguments, [
      '/artist/lookup',
      { params: { term: `lidarr:${UNKNOWN_MBID}` } },
    ]);
  });

  it('looks albums up by term and answers what Lidarr found', async () => {
    const lidarr = buildLidarr();
    const found = fixture<LidarrAlbum[]>('album-lookup-term');
    const get = mock.method(getAxios(lidarr), 'get', async () => ({
      data: found,
    }));

    const albums = await lidarr.lookupAlbums('ok computer');

    assert.deepStrictEqual(get.mock.calls[0].arguments, [
      '/album/lookup',
      { params: { term: 'ok computer' } },
    ]);
    assert.deepStrictEqual(albums, found);
    assert.strictEqual(albums[0].title, 'OK Computer');
    assert.strictEqual(albums[0].foreignAlbumId, OK_COMPUTER);
  });

  it('looks an album up by its release-group id with the lidarr: term', async () => {
    const lidarr = buildLidarr();
    const found = fixture<LidarrAlbum[]>('album-lookup-mbid');
    const get = mock.method(getAxios(lidarr), 'get', async () => ({
      data: found,
    }));

    const album = await lidarr.lookupAlbumByMbid(OK_COMPUTER);

    assert.deepStrictEqual(get.mock.calls[0].arguments, [
      '/album/lookup',
      { params: { term: `lidarr:${OK_COMPUTER}` } },
    ]);
    assert.deepStrictEqual(album, found[0]);
    assert.strictEqual(album?.artist?.foreignArtistId, RADIOHEAD);
  });

  it('answers the first album when Lidarr answers several for the id', async () => {
    const lidarr = buildLidarr();
    const found = fixture<LidarrAlbum[]>('album-lookup-term');
    mock.method(getAxios(lidarr), 'get', async () => ({ data: found }));

    assert.deepStrictEqual(
      await lidarr.lookupAlbumByMbid(OK_COMPUTER),
      found[0]
    );
  });

  it('answers null, not a throw, when no album has the release-group id', async () => {
    const lidarr = buildLidarr();
    const get = mock.method(getAxios(lidarr), 'get', async () => ({
      // Lidarr's answer (200) to lidarr:<an id it does not know>
      data: fixture('album-lookup-unknown-mbid'),
    }));

    assert.strictEqual(await lidarr.lookupAlbumByMbid(UNKNOWN_MBID), null);
    assert.deepStrictEqual(get.mock.calls[0].arguments, [
      '/album/lookup',
      { params: { term: `lidarr:${UNKNOWN_MBID}` } },
    ]);
  });

  it('throws a [Lidarr] error with the cause when a lookup fails', async () => {
    const lidarr = buildLidarr();
    const cause = lidarrError(401, { error: 'Unauthorized' });
    mock.method(getAxios(lidarr), 'get', async () => {
      throw cause;
    });

    for (const [call, act] of [
      [() => lidarr.lookupArtists('radiohead'), 'look up artists'],
      [() => lidarr.lookupArtistByMbid(RADIOHEAD), 'look up artists'],
      [() => lidarr.lookupAlbums('ok computer'), 'look up albums'],
      [() => lidarr.lookupAlbumByMbid(OK_COMPUTER), 'look up albums'],
    ] as const) {
      const error = await rejection(call());

      assert.strictEqual(
        error.message,
        `[Lidarr] Failed to ${act}: Request failed with status code 401`
      );
      assert.strictEqual(error.cause, cause);
    }
  });
});

describe('LidarrAPI held artists and albums', () => {
  afterEach(() => mock.restoreAll());

  it('answers every artist held, with its statistics', async () => {
    const lidarr = buildLidarr();
    const held = fixture<LidarrArtist[]>('artists');
    const get = mock.method(getAxios(lidarr), 'get', async () => ({
      data: held,
    }));

    const artists = await lidarr.getArtists();

    assert.deepStrictEqual(get.mock.calls[0].arguments, ['/artist']);
    assert.deepStrictEqual(artists, held);
    assert.strictEqual(artists[0].id, 3);
    assert.deepStrictEqual(artists[0].statistics, {
      albumCount: 9,
      trackFileCount: 0,
      trackCount: 91,
      totalTrackCount: 302,
      sizeOnDisk: 0,
      percentOfTracks: 0,
    });
  });

  it('answers an empty list when Lidarr holds no artist', async () => {
    const lidarr = buildLidarr();
    mock.method(getAxios(lidarr), 'get', async () => ({
      data: fixture('artists-empty'),
    }));

    assert.deepStrictEqual(await lidarr.getArtists(), []);
  });

  it('answers one artist by its Lidarr id', async () => {
    const lidarr = buildLidarr();
    const held = fixture<LidarrArtist>('artist-by-id');
    const get = mock.method(getAxios(lidarr), 'get', async () => ({
      data: held,
    }));

    const artist = await lidarr.getArtist(3);

    assert.deepStrictEqual(get.mock.calls[0].arguments, ['/artist/3']);
    assert.deepStrictEqual(artist, held);
    assert.strictEqual(artist.foreignArtistId, RADIOHEAD);
  });

  it('finds an artist held by its MusicBrainz id among those held', async () => {
    const lidarr = buildLidarr();
    const held = fixture<LidarrArtist[]>('artists');
    const get = mock.method(getAxios(lidarr), 'get', async () => ({
      data: held,
    }));

    const artist = await lidarr.getArtistByMbid(RADIOHEAD);

    assert.deepStrictEqual(get.mock.calls[0].arguments, ['/artist']);
    assert.deepStrictEqual(artist, held[0]);
    assert.strictEqual(artist?.id, 3);
  });

  it('answers null when no artist held has the MusicBrainz id', async () => {
    const lidarr = buildLidarr();
    mock.method(getAxios(lidarr), 'get', async () => ({
      data: fixture('artists'),
    }));

    assert.strictEqual(
      await lidarr.getArtistByMbid('00000000-0000-0000-0000-000000000000'),
      null
    );
  });

  it('answers the albums of one artist with their statistics', async () => {
    const lidarr = buildLidarr();
    const held = fixture<LidarrAlbum[]>('albums');
    const get = mock.method(getAxios(lidarr), 'get', async () => ({
      data: held,
    }));

    const albums = await lidarr.getAlbums({ artistId: 3 });

    assert.deepStrictEqual(get.mock.calls[0].arguments, [
      '/album',
      { params: { artistId: 3 } },
    ]);
    assert.deepStrictEqual(albums, held);
    assert.strictEqual(albums.length, 9);
    assert.deepStrictEqual(
      albums.filter((album) => album.monitored).map((album) => album.title),
      ['OK Computer']
    );
    assert.strictEqual(albums[0].statistics?.totalTrackCount, 23);
  });

  it('asks for every album held when no artist is given', async () => {
    const lidarr = buildLidarr();
    const get = mock.method(getAxios(lidarr), 'get', async () => ({
      data: fixture('albums'),
    }));

    await lidarr.getAlbums();

    assert.deepStrictEqual(get.mock.calls[0].arguments, [
      '/album',
      { params: undefined },
    ]);
  });

  it('throws a [Lidarr] error with the cause when reading what Lidarr holds fails', async () => {
    const lidarr = buildLidarr();
    const cause = lidarrError(404, fixture('error-artist-404'));
    mock.method(getAxios(lidarr), 'get', async () => {
      throw cause;
    });

    for (const [call, act] of [
      [() => lidarr.getArtists(), 'retrieve artists'],
      [() => lidarr.getArtistByMbid(RADIOHEAD), 'retrieve artists'],
      [() => lidarr.getArtist(9999), 'retrieve artist'],
      [() => lidarr.getAlbums({ artistId: 3 }), 'retrieve albums'],
    ] as const) {
      const error = await rejection(call());

      assert.strictEqual(
        error.message,
        `[Lidarr] Failed to ${act}: Request failed with status code 404`
      );
      assert.strictEqual(error.cause, cause);
    }
  });
});

describe('LidarrAPI addArtist', () => {
  afterEach(() => mock.restoreAll());

  // R-7: the artist with only the requested album monitored, no new albums
  const forAlbum: LidarrArtistOptions = {
    foreignArtistId: RADIOHEAD,
    artistName: 'Radiohead',
    qualityProfileId: 3,
    metadataProfileId: 1,
    rootFolderPath: '/music',
    monitorNewItems: 'none',
    monitor: 'none',
    albumsToMonitor: [OK_COMPUTER],
  };

  it('adds an artist with one album monitored and no new albums monitored', async () => {
    const lidarr = buildLidarr();
    const added = fixture<LidarrArtist>('artist-add');
    const post = mock.method(getAxios(lidarr), 'post', async () => ({
      data: added,
    }));

    const artist = await lidarr.addArtist(forAlbum);

    assert.strictEqual(post.mock.callCount(), 1);
    assert.deepStrictEqual(post.mock.calls[0].arguments, [
      '/artist',
      {
        foreignArtistId: RADIOHEAD,
        artistName: 'Radiohead',
        qualityProfileId: 3,
        metadataProfileId: 1,
        rootFolderPath: '/music',
        monitored: true,
        monitorNewItems: 'none',
        addOptions: {
          monitor: 'none',
          albumsToMonitor: [OK_COMPUTER],
          searchForMissingAlbums: false,
        },
      },
    ]);
    assert.deepStrictEqual(artist, added);
    assert.strictEqual(artist.id, 3);
  });

  it("adds an album's missing artist in one call, monitored, with monitor existing and only the album to monitor", async () => {
    const lidarr = buildLidarr();
    const added = fixture<LidarrArtist>('artist-add-existing');
    const post = mock.method(getAxios(lidarr), 'post', async () => ({
      data: added,
    }));

    const artist = await lidarr.addArtist({
      ...forAlbum,
      monitor: 'existing',
      searchForMissingAlbums: true,
    });

    assert.strictEqual(post.mock.callCount(), 1);
    assert.deepStrictEqual(post.mock.calls[0].arguments, [
      '/artist',
      {
        foreignArtistId: RADIOHEAD,
        artistName: 'Radiohead',
        qualityProfileId: 3,
        metadataProfileId: 1,
        rootFolderPath: '/music',
        monitored: true,
        monitorNewItems: 'none',
        addOptions: {
          monitor: 'existing',
          albumsToMonitor: [OK_COMPUTER],
          searchForMissingAlbums: true,
        },
      },
    ]);
    // as the test Lidarr answered: the artist held monitored
    assert.strictEqual(artist.monitored, true);
    assert.strictEqual(artist.monitorNewItems, 'none');
  });

  it('adds an artist with all albums and new albums monitored and a search on add', async () => {
    const lidarr = buildLidarr();
    const post = mock.method(getAxios(lidarr), 'post', async () => ({
      data: fixture('artist-add'),
    }));

    await lidarr.addArtist({
      foreignArtistId: RADIOHEAD,
      artistName: 'Radiohead',
      qualityProfileId: 3,
      metadataProfileId: 1,
      rootFolderPath: '/music',
      monitored: true,
      monitorNewItems: 'all',
      monitor: 'all',
      searchForMissingAlbums: true,
    });

    assert.deepStrictEqual(post.mock.calls[0].arguments[1], {
      foreignArtistId: RADIOHEAD,
      artistName: 'Radiohead',
      qualityProfileId: 3,
      metadataProfileId: 1,
      rootFolderPath: '/music',
      monitored: true,
      monitorNewItems: 'all',
      addOptions: {
        monitor: 'all',
        albumsToMonitor: [],
        searchForMissingAlbums: true,
      },
    });
  });

  it('sends monitored false when it is given', async () => {
    const lidarr = buildLidarr();
    const post = mock.method(getAxios(lidarr), 'post', async () => ({
      data: fixture('artist-add'),
    }));

    await lidarr.addArtist({ ...forAlbum, monitored: false });

    assert.strictEqual(
      (post.mock.calls[0].arguments[1] as { monitored: boolean }).monitored,
      false
    );
  });

  it('throws a [Lidarr] error with the cause when Lidarr refuses the artist', async () => {
    const lidarr = buildLidarr();
    const cause = lidarrError(400, fixture('error-add-400'));
    mock.method(getAxios(lidarr), 'post', async () => {
      throw cause;
    });

    const error = await rejection(lidarr.addArtist(forAlbum));

    assert.strictEqual(
      error.message,
      '[Lidarr] Failed to add artist: Request failed with status code 400'
    );
    assert.strictEqual(error.cause, cause);
  });
});

describe('LidarrAPI updateArtist', () => {
  afterEach(() => mock.restoreAll());

  it('puts the artist held with its monitoring and new-album monitoring changed', async () => {
    const lidarr = buildLidarr();
    const held = fixture<LidarrArtist>('artist-by-id');
    const updated = fixture<LidarrArtist>('artist-update');
    const get = mock.method(getAxios(lidarr), 'get', async () => ({
      data: held,
    }));
    const put = mock.method(getAxios(lidarr), 'put', async () => ({
      data: updated,
    }));

    const artist = await lidarr.updateArtist(3, {
      monitored: true,
      monitorNewItems: 'all',
    });

    assert.deepStrictEqual(get.mock.calls[0].arguments, ['/artist/3']);
    assert.strictEqual(put.mock.callCount(), 1);
    assert.strictEqual(put.mock.calls[0].arguments[0], '/artist/3');
    assert.deepStrictEqual(put.mock.calls[0].arguments[1], {
      ...held,
      monitored: true,
      monitorNewItems: 'all',
    });
    assert.strictEqual(held.monitorNewItems, 'none');
    assert.deepStrictEqual(artist, updated);
    assert.strictEqual(artist.monitorNewItems, 'all');
  });

  it('changes only what is given', async () => {
    const lidarr = buildLidarr();
    const held = fixture<LidarrArtist>('artist-by-id');
    mock.method(getAxios(lidarr), 'get', async () => ({ data: held }));
    const put = mock.method(getAxios(lidarr), 'put', async () => ({
      data: held,
    }));

    await lidarr.updateArtist(3, { monitorNewItems: 'all' });

    assert.deepStrictEqual(put.mock.calls[0].arguments[1], {
      ...held,
      monitorNewItems: 'all',
    });
  });

  it('throws a [Lidarr] error with the cause, and puts nothing, when the artist cannot be read', async () => {
    const lidarr = buildLidarr();
    const cause = lidarrError(404, fixture('error-artist-404'));
    mock.method(getAxios(lidarr), 'get', async () => {
      throw cause;
    });
    const put = mock.method(getAxios(lidarr), 'put', async () => ({}));

    const error = await rejection(
      lidarr.updateArtist(9999, { monitored: true })
    );

    assert.strictEqual(
      error.message,
      '[Lidarr] Failed to update artist: Request failed with status code 404'
    );
    assert.strictEqual(error.cause, cause);
    assert.strictEqual(put.mock.callCount(), 0);
  });

  it('throws a [Lidarr] error with the cause when Lidarr refuses the update', async () => {
    const lidarr = buildLidarr();
    const cause = lidarrError(500, { message: 'boom' });
    mock.method(getAxios(lidarr), 'get', async () => ({
      data: fixture('artist-by-id'),
    }));
    mock.method(getAxios(lidarr), 'put', async () => {
      throw cause;
    });

    const error = await rejection(
      lidarr.updateArtist(3, { monitorNewItems: 'all' })
    );

    assert.strictEqual(
      error.message,
      '[Lidarr] Failed to update artist: Request failed with status code 500'
    );
    assert.strictEqual(error.cause, cause);
  });
});

describe('LidarrAPI monitorAlbums', () => {
  afterEach(() => mock.restoreAll());

  it('monitors albums by Lidarr id and answers the albums', async () => {
    const lidarr = buildLidarr();
    const monitored = fixture<LidarrAlbum[]>('album-monitor');
    const put = mock.method(getAxios(lidarr), 'put', async () => ({
      data: monitored,
    }));

    const albums = await lidarr.monitorAlbums([19, 20], true);

    assert.deepStrictEqual(put.mock.calls[0].arguments, [
      '/album/monitor',
      { albumIds: [19, 20], monitored: true },
    ]);
    assert.deepStrictEqual(albums, monitored);
    assert.deepStrictEqual(
      albums.map((album) => [album.id, album.monitored]),
      [
        [19, true],
        [20, true],
      ]
    );
  });

  it('unmonitors albums', async () => {
    const lidarr = buildLidarr();
    const put = mock.method(getAxios(lidarr), 'put', async () => ({
      data: [],
    }));

    await lidarr.monitorAlbums([27], false);

    assert.deepStrictEqual(put.mock.calls[0].arguments[1], {
      albumIds: [27],
      monitored: false,
    });
  });

  it('throws a [Lidarr] error with the cause when Lidarr fails', async () => {
    const lidarr = buildLidarr();
    const cause = lidarrError(500, { message: 'boom' });
    mock.method(getAxios(lidarr), 'put', async () => {
      throw cause;
    });

    const error = await rejection(lidarr.monitorAlbums([19], true));

    assert.strictEqual(
      error.message,
      '[Lidarr] Failed to monitor albums: Request failed with status code 500'
    );
    assert.strictEqual(error.cause, cause);
  });
});

describe('LidarrAPI search commands', () => {
  afterEach(() => mock.restoreAll());

  it('runs AlbumSearch with the album ids', async () => {
    const lidarr = buildLidarr();
    const post = mock.method(getAxios(lidarr), 'post', async () => ({
      data: fixture('command-albumsearch'),
    }));

    assert.strictEqual(await lidarr.searchAlbums([19, 20]), undefined);

    assert.strictEqual(post.mock.callCount(), 1);
    assert.deepStrictEqual(post.mock.calls[0].arguments, [
      '/command',
      { name: 'AlbumSearch', albumIds: [19, 20] },
    ]);
  });

  it('runs ArtistSearch with the artist id', async () => {
    const lidarr = buildLidarr();
    const post = mock.method(getAxios(lidarr), 'post', async () => ({
      data: fixture('command-artistsearch'),
    }));

    assert.strictEqual(await lidarr.searchArtist(3), undefined);

    assert.deepStrictEqual(post.mock.calls[0].arguments, [
      '/command',
      { name: 'ArtistSearch', artistId: 3 },
    ]);
  });

  it('throws a [Lidarr] error with the cause when Lidarr fails to take a command', async () => {
    const lidarr = buildLidarr();
    const cause = lidarrError(500, { message: 'boom' });
    mock.method(getAxios(lidarr), 'post', async () => {
      throw cause;
    });

    for (const call of [
      () => lidarr.searchAlbums([19]),
      () => lidarr.searchArtist(3),
    ]) {
      const error = await rejection(call());

      assert.strictEqual(
        error.message,
        '[Lidarr] Failed to run command: Request failed with status code 500'
      );
      assert.strictEqual(error.cause, cause);
    }
  });
});

describe('LidarrAPI command queue', () => {
  afterEach(() => mock.restoreAll());

  // the fixtures are Lidarr's queue as the test Lidarr answered it while it
  // refreshed an artist it had just been given (Lidarr id 9)
  const ARTIST = 9;

  it('reads the queue with GET /command and answers what Lidarr listed', async () => {
    const lidarr = buildLidarr();
    const queue = fixture<LidarrCommand[]>('command-queue-refresh-started');
    const get = mock.method(getAxios(lidarr), 'get', async () => ({
      data: queue,
    }));

    assert.deepStrictEqual(await lidarr.getCommands(), queue);
    assert.deepStrictEqual(get.mock.calls[0].arguments, ['/command']);
  });

  it('finds a started command naming the artist by artistIds', async () => {
    const lidarr = buildLidarr();
    const refresh = fixture<LidarrCommand[]>('command-queue-refresh-started');
    const rescan = fixture<LidarrCommand[]>('command-queue-rescan-started');
    const answers = [refresh, rescan];
    mock.method(getAxios(lidarr), 'get', async () => ({
      data: answers.shift(),
    }));

    // RefreshArtist {artistIds}, RescanFolders {artistIds}
    assert.strictEqual(await lidarr.hasUnfinishedCommand(ARTIST), true);
    assert.strictEqual(await lidarr.hasUnfinishedCommand(ARTIST), true);
  });

  it('does not find a search naming the artist, started or queued (D-352)', async () => {
    const lidarr = buildLidarr();
    const search = fixture<LidarrCommand[]>('command-queue-search-started');
    const answers = [
      search,
      search.map((c) =>
        c.status === 'started' ? { ...c, status: 'queued' } : c
      ),
      search.map((c) => ({
        ...c,
        name: 'ArtistSearch',
        body: { ...c.body, name: 'ArtistSearch' },
      })),
    ];
    mock.method(getAxios(lidarr), 'get', async () => ({
      data: answers.shift(),
    }));

    // MissingAlbumSearch {artistId} started, queued, and an ArtistSearch
    assert.strictEqual(await lidarr.hasUnfinishedCommand(ARTIST), false);
    assert.strictEqual(await lidarr.hasUnfinishedCommand(ARTIST), false);
    assert.strictEqual(await lidarr.hasUnfinishedCommand(ARTIST), false);
  });

  it('finds a RefreshArtist naming the artist beside a search naming it', async () => {
    const lidarr = buildLidarr();
    mock.method(getAxios(lidarr), 'get', async () => ({
      data: [
        ...fixture<LidarrCommand[]>('command-queue-search-started'),
        ...fixture<LidarrCommand[]>('command-queue-refresh-started'),
      ],
    }));

    assert.strictEqual(await lidarr.hasUnfinishedCommand(ARTIST), true);
  });

  it('finds a queued command naming the artist', async () => {
    const lidarr = buildLidarr();
    const queue = fixture<LidarrCommand[]>('command-queue-refresh-started');
    const queued = queue.map((command) =>
      command.body.artistIds?.includes(ARTIST)
        ? { ...command, status: 'queued' }
        : command
    );
    mock.method(getAxios(lidarr), 'get', async () => ({ data: queued }));

    assert.strictEqual(await lidarr.hasUnfinishedCommand(ARTIST), true);
  });

  it('finds nothing where the commands naming the artist are completed, or name another artist', async () => {
    const lidarr = buildLidarr();
    mock.method(getAxios(lidarr), 'get', async () => ({
      data: fixture<LidarrCommand[]>('command-queue-settled'),
    }));

    assert.strictEqual(await lidarr.hasUnfinishedCommand(ARTIST), false);

    const refresh = fixture<LidarrCommand[]>('command-queue-refresh-started');
    mock.restoreAll();
    mock.method(getAxios(lidarr), 'get', async () => ({ data: refresh }));

    assert.strictEqual(await lidarr.hasUnfinishedCommand(3), false);
  });

  it('throws a [Lidarr] error with the cause when Lidarr fails', async () => {
    const lidarr = buildLidarr();
    const cause = lidarrError(500, { message: 'boom' });
    mock.method(getAxios(lidarr), 'get', async () => {
      throw cause;
    });

    const error = await rejection(lidarr.hasUnfinishedCommand(ARTIST));

    assert.strictEqual(
      error.message,
      '[Lidarr] Failed to retrieve commands: Request failed with status code 500'
    );
    assert.strictEqual(error.cause, cause);
  });
});

describe('LidarrAPI getMetadataProfiles', () => {
  afterEach(() => mock.restoreAll());

  it('answers the metadata profiles Lidarr has', async () => {
    const lidarr = buildLidarr();
    const profiles =
      fixture<{ id: number; name: string }[]>('metadataprofiles');
    const get = mock.method(getAxios(lidarr), 'get', async () => ({
      data: profiles,
    }));

    const answer = await lidarr.getMetadataProfiles();

    assert.strictEqual(get.mock.calls[0].arguments[0], '/metadataprofile');
    assert.deepStrictEqual(answer, profiles);
    assert.deepStrictEqual(
      answer.map((profile) => [profile.id, profile.name]),
      [
        [1, 'Standard'],
        [2, 'None'],
      ]
    );
  });

  it('throws a [Lidarr] error with the cause when Lidarr fails', async () => {
    const lidarr = buildLidarr();
    const cause = lidarrError(401, { error: 'Unauthorized' });
    mock.method(getAxios(lidarr), 'get', async () => {
      throw cause;
    });

    const error = await rejection(lidarr.getMetadataProfiles());

    assert.strictEqual(
      error.message,
      '[Lidarr] Failed to retrieve metadata profiles: Request failed with status code 401'
    );
    assert.strictEqual(error.cause, cause);
  });
});

describe('LidarrAPI getMetadataProfile', () => {
  afterEach(() => mock.restoreAll());

  it('answers one saved profile with the types and statuses it allows, read afresh', async () => {
    const lidarr = buildLidarr();
    const profiles = fixture<MetadataProfile[]>('metadataprofiles');
    const get = mock.method(getAxios(lidarr), 'get', async () => ({
      data: profiles,
    }));

    const answer = await lidarr.getMetadataProfile(1);

    assert.strictEqual(get.mock.calls[0].arguments[0], '/metadataprofile');
    assert.deepStrictEqual(answer, profiles[0]);
    assert.strictEqual(
      answer.primaryAlbumTypes?.find((t) => t.allowed)?.albumType.name,
      'Album'
    );
  });

  it('throws a [Lidarr] error where Lidarr lacks the profile or fails', async () => {
    const lidarr = buildLidarr();
    mock.method(getAxios(lidarr), 'get', async () => ({
      data: fixture<MetadataProfile[]>('metadataprofiles'),
    }));

    const missing = await rejection(lidarr.getMetadataProfile(99));

    assert.strictEqual(
      missing.message,
      '[Lidarr] Failed to retrieve metadata profile: no metadata profile 99'
    );

    mock.restoreAll();
    const cause = lidarrError(401, { error: 'Unauthorized' });
    mock.method(getAxios(lidarr), 'get', async () => {
      throw cause;
    });

    const failed = await rejection(lidarr.getMetadataProfile(1));

    assert.strictEqual(failed.cause, cause);
  });
});

describe('LidarrAPI addAlbumFromLookup', () => {
  afterEach(() => mock.restoreAll());

  // an album Lidarr does not list for an artist it holds (D-352): Lidarr's
  // lookup of it, an EP outside the saved metadata profile
  const lookedUp = fixture<LidarrAlbum[]>('album-lookup-not-listed')[0];

  it('posts the looked-up album monitored, addType manual, with no search on add', async () => {
    const lidarr = buildLidarr();
    const added = fixture<LidarrAlbum>('album-add');
    const post = mock.method(getAxios(lidarr), 'post', async () => ({
      data: added,
    }));

    const album = await lidarr.addAlbumFromLookup(lookedUp);

    assert.strictEqual(post.mock.callCount(), 1);
    assert.deepStrictEqual(post.mock.calls[0].arguments, [
      '/album',
      {
        ...lookedUp,
        monitored: true,
        addOptions: { addType: 'manual', searchForNewAlbum: false },
      },
    ]);
    assert.deepStrictEqual(album, added);
    assert.strictEqual(album.monitored, true);
    assert.strictEqual(album.id, 61);
  });

  it('throws a [Lidarr] error with the cause when Lidarr refuses the album', async () => {
    const lidarr = buildLidarr();
    const cause = lidarrError(400, fixture('error-add-400'));
    mock.method(getAxios(lidarr), 'post', async () => {
      throw cause;
    });

    const error = await rejection(lidarr.addAlbumFromLookup(lookedUp));

    assert.strictEqual(
      error.message,
      '[Lidarr] Failed to add album: Request failed with status code 400'
    );
    assert.strictEqual(error.cause, cause);
  });
});

describe('LidarrAPI is not upstream/music 98cfc910 addAlbum', () => {
  it('has neither addAlbum nor removeAlbum', () => {
    const lidarr = buildLidarr() as unknown as Record<string, unknown>;

    assert.strictEqual(lidarr.addAlbum, undefined);
    assert.strictEqual(lidarr.removeAlbum, undefined);
  });
});

describe('LidarrAPI getTracks', () => {
  afterEach(() => mock.restoreAll());

  it('asks for the tracks of an album held and answers what Lidarr holds', async () => {
    const lidarr = buildLidarr();
    // recorded from the test Lidarr: GET /track?albumId=45 (OK Computer, 6 media)
    const tracks = fixture<LidarrTrack[]>('tracks');
    const get = mock.method(getAxios(lidarr), 'get', async () => ({
      data: tracks,
    }));

    const answer = await lidarr.getTracks(45);

    assert.strictEqual(get.mock.callCount(), 1);
    assert.deepStrictEqual(get.mock.calls[0].arguments, [
      '/track',
      { params: { albumId: 45 } },
    ]);
    assert.deepStrictEqual(answer, tracks);
    assert.strictEqual(answer.length, 91);
    assert.deepStrictEqual(
      [
        answer[0].title,
        answer[0].mediumNumber,
        answer[0].absoluteTrackNumber,
        answer[0].trackNumber,
        answer[0].duration,
      ],
      ['Airbag', 1, 1, 'A1', 284000]
    );
  });

  it('answers an empty list for an album Lidarr has no tracks of', async () => {
    const lidarr = buildLidarr();
    mock.method(getAxios(lidarr), 'get', async () => ({
      data: fixture('tracks-empty'),
    }));

    assert.deepStrictEqual(await lidarr.getTracks(9999), []);
  });

  it('throws a [Lidarr] error with the cause when Lidarr fails', async () => {
    const lidarr = buildLidarr();
    const cause = lidarrError(400, { message: 'albumId is required' });
    mock.method(getAxios(lidarr), 'get', async () => {
      throw cause;
    });

    const error = await rejection(lidarr.getTracks(45));

    assert.strictEqual(
      error.message,
      '[Lidarr] Failed to retrieve tracks: Request failed with status code 400'
    );
    assert.strictEqual(error.cause, cause);
  });
});

describe('LidarrAPI getTrackFiles', () => {
  afterEach(() => mock.restoreAll());

  // the requests the client sends, as the URL axios builds for them, answered
  // by the given function
  function wire(
    lidarr: LidarrAPI,
    respond: (url: string) => { status?: number; data?: unknown }
  ): string[] {
    const urls: string[] = [];
    getAxios(lidarr).defaults.adapter = async (config) => {
      const url = getAxios(lidarr).getUri(config);
      urls.push(url);
      const { status = 200, data = [] } = respond(url);
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
          {
            response,
          }
        );
      }

      return response;
    };

    return urls;
  }

  it('asks GET /trackfile with one albumId parameter for each album, and answers the files', async () => {
    const lidarr = buildLidarr();
    // recorded from the test Lidarr: GET /trackfile?albumId=1&albumId=2 (the
    // first three files of Untrue, album 2)
    const files = fixture<LidarrTrackFile[]>('trackfiles');
    const urls = wire(lidarr, () => ({ data: files }));

    const answer = await lidarr.getTrackFiles([1, 2]);

    assert.deepStrictEqual(urls, [
      'http://localhost:8686/lidarr' +
        instance +
        '/api/v1/trackfile?apikey=test&albumId=1&albumId=2',
    ]);
    assert.deepStrictEqual(answer, files);
    assert.deepStrictEqual(
      answer.map((file) => [file.albumId, file.dateAdded]),
      [
        [2, '2026-10-15T14:07:50Z'],
        [2, '2026-10-15T14:07:50Z'],
        [2, '2026-10-15T14:07:50Z'],
      ]
    );
  });

  it('asks nothing for no album', async () => {
    const lidarr = buildLidarr();
    const urls = wire(lidarr, () => ({}));

    assert.deepStrictEqual(await lidarr.getTrackFiles([]), []);
    assert.strictEqual(urls.length, 0);
  });

  it('asks 50 albums at a time and answers the files of every batch in order', async () => {
    const lidarr = buildLidarr();
    const ids = Array.from({ length: 120 }, (_, i) => i + 1);
    const urls = wire(lidarr, (url) => {
      const asked = new URL(url).searchParams.getAll('albumId').map(Number);

      return {
        data: asked.map((albumId) => ({
          id: albumId * 10,
          albumId,
          dateAdded: '2026-01-01T00:00:00Z',
        })),
      };
    });

    const answer = await lidarr.getTrackFiles(ids);

    assert.deepStrictEqual(
      urls.map((url) => new URL(url).searchParams.getAll('albumId').length),
      [50, 50, 20]
    );
    assert.deepStrictEqual(
      answer.map((file) => file.albumId),
      ids
    );
  });

  it('throws a [Lidarr] error with the cause when a batch fails, answering no files', async () => {
    const lidarr = buildLidarr();
    const urls = wire(lidarr, (url) =>
      new URL(url).searchParams.getAll('albumId').includes('51')
        ? { status: 404 }
        : { data: [] }
    );

    const error = await rejection(
      lidarr.getTrackFiles(Array.from({ length: 120 }, (_, i) => i + 1))
    );

    assert.strictEqual(
      error.message,
      '[Lidarr] Failed to retrieve track files: Request failed with status code 404'
    );
    assert.ok(error.cause);
    assert.strictEqual(urls.length, 2, 'the third batch is not asked');
  });
});

describe('LidarrAPI timeout', () => {
  it('keeps the timeout it is given on its requests', () => {
    const lidarr = new LidarrAPI({
      url: 'http://localhost:8686/lidarr-timeout/api/v1',
      apiKey: 'test',
      timeout: 4321,
    });

    assert.strictEqual(getAxios(lidarr).defaults.timeout, 4321);
  });
});
