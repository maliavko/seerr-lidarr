import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MediaStatus, MediaType, MusicKind } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import type { MusicAlbumSummary, MusicArtistSummary } from '@server/lib/music';
import { buildMusicResults } from '@server/lib/musicResults';
import { setupTestDb } from '@server/test/db';

// The helper search's music results and the music sliders are both built by
// (F2-D-92): its own order and answers are held here; search's through its
// route's tests.

setupTestDb();

const artist = (n: number): MusicArtistSummary => ({
  id: `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`,
  name: `Artist ${n}`,
  inLidarr: false,
});

const album = (n: number, artistN: number): MusicAlbumSummary => ({
  id: `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`,
  title: `Album ${n}`,
  artist: { id: artist(artistN).id, name: artist(artistN).name },
  secondaryTypes: [],
  coverUrl: 'https://img.example/c.jpg',
  inLidarr: false,
});

describe('buildMusicResults', () => {
  it('answers nothing for nothing', async () => {
    assert.deepStrictEqual(await buildMusicResults([], []), []);
  });

  it('answers the artists and then the albums, each in the order given, in search shape', async () => {
    const results = await buildMusicResults(
      [artist(2), artist(1)],
      [album(2, 1), album(1, 1)]
    );

    assert.deepStrictEqual(
      results.map((r) => [r.mediaType, r.id.slice(-3)]),
      [
        ['artist', '002'],
        ['artist', '001'],
        ['album', '002'],
        ['album', '001'],
      ]
    );
    assert.deepStrictEqual(results[2], {
      id: album(2, 1).id,
      mediaType: 'album',
      title: 'Album 2',
      artistId: artist(1).id,
      artistName: 'Artist 1',
      releaseDate: undefined,
      albumType: undefined,
      coverUrl: 'https://img.example/c.jpg',
      mediaInfo: undefined,
    });
  });

  it("carries each item's media row with the status the server computes, none for an item nothing is known of", async () => {
    await getRepository(Media).save([
      new Media({
        mediaType: MediaType.MUSIC,
        musicBrainzId: artist(1).id,
        musicKind: MusicKind.ARTIST,
        status: MediaStatus.PARTIALLY_AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      }),
      new Media({
        mediaType: MediaType.MUSIC,
        musicBrainzId: album(1, 1).id,
        musicKind: MusicKind.ALBUM,
        artistMusicBrainzId: artist(1).id,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      }),
    ]);

    const results = await buildMusicResults(
      [artist(1), artist(2)],
      [album(1, 1), album(2, 1)]
    );

    assert.deepStrictEqual(
      results.map((r) => r.mediaInfo?.status),
      [
        MediaStatus.PARTIALLY_AVAILABLE,
        undefined,
        MediaStatus.AVAILABLE,
        undefined,
      ]
    );
  });
});
