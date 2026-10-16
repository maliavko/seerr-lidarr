import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import MusicRequestButton from '@app/components/MusicRequestButton';
import StatusBadge from '@app/components/StatusBadge';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import {
  formatTrackLength,
  releaseYear,
  shownStatus,
} from '@app/utils/musicHelpers';
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
});

export interface MusicTrack {
  disc: number;
  position: number;
  number: string;
  title: string;
  // milliseconds, where known
  length?: number;
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

  const attributes = [data.albumType, ...data.genres].filter(
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
      {data.overview && (
        <div className="media-overview">
          <div className="media-overview-left">
            <h2>{intl.formatMessage(messages.overview)}</h2>
            <p data-testid="album-overview">{data.overview}</p>
          </div>
        </div>
      )}
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
