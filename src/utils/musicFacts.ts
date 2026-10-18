import { formatBytes } from './numberHelpers';

// How the music pages write what their facts hold.

export interface MusicLinkItem {
  name: string;
  label: string;
  url: string;
}

export interface MusicRatingItem {
  value: number;
  votes: number;
}

// An album's length as h:mm:ss, or m:ss under an hour.
export const formatAlbumLength = (milliseconds: number): string => {
  const total = Math.round(milliseconds / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
};

// The years an artist was active: '1991 – present', '1981 – 1990', or only
// what is known.
export const activeYears = (
  begin?: string,
  end?: string,
  ended?: boolean,
  present = 'present'
): string | undefined => {
  if (!begin && !end) {
    return undefined;
  }
  if (begin && !end) {
    return ended ? begin : `${begin} – ${present}`;
  }
  return `${begin ?? '?'} – ${end}`;
};

// A rating as '9.1 / 10'.
export const ratingText = (rating: MusicRatingItem): string =>
  `${rating.value.toFixed(1)} / 10`;

export const sizeText = (bytes?: number): string | undefined =>
  bytes && bytes > 0 ? formatBytes(bytes, 1) : undefined;

// The page a genre tag opens: the genre's tag on MusicBrainz.
export const genreUrl = (genre: string): string =>
  `https://musicbrainz.org/tag/${encodeURIComponent(genre.toLowerCase())}`;
