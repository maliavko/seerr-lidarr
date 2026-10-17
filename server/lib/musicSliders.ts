import { getLidarrMetadata } from '@server/api/lidarrmetadata';
import { getListenBrainz } from '@server/api/listenbrainz';
import type { LidarrAlbum } from '@server/api/servarr/lidarr';
import type { MusicAlbumSummary, MusicArtistSummary } from '@server/lib/music';
import {
  buildLidarr,
  getDefaultLidarr,
  logFailure,
  metadataImage,
  toAlbumSummary,
} from '@server/lib/music';

// A music slider shows at most 20 items (F2-D-92).
export const SLIDER_LIMIT = 20;

// The albums the default Lidarr holds at least one track file of, the album
// whose newest track file Lidarr gained most recently first (ties in Lidarr's
// order, an album none of whose files was answered last), at most 20, read as
// Lidarr stands now (no cache). No default Lidarr server gives none; Lidarr
// failing, a batch of track files among it, throws.
export async function getRecentlyAddedAlbums(): Promise<MusicAlbumSummary[]> {
  const server = getDefaultLidarr();

  if (!server) {
    return [];
  }

  const lidarr = buildLidarr(server);
  const held = (await lidarr.getAlbums()).filter(
    (album): album is LidarrAlbum & { id: number } =>
      album.id !== undefined && (album.statistics?.trackFileCount ?? 0) > 0
  );

  if (held.length === 0) {
    return [];
  }

  const newest = new Map<number, number>();

  for (const file of await lidarr.getTrackFiles(held.map((a) => a.id))) {
    const added = Date.parse(file.dateAdded);

    if (
      !Number.isNaN(added) &&
      added > (newest.get(file.albumId) ?? -Infinity)
    ) {
      newest.set(file.albumId, added);
    }
  }

  const ordered = held
    .map((album, index) => ({ album, index }))
    .sort(
      (a, b) =>
        (newest.get(b.album.id) ?? -Infinity) -
          (newest.get(a.album.id) ?? -Infinity) || a.index - b.index
    )
    .slice(0, SLIDER_LIMIT)
    .map(({ album }) => album);

  // an album Lidarr gave without its artist has it by the artist's id
  const artists = ordered.some((album) => !album.artist)
    ? await lidarr.getArtists()
    : [];

  return ordered.map((album) =>
    toAlbumSummary({
      ...album,
      artist:
        album.artist ?? artists.find((artist) => artist.id === album.artistId),
    })
  );
}

// ListenBrainz's popular albums as album summaries, most listened first; none
// where ListenBrainz fails (the client answers an empty list).
export async function getPopularAlbumSummaries(): Promise<MusicAlbumSummary[]> {
  const popular = await getListenBrainz().getPopularAlbums();

  return popular.slice(0, SLIDER_LIMIT).map((album) => ({
    id: album.mbid,
    title: album.title,
    artist: album.artistMbid
      ? { id: album.artistMbid, name: album.artistName ?? '' }
      : undefined,
    secondaryTypes: [],
    coverUrl: album.coverUrl,
    inLidarr: false,
  }));
}

// The artists ListenBrainz gives as similar to an artist, most similar first,
// each with its image read by its MusicBrainz id from Lidarr's metadata service
// (side by side); an image that cannot be read is left out, never the list.
export async function getSimilarArtistSummaries(
  mbid: string
): Promise<MusicArtistSummary[]> {
  const similar = await getListenBrainz().getSimilarArtists(mbid);

  return Promise.all(
    similar.slice(0, SLIDER_LIMIT).map(async (artist) => {
      let imageUrl: string | undefined;

      try {
        const service = await getLidarrMetadata().getArtist(artist.mbid);
        imageUrl = metadataImage(service?.images, 'Poster');
      } catch (e) {
        logFailure(
          "Failed to read a similar artist's image from Lidarr's metadata service",
          e
        );
      }

      return {
        id: artist.mbid,
        name: artist.name,
        imageUrl,
        inLidarr: false,
      };
    })
  );
}
