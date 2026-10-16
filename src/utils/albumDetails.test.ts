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
        loadClient<{ default: Component }>('components/AlbumDetails')
          .default as never,
        props as never
      ),
    { mbid: 'album-1' }
  );

const album = {
  id: 'album-1',
  title: 'OK Computer',
  artist: { id: 'artist-1', name: 'Radiohead' },
  releaseDate: '1997-05-21',
  albumType: 'Album',
  secondaryTypes: [],
  genres: [],
  inLidarr: true,
  coverUrl: 'https://coverartarchive.org/ok.jpg',
  overview: 'The third album.',
  mediaInfo: { status: MediaStatus.AVAILABLE },
  tracks: [
    { disc: 1, position: 1, number: '1', title: 'Airbag', length: 284000 },
    {
      disc: 1,
      position: 2,
      number: '2',
      title: 'Paranoid Android',
      length: 387000,
    },
    { disc: 1, position: 3, number: '3', title: 'No Length' },
  ],
};

describe('AlbumDetails', () => {
  it('shows title, year, cover, status and the artist linking to its page', async () => {
    const html = await page({ album });

    assert.match(html, /data-testid="media-title">OK Computer/);
    assert.match(html, /data-testid="album-year">\(1997\)</);
    assert.ok(html.includes('src="https://coverartarchive.org/ok.jpg"'));
    assert.match(html, /<span>Available<\/span>/);
    assert.match(html, /data-testid="album-artist"/);
    assert.match(
      html,
      /<a [^>]*href="\/music\/artist\/artist-1"[^>]*>Radiohead<\/a>/
    );
    assert.match(html, /data-testid="album-overview">The third album\./);
  });

  it('shows the track list with number, title and length as m:ss, and no length where unknown', async () => {
    const html = await page({ album });
    const rows =
      html.match(/<tr[^>]*data-testid="album-track">.*?<\/tr>/g) ?? [];

    assert.equal(rows.length, 3);
    assert.match(
      rows[0],
      /<td[^>]*>1<\/td><td[^>]*>Airbag<\/td><td[^>]*>4:44<\/td>/
    );
    assert.match(
      rows[1],
      /<td[^>]*>2<\/td><td[^>]*>Paranoid Android<\/td><td[^>]*>6:27<\/td>/
    );
    assert.match(
      rows[2],
      /<td[^>]*>3<\/td><td[^>]*>No Length<\/td><td[^>]*><\/td>/
    );
  });

  it('shows the placeholder, and no year, tracks, overview or status where they are not known, and does not fail', async () => {
    const html = await page({
      album: {
        id: 'album-1',
        title: 'Mystery',
        artist: { id: 'artist-1', name: 'Various Artists' },
        releaseDate: '0001-01-01',
        secondaryTypes: [],
        genres: [],
        inLidarr: false,
        tracks: [],
      },
    });

    assert.match(html, /data-testid="media-title">Mystery/);
    assert.ok(html.includes('src="/images/seerr_poster_not_found.png"'));
    assert.doesNotMatch(html, /album-year/);
    assert.doesNotMatch(html, /album-tracks/);
    assert.doesNotMatch(html, /album-overview/);
    assert.doesNotMatch(html, /data-testid="music-status"><span/);
  });

  it('shows the not-found page for a 404 answer and the error page for a 500', async () => {
    const notFound = await page({ statusCode: 404 });
    const failed = await page({ statusCode: 500 });

    assert.match(notFound, /404 - Something Went Wrong/);
    assert.match(failed, /500 - Internal Server Error/);
    assert.doesNotMatch(failed, /media-page/);
  });
});
