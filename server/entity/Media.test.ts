import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import {
  MediaRequestStatus,
  MediaType,
  MusicKind,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import { User } from '@server/entity/User';
import { seedTestDb } from '@server/utils/seedTestDb';
import { SelectQueryBuilder } from 'typeorm';

mock.method(MediaRequest, 'sendNotification', async () => undefined);

// The keys of a movie or TV media row as it serialises on develop (978f437d),
// before the music columns: a key gained or lost fails the tests below (D-121, D-8).
const DEVELOP_MEDIA_KEYS = [
  'downloadStatus',
  'downloadStatus4k',
  'id',
  'mediaType',
  'tmdbId',
  'tvdbId',
  'imdbId',
  'status',
  'status4k',
  'createdAt',
  'updatedAt',
  'lastSeasonChange',
  'mediaAddedAt',
  'serviceId',
  'serviceId4k',
  'externalServiceId',
  'externalServiceId4k',
  'externalServiceSlug',
  'externalServiceSlug4k',
  'ratingKey',
  'ratingKey4k',
  'jellyfinMediaId',
  'jellyfinMediaId4k',
  'seasons',
];

const MUSIC_KEYS = ['musicBrainzId', 'musicKind', 'artistMusicBrainzId'];

function keysOf(value: unknown): string[] {
  return Object.keys(JSON.parse(JSON.stringify(value)));
}

// The schema is the one the migrations build, so the entity is read against
// what an upgraded database holds.
before(async () => {
  await seedTestDb({ withMigrations: true });
});

beforeEach(async () => {
  await dataSource.query('DELETE FROM media_request');
  await dataSource.query('DELETE FROM media');
});

async function saveMovie(tmdbId: number): Promise<Media> {
  return getRepository(Media).save(
    new Media({ mediaType: MediaType.MOVIE, tmdbId })
  );
}

async function saveMusic(
  mbid: string,
  kind: MusicKind,
  artistMbid?: string
): Promise<Media> {
  return getRepository(Media).save(
    new Media({
      mediaType: MediaType.MUSIC,
      musicBrainzId: mbid,
      musicKind: kind,
      artistMusicBrainzId: artistMbid,
    })
  );
}

describe('Media.toJSON', () => {
  it('serialises a movie row with exactly the keys it carries on develop', async () => {
    const saved = await saveMovie(603);
    const movie = await getRepository(Media).findOneOrFail({
      where: { id: saved.id },
    });

    assert.deepStrictEqual(keysOf(movie), DEVELOP_MEDIA_KEYS);
  });

  it('serialises a TV row with a season with exactly the keys it carries on develop', async () => {
    const saved = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 1396,
        tvdbId: 81189,
        seasons: [new Season({ seasonNumber: 1 })],
      })
    );
    const tv = await getRepository(Media).findOneOrFail({
      where: { id: saved.id },
    });

    assert.strictEqual(tv.seasons.length, 1);
    assert.deepStrictEqual(keysOf(tv), DEVELOP_MEDIA_KEYS);
    assert.deepStrictEqual(
      keysOf(tv.seasons[0]),
      keysOf(
        await getRepository(Season).findOneOrFail({
          where: { id: tv.seasons[0].id },
        })
      )
    );
  });

  it('serialises the media of a request with exactly the keys it carries on develop', async () => {
    const movie = await saveMovie(604);
    const requester = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    const saved = await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MOVIE,
        media: movie,
        requestedBy: requester,
        status: MediaRequestStatus.PENDING,
      })
    );
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { id: saved.id },
      relations: { media: true },
    });

    assert.deepStrictEqual(
      Object.keys(JSON.parse(JSON.stringify(request)).media),
      DEVELOP_MEDIA_KEYS
    );
  });

  it('serialises a request carried in the requests of a media row without the music keys', async () => {
    const movie = await saveMovie(605);
    const requester = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MOVIE,
        media: movie,
        requestedBy: requester,
        status: MediaRequestStatus.PENDING,
      })
    );
    const loaded = await Media.getMedia(605, MediaType.MOVIE);

    assert.ok(loaded);
    assert.strictEqual(loaded.requests.length, 1);
    // the order of loaded relations is the query's, so the keys are compared as a set
    assert.deepStrictEqual(
      keysOf(loaded).sort(),
      [...DEVELOP_MEDIA_KEYS, 'requests', 'issues'].sort()
    );
  });

  it('serialises the mediaInfo the movie and TV routes answer (filter) with exactly the keys of develop', async () => {
    const saved = await saveMovie(606);
    const movie = await Media.getMedia(saved.tmdbId, MediaType.MOVIE);

    assert.ok(movie);
    assert.deepStrictEqual(
      keysOf(movie.filter()).sort(),
      [...DEVELOP_MEDIA_KEYS, 'requests', 'issues'].sort()
    );
  });

  it('leaves the music fields out of a movie or TV row even where they are set', () => {
    for (const mediaType of [MediaType.MOVIE, MediaType.TV]) {
      const row = new Media({
        mediaType,
        tmdbId: 1,
        musicBrainzId: 'mb',
        musicKind: MusicKind.ALBUM,
        artistMusicBrainzId: 'mb-artist',
      });
      const keys = keysOf(row);

      for (const key of MUSIC_KEYS) {
        assert.ok(!keys.includes(key), `${mediaType} row serialised ${key}`);
      }
    }
  });

  it('serialises the three music fields on an artist row and on an album row', async () => {
    const artist = await saveMusic('mb-artist', MusicKind.ARTIST);
    const album = await saveMusic('mb-album', MusicKind.ALBUM, 'mb-artist');

    const loadedArtist = JSON.parse(
      JSON.stringify(
        await getRepository(Media).findOneOrFail({ where: { id: artist.id } })
      )
    );
    const loadedAlbum = JSON.parse(
      JSON.stringify(
        await getRepository(Media).findOneOrFail({ where: { id: album.id } })
      )
    );

    for (const row of [loadedArtist, loadedAlbum]) {
      assert.deepStrictEqual(
        Object.keys(row).filter((k) => MUSIC_KEYS.includes(k)),
        MUSIC_KEYS
      );
      assert.strictEqual(row.tmdbId, null);
      assert.strictEqual(row.mediaType, 'music');
    }
    assert.strictEqual(loadedArtist.musicBrainzId, 'mb-artist');
    assert.strictEqual(loadedArtist.musicKind, 'artist');
    assert.strictEqual(loadedArtist.artistMusicBrainzId, null);
    assert.strictEqual(loadedAlbum.musicBrainzId, 'mb-album');
    assert.strictEqual(loadedAlbum.musicKind, 'album');
    assert.strictEqual(loadedAlbum.artistMusicBrainzId, 'mb-artist');
  });
});

describe('music rows in the media table', () => {
  it('refuses a second row of the same MusicBrainz id and kind', async () => {
    await saveMusic('mb-dup', MusicKind.ARTIST);

    await assert.rejects(() => saveMusic('mb-dup', MusicKind.ARTIST));
    // the same id under the other kind is another row
    await saveMusic('mb-dup', MusicKind.ALBUM, 'mb-other');
  });

  it('lets many movie and TV rows stand beside each other with null music columns', async () => {
    await saveMovie(1);
    await saveMovie(2);

    assert.strictEqual(await getRepository(Media).count(), 2);
  });
});

describe('Media.getMusicMedia', () => {
  it('gives the row of the id and kind with its requests and issues', async () => {
    const artist = await saveMusic('mb-a', MusicKind.ARTIST);
    const requester = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MUSIC,
        media: artist,
        requestedBy: requester,
        status: MediaRequestStatus.PENDING,
      })
    );

    const found = await Media.getMusicMedia('mb-a', MusicKind.ARTIST);

    assert.ok(found);
    assert.strictEqual(found.id, artist.id);
    assert.strictEqual(found.requests.length, 1);
    assert.deepStrictEqual(found.issues, []);
  });

  it('does not give the row of the same id under the other kind', async () => {
    await saveMusic('mb-a', MusicKind.ARTIST);

    assert.strictEqual(
      await Media.getMusicMedia('mb-a', MusicKind.ALBUM),
      undefined
    );
  });

  it('gives undefined for an id Seerr holds no row of, and never a movie or TV row', async () => {
    await saveMovie(603);

    assert.strictEqual(
      await Media.getMusicMedia('603', MusicKind.ARTIST),
      undefined
    );
    assert.strictEqual(
      await Media.getMusicMedia('mb-none', MusicKind.ALBUM),
      undefined
    );
  });
});

describe('Media.getRelatedMusicMedia', () => {
  it('gives the rows of the listed items and kinds in one query', async () => {
    const artist = await saveMusic('mb-a', MusicKind.ARTIST);
    // same id as the artist, other kind: not listed, so not given
    await saveMusic('mb-a', MusicKind.ALBUM, 'mb-x');
    const album = await saveMusic('mb-b', MusicKind.ALBUM, 'mb-a');
    await saveMusic('mb-c', MusicKind.ARTIST);
    await saveMovie(603);

    const getMany = mock.method(SelectQueryBuilder.prototype, 'getMany');
    let related: Media[];
    try {
      related = await Media.getRelatedMusicMedia([
        { mbid: 'mb-a', kind: MusicKind.ARTIST },
        { mbid: 'mb-b', kind: MusicKind.ALBUM },
        { mbid: 'mb-missing', kind: MusicKind.ALBUM },
      ]);
      assert.strictEqual(getMany.mock.callCount(), 1);
    } finally {
      getMany.mock.restore();
    }

    assert.deepStrictEqual(related.map((m) => m.id).sort(), [
      artist.id,
      album.id,
    ]);
  });

  it('gives nothing for no items, without a query', async () => {
    await saveMusic('mb-a', MusicKind.ARTIST);

    const getMany = mock.method(SelectQueryBuilder.prototype, 'getMany');
    try {
      assert.deepStrictEqual(await Media.getRelatedMusicMedia([]), []);
      assert.strictEqual(getMany.mock.callCount(), 0);
    } finally {
      getMany.mock.restore();
    }
  });
});
