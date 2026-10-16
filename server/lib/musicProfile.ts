import type { LidarrAlbum, MetadataProfile } from '@server/api/servarr/lidarr';

// Whether an album's types fall inside a saved metadata profile as Lidarr's
// profile filter reads them (D-352), read on an album of Lidarr's lookup by the send and on an entry of getAlbums by lidarr-scan (D-381): its primary type is allowed, and either
// it has no secondary type and Studio is allowed or one of its secondary types
// is allowed, and, where the lookup lists its releases, one has an allowed
// status.
export const albumInProfile = (
  album: LidarrAlbum,
  profile: MetadataProfile
): boolean => {
  const allowed = (
    list: { albumType: { name: string }; allowed: boolean }[] | undefined,
    name: string | undefined
  ): boolean =>
    !!name &&
    (list ?? []).some(
      (t) => t.allowed && t.albumType.name.toLowerCase() === name.toLowerCase()
    );
  const secondary = album.secondaryTypes ?? [];
  const releases = album.releases ?? [];

  return (
    allowed(profile.primaryAlbumTypes, album.albumType) &&
    (secondary.length === 0
      ? allowed(profile.secondaryAlbumTypes, 'Studio')
      : secondary.some((t) => allowed(profile.secondaryAlbumTypes, t))) &&
    (releases.length === 0 ||
      releases.some((r) =>
        (profile.releaseStatuses ?? []).some(
          (st) =>
            st.allowed &&
            st.releaseStatus.name.toLowerCase() === r.status?.toLowerCase()
        )
      ))
  );
};
