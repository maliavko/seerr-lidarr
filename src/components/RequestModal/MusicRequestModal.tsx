import Alert from '@app/components/Common/Alert';
import Modal from '@app/components/Common/Modal';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import { Permission } from '@server/lib/permissions';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import { mutate } from 'swr';

const messages = defineMessages('components.RequestModal', {
  requestadmin: 'This request will be approved automatically.',
  requestSuccess: '<strong>{title}</strong> requested successfully!',
  requestCancel: 'Request for <strong>{title}</strong> canceled.',
  requestalbumtitle: 'Request Album',
  requestartisttitle: 'Request Artist',
  requestartistinfo:
    'All of the artist’s albums will be requested, and new albums it releases too.',
  cancel: 'Cancel Request',
  approve: 'Approve Request',
  requestApproved: 'Request for <strong>{title}</strong> approved!',
  pendingalbumrequest: 'Pending Album Request',
  pendingartistrequest: 'Pending Artist Request',
  requestfrom: "{username}'s request is pending approval.",
  requesterror: 'Something went wrong while submitting the request.',
  approveerror: 'Something went wrong while approving the request.',
  pendingapproval: 'Your request is pending approval.',
});

interface MusicRequestModalProps {
  show: boolean;
  // the MusicBrainz id: the album's release-group id or the artist's id
  mbid: string;
  kind: 'album' | 'artist';
  title: string;
  // a pending request to look at: cancel it, or approve it
  editRequest?: NonFunctionProperties<MediaRequest>;
  onComplete?: (newStatus: MediaStatus) => void;
  onCancel?: () => void;
  onUpdating?: (isUpdating: boolean) => void;
}

// The request of an album or a whole artist, and a pending one to cancel or
// approve, as the movie request's modal does, with no 4K, season, server or
// profile choice (BAR, D-11).
const MusicRequestModalContent = ({
  mbid,
  kind,
  title,
  editRequest,
  onComplete,
  onCancel,
  onUpdating,
}: Omit<MusicRequestModalProps, 'show'>) => {
  const intl = useIntl();
  const { user, hasPermission } = useUser();
  const { addToast } = useToasts();
  const [isUpdating, setIsUpdating] = useState(false);

  const updating = (value: boolean) => {
    setIsUpdating(value);
    onUpdating?.(value);
  };

  const strong = (msg: React.ReactNode) => <strong>{msg}</strong>;

  const sendRequest = async () => {
    updating(true);

    try {
      const response = await axios.post<MediaRequest>('/api/v1/request', {
        mediaType: 'music',
        musicBrainzId: mbid,
        musicKind: kind,
      });
      mutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');
      mutate('/api/v1/request/count');

      if (response.data) {
        onComplete?.(
          response.data.status === MediaRequestStatus.PENDING
            ? MediaStatus.PENDING
            : MediaStatus.PROCESSING
        );
        addToast(
          <span>
            {intl.formatMessage(messages.requestSuccess, { title, strong })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );
      }
    } catch {
      addToast(intl.formatMessage(messages.requesterror), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      updating(false);
    }
  };

  const cancelRequest = async () => {
    updating(true);

    try {
      const response = await axios.delete(`/api/v1/request/${editRequest?.id}`);
      mutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');
      mutate('/api/v1/request/count');

      if (response.status === 204) {
        onComplete?.(MediaStatus.UNKNOWN);
        addToast(
          <span>
            {intl.formatMessage(messages.requestCancel, { title, strong })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );
      }
    } catch {
      updating(false);
    }
  };

  const approveRequest = async () => {
    updating(true);

    try {
      await axios.post(`/api/v1/request/${editRequest?.id}/approve`);
      mutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');
      mutate('/api/v1/request/count');

      addToast(
        <span>
          {intl.formatMessage(messages.requestApproved, { title, strong })}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );
      onComplete?.(MediaStatus.PROCESSING);
    } catch {
      addToast(intl.formatMessage(messages.approveerror), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      updating(false);
    }
  };

  if (editRequest) {
    const isOwner = editRequest.requestedBy.id === user?.id;
    const canManage = hasPermission(Permission.MANAGE_REQUESTS);

    return (
      <Modal
        backgroundClickable
        onCancel={onCancel}
        title={intl.formatMessage(
          kind === 'album'
            ? messages.pendingalbumrequest
            : messages.pendingartistrequest
        )}
        subTitle={title}
        onOk={() => (canManage ? approveRequest() : cancelRequest())}
        okDisabled={isUpdating}
        okText={intl.formatMessage(
          canManage ? messages.approve : messages.cancel
        )}
        okButtonType={canManage ? 'success' : 'danger'}
        onSecondary={isOwner && canManage ? () => cancelRequest() : undefined}
        secondaryDisabled={isUpdating}
        secondaryText={
          isOwner && canManage ? intl.formatMessage(messages.cancel) : undefined
        }
        secondaryButtonType="danger"
        cancelText={intl.formatMessage(globalMessages.close)}
      >
        {isOwner
          ? intl.formatMessage(messages.pendingapproval)
          : intl.formatMessage(messages.requestfrom, {
              username: editRequest.requestedBy.displayName,
            })}
      </Modal>
    );
  }

  const hasAutoApprove = hasPermission(
    [
      Permission.MANAGE_REQUESTS,
      Permission.AUTO_APPROVE,
      Permission.AUTO_APPROVE_MUSIC,
    ],
    { type: 'or' }
  );

  return (
    <Modal
      backgroundClickable
      onCancel={onCancel}
      onOk={sendRequest}
      okDisabled={isUpdating}
      title={intl.formatMessage(
        kind === 'album'
          ? messages.requestalbumtitle
          : messages.requestartisttitle
      )}
      subTitle={title}
      okText={intl.formatMessage(
        isUpdating ? globalMessages.requesting : globalMessages.request
      )}
      okButtonType="primary"
    >
      {kind === 'artist' && (
        <p className="mt-4" data-testid="music-request-artist-info">
          {intl.formatMessage(messages.requestartistinfo)}
        </p>
      )}
      {hasAutoApprove && (
        <div className="mt-6">
          <Alert
            title={intl.formatMessage(messages.requestadmin)}
            type="info"
          />
        </div>
      )}
    </Modal>
  );
};

const MusicRequestModal = ({ show, ...props }: MusicRequestModalProps) => (
  <Transition
    as="div"
    enter="transition-opacity duration-300"
    enterFrom="opacity-0"
    enterTo="opacity-100"
    leave="transition-opacity duration-300"
    leaveFrom="opacity-100"
    leaveTo="opacity-0"
    show={show}
  >
    <MusicRequestModalContent {...props} />
  </Transition>
);

export default MusicRequestModal;
