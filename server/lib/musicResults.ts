import { MusicKind } from '@server/constants/media';
import Media from '@server/entity/Media';
import type { MusicAlbumSummary, MusicArtistSummary } from '@server/lib/music';
import { musicMediaInfo, resolveMusicItems } from '@server/lib/musicStatus';
import type { MusicResults } from '@server/models/Search';
import { mapAlbumResult, mapArtistResult } from '@server/models/Search';

// Artist and album summaries as the music results search and the music
// sliders answer (F2-D-92): the artists and then the albums, in the order
// given, each with its media row and the status the server computes for music.
// An artist whose covering is undecided carries its row as it is; an album
// whose covering is undecided is left out, the rest standing. A failure of the
// database or of the covering's sources throws, for the caller to answer as its
// place requires.
export async function buildMusicResults(
  artists: MusicArtistSummary[],
  albums: MusicAlbumSummary[]
): Promise<MusicResults[]> {
  const media = await Media.getRelatedMusicMedia([
    ...artists.map((artist) => ({
      mbid: artist.id,
      kind: MusicKind.ARTIST,
    })),
    ...albums.map((album) => ({
      mbid: album.id,
      kind: MusicKind.ALBUM,
    })),
  ]);
  const resolutions = await resolveMusicItems([
    ...artists.map((artist) => ({
      mbid: artist.id,
      kind: MusicKind.ARTIST,
    })),
    ...albums.map((album) => ({
      mbid: album.id,
      kind: MusicKind.ALBUM,
      artistMbid: album.artist?.id,
    })),
  ]);
  const rowOf = (mbid: string, kind: MusicKind) =>
    media.find((row) => row.musicBrainzId === mbid && row.musicKind === kind);

  return [
    ...artists.map((artist, index) => {
      const resolved = resolutions[index];

      return mapArtistResult(
        artist,
        resolved.decided
          ? musicMediaInfo(resolved, rowOf(artist.id, MusicKind.ARTIST))
          : rowOf(artist.id, MusicKind.ARTIST)
      );
    }),
    ...albums.flatMap((album, index) => {
      const resolved = resolutions[artists.length + index];

      return resolved.decided
        ? [
            mapAlbumResult(
              album,
              musicMediaInfo(resolved, rowOf(album.id, MusicKind.ALBUM))
            ),
          ]
        : [];
    }),
  ];
}
