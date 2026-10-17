export type SearchPlaceholderKey =
  | 'searchPlaceholder'
  | 'searchPlaceholderAll'
  | 'searchPlaceholderMoviesMusic'
  | 'searchPlaceholderSeriesMusic'
  | 'searchPlaceholderMovies'
  | 'searchPlaceholderSeries'
  | 'searchPlaceholderMusic'
  | 'searchPlaceholderNone';

// F2-D-131: the name of the search box placeholder message for the kinds
// shown. Only movie, tv and music count; person, anything else and the order
// are ignored.
export const getSearchPlaceholderKey = (
  kindsShown: readonly string[]
): SearchPlaceholderKey => {
  const movie = kindsShown.includes('movie');
  const tv = kindsShown.includes('tv');
  const music = kindsShown.includes('music');

  if (movie && tv && music) return 'searchPlaceholderAll';
  if (movie && tv) return 'searchPlaceholder';
  if (movie && music) return 'searchPlaceholderMoviesMusic';
  if (tv && music) return 'searchPlaceholderSeriesMusic';
  if (movie) return 'searchPlaceholderMovies';
  if (tv) return 'searchPlaceholderSeries';
  if (music) return 'searchPlaceholderMusic';
  return 'searchPlaceholderNone';
};
