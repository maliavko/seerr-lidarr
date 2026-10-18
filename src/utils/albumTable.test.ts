import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_ALBUM_SORT,
  albumTypeLabel,
  albumYear,
  nextAlbumSort,
  sortAlbums,
} from './albumTable';

const albums = [
  {
    id: '1',
    title: 'OK Computer',
    releaseDate: '1997-05-21',
    albumType: 'Album',
    trackCount: 12,
  },
  {
    id: '2',
    title: 'I Might Be Wrong',
    releaseDate: '2001-11-12',
    albumType: 'Album',
    secondaryTypes: ['Live'],
    trackCount: 8,
  },
  { id: '3', title: 'Airbag', releaseDate: '1998-03-23', albumType: 'EP' },
  { id: '4', title: 'Untitled', albumType: 'Album', trackCount: 20 },
  {
    id: '5',
    title: 'Kid A',
    releaseDate: '2000-10-02',
    albumType: 'Album',
    trackCount: 10,
  },
];

const titles = (rows: { title: string }[]) => rows.map((row) => row.title);

describe('sortAlbums', () => {
  it('opens on the latest release first, undated albums last', () => {
    assert.deepEqual(titles(sortAlbums(albums, DEFAULT_ALBUM_SORT)), [
      'I Might Be Wrong',
      'Kid A',
      'Airbag',
      'OK Computer',
      'Untitled',
    ]);
  });

  it('sorts by year ascending, unknown still last', () => {
    assert.deepEqual(
      titles(sortAlbums(albums, { key: 'year', direction: 'asc' })),
      ['OK Computer', 'Airbag', 'Kid A', 'I Might Be Wrong', 'Untitled']
    );
  });

  it('sorts by track count, albums with no count last in either direction', () => {
    assert.deepEqual(
      titles(sortAlbums(albums, { key: 'tracks', direction: 'desc' })),
      ['Untitled', 'OK Computer', 'Kid A', 'I Might Be Wrong', 'Airbag']
    );
    assert.deepEqual(
      titles(sortAlbums(albums, { key: 'tracks', direction: 'asc' })),
      ['I Might Be Wrong', 'Kid A', 'OK Computer', 'Untitled', 'Airbag']
    );
  });

  it('sorts by title and by type, by title among equal types', () => {
    assert.deepEqual(
      titles(sortAlbums(albums, { key: 'title', direction: 'asc' })),
      ['Airbag', 'I Might Be Wrong', 'Kid A', 'OK Computer', 'Untitled']
    );
    assert.deepEqual(
      titles(sortAlbums(albums, { key: 'type', direction: 'asc' })),
      ['Kid A', 'OK Computer', 'Untitled', 'I Might Be Wrong', 'Airbag']
    );
  });

  it('leaves the given list as it was', () => {
    const copy = [...albums];
    sortAlbums(albums, { key: 'title', direction: 'asc' });
    assert.deepEqual(albums, copy);
  });
});

describe('nextAlbumSort', () => {
  it('flips the direction of the same column', () => {
    assert.deepEqual(nextAlbumSort(DEFAULT_ALBUM_SORT, 'year'), {
      key: 'year',
      direction: 'asc',
    });
  });

  it('starts year and tracks descending, title and type ascending', () => {
    assert.deepEqual(nextAlbumSort(DEFAULT_ALBUM_SORT, 'tracks'), {
      key: 'tracks',
      direction: 'desc',
    });
    assert.deepEqual(nextAlbumSort(DEFAULT_ALBUM_SORT, 'title'), {
      key: 'title',
      direction: 'asc',
    });
  });
});

describe('albumTypeLabel and albumYear', () => {
  it('joins the primary and secondary types, and shows a dash for no year', () => {
    assert.equal(albumTypeLabel(albums[1]), 'Album · Live');
    assert.equal(albumTypeLabel({ id: 'x', title: 'x' }), '');
    assert.equal(albumYear(albums[0]), '1997');
    assert.equal(albumYear(albums[3]), '—');
  });
});
