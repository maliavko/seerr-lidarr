import { MediaStatus } from '@server/constants/media';
import type { AlbumResult, ArtistResult } from '@server/models/Search';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { loadClient, renderClient } from './musicTestSupport';

type Props = Record<string, unknown>;
type Component = (props: never) => React.ReactNode;

const card = (name: 'ArtistCard' | 'AlbumCard', props: Props) =>
  renderClient(() =>
    createElement(
      loadClient<{ default: Component }>(`components/MusicCard/${name}`)
        .default as never,
      props as never
    )
  );

const PLACEHOLDER = '/images/seerr_poster_not_found.png';

describe('Artist card', () => {
  it('is marked Artist, shows the name, the placeholder where there is no image, and links to the artist page', async () => {
    const html = await card('ArtistCard', { id: 'mbid-1', name: 'Radiohead' });

    assert.match(html, /data-testid="artist-card"/);
    assert.match(html, /data-testid="music-card-kind">Artist</);
    assert.match(html, /data-testid="music-card-title">Radiohead</);
    assert.match(html, /href="\/music\/artist\/mbid-1"/);
    assert.ok(html.includes(`src="${PLACEHOLDER}"`));
    assert.doesNotMatch(html, /music-card-artist/);
  });

  it('shows the image it is given, unchanged', async () => {
    const html = await card('ArtistCard', {
      id: 'mbid-1',
      name: 'Radiohead',
      image: 'https://images.lidarr.audio/a.jpg',
    });

    assert.ok(html.includes('src="https://images.lidarr.audio/a.jpg"'));
    assert.ok(!html.includes(PLACEHOLDER));
  });

  it('shows a status badge for a known status and none where unknown or absent', async () => {
    const available = await card('ArtistCard', {
      id: 'a',
      name: 'N',
      status: MediaStatus.AVAILABLE,
    });
    const unknown = await card('ArtistCard', {
      id: 'a',
      name: 'N',
      status: MediaStatus.UNKNOWN,
    });
    const absent = await card('ArtistCard', { id: 'a', name: 'N' });

    assert.match(available, /bg-green-500\/80/);
    assert.doesNotMatch(unknown, /rounded-full shadow-md/);
    assert.doesNotMatch(absent, /rounded-full shadow-md/);
  });
});

describe('Album card', () => {
  it('is marked Album, shows title, artist name and year, and links to the album page', async () => {
    const html = await card('AlbumCard', {
      id: 'mbid-2',
      title: 'OK Computer',
      artistName: 'Radiohead',
      releaseDate: '1997-05-21',
    });

    assert.match(html, /data-testid="album-card"/);
    assert.match(html, /data-testid="music-card-kind">Album</);
    assert.match(html, /data-testid="music-card-title">OK Computer</);
    assert.match(html, /data-testid="music-card-artist">Radiohead</);
    assert.match(html, />1997</);
    assert.match(html, /href="\/music\/album\/mbid-2"/);
    assert.ok(html.includes(`src="${PLACEHOLDER}"`));
  });

  it('leaves out the artist and the year where not known', async () => {
    const html = await card('AlbumCard', {
      id: 'mbid-2',
      title: 'OK Computer',
      releaseDate: '0001-01-01',
    });

    assert.doesNotMatch(html, /music-card-artist/);
    assert.doesNotMatch(html, /0001/);
    assert.match(html, /data-testid="music-card-title">OK Computer</);
  });

  it('shows its cover and its status badge', async () => {
    const html = await card('AlbumCard', {
      id: 'mbid-2',
      title: 'T',
      image: 'https://coverartarchive.org/c.jpg',
      status: MediaStatus.PENDING,
    });

    assert.ok(html.includes('src="https://coverartarchive.org/c.jpg"'));
    assert.match(html, /bg-yellow-500\/80/);
  });
});

describe("ListView's music cases", () => {
  const artist: ArtistResult = {
    id: 'artist-1',
    mediaType: 'artist',
    name: 'Radiohead',
    imageUrl: undefined,
    mediaInfo: { status: MediaStatus.PARTIALLY_AVAILABLE } as never,
  };
  const album: AlbumResult = {
    id: 'album-1',
    mediaType: 'album',
    title: 'Kid A',
    artistId: 'artist-1',
    artistName: 'Radiohead',
    releaseDate: '2000-10-02',
    mediaInfo: { status: MediaStatus.AVAILABLE } as never,
  };

  it('renders an artist result as an Artist card and an album result as an Album card with its artist name', async () => {
    const ListView = loadClient<{ default: Component }>(
      'components/Common/ListView'
    ).default;
    const html = await renderClient(() =>
      createElement(
        ListView as never,
        {
          items: [artist, album],
          onScrollBottom: () => {},
          isReachingEnd: true,
        } as never
      )
    );

    assert.equal(html.match(/data-testid="artist-card"/g)?.length, 1);
    assert.equal(html.match(/data-testid="album-card"/g)?.length, 1);
    assert.match(html, /data-testid="music-card-kind">Artist</);
    assert.match(html, /data-testid="music-card-kind">Album</);
    assert.match(html, /href="\/music\/artist\/artist-1"/);
    assert.match(html, /href="\/music\/album\/album-1"/);
    assert.match(html, /data-testid="music-card-title">Kid A</);
    assert.match(html, /data-testid="music-card-artist">Radiohead</);
    assert.match(html, />2000</);
    assert.ok(html.includes('M5.25 12a.75.75 0 0 1 .75-.75h12'));
  });
});
