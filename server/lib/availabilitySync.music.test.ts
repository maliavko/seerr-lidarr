import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { JellyfinLibraryItemExtended } from '@server/api/jellyfin';
import JellyfinAPI from '@server/api/jellyfin';
import PlexAPI from '@server/api/plexapi';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import Season from '@server/entity/Season';
import availabilitySync from '@server/lib/availabilitySync';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import {
  MethodStubs,
  assertRowsUnchanged,
  rawMediaRows,
  saveMusicRows,
} from '@server/test/musicRows';
import { Repository } from 'typeorm';

// A music artist row and a music album row in the media table: the availability
// sync reads movies and TV only, so it never marks a music row deleted, asks no
// server about it, and does for movies and TV what it does without them
// (D-84, D-371, D-8).

setupTestDb();

const stubs = new MethodStubs();
let asked: Record<string, unknown[][]>;

beforeEach(async () => {
  const known = new Map<string, string>([
    ['jf-movie-here', 'Movie'],
    ['jf-show-here', 'Series'],
  ]);

  const record = (name: string) => {
    asked[name] = [];
    return asked[name];
  };
  asked = {};

  const jellyfinItems = record('JellyfinAPI.getItemData');
  stubs.stub(JellyfinAPI.prototype, 'getItemData', async (id: string) => {
    jellyfinItems.push([id]);
    const type = known.get(id);
    return type
      ? ({
          Id: id,
          Type: type,
          Name: id,
        } as unknown as JellyfinLibraryItemExtended)
      : undefined;
  });
  stubs.stub(JellyfinAPI.prototype, 'getSystemInfo', async () => ({
    ServerName: 'Test',
  }));
  stubs.stub(JellyfinAPI.prototype, 'setUserId', () => {});
  const seasons = record('JellyfinAPI.getSeasons');
  stubs.stub(JellyfinAPI.prototype, 'getSeasons', async (id: string) => {
    seasons.push([id]);
    return id === 'jf-show-here'
      ? [{ Id: 'jf-season-1', IndexNumber: 1, Type: 'Season', Name: 'S1' }]
      : [];
  });
  stubs.stub(JellyfinAPI.prototype, 'getEpisodes', async () => [
    { Id: 'jf-episode-1', IndexNumber: 1, Type: 'Episode', Name: 'E1' },
  ]);

  const outside: [string, object, string][] = [
    ['PlexAPI.getMetadata', PlexAPI.prototype, 'getMetadata'],
    ['RadarrAPI.getMovie', RadarrAPI.prototype, 'getMovie'],
    ['SonarrAPI.getSeriesById', SonarrAPI.prototype, 'getSeriesById'],
    ['TheMovieDb.getTvShow', TheMovieDb.prototype, 'getTvShow'],
    ['TheMovieDb.getTvShowForScan', TheMovieDb.prototype, 'getTvShowForScan'],
  ];
  for (const [name, prototype, method] of outside) {
    const calls = record(name);
    stubs.stub(prototype, method, async (...args: unknown[]) => {
      calls.push(args);
      throw new Error('404');
    });
  }
  const tmdbScan = record('availabilitySync.tmdb.getTvShowForScan');
  Object.defineProperty(availabilitySync.tmdb, 'getTvShowForScan', {
    value: async (...args: unknown[]) => {
      tmdbScan.push(args);
      throw new Error('404');
    },
    configurable: true,
  });

  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.JELLYFIN;
  settings.jellyfin = { ...settings.jellyfin, apiKey: 'test-api-key' };
  settings.radarr = [];
  settings.sonarr = [];
});

afterEach(() => {
  stubs.restore();
});

async function saveMovieAndShow(
  movieKey: string,
  showKey: string,
  tmdbIds: [number, number]
) {
  const repository = getRepository(Media);

  const movie = await repository.save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: tmdbIds[0],
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
      jellyfinMediaId: movieKey,
    })
  );
  const show = await repository.save(
    new Media({
      mediaType: MediaType.TV,
      tmdbId: tmdbIds[1],
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
      jellyfinMediaId: showKey,
      seasons: [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
        }),
      ],
    })
  );

  return { movie, show };
}

describe('Availability sync with music rows in the table', () => {
  it('never marks a music row deleted or asks a server about it, whatever its status', async () => {
    const { movie, show } = await saveMovieAndShow(
      'jf-movie-gone',
      'jf-show-gone',
      [9801, 9802]
    );
    const { artist, album } = await saveMusicRows(MediaStatus.AVAILABLE);
    await getRepository(Media).update(
      { id: album.id },
      { status: MediaStatus.PARTIALLY_AVAILABLE }
    );
    const before = await rawMediaRows([artist.id, album.id]);

    await availabilitySync.run();

    assert.strictEqual(
      (await getRepository(Media).findOneByOrFail({ id: movie.id })).status,
      MediaStatus.DELETED,
      'a movie missing from the server is marked deleted, as without music rows'
    );
    assert.strictEqual(
      (await getRepository(Media).findOneByOrFail({ id: show.id })).status,
      MediaStatus.DELETED,
      'a show missing from the server is marked deleted, as without music rows'
    );
    await assertRowsUnchanged([artist, album], before);

    assert.deepStrictEqual(
      new Set(asked['JellyfinAPI.getItemData'].map(([id]) => id)),
      new Set(['jf-movie-gone', 'jf-show-gone']),
      'the sync asked Jellyfin only for the movie and the show'
    );
    for (const name of [
      'PlexAPI.getMetadata',
      'RadarrAPI.getMovie',
      'SonarrAPI.getSeriesById',
      'TheMovieDb.getTvShow',
      'TheMovieDb.getTvShowForScan',
    ]) {
      assert.deepStrictEqual(asked[name], [], `${name} was called`);
    }
    assert.deepStrictEqual(
      asked['availabilitySync.tmdb.getTvShowForScan'],
      [[{ tvId: 9802 }]],
      'TMDB was asked for the show alone'
    );
  });

  it('keeps the movies and shows the server still has, and music rows, as they are', async () => {
    const { movie, show } = await saveMovieAndShow(
      'jf-movie-here',
      'jf-show-here',
      [9803, 9804]
    );
    const { artist, album } = await saveMusicRows(MediaStatus.AVAILABLE);
    const before = await rawMediaRows([artist.id, album.id]);

    await availabilitySync.run();

    assert.strictEqual(
      (await getRepository(Media).findOneByOrFail({ id: movie.id })).status,
      MediaStatus.AVAILABLE
    );
    assert.strictEqual(
      (await getRepository(Media).findOneByOrFail({ id: show.id })).status,
      MediaStatus.AVAILABLE
    );
    await assertRowsUnchanged([artist, album], before);
  });

  it('still checks the movies and shows when more music rows are available than one page of the sync', async () => {
    // more available music rows than one page of the sync (50), created first
    const repository = getRepository(Media);
    for (let i = 0; i < 60; i++) {
      await repository.save(
        new Media({
          mediaType: MediaType.MUSIC,
          musicBrainzId: `mbid-${i}`,
          musicKind: 'album' as never,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
        })
      );
    }
    const { movie } = await saveMovieAndShow(
      'jf-movie-gone',
      'jf-show-gone',
      [9805, 9806]
    );

    await availabilitySync.run();

    assert.strictEqual(
      (await repository.findOneByOrFail({ id: movie.id })).status,
      MediaStatus.DELETED
    );
    assert.strictEqual(
      await repository.countBy({
        mediaType: MediaType.MUSIC,
        status: MediaStatus.AVAILABLE,
      }),
      60
    );
  });

  it('is handed no music row by the media table reads of its run', async () => {
    await saveMovieAndShow('jf-movie-here', 'jf-show-here', [9807, 9808]);
    await saveMusicRows(MediaStatus.AVAILABLE);
    const find = mock.method(Repository.prototype, 'find');

    try {
      await availabilitySync.run();

      const handed: Media[] = [];
      for (const call of find.mock.calls) {
        const rows = (await call.result) as unknown[];
        handed.push(
          ...rows.filter((row): row is Media => row instanceof Media)
        );
      }

      assert.ok(
        handed.length > 0,
        'the sync read no media row: the case proves nothing'
      );
      assert.deepStrictEqual(
        handed.filter((row) => row.mediaType === MediaType.MUSIC),
        []
      );
    } finally {
      find.mock.restore();
    }
  });
});
