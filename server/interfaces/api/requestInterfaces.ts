import type { MediaType, MusicKind } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties, PaginatedResponse } from './common';

export interface RequestResultsResponse extends PaginatedResponse {
  results: (NonFunctionProperties<MediaRequest> & {
    profileName?: string;
    canRemove?: boolean;
  })[];
  serviceErrors: {
    radarr: { id: number; name: string }[];
    sonarr: { id: number; name: string }[];
  };
}

export type MediaRequestBody = {
  mediaType: MediaType;
  mediaId: number;
  tvdbId?: number;
  seasons?: number[] | 'all';
  is4k?: boolean;
  serverId?: number;
  profileId?: number;
  profileName?: string;
  rootFolder?: string;
  languageProfileId?: number;
  userId?: number;
  tags?: number[];
  ignoreQuota?: boolean;
};

// The body of POST /api/v1/request for music (D-311): the item's MusicBrainz id
// and its kind, and the existing userId. The fields of a movie or TV body have no
// place in it. As it arrives it may carry any of them, which the route refuses.
export type MusicRequestBody = {
  mediaType: MediaType.MUSIC;
  musicBrainzId: string;
  musicKind: MusicKind;
  userId?: number | null;
};
