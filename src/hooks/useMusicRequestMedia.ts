import type { MusicAlbumDetails } from '@app/components/AlbumDetails';
import type { MusicArtistDetails } from '@app/components/ArtistDetails';
import { isRequestListKey, musicRequestTarget } from '@app/utils/musicRequests';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import useSWR, { useSWRConfig } from 'swr';

// What a music request's row or card shows of its item, from the music routes
// (D-9): the album's title, artist and cover, or the artist's name and image.
// Where the route fails, or gives no image, it is what the request has (R-14).
export interface MusicRequestMedia {
  kind?: 'album' | 'artist';
  href?: string;
  title?: string;
  artist?: { id: string; name: string };
  image?: string;
  releaseDate?: string;
  loading: boolean;
}

const useMusicRequestMedia = (
  request: NonFunctionProperties<MediaRequest>,
  enabled: boolean
): MusicRequestMedia => {
  const target = musicRequestTarget(request.media);
  const { data, error } = useSWR<MusicAlbumDetails | MusicArtistDetails>(
    enabled && target ? target.apiUrl : null
  );

  if (!target) {
    return { loading: false };
  }

  if (!data) {
    return {
      kind: target.kind,
      href: target.href,
      loading: enabled && !error,
    };
  }

  if (target.kind === 'album') {
    const album = data as MusicAlbumDetails;

    return {
      kind: 'album',
      href: target.href,
      title: album.title,
      artist: album.artist,
      image: album.coverUrl,
      releaseDate: album.releaseDate,
      loading: false,
    };
  }

  const artist = data as MusicArtistDetails;

  return {
    kind: 'artist',
    href: target.href,
    title: artist.name,
    image: artist.imageUrl,
    loading: false,
  };
};

// Refresh every requests list the client holds, after an act on a request.
export const useRefreshRequestLists = () => {
  const { mutate } = useSWRConfig();

  return () => {
    mutate(isRequestListKey);
    mutate('/api/v1/request/count');
  };
};

export default useMusicRequestMedia;
