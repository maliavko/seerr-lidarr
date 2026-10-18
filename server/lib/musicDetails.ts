import type { MusicBrainzArtist } from '@server/api/musicbrainz';
import type {
  LidarrLink,
  LidarrRatings,
  LidarrRelease,
  LidarrTrackFile,
} from '@server/api/servarr/lidarr';
import type { LidarrSettings } from '@server/lib/settings';

// What the artist and album pages show beside their own record: links out,
// a rating, facts, and - for what Lidarr holds - its files.

export interface MusicLink {
  // a stable key for the site ('musicbrainz', 'discogs', ...)
  name: string;
  // the site as the page names it
  label: string;
  url: string;
}

export interface MusicRating {
  // MusicBrainz's rating out of 10, as Lidarr gives it
  value: number;
  votes: number;
}

export interface MusicArtistFacts {
  country?: string;
  // the year the artist began, and ended where it has
  begin?: string;
  end?: string;
  ended?: boolean;
  // of the artist's albums on its page, how many Lidarr holds files of
  albumsHeld?: number;
  albumsListed?: number;
  // bytes of the artist's files in Lidarr
  sizeOnDisk?: number;
}

export interface MusicAlbumFacts {
  label?: string;
  country?: string;
  discs?: number;
  // milliseconds
  duration?: number;
  // the number of editions (releases) the album has
  editions?: number;
}

export interface MusicAlbumFiles {
  trackFileCount: number;
  trackCount: number;
  // bytes
  sizeOnDisk: number;
  // the qualities of the files, most files first ('FLAC', 'MP3-320')
  qualities: string[];
}

// The sites the pages link to, in the order they are shown; a link of
// Lidarr's list whose name is not here is left out.
const LINK_SITES: [string, string][] = [
  ['discogs', 'Discogs'],
  ['allmusic', 'AllMusic'],
  ['wikipedia', 'Wikipedia'],
  ['wikidata', 'Wikidata'],
  ['rateyourmusic', 'Rate Your Music'],
  ['last', 'Last.fm'],
  ['spotify', 'Spotify'],
  ['apple', 'Apple Music'],
  ['deezer', 'Deezer'],
  ['tidal', 'Tidal'],
  ['bandcamp', 'Bandcamp'],
  ['youtube', 'YouTube'],
  ['genius', 'Genius'],
  ['setlist', 'setlist.fm'],
];

// The links a page shows: MusicBrainz always, the artist's official site
// where MusicBrainz names one, then the known sites of Lidarr's list, one
// link a site.
export function musicLinks(
  kind: 'artist' | 'album',
  mbid: string,
  lidarrLinks: LidarrLink[] = [],
  homepage?: string
): MusicLink[] {
  const links: MusicLink[] = [
    {
      name: 'musicbrainz',
      label: 'MusicBrainz',
      url: `https://musicbrainz.org/${kind === 'artist' ? 'artist' : 'release-group'}/${mbid}`,
    },
  ];

  if (homepage && /^https?:\/\//.test(homepage)) {
    links.push({ name: 'official', label: 'Official site', url: homepage });
  }

  for (const [name, label] of LINK_SITES) {
    const found = lidarrLinks.find(
      (link) => link.name === name && /^https?:\/\//.test(link.url)
    );
    if (found) {
      links.push({ name, label, url: found.url });
    }
  }

  return links;
}

export const musicRating = (
  ratings?: LidarrRatings
): MusicRating | undefined =>
  ratings && ratings.votes > 0 && ratings.value > 0
    ? { value: ratings.value, votes: ratings.votes }
    : undefined;

const year = (date?: string | null): string | undefined => {
  const found = date?.slice(0, 4);
  return found && /^\d{4}$/.test(found) ? found : undefined;
};

// The artist's official site, as MusicBrainz relates it.
export const officialHomepage = (
  artist?: MusicBrainzArtist
): string | undefined =>
  artist?.relations?.find((relation) => relation.type === 'official homepage')
    ?.url?.resource;

// An artist's facts: its area and life span from MusicBrainz, whether it has
// ended from either source, and what Lidarr holds of it.
export function artistFacts(
  musicBrainz: MusicBrainzArtist | undefined,
  lidarr: { ended?: boolean; sizeOnDisk?: number } | undefined,
  albums?: { listed: number; held: number }
): MusicArtistFacts {
  const lifeSpan = musicBrainz?.['life-span'] ?? undefined;
  const ended = lifeSpan?.ended ?? lidarr?.ended ?? undefined;

  return {
    country: musicBrainz?.area?.name ?? undefined,
    begin: year(lifeSpan?.begin),
    end: year(lifeSpan?.end),
    ended: ended ?? undefined,
    albumsHeld: albums?.held,
    albumsListed: albums?.listed,
    sizeOnDisk: lidarr?.sizeOnDisk || undefined,
  };
}

// An album's facts, from its canonical release (label, country, discs,
// length) and the number of its releases.
export function albumFacts(
  canonical: LidarrRelease | undefined,
  releases: LidarrRelease[] = []
): MusicAlbumFacts {
  return {
    label: canonical?.label?.find((label) => !!label) ?? undefined,
    country: canonical?.country?.find((country) => !!country) ?? undefined,
    discs: canonical?.mediumCount || undefined,
    duration: canonical?.duration || undefined,
    editions: releases.length || undefined,
  };
}

// What Lidarr holds of an album: its files against its tracks, their size
// and their qualities, the most common first.
export function albumFiles(
  trackFiles: LidarrTrackFile[],
  trackCount: number
): MusicAlbumFiles {
  const qualities = new Map<string, number>();

  for (const file of trackFiles) {
    const name = file.quality?.quality?.name;
    if (name) {
      qualities.set(name, (qualities.get(name) ?? 0) + 1);
    }
  }

  return {
    trackFileCount: trackFiles.length,
    trackCount,
    sizeOnDisk: trackFiles.reduce((sum, file) => sum + (file.size ?? 0), 0),
    qualities: [...qualities.entries()]
      .sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))
      .map(([name]) => name),
  };
}

// Where an administrator opens an artist or album in Lidarr: under the
// server's external URL; none where it has no external URL, its own address
// (often a container's name) being no address a browser can open.
export function lidarrPageUrl(
  server: LidarrSettings,
  kind: 'artist' | 'album',
  mbid: string
): string | undefined {
  const base = server.externalUrl?.trim().replace(/\/+$/, '');

  return base && /^https?:\/\//.test(base)
    ? `${base}/${kind}/${mbid}`
    : undefined;
}
