import { DiscoverSliderType } from '@server/constants/discover';
import type { KindShown } from '@server/lib/kindsShown';

// Where the kinds shown (F2-D-2) reach the menu and the home page's sliders
// (F2-D-122, F2-D-211). Pure helpers: the components only apply them.

// The kinds each slider type declares (F2-D-211). They decide only whether the
// slider is rendered (and so fetched) on the home page: while at least one is
// shown. What a mixed slider drops of its items is decided by the kinds shown
// alone, never by these.
const sliderTypeKinds: Record<DiscoverSliderType, KindShown[]> = {
  [DiscoverSliderType.POPULAR_MOVIES]: ['movie'],
  [DiscoverSliderType.MOVIE_GENRES]: ['movie'],
  [DiscoverSliderType.UPCOMING_MOVIES]: ['movie'],
  [DiscoverSliderType.STUDIOS]: ['movie'],
  [DiscoverSliderType.TMDB_MOVIE_KEYWORD]: ['movie'],
  [DiscoverSliderType.TMDB_MOVIE_GENRE]: ['movie'],
  [DiscoverSliderType.TMDB_STUDIO]: ['movie'],
  [DiscoverSliderType.TMDB_MOVIE_STREAMING_SERVICES]: ['movie'],
  [DiscoverSliderType.POPULAR_TV]: ['tv'],
  [DiscoverSliderType.TV_GENRES]: ['tv'],
  [DiscoverSliderType.UPCOMING_TV]: ['tv'],
  [DiscoverSliderType.NETWORKS]: ['tv'],
  [DiscoverSliderType.TMDB_TV_KEYWORD]: ['tv'],
  [DiscoverSliderType.TMDB_TV_GENRE]: ['tv'],
  [DiscoverSliderType.TMDB_NETWORK]: ['tv'],
  [DiscoverSliderType.TMDB_TV_STREAMING_SERVICES]: ['tv'],
  [DiscoverSliderType.RECENTLY_ADDED]: ['movie', 'tv'],
  [DiscoverSliderType.PLEX_WATCHLIST]: ['movie', 'tv'],
  [DiscoverSliderType.RECENT_REQUESTS]: ['movie', 'tv', 'music'],
  [DiscoverSliderType.TRENDING]: ['movie', 'tv', 'person'],
  [DiscoverSliderType.TMDB_SEARCH]: ['movie', 'tv', 'music', 'person'],
  [DiscoverSliderType.RECENTLY_ADDED_MUSIC]: ['music'],
  [DiscoverSliderType.RECENT_MUSIC_REQUESTS]: ['music'],
  [DiscoverSliderType.POPULAR_ALBUMS]: ['music'],
};

export const getSliderKinds = (type: DiscoverSliderType): KindShown[] =>
  sliderTypeKinds[type] ?? [];

// A slider is rendered on the home page while at least one of the kinds its
// type declares is shown; a slider of no kind shown is neither fetched nor
// shown (a type that declares none is not shown).
export const isSliderShown = (
  type: DiscoverSliderType | undefined,
  kindsShown: readonly string[]
): boolean =>
  type !== undefined &&
  getSliderKinds(type).some((kind) => kindsShown.includes(kind));

// The menu item of a kind is shown only while the kind is; an item of no kind
// (Discover, Requests, ...) always is.
export const isMenuKindShown = (
  kind: KindShown | undefined,
  kindsShown: readonly string[]
): boolean => kind === undefined || kindsShown.includes(kind);

// The kind of an item by its media type: a movie, tv or person result by its
// mediaType, a media row likewise, a request by its type (movie, tv, music), an
// artist or album result as music. Undefined for a type that is none of them.
export const getItemKind = (
  mediaType: string | undefined
): KindShown | undefined => {
  switch (mediaType) {
    case 'movie':
    case 'tv':
    case 'person':
    case 'music':
      return mediaType;
    case 'artist':
    case 'album':
      return 'music';
    default:
      return undefined;
  }
};

// A mixed slider keeps every item whose kind is shown - one of a kind outside
// those its type declares among them - and drops every item whose kind is not
// shown. An item of no known kind has none to hide and is kept.
export const keepShownKinds = <T>(
  items: readonly T[],
  kindsShown: readonly string[],
  mediaTypeOf: (item: T) => string | undefined
): T[] =>
  items.filter((item) => {
    const kind = getItemKind(mediaTypeOf(item));

    return kind === undefined || kindsShown.includes(kind);
  });

// RecentlyAddedSlider, RecentRequestsSlider and PlexWatchlistSlider draw a card
// for every item they keep, so each is left out once loaded only where its
// source gave items and every one was dropped as of a kind not shown; one whose
// source gave none keeps showing as it does today (F2-D-211). MediaSlider is
// left out by isMediaSliderLeftOut below.
export const isLeftOutByKinds = (
  sourceCount: number,
  keptCount: number
): boolean => sourceCount > 0 && keptCount === 0;

// The media types MediaSlider draws a card for; it draws none for an artist or
// an album (F2-D-211).
const mediaSliderCardKinds: KindShown[] = ['movie', 'tv', 'person'];

const isCardKind = (mediaType: string): boolean =>
  mediaSliderCardKinds.some((kind) => kind === mediaType);

// MediaSlider is left out once loaded (F2-D-211) where all three hold: its
// source gave at least one item; none of the items it kept (those of a kind
// shown) is of mediaType movie, tv or person; and it dropped at least one item
// as of a kind not shown, or at least one of movie, tv and person is not shown
// (the server then left that kind out of its source, F2-D-21). It reads the
// media types of every item the source gave, as loaded, before the hide
// filters; where every kind is shown, or movie, tv and person are, or the
// source gave nothing, it is false and the slider stands as today.
export const isMediaSliderLeftOut = (
  sourceMediaTypes: readonly (string | undefined)[],
  kindsShown: readonly string[]
): boolean => {
  if (sourceMediaTypes.length === 0) {
    return false;
  }

  const kept = keepShownKinds(sourceMediaTypes, kindsShown, (type) => type);

  if (kept.some((type) => type !== undefined && isCardKind(type))) {
    return false;
  }

  return (
    kept.length < sourceMediaTypes.length ||
    mediaSliderCardKinds.some((kind) => !kindsShown.includes(kind))
  );
};
