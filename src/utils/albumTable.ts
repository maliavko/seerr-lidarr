import { releaseYear } from './musicHelpers';

// What the artist page's album table reads of an album.
export interface AlbumTableRow {
  id: string;
  title: string;
  releaseDate?: string;
  albumType?: string;
  secondaryTypes?: string[];
  trackCount?: number;
}

export type AlbumSortKey = 'year' | 'title' | 'type' | 'tracks';
export type SortDirection = 'asc' | 'desc';

export interface AlbumSort {
  key: AlbumSortKey;
  direction: SortDirection;
}

// The order the page opens on: the latest release first.
export const DEFAULT_ALBUM_SORT: AlbumSort = { key: 'year', direction: 'desc' };

// An album's type as one label: its primary type and its secondary ones
// ("Album · Live"), none where the source gives none.
export const albumTypeLabel = (album: AlbumTableRow): string =>
  [album.albumType, ...(album.secondaryTypes ?? [])]
    .filter((type): type is string => !!type)
    .join(' · ');

// The value an album is sorted by under a key; undefined where unknown.
const sortValue = (
  album: AlbumTableRow,
  key: AlbumSortKey
): string | number | undefined => {
  switch (key) {
    case 'year':
      return album.releaseDate || undefined;
    case 'title':
      return album.title.toLocaleLowerCase();
    case 'type':
      return albumTypeLabel(album).toLocaleLowerCase() || undefined;
    case 'tracks':
      return album.trackCount;
  }
};

// The albums sorted by a column: albums whose value is unknown always last,
// by title among equals.
export const sortAlbums = <T extends AlbumTableRow>(
  albums: T[],
  { key, direction }: AlbumSort
): T[] =>
  [...albums].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);

    if (va === undefined || vb === undefined) {
      if (va === vb) {
        return a.title.localeCompare(b.title);
      }
      return va === undefined ? 1 : -1;
    }

    const order =
      typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb));

    return (
      (direction === 'asc' ? order : -order) || a.title.localeCompare(b.title)
    );
  });

// The sort after pressing a column's header: the same column flips its
// direction; another starts descending for year and tracks, ascending else.
export const nextAlbumSort = (
  current: AlbumSort,
  key: AlbumSortKey
): AlbumSort =>
  current.key === key
    ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
    : { key, direction: key === 'year' || key === 'tracks' ? 'desc' : 'asc' };

export const albumYear = (album: AlbumTableRow): string =>
  releaseYear(album.releaseDate) ?? '—';

// How the artist page shows its albums, as the viewer last chose it.
export type AlbumView = 'cards' | 'table';

const VIEW_KEY = 'artist-albums-view';

export const readAlbumView = (): AlbumView => {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'table'
      ? 'table'
      : 'cards';
  } catch {
    return 'cards';
  }
};

export const saveAlbumView = (view: AlbumView): void => {
  try {
    window.localStorage.setItem(VIEW_KEY, view);
  } catch {
    // storage unavailable: the choice lasts this page only
  }
};
