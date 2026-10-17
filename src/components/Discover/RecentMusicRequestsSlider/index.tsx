import MusicCard from '@app/components/MusicCard';
import Slider from '@app/components/Slider';
import TitleCard from '@app/components/TitleCard';
import useMusicRequestMedia from '@app/hooks/useMusicRequestMedia';
import defineMessages from '@app/utils/defineMessages';
import { shownStatus } from '@app/utils/musicHelpers';
import { musicRequestTarget } from '@app/utils/musicRequests';
import type { RequestResultsResponse } from '@server/interfaces/api/requestInterfaces';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.Discover.RecentMusicRequestsSlider',
  {
    title: 'Recent Music Requests',
    unknowntitle: 'Unknown Title',
  }
);

type MusicRequest = RequestResultsResponse['results'][number];

// One request's card (F2-D-93): the placeholder while its item is read, then
// music's own card of the item, with the status the request's media carries.
const RequestMusicCard = ({ request }: { request: MusicRequest }) => {
  const intl = useIntl();
  const music = useMusicRequestMedia(request, true);
  const target = musicRequestTarget(request.media);

  if (!target || music.loading) {
    return <TitleCard.Placeholder />;
  }

  return (
    <MusicCard
      kind={target.kind}
      id={target.mbid}
      title={music.title ?? intl.formatMessage(messages.unknowntitle)}
      artistName={music.artist?.name}
      releaseDate={music.releaseDate}
      image={music.image}
      status={shownStatus(request.media.status)}
    />
  );
};

interface RecentMusicRequestsSliderProps {
  title?: string;
}

// The latest music requests, newest first, as the request list answers this
// user (F2-R-4): it adds no permission check of its own.
const RecentMusicRequestsSlider = ({
  title,
}: RecentMusicRequestsSliderProps) => {
  const intl = useIntl();
  const { data, error } = useSWR<RequestResultsResponse>(
    '/api/v1/request?filter=all&take=20&sort=added&skip=0&mediaType=music',
    { revalidateOnMount: true }
  );
  const requests = (data?.results ?? []).filter((request) =>
    musicRequestTarget(request.media)
  );

  return (
    <>
      <div className="slider-header">
        <div className="slider-title">
          <span>{title ?? intl.formatMessage(messages.title)}</span>
        </div>
      </div>
      <Slider
        sliderKey="recent-music-requests"
        isLoading={!data && !error}
        isEmpty={!!error || (!!data && requests.length === 0)}
        items={requests.map((request) => (
          <RequestMusicCard
            key={`recent-music-request-${request.id}`}
            request={request}
          />
        ))}
      />
    </>
  );
};

export default RecentMusicRequestsSlider;
