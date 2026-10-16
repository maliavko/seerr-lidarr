import type { LidarrAlbum, MetadataProfile } from '@server/api/servarr/lidarr';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// What the tests of the music covering (D-362) give for the default Lidarr
// server's saved metadata profile and for the albums Lidarr lists for a held
// artist: the profiles recorded from the test Lidarr (the saved one, 'Standard',
// takes in Album and Studio only) and the S139 albums of Burial under another
// profile and under the saved one.

const readJson = <T>(...path: string[]): T =>
  JSON.parse(readFileSync(join(__dirname, '..', ...path), 'utf8')) as T;

export const savedProfiles = (): MetadataProfile[] =>
  readJson<MetadataProfile[]>(
    'api/servarr/lidarr.fixtures/metadataprofiles.json'
  );

// the 13 albums Lidarr listed for Burial under a profile taking in EPs (2 Album,
// 11 EP), and the 2 it lists under the saved one
export const burialUnderOtherProfile = (): LidarrAlbum[] =>
  readJson<LidarrAlbum[]>(
    'lib/scanners/lidarr.fixtures/albums-burial-metadata-profile-other.json'
  );
export const burialUnderSavedProfile = (): LidarrAlbum[] =>
  readJson<LidarrAlbum[]>(
    'lib/scanners/lidarr.fixtures/albums-burial-metadata-profile-saved.json'
  );

// An album as Lidarr lists it for a held artist, of the types given (an Album
// with no secondary type, which the saved profile takes in, by default)
export const listedAlbum = (
  foreignAlbumId: string,
  albumType = 'Album'
): LidarrAlbum =>
  ({
    foreignAlbumId,
    title: `Album ${foreignAlbumId}`,
    albumType,
    secondaryTypes: [],
    images: [],
    monitored: false,
  }) as unknown as LidarrAlbum;

// What LidarrAPI's getMetadataProfile answers for the saved profile: the one the
// server saved, or a stated error where Lidarr fails or does not have it
export function savedProfileAnswer(
  profile: 'saved' | 'lacking' | Error,
  id: number
): MetadataProfile {
  if (profile instanceof Error) {
    throw profile;
  }

  const found =
    profile === 'saved' ? savedProfiles().find((p) => p.id === id) : undefined;

  if (!found) {
    throw new Error(
      `[Lidarr] Failed to retrieve metadata profile: no metadata profile ${id}`
    );
  }

  return found;
}
