import { MediaStatus } from '@server/constants/media';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { loadClient, renderClient } from './musicTestSupport';

type Component = (props: never) => React.ReactNode;

const page = (props: Record<string, unknown>) =>
  renderClient(
    () =>
      createElement(
        loadClient<{ default: Component }>('components/ArtistDetails')
          .default as never,
        props as never
      ),
    { mbid: 'artist-1' }
  );

const artist = {
  id: 'artist-1',
  name: 'Radiohead',
  genres: ['Rock'],
  artistType: 'Group',
  inLidarr: true,
  overview: 'An English rock band.',
  imageUrl: 'https://images.lidarr.audio/radiohead.jpg',
  mediaInfo: { status: MediaStatus.PARTIALLY_AVAILABLE },
  albums: [
    {
      id: 'album-1',
      title: 'OK Computer',
      releaseDate: '1997-05-21',
      coverUrl: 'https://coverartarchive.org/ok.jpg',
      mediaInfo: { status: MediaStatus.AVAILABLE },
    },
    { id: 'album-2', title: 'Kid A', releaseDate: '2000-10-02' },
  ],
};

describe('ArtistDetails', () => {
  it('shows name, image, overview, status and its albums', async () => {
    const html = await page({ artist });

    assert.match(html, /data-testid="media-title">Radiohead</);
    assert.ok(html.includes('src="https://images.lidarr.audio/radiohead.jpg"'));
    assert.match(html, /data-testid="artist-overview">An English rock band\./);
    assert.match(html, /<span>Partially Available<\/span>/);
    assert.match(html, /data-testid="artist-albums"/);
    assert.equal(html.match(/data-testid="album-card"/g)?.length, 2);
  });

  it('shows each album with cover or placeholder, title, year and status, linking to its page', async () => {
    const html = await page({ artist });

    assert.ok(html.includes('src="https://coverartarchive.org/ok.jpg"'));
    assert.ok(html.includes('src="/images/seerr_poster_not_found.png"'));
    assert.match(html, /href="\/music\/album\/album-2"/);
    assert.match(html, /data-testid="music-card-title">Kid A</);
    assert.match(html, />2000</);
    // Kid A has no status: only OK Computer's badge (available) is shown
    assert.equal(html.match(/bg-green-500\/80 border-green-400/g)?.length, 1);
  });

  it('shows the placeholder, no overview, no albums and no status where they are not known, and does not fail', async () => {
    const html = await page({
      artist: {
        id: 'artist-1',
        name: 'Unknown Artist',
        genres: [],
        inLidarr: false,
        albums: [],
      },
    });

    assert.match(html, /data-testid="media-title">Unknown Artist</);
    assert.ok(html.includes('src="/images/seerr_poster_not_found.png"'));
    assert.doesNotMatch(html, /artist-overview/);
    assert.doesNotMatch(html, /artist-albums/);
    assert.doesNotMatch(html, /<span>Available<\/span>|Partially|Pending/);
  });

  it('shows no badge for an unknown status', async () => {
    const html = await page({
      artist: { ...artist, mediaInfo: { status: MediaStatus.UNKNOWN } },
    });

    assert.doesNotMatch(html, /<span>Unknown<\/span>/);
    assert.doesNotMatch(html, /data-testid="music-status"><span/);
  });

  it('shows the not-found page for a 404 answer and the error page for a 500 or other failure', async () => {
    const notFound = await page({ statusCode: 404 });
    const failed = await page({ statusCode: 500 });
    const other = await page({ statusCode: 502 });

    assert.match(notFound, /404 - Something Went Wrong/);
    assert.match(failed, /500 - Internal Server Error/);
    assert.match(other, /500 - Internal Server Error/);
    assert.doesNotMatch(failed, /media-page/);
  });
});
