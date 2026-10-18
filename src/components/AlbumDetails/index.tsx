import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import {
  GenreTags,
  LidarrManage,
  MusicFacts,
  MusicLinks,
} from '@app/components/MusicDetails';
import MusicRequestButton from '@app/components/MusicRequestButton';
import StatusBadge from '@app/components/StatusBadge';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type { MusicLinkItem, MusicRatingItem } from '@app/utils/musicFacts';
import { formatAlbumLength, sizeText } from '@app/utils/musicFacts';
import {
  formatTrackLength,
  releaseYear,
  shownStatus,
} from '@app/utils/musicHelpers';
import { CheckCircleIcon, MinusCircleIcon } from '@heroicons/react/24/solid';
import type Media from '@server/entity/Media';
import axios from 'axios';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.AlbumDetails', {
  overview: 'Overview',
  tracks: 'Tracks',
  trackNumber: 'Number',
  trackTitle: 'Title',
  trackLength: 'Length',
  trackFile: 'In library',
  releaseDate: 'Release Date',
  label: 'Label',
  country: 'Country',
  discs: 'Discs',
  length: 'Length',
  editions: 'Editions',
  files: 'Files',
  size: 'Size',
  hasFile: 'In your library',
  missingFile: 'Not in your library',
});

export interface MusicTrack {
  disc: number;
  position: number;
  number: string;
  title: string;
  // milliseconds, where known
  length?: number;
  // whether Lidarr holds a file of it (an album Lidarr holds only)
  hasFile?: boolean;
}

export interface MusicAlbumDetails {
  id: string;
  title: string;
  disambiguation?: string;
  artist: { id: string; name: string };
  releaseDate?: string;
  albumType?: string;
  secondaryTypes: string[];
  coverUrl?: string;
  overview?: string;
  genres: string[];
  inLidarr: boolean;
  tracks: MusicTrack[];
  mediaInfo?: Media;
  links?: MusicLinkItem[];
  rating?: MusicRatingItem;
  facts?: {
    label?: string;
    country?: string;
    discs?: number;
    duration?: number;
    editions?: number;
  };
  files?: {
    trackFileCount: number;
    trackCount: number;
    sizeOnDisk: number;
    qualities: string[];
  };
  lidarrUrl?: string;
}

interface AlbumDetailsProps {
  album?: MusicAlbumDetails;
  // the status of the answer the page could not get, if any
  statusCode?: number;
}

const AlbumDetails = ({ album, statusCode }: AlbumDetailsProps) => {
  const router = useRouter();
  const intl = useIntl();

  const { data, error, mutate } = useSWR<MusicAlbumDetails>(
    `/api/v1/music/album/${router.query.mbid}`,
    { fallbackData: album }
  );

  if (!data && !error && !statusCode) {
    return <LoadingSpinner />;
  }

  if (!data) {
    const code =
      statusCode ?? (axios.isAxiosError(error) ? error.response?.status : 500);
    return <ErrorPage statusCode={code === 404 ? 404 : 500} />;
  }

  const attributes = [data.albumType, ...(data.secondaryTypes ?? [])].filter(
    (attribute): attribute is string => !!attribute
  );

  return (
    <div
      className="media-page"
      style={{
        height: 493,
      }}
    >
      <PageTitle title={data.title} />
      <div className="media-header">
        <div className="media-poster">
          <CachedImage
            type="music"
            src={data.coverUrl ?? ''}
            alt=""
            sizes="100vw"
            style={{ width: '100%', height: 'auto' }}
            width={600}
            height={600}
            priority
          />
        </div>
        <div className="media-title">
          <div className="media-status" data-testid="music-status">
            {shownStatus(data.mediaInfo?.status) !== undefined && (
              <StatusBadge status={data.mediaInfo?.status} title={data.title} />
            )}
          </div>
          <h1 data-testid="media-title">
            {data.title}{' '}
            {releaseYear(data.releaseDate) && (
              <span className="media-year" data-testid="album-year">
                ({releaseYear(data.releaseDate)})
              </span>
            )}
          </h1>
          <span className="media-attributes">
            <Link
              href={`/music/artist/${data.artist.id}`}
              data-testid="album-artist"
            >
              {data.artist.name}
            </Link>
            {attributes.map((attribute, index) => (
              <span key={`${attribute}-${index}`}>{attribute}</span>
            ))}
          </span>
        </div>
        <div className="media-actions">
          <MusicRequestButton
            kind="album"
            mbid={data.id}
            title={data.title}
            media={data.mediaInfo}
            onUpdate={() => mutate()}
          />
        </div>
      </div>
      <div className="media-overview">
        <div className="media-overview-left">
          {data.overview && (
            <>
              <h2>{intl.formatMessage(messages.overview)}</h2>
              <p data-testid="album-overview">{data.overview}</p>
            </>
          )}
          <GenreTags genres={data.genres} />
          <MusicLinks links={data.links} />
        </div>
        <div className="media-overview-right">
          <MusicFacts
            rating={data.rating}
            facts={[
              {
                label: intl.formatMessage(messages.releaseDate),
                value: data.releaseDate
                  ? intl.formatDate(data.releaseDate, {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                      timeZone: 'UTC',
                    })
                  : undefined,
              },
              {
                label: intl.formatMessage(messages.label),
                value: data.facts?.label,
              },
              {
                label: intl.formatMessage(messages.country),
                value: data.facts?.country,
              },
              {
                label: intl.formatMessage(messages.discs),
                value: data.facts?.discs,
              },
              {
                label: intl.formatMessage(messages.length),
                value: data.facts?.duration
                  ? formatAlbumLength(data.facts.duration)
                  : undefined,
              },
              {
                label: intl.formatMessage(messages.editions),
                value: data.facts?.editions,
              },
              {
                label: intl.formatMessage(messages.files),
                value: data.files
                  ? [
                      `${data.files.trackFileCount} / ${data.files.trackCount}`,
                      data.files.qualities.join(', '),
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : undefined,
              },
              {
                label: intl.formatMessage(messages.size),
                value: sizeText(data.files?.sizeOnDisk),
              },
            ]}
          />
          <LidarrManage
            kind="album"
            mbid={data.id}
            title={data.title}
            inLidarr={data.inLidarr}
            lidarrUrl={data.lidarrUrl}
          />
        </div>
      </div>
      {data.tracks.length > 0 && (
        <div className="mt-6 pb-4 text-white">
          <div className="slider-header">
            <div className="slider-title">
              <span>{intl.formatMessage(messages.tracks)}</span>
            </div>
          </div>
          <table
            className="w-full text-left text-sm"
            data-testid="album-tracks"
          >
            <thead className="text-gray-400">
              <tr>
                <th className="w-16 py-2 pr-2">
                  {intl.formatMessage(messages.trackNumber)}
                </th>
                <th className="py-2 pr-2">
                  {intl.formatMessage(messages.trackTitle)}
                </th>
                <th className="w-20 py-2 text-right">
                  {intl.formatMessage(messages.trackLength)}
                </th>
                {data.inLidarr && (
                  <th className="w-10 py-2 text-right">
                    <span className="sr-only">
                      {intl.formatMessage(messages.trackFile)}
                    </span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {data.tracks.map((track) => (
                <tr
                  key={`${track.disc}-${track.position}-${track.number}`}
                  className="border-t border-gray-700"
                  data-testid="album-track"
                >
                  <td className="py-2 pr-2 text-gray-400">{track.number}</td>
                  <td className="py-2 pr-2">{track.title}</td>
                  <td className="py-2 text-right text-gray-400">
                    {track.length ? formatTrackLength(track.length) : ''}
                  </td>
                  {data.inLidarr && (
                    <td className="py-2 pl-2 text-right">
                      {track.hasFile ? (
                        <CheckCircleIcon
                          className="ml-auto h-5 w-5 text-green-500"
                          aria-label={intl.formatMessage(messages.hasFile)}
                        />
                      ) : (
                        <MinusCircleIcon
                          className="ml-auto h-5 w-5 text-gray-600"
                          aria-label={intl.formatMessage(messages.missingFile)}
                        />
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default AlbumDetails;
