import Button from '@app/components/Common/Button';
import Tag from '@app/components/Common/Tag';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import type { MusicLinkItem, MusicRatingItem } from '@app/utils/musicFacts';
import { genreUrl, ratingText } from '@app/utils/musicFacts';
import {
  ArrowTopRightOnSquareIcon,
  MagnifyingGlassIcon,
  StarIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';

// What the artist and album pages show beside their own record: links out,
// genre tags, a facts panel and, for a user who manages requests, Lidarr's
// actions.

const messages = defineMessages('components.MusicDetails', {
  links: 'Links',
  rating: 'Rating',
  votes: '{votes} votes',
  openInLidarr: 'Open in Lidarr',
  searchInLidarr: 'Search in Lidarr',
  searchStarted: 'Lidarr is searching for {title}.',
  searchFailed: 'Lidarr could not start a search.',
});

export const MusicLinks = ({ links }: { links?: MusicLinkItem[] }) => {
  if (!links || links.length === 0) {
    return null;
  }

  return (
    <div className="mt-6 flex flex-wrap gap-2" data-testid="music-links">
      {links.map((link) => (
        <a
          key={link.name}
          href={link.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-full bg-gray-800 px-3 py-1 text-sm text-gray-200 ring-1 ring-inset ring-gray-600 transition hover:bg-gray-700 hover:text-white"
        >
          {link.label}
          <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 text-gray-400" />
        </a>
      ))}
    </div>
  );
};

export const GenreTags = ({ genres }: { genres: string[] }) => {
  if (genres.length === 0) {
    return null;
  }

  return (
    <div className="mt-6" data-testid="music-genres">
      {genres.map((genre) => (
        <a
          key={genre}
          href={genreUrl(genre)}
          target="_blank"
          rel="noreferrer"
          className="mb-2 mr-2 inline-flex last:mr-0"
        >
          <Tag>{genre}</Tag>
        </a>
      ))}
    </div>
  );
};

export interface MusicFact {
  label: string;
  value?: React.ReactNode;
}

export const MusicFacts = ({
  rating,
  facts,
}: {
  rating?: MusicRatingItem;
  facts: MusicFact[];
}) => {
  const intl = useIntl();
  const shown = facts.filter(
    (fact) => fact.value !== undefined && fact.value !== ''
  );

  if (!rating && shown.length === 0) {
    return null;
  }

  return (
    <div className="media-facts" data-testid="music-facts">
      {rating && (
        <div className="media-ratings">
          <span
            className="media-rating"
            title={intl.formatMessage(messages.votes, { votes: rating.votes })}
          >
            <StarIcon className="h-5 w-5 text-yellow-400" />
            <span>{ratingText(rating)}</span>
            <span className="text-xs font-normal text-gray-400">
              ({intl.formatMessage(messages.votes, { votes: rating.votes })})
            </span>
          </span>
        </div>
      )}
      {shown.map((fact) => (
        <div className="media-fact" key={fact.label}>
          <span>{fact.label}</span>
          <span className="media-fact-value">{fact.value}</span>
        </div>
      ))}
    </div>
  );
};

// Open the artist or album in Lidarr, or have Lidarr search for it again:
// for a user who manages requests, where Lidarr holds it.
export const LidarrManage = ({
  kind,
  mbid,
  title,
  inLidarr,
  lidarrUrl,
}: {
  kind: 'artist' | 'album';
  mbid: string;
  title: string;
  inLidarr: boolean;
  lidarrUrl?: string;
}) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const { addToast } = useToasts();
  const [searching, setSearching] = useState(false);

  if (!inLidarr || !hasPermission(Permission.MANAGE_REQUESTS)) {
    return null;
  }

  const search = async () => {
    setSearching(true);
    try {
      await axios.post(`/api/v1/music/${kind}/${mbid}/search`);
      addToast(intl.formatMessage(messages.searchStarted, { title }), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch {
      addToast(intl.formatMessage(messages.searchFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="mt-4 flex flex-col gap-2" data-testid="lidarr-manage">
      {lidarrUrl && (
        <a href={lidarrUrl} target="_blank" rel="noreferrer">
          <Button buttonType="ghost" className="w-full">
            <ArrowTopRightOnSquareIcon />
            <span>{intl.formatMessage(messages.openInLidarr)}</span>
          </Button>
        </a>
      )}
      <Button
        buttonType="ghost"
        className="w-full"
        onClick={search}
        disabled={searching}
      >
        <MagnifyingGlassIcon />
        <span>{intl.formatMessage(messages.searchInLidarr)}</span>
      </Button>
    </div>
  );
};
