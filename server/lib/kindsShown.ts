import type {
  LidarrSettings,
  RadarrSettings,
  SonarrSettings,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';

export type KindShown = 'movie' | 'tv' | 'music' | 'person';

// The kinds of media Seerr shows (F2-D-2, F2-D-31), computed from the settings
// as they stand at each call and stored nowhere: movie while any Radarr server
// is configured (4K or not), tv while any Sonarr server is, music while a
// Lidarr server is marked default, person while movie or tv is. In the order
// movie, tv, music, person.
export const getKindsShown = (
  settings: {
    radarr: RadarrSettings[];
    sonarr: SonarrSettings[];
    lidarr: LidarrSettings[];
  } = getSettings()
): KindShown[] => {
  const movie = settings.radarr.length > 0;
  const tv = settings.sonarr.length > 0;
  const music = settings.lidarr.some((lidarr) => lidarr.isDefault);

  return [
    ...(movie ? (['movie'] as const) : []),
    ...(tv ? (['tv'] as const) : []),
    ...(music ? (['music'] as const) : []),
    ...(movie || tv ? (['person'] as const) : []),
  ];
};
