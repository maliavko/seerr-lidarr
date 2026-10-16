import Spinner from '@app/assets/spinner.svg';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import Tooltip from '@app/components/Common/Tooltip';
import MusicRequestEditModal from '@app/components/RequestModal/MusicRequestEditModal';
import StatusBadge from '@app/components/StatusBadge';
import useMusicRequestMedia, {
  useRefreshRequestLists,
} from '@app/hooks/useMusicRequestMedia';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { canEditMusicRequest } from '@app/utils/musicRequests';
import {
  ArrowPathIcon,
  CheckIcon,
  PencilIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
import { MediaRequestStatus } from '@server/constants/media';
import type { RequestResultsResponse } from '@server/interfaces/api/requestInterfaces';
import axios from 'axios';
import Link from 'next/link';
import { useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { FormattedRelativeTime, useIntl } from 'react-intl';

const messages = defineMessages('components.RequestCard.MusicRequestCard', {
  failedretry: 'Something went wrong while retrying the request.',
  failedmodify: 'Something went wrong while modifying the request.',
  approverequest: 'Approve Request',
  declinerequest: 'Decline Request',
  editrequest: 'Edit Request',
  cancelrequest: 'Cancel Request',
  unknowntitle: 'Unknown Title',
  musicalbum: 'Album',
  musicartist: 'Artist',
  requestedby: '{date} by {user}',
  modifiedby: 'Handled {date} by {user}',
});

interface MusicRequestCardProps {
  request: RequestResultsResponse['results'][number];
}

// A music request's card, as the recent requests slider shows requests (R-12):
// the album's cover or the artist's image or a placeholder, its title and
// artist or name, its kind, the requester, the date, the request's status and
// its media's status, and by whom it was handled once it is; the actions a
// movie request's card offers the same user, and the requester's edit (D-311).
const MusicRequestCard = ({ request }: MusicRequestCardProps) => {
  const { ref, inView } = useInView({ triggerOnce: true });
  const intl = useIntl();
  const { user, hasPermission } = useUser();
  const { addToast } = useToasts();
  const refreshLists = useRefreshRequestLists();
  const music = useMusicRequestMedia(request, inView);
  const [isRetrying, setRetrying] = useState(false);
  const [updatingType, setUpdatingType] = useState<
    'approve' | 'decline' | null
  >(null);
  const [showEditModal, setShowEditModal] = useState(false);

  const canManage = hasPermission(Permission.MANAGE_REQUESTS);
  const title = music.title ?? intl.formatMessage(messages.unknowntitle);
  // while the music route is being read the title is a bar, not a guess

  const modifyRequest = async (type: 'approve' | 'decline') => {
    setUpdatingType(type);
    try {
      await axios.post(`/api/v1/request/${request.id}/${type}`);
      refreshLists();
    } catch {
      addToast(intl.formatMessage(messages.failedmodify), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setUpdatingType(null);
    }
  };

  const deleteRequest = async () => {
    await axios.delete(`/api/v1/request/${request.id}`);
    refreshLists();
  };

  const retryRequest = async () => {
    setRetrying(true);

    try {
      await axios.post(`/api/v1/request/${request.id}/retry`);
      refreshLists();
    } catch {
      addToast(intl.formatMessage(messages.failedretry), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setRetrying(false);
    }
  };

  const canEdit = canEditMusicRequest({
    status: request.status,
    requesterId: request.requestedBy.id,
    userId: user?.id,
    canManageRequests: canManage,
    canRequestAdvanced: hasPermission(Permission.REQUEST_ADVANCED),
    card: true,
  });

  const relativeTime = (date: Date | string) => (
    <FormattedRelativeTime
      value={Math.floor((new Date(date).getTime() - Date.now()) / 1000)}
      updateIntervalInSeconds={1}
      numeric="auto"
    />
  );

  const userLink = (handler: { id: number; displayName: string }) => (
    <Link href={`/users/${handler.id}`} className="group inline-flex">
      <span className="truncate font-semibold group-hover:text-white group-hover:underline">
        {handler.displayName}
      </span>
    </Link>
  );

  const titleLink = music.href ?? '#';

  return (
    <>
      {music.kind && (
        <MusicRequestEditModal
          show={showEditModal}
          request={request}
          kind={music.kind}
          title={music.title}
          onCancel={() => setShowEditModal(false)}
          onComplete={() => {
            refreshLists();
            setShowEditModal(false);
          }}
        />
      )}
      <div
        ref={ref}
        className="relative flex w-72 overflow-hidden rounded-xl bg-gray-800 bg-cover bg-center p-4 text-gray-400 shadow ring-1 ring-gray-700 sm:w-96"
        data-testid="request-card"
      >
        <div
          className="relative z-10 flex min-w-0 flex-1 flex-col pr-4"
          data-testid="request-card-title"
        >
          <div
            className="hidden text-xs font-medium text-white sm:flex"
            data-testid="music-request-kind"
          >
            {intl.formatMessage(
              music.kind === 'artist'
                ? messages.musicartist
                : messages.musicalbum
            )}
          </div>
          <Link
            href={titleLink}
            className="overflow-hidden overflow-ellipsis whitespace-nowrap text-base font-bold text-white hover:underline sm:text-lg"
            data-testid="music-request-title"
          >
            {music.loading ? (
              <span className="inline-block h-5 w-40 animate-pulse rounded bg-gray-700" />
            ) : (
              title
            )}
          </Link>
          {music.artist && (
            <Link
              href={`/music/artist/${music.artist.id}`}
              className="overflow-hidden overflow-ellipsis whitespace-nowrap text-sm hover:text-white hover:underline"
              data-testid="music-request-artist"
            >
              {music.artist.name}
            </Link>
          )}
          <div className="card-field text-sm">
            <span className="truncate">
              {hasPermission(
                [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
                { type: 'or' }
              )
                ? intl.formatMessage(messages.requestedby, {
                    date: relativeTime(request.createdAt),
                    user: userLink(request.requestedBy),
                  })
                : relativeTime(request.createdAt)}
            </span>
          </div>
          {request.modifiedBy && (
            <div className="card-field text-sm">
              <span className="truncate">
                {intl.formatMessage(messages.modifiedby, {
                  date: relativeTime(request.updatedAt),
                  user: userLink(request.modifiedBy),
                })}
              </span>
            </div>
          )}
          <div className="mt-2 flex items-center text-sm sm:mt-1">
            <span className="mr-2 hidden font-bold sm:block">
              {intl.formatMessage(globalMessages.status)}
            </span>
            {request.status === MediaRequestStatus.DECLINED ? (
              <Badge badgeType="danger">
                {intl.formatMessage(globalMessages.declined)}
              </Badge>
            ) : request.status === MediaRequestStatus.FAILED ? (
              <Badge badgeType="danger" href={music.href}>
                {intl.formatMessage(globalMessages.failed)}
              </Badge>
            ) : (
              <StatusBadge status={request.media.status} title={title} />
            )}
          </div>
          <div className="flex flex-1 items-end space-x-2">
            {request.status === MediaRequestStatus.FAILED && canManage && (
              <Button
                buttonType="primary"
                buttonSize="sm"
                disabled={isRetrying}
                onClick={() => retryRequest()}
              >
                <ArrowPathIcon
                  className={isRetrying ? 'animate-spin' : ''}
                  style={{ marginRight: '0', animationDirection: 'reverse' }}
                />
                <span className="ml-1.5 hidden sm:block">
                  {intl.formatMessage(globalMessages.retry)}
                </span>
              </Button>
            )}
            {request.status === MediaRequestStatus.PENDING && canManage && (
              <>
                <div>
                  <Button
                    buttonType="success"
                    buttonSize="sm"
                    className="hidden sm:block"
                    onClick={() => modifyRequest('approve')}
                    disabled={updatingType !== null}
                  >
                    {updatingType === 'approve' ? <Spinner /> : <CheckIcon />}
                    <span>{intl.formatMessage(globalMessages.approve)}</span>
                  </Button>
                  <Tooltip
                    content={intl.formatMessage(messages.approverequest)}
                  >
                    <Button
                      buttonType="success"
                      buttonSize="sm"
                      className="sm:hidden"
                      onClick={() => modifyRequest('approve')}
                      disabled={updatingType !== null}
                    >
                      {updatingType === 'approve' ? <Spinner /> : <CheckIcon />}
                    </Button>
                  </Tooltip>
                </div>
                <div>
                  <Button
                    buttonType="danger"
                    buttonSize="sm"
                    className="hidden sm:block"
                    onClick={() => modifyRequest('decline')}
                    disabled={updatingType !== null}
                  >
                    {updatingType === 'decline' ? <Spinner /> : <XMarkIcon />}
                    <span>{intl.formatMessage(globalMessages.decline)}</span>
                  </Button>
                  <Tooltip
                    content={intl.formatMessage(messages.declinerequest)}
                  >
                    <Button
                      buttonType="danger"
                      buttonSize="sm"
                      className="sm:hidden"
                      onClick={() => modifyRequest('decline')}
                      disabled={updatingType !== null}
                    >
                      {updatingType === 'decline' ? <Spinner /> : <XMarkIcon />}
                    </Button>
                  </Tooltip>
                </div>
              </>
            )}
            {canEdit && music.kind && (
              <div>
                <Button
                  buttonType="primary"
                  buttonSize="sm"
                  className="hidden sm:block"
                  onClick={() => setShowEditModal(true)}
                  disabled={updatingType !== null}
                >
                  <PencilIcon />
                  <span>{intl.formatMessage(globalMessages.edit)}</span>
                </Button>
                <Tooltip content={intl.formatMessage(messages.editrequest)}>
                  <Button
                    buttonType="primary"
                    buttonSize="sm"
                    className="sm:hidden"
                    onClick={() => setShowEditModal(true)}
                    disabled={updatingType !== null}
                  >
                    <PencilIcon />
                  </Button>
                </Tooltip>
              </div>
            )}
            {request.status === MediaRequestStatus.PENDING &&
              !canManage &&
              request.requestedBy.id === user?.id && (
                <div>
                  <Button
                    buttonType="danger"
                    buttonSize="sm"
                    className="hidden sm:block"
                    onClick={() => deleteRequest()}
                  >
                    <XMarkIcon />
                    <span>{intl.formatMessage(globalMessages.cancel)}</span>
                  </Button>
                  <Tooltip content={intl.formatMessage(messages.cancelrequest)}>
                    <Button
                      buttonType="danger"
                      buttonSize="sm"
                      className="sm:hidden"
                      onClick={() => deleteRequest()}
                    >
                      <XMarkIcon />
                    </Button>
                  </Tooltip>
                </div>
              )}
          </div>
        </div>
        <Link
          href={titleLink}
          className="w-20 flex-shrink-0 scale-100 transform-gpu cursor-pointer overflow-hidden rounded-md shadow-sm transition duration-300 hover:scale-105 hover:shadow-md sm:w-28"
        >
          <CachedImage
            type="music"
            src={music.image ?? ''}
            alt=""
            sizes="100vw"
            style={{ width: '100%', height: 'auto' }}
            width={600}
            height={900}
          />
        </Link>
      </div>
    </>
  );
};

export default MusicRequestCard;
