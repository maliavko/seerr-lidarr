import { MediaStatus } from '@server/constants/media';
import type { AlbumResult, ArtistResult } from '@server/models/Search';

// The status a music card or page shows as a badge: the badges movies use,
// and none where there is no status or it is unknown (D-101).
export const shownStatus = (status?: MediaStatus): MediaStatus | undefined =>
  status !== undefined && status !== MediaStatus.UNKNOWN ? status : undefined;

// The year of a release date as the source gives it ("1997-05-21"), where known.
export const releaseYear = (releaseDate?: string): string | undefined => {
  const year = releaseDate?.slice(0, 4);

  return year && /^\d{4}$/.test(year) && Number(year) > 1 ? year : undefined;
};

// A track's length in milliseconds as m:ss.
export const formatTrackLength = (milliseconds: number): string => {
  const totalSeconds = Math.round(milliseconds / 1000);
  const seconds = totalSeconds % 60;

  return `${Math.floor(totalSeconds / 60)}:${seconds < 10 ? '0' : ''}${seconds}`;
};

// What an Artist card shows of a search result: name, image, status.
export const artistCardProps = (artist: ArtistResult) => ({
  id: artist.id,
  name: artist.name,
  image: artist.imageUrl,
  status: shownStatus(artist.mediaInfo?.status),
});

// What an Album card shows of a search result: title, its artist's name (as
// AlbumResult's artistName gives it), year, cover, status.
export const albumCardProps = (album: AlbumResult) => ({
  id: album.id,
  title: album.title,
  artistName: album.artistName,
  releaseDate: album.releaseDate,
  image: album.coverUrl,
  status: shownStatus(album.mediaInfo?.status),
});
