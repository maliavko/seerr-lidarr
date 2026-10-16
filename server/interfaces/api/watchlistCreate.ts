import { MediaType } from '@server/constants/media';
import { z } from 'zod';

export const watchlistCreate = z.object({
  ratingKey: z.coerce.string().optional(),
  tmdbId: z.coerce.number(),
  // music has no TMDB id to put on a watchlist: only the two kinds this accepted
  // before music joined MediaType (D-8, D-111)
  mediaType: z.enum([MediaType.MOVIE, MediaType.TV]),
  title: z.coerce.string().optional(),
});
