import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LidarrSettings } from '@server/lib/settings';
import {
  albumFacts,
  albumFiles,
  artistFacts,
  lidarrPageUrl,
  musicLinks,
  musicRating,
  officialHomepage,
} from './musicDetails';

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';

describe('musicLinks', () => {
  const lidarrLinks = [
    { name: 'myspace', url: 'https://myspace.com/radiohead' },
    { name: 'last', url: 'https://www.last.fm/music/Radiohead' },
    { name: 'discogs', url: 'https://www.discogs.com/artist/3840' },
    { name: 'discogs', url: 'https://www.discogs.com/artist/other' },
    { name: 'spotify', url: 'javascript:alert(1)' },
  ];

  it('leads with MusicBrainz and the official site, then the known sites in a fixed order, one link a site', () => {
    assert.deepEqual(
      musicLinks('artist', RADIOHEAD, lidarrLinks, 'https://www.radiohead.com'),
      [
        {
          name: 'musicbrainz',
          label: 'MusicBrainz',
          url: `https://musicbrainz.org/artist/${RADIOHEAD}`,
        },
        {
          name: 'official',
          label: 'Official site',
          url: 'https://www.radiohead.com',
        },
        {
          name: 'discogs',
          label: 'Discogs',
          url: 'https://www.discogs.com/artist/3840',
        },
        {
          name: 'last',
          label: 'Last.fm',
          url: 'https://www.last.fm/music/Radiohead',
        },
      ]
    );
  });

  it('links an album to its MusicBrainz release group, and leaves out what is not a web link', () => {
    const links = musicLinks('album', 'rg', [], 'ftp://example.org');
    assert.deepEqual(links, [
      {
        name: 'musicbrainz',
        label: 'MusicBrainz',
        url: 'https://musicbrainz.org/release-group/rg',
      },
    ]);
  });
});

describe('musicRating', () => {
  it('answers a rating with votes, none without', () => {
    assert.deepEqual(musicRating({ value: 9.1, votes: 89 }), {
      value: 9.1,
      votes: 89,
    });
    assert.equal(musicRating({ value: 0, votes: 0 }), undefined);
    assert.equal(musicRating(undefined), undefined);
  });
});

describe('artistFacts', () => {
  const musicBrainz = {
    id: RADIOHEAD,
    name: 'Radiohead',
    area: { name: 'United Kingdom' },
    'life-span': { begin: '1991', end: null, ended: false },
    relations: [
      { type: 'discogs', url: { resource: 'https://www.discogs.com/x' } },
      {
        type: 'official homepage',
        url: { resource: 'https://www.radiohead.com/' },
      },
    ],
  };

  it("takes the area and the years from MusicBrainz, and what Lidarr holds of the artist's albums", () => {
    assert.deepEqual(
      artistFacts(
        musicBrainz,
        { ended: false, sizeOnDisk: 5e9 },
        {
          listed: 9,
          held: 4,
        }
      ),
      {
        country: 'United Kingdom',
        begin: '1991',
        end: undefined,
        ended: false,
        albumsHeld: 4,
        albumsListed: 9,
        sizeOnDisk: 5e9,
      }
    );
    assert.equal(officialHomepage(musicBrainz), 'https://www.radiohead.com/');
  });

  it('takes whether the artist ended from Lidarr where MusicBrainz does not answer, and the end year where it has ended', () => {
    assert.equal(artistFacts(undefined, { ended: true }).ended, true);
    assert.deepEqual(
      artistFacts(
        {
          id: 'x',
          name: 'Kino',
          'life-span': { begin: '1981-05-01', end: '1990-08-15', ended: true },
        },
        undefined
      ),
      {
        country: undefined,
        begin: '1981',
        end: '1990',
        ended: true,
        albumsHeld: undefined,
        albumsListed: undefined,
        sizeOnDisk: undefined,
      }
    );
  });
});

describe('albumFacts and albumFiles', () => {
  it("takes the album's label, country, discs and length from its canonical release, and counts its releases", () => {
    const canonical = {
      foreignReleaseId: 'r1',
      monitored: false,
      label: ['', 'Parlophone'],
      country: ['United Kingdom'],
      mediumCount: 1,
      duration: 3207156,
    };
    assert.deepEqual(albumFacts(canonical, [canonical, canonical, canonical]), {
      label: 'Parlophone',
      country: 'United Kingdom',
      discs: 1,
      duration: 3207156,
      editions: 3,
    });
    assert.deepEqual(albumFacts(undefined), {
      label: undefined,
      country: undefined,
      discs: undefined,
      duration: undefined,
      editions: undefined,
    });
  });

  it('sums the files Lidarr holds and lists their qualities, the most common first', () => {
    const file = (name: string, size: number) => ({
      id: 1,
      albumId: 45,
      dateAdded: '2026-10-01T00:00:00Z',
      size,
      quality: { quality: { name } },
    });

    assert.deepEqual(
      albumFiles([file('MP3-320', 10), file('FLAC', 30), file('FLAC', 40)], 12),
      {
        trackFileCount: 3,
        trackCount: 12,
        sizeOnDisk: 80,
        qualities: ['FLAC', 'MP3-320'],
      }
    );
  });
});

describe('lidarrPageUrl', () => {
  const server = (externalUrl?: string) =>
    ({ hostname: 'lidarr', port: 8686, externalUrl }) as LidarrSettings;

  it("opens the artist or album under the server's external URL", () => {
    assert.equal(
      lidarrPageUrl(server('https://lidarr.example.org/'), 'album', 'rg'),
      'https://lidarr.example.org/album/rg'
    );
    assert.equal(
      lidarrPageUrl(server('https://lidarr.example.org'), 'artist', RADIOHEAD),
      `https://lidarr.example.org/artist/${RADIOHEAD}`
    );
  });

  it('gives none without an external URL: the server address is often a container name', () => {
    assert.equal(lidarrPageUrl(server(), 'album', 'rg'), undefined);
    assert.equal(lidarrPageUrl(server('  '), 'album', 'rg'), undefined);
  });
});
