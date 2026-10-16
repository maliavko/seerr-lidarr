import { MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { AlbumResult, ArtistResult } from '@server/models/Search';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  albumCardProps,
  artistCardProps,
  formatTrackLength,
  releaseYear,
  shownStatus,
} from './musicHelpers';

const mediaWith = (status: MediaStatus) => ({ status }) as unknown as Media;

describe('shownStatus', () => {
  it('shows the status of a known one and none where unknown or absent', () => {
    assert.equal(shownStatus(MediaStatus.AVAILABLE), MediaStatus.AVAILABLE);
    assert.equal(shownStatus(MediaStatus.PENDING), MediaStatus.PENDING);
    assert.equal(
      shownStatus(MediaStatus.PARTIALLY_AVAILABLE),
      MediaStatus.PARTIALLY_AVAILABLE
    );
    assert.equal(shownStatus(MediaStatus.UNKNOWN), undefined);
    assert.equal(shownStatus(undefined), undefined);
  });
});

describe('releaseYear', () => {
  it('gives the year of a date and nothing where unknown or malformed', () => {
    assert.equal(releaseYear('1997-05-21T00:00:00Z'), '1997');
    assert.equal(releaseYear('1997'), '1997');
    assert.equal(releaseYear(undefined), undefined);
    assert.equal(releaseYear(''), undefined);
    assert.equal(releaseYear('n/a'), undefined);
    // Lidarr's date for a release of unknown date
    assert.equal(releaseYear('0001-01-01T00:00:00Z'), undefined);
  });
});

describe('formatTrackLength', () => {
  it('writes milliseconds as m:ss', () => {
    assert.equal(formatTrackLength(284000), '4:44');
    assert.equal(formatTrackLength(61000), '1:01');
    assert.equal(formatTrackLength(5000), '0:05');
    assert.equal(formatTrackLength(3600000), '60:00');
  });
});

describe('music card props', () => {
  const artist: ArtistResult = {
    id: 'a-1',
    mediaType: 'artist',
    name: 'Radiohead',
    imageUrl: 'https://img/artist.jpg',
    mediaInfo: mediaWith(MediaStatus.PARTIALLY_AVAILABLE),
  };
  const album: AlbumResult = {
    id: 'b-1',
    mediaType: 'album',
    title: 'OK Computer',
    artistId: 'a-1',
    artistName: 'Radiohead',
    releaseDate: '1997-05-21T00:00:00Z',
    coverUrl: 'https://img/cover.jpg',
    mediaInfo: mediaWith(MediaStatus.AVAILABLE),
  };

  it('an Artist card shows name, image and status', () => {
    assert.deepEqual(artistCardProps(artist), {
      id: 'a-1',
      name: 'Radiohead',
      image: 'https://img/artist.jpg',
      status: MediaStatus.PARTIALLY_AVAILABLE,
    });
  });

  it('an Album card in search shows title, artist name, year, cover and status', () => {
    assert.deepEqual(albumCardProps(album), {
      id: 'b-1',
      title: 'OK Computer',
      artistName: 'Radiohead',
      releaseDate: '1997-05-21T00:00:00Z',
      image: 'https://img/cover.jpg',
      status: MediaStatus.AVAILABLE,
    });
  });

  it('shows no status where there is no mediaInfo or it is unknown, and no image where there is none', () => {
    assert.equal(
      artistCardProps({ ...artist, mediaInfo: undefined, imageUrl: undefined })
        .status,
      undefined
    );
    assert.equal(
      artistCardProps({ ...artist, imageUrl: undefined }).image,
      undefined
    );
    assert.equal(
      albumCardProps({
        ...album,
        mediaInfo: mediaWith(MediaStatus.UNKNOWN),
        artistName: undefined,
        coverUrl: undefined,
      }).status,
      undefined
    );
    assert.equal(
      albumCardProps({ ...album, artistName: undefined }).artistName,
      undefined
    );
  });
});
