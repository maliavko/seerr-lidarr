import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';

// A Radarr and a Sonarr server as the settings hold them, for a test that
// needs movies, TV and people shown (F2-D-2): the kinds shown follow the
// servers configured.
export const radarrServer = (
  overrides: Partial<RadarrSettings> = {}
): RadarrSettings => ({
  id: 0,
  name: 'Test Radarr',
  hostname: '127.0.0.1',
  port: 7878,
  apiKey: 'test-key',
  useSsl: false,
  activeProfileId: 1,
  activeProfileName: 'Any',
  activeDirectory: '/movies',
  tags: [],
  is4k: false,
  isDefault: true,
  syncEnabled: false,
  preventSearch: false,
  tagRequests: false,
  overrideRule: [],
  minimumAvailability: 'released',
  ...overrides,
});

export const sonarrServer = (
  overrides: Partial<SonarrSettings> = {}
): SonarrSettings => ({
  id: 0,
  name: 'Test Sonarr',
  hostname: '127.0.0.1',
  port: 8989,
  apiKey: 'test-key',
  useSsl: false,
  activeProfileId: 1,
  activeProfileName: 'Any',
  activeDirectory: '/tv',
  tags: [],
  is4k: false,
  isDefault: true,
  syncEnabled: false,
  preventSearch: false,
  tagRequests: false,
  overrideRule: [],
  seriesType: 'standard',
  animeSeriesType: 'anime',
  enableSeasonFolders: true,
  monitorNewItems: 'all',
  ...overrides,
});
