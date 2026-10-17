import type DiscoverSlider from '@server/entity/DiscoverSlider';

export enum DiscoverSliderType {
  RECENTLY_ADDED = 1,
  RECENT_REQUESTS,
  PLEX_WATCHLIST,
  TRENDING,
  POPULAR_MOVIES,
  MOVIE_GENRES,
  UPCOMING_MOVIES,
  STUDIOS,
  POPULAR_TV,
  TV_GENRES,
  UPCOMING_TV,
  NETWORKS,
  TMDB_MOVIE_KEYWORD,
  TMDB_MOVIE_GENRE,
  TMDB_TV_KEYWORD,
  TMDB_TV_GENRE,
  TMDB_SEARCH,
  TMDB_STUDIO,
  TMDB_NETWORK,
  TMDB_MOVIE_STREAMING_SERVICES,
  TMDB_TV_STREAMING_SERVICES,
  RECENTLY_ADDED_MUSIC = 22,
  RECENT_MUSIC_REQUESTS = 23,
  POPULAR_ALBUMS = 24,
}

// The built-in sliders of music (F2-D-7, F2-D-211): created after the last slider
// saved and disabled, so no existing home page changes until an administrator
// enables them.
export const musicSliderTypes: DiscoverSliderType[] = [
  DiscoverSliderType.RECENTLY_ADDED_MUSIC,
  DiscoverSliderType.RECENT_MUSIC_REQUESTS,
  DiscoverSliderType.POPULAR_ALBUMS,
];

export const defaultSliders: Partial<DiscoverSlider>[] = [
  {
    type: DiscoverSliderType.RECENTLY_ADDED,
    enabled: true,
    isBuiltIn: true,
    order: 0,
  },
  {
    type: DiscoverSliderType.RECENT_REQUESTS,
    enabled: true,
    isBuiltIn: true,
    order: 1,
  },
  {
    type: DiscoverSliderType.PLEX_WATCHLIST,
    enabled: true,
    isBuiltIn: true,
    order: 2,
  },
  {
    type: DiscoverSliderType.TRENDING,
    enabled: true,
    isBuiltIn: true,
    order: 3,
  },
  {
    type: DiscoverSliderType.POPULAR_MOVIES,
    enabled: true,
    isBuiltIn: true,
    order: 4,
  },
  {
    type: DiscoverSliderType.MOVIE_GENRES,
    enabled: true,
    isBuiltIn: true,
    order: 5,
  },
  {
    type: DiscoverSliderType.UPCOMING_MOVIES,
    enabled: true,
    isBuiltIn: true,
    order: 6,
  },
  {
    type: DiscoverSliderType.STUDIOS,
    enabled: true,
    isBuiltIn: true,
    order: 7,
  },
  {
    type: DiscoverSliderType.POPULAR_TV,
    enabled: true,
    isBuiltIn: true,
    order: 8,
  },
  {
    type: DiscoverSliderType.TV_GENRES,
    enabled: true,
    isBuiltIn: true,
    order: 9,
  },
  {
    type: DiscoverSliderType.UPCOMING_TV,
    enabled: true,
    isBuiltIn: true,
    order: 10,
  },
  {
    type: DiscoverSliderType.NETWORKS,
    enabled: true,
    isBuiltIn: true,
    order: 11,
  },
  {
    type: DiscoverSliderType.RECENTLY_ADDED_MUSIC,
    enabled: false,
    isBuiltIn: true,
    order: 12,
  },
  {
    type: DiscoverSliderType.RECENT_MUSIC_REQUESTS,
    enabled: false,
    isBuiltIn: true,
    order: 13,
  },
  {
    type: DiscoverSliderType.POPULAR_ALBUMS,
    enabled: false,
    isBuiltIn: true,
    order: 14,
  },
];
