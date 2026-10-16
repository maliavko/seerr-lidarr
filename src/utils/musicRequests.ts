import type { MusicKind } from '@server/constants/media';
import { MediaRequestStatus } from '@server/constants/media';

// Where a music request's item lives: its MusicBrainz id and kind, which the
// request's media row carries (D-111), and the page that shows it (D-9).
export interface MusicRequestTarget {
  kind: MusicKind;
  mbid: string;
  href: string;
  apiUrl: string;
}

export const musicRequestTarget = (media?: {
  musicBrainzId?: string | null;
  musicKind?: MusicKind | null;
}): MusicRequestTarget | undefined => {
  if (
    !media?.musicBrainzId ||
    (media.musicKind !== 'album' && media.musicKind !== 'artist')
  ) {
    return undefined;
  }

  return {
    kind: media.musicKind,
    mbid: media.musicBrainzId,
    href: `/music/${media.musicKind}/${media.musicBrainzId}`,
    apiUrl: `/api/v1/music/${media.musicKind}/${media.musicBrainzId}`,
  };
};

// Who is offered the edit of a music request in the requests lists: the edit a
// movie request's row offers the same user (D-311) — a pending request, to a
// user who manages requests or to its requester holding Request Advanced; the
// request card offers it to the requester holding Request Advanced only, as a
// movie request's card does.
export const canEditMusicRequest = ({
  status,
  requesterId,
  userId,
  canManageRequests,
  canRequestAdvanced,
  card = false,
}: {
  status: MediaRequestStatus;
  requesterId: number;
  userId?: number;
  canManageRequests: boolean;
  canRequestAdvanced: boolean;
  card?: boolean;
}): boolean => {
  if (status !== MediaRequestStatus.PENDING) {
    return false;
  }

  const isRequester = userId !== undefined && requesterId === userId;

  if (card) {
    return !canManageRequests && isRequester && canRequestAdvanced;
  }

  return canManageRequests || (isRequester && canRequestAdvanced);
};

// The keys of the requests lists the client holds in SWR: the list, a user's
// own list, the recent requests slider and the profile's slider.
export const isRequestListKey = (key: unknown): boolean =>
  typeof key === 'string' &&
  /^\/api\/v1\/(request\?|user\/\d+\/requests)/.test(key);

// The body the list's edit saves through PUT /api/v1/request/:id: the one field
// a music request has, its requester, and nothing of seasons, 4K, server,
// profile, folder, language or tags (D-311).
export const musicRequestEditBody = (userId?: number) => ({
  mediaType: 'music' as const,
  userId,
});
