import CachedImage from '@app/components/Common/CachedImage';
import Modal from '@app/components/Common/Modal';
import useToasts from '@app/hooks/useToasts';
import type { User } from '@app/hooks/useUser';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { musicRequestEditBody } from '@app/utils/musicRequests';
import {
  Label,
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
  Transition,
} from '@headlessui/react';
import { CheckIcon, ChevronDownIcon } from '@heroicons/react/24/solid';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import type { UserResultsResponse } from '@server/interfaces/api/userInterfaces';
import { Permission, hasPermission } from '@server/lib/permissions';
import axios from 'axios';
import { useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

const messages = defineMessages('components.MusicRequestEditModal', {
  pendingalbumrequest: 'Pending Album Request',
  pendingartistrequest: 'Pending Artist Request',
  pendingapproval: 'Your request is pending approval.',
  requestfrom: "{username}'s request is pending approval.",
  edit: 'Edit Request',
  approve: 'Approve Request',
  cancel: 'Cancel Request',
  requestas: 'Request As',
  requestedited: 'Request for <strong>{title}</strong> edited successfully!',
  requestApproved: 'Request for <strong>{title}</strong> approved!',
  requestCancel: 'Request for <strong>{title}</strong> canceled.',
  errorediting: 'Something went wrong while editing the request.',
  errorcancelling: 'Something went wrong while canceling the request.',
  unknowntitle: 'Unknown Title',
});

interface MusicRequestEditModalProps {
  show: boolean;
  request: NonFunctionProperties<MediaRequest>;
  kind: 'album' | 'artist';
  title?: string;
  onComplete?: () => void;
  onCancel?: () => void;
}

// The edit of a pending music request in the requests lists: the edit a movie
// request's modal offers the same user, holding the requester alone (D-311) —
// no season, 4K, server, profile, folder, language or tags — saved through PUT
// /api/v1/request/:id; a user who manages requests approves with it.
const MusicRequestEditModalContent = ({
  request,
  kind,
  title,
  onComplete,
  onCancel,
}: Omit<MusicRequestEditModalProps, 'show'>) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { user, hasPermission: currentHasPermission } = useUser();
  const [isUpdating, setIsUpdating] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(
    request.requestedBy as User
  );

  const canChooseRequester = currentHasPermission([
    Permission.MANAGE_REQUESTS,
    Permission.MANAGE_USERS,
  ]);
  const { data: userData } = useSWR<UserResultsResponse>(
    canChooseRequester ? '/api/v1/user?take=1000&sort=displayname' : null
  );
  // the users who may request music
  const requesters = useMemo(
    () =>
      userData?.results.filter((candidate) =>
        hasPermission(
          [Permission.REQUEST, Permission.REQUEST_MUSIC],
          candidate.permissions,
          { type: 'or' }
        )
      ),
    [userData?.results]
  );

  const isOwner = request.requestedBy.id === user?.id;
  const canManage = currentHasPermission(Permission.MANAGE_REQUESTS);
  const canEdit = currentHasPermission(Permission.REQUEST_ADVANCED);
  const shownTitle = title ?? intl.formatMessage(messages.unknowntitle);
  const strong = (msg: React.ReactNode) => <strong>{msg}</strong>;

  const refresh = () => {
    mutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');
    mutate('/api/v1/request/count');
  };

  const updateRequest = async (alsoApproveRequest = false) => {
    setIsUpdating(true);

    try {
      await axios.put(
        `/api/v1/request/${request.id}`,
        musicRequestEditBody(selectedUser?.id)
      );

      if (alsoApproveRequest) {
        await axios.post(`/api/v1/request/${request.id}/approve`);
      }
      refresh();

      addToast(
        <span>
          {intl.formatMessage(
            alsoApproveRequest
              ? messages.requestApproved
              : messages.requestedited,
            { title: shownTitle, strong }
          )}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );
      onComplete?.();
    } catch {
      addToast(<span>{intl.formatMessage(messages.errorediting)}</span>, {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const cancelRequest = async () => {
    setIsUpdating(true);

    try {
      const response = await axios.delete(`/api/v1/request/${request.id}`);
      refresh();

      if (response.status === 204) {
        addToast(
          <span>
            {intl.formatMessage(messages.requestCancel, {
              title: shownTitle,
              strong,
            })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );
        onComplete?.();
      }
    } catch {
      addToast(<span>{intl.formatMessage(messages.errorcancelling)}</span>, {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <Modal
      backgroundClickable
      onCancel={onCancel}
      title={intl.formatMessage(
        kind === 'album'
          ? messages.pendingalbumrequest
          : messages.pendingartistrequest
      )}
      subTitle={shownTitle}
      onOk={() =>
        canManage
          ? updateRequest(true)
          : canEdit
            ? updateRequest()
            : cancelRequest()
      }
      okDisabled={isUpdating}
      okText={
        canManage
          ? intl.formatMessage(messages.approve)
          : canEdit
            ? intl.formatMessage(messages.edit)
            : intl.formatMessage(messages.cancel)
      }
      okButtonType={canManage ? 'success' : canEdit ? 'primary' : 'danger'}
      onSecondary={
        isOwner && (canEdit || canManage) ? cancelRequest : undefined
      }
      secondaryDisabled={isUpdating}
      secondaryText={
        isOwner && (canEdit || canManage)
          ? intl.formatMessage(messages.cancel)
          : undefined
      }
      secondaryButtonType="danger"
      cancelText={intl.formatMessage(globalMessages.close)}
    >
      {isOwner
        ? intl.formatMessage(messages.pendingapproval)
        : intl.formatMessage(messages.requestfrom, {
            username: request.requestedBy.displayName,
          })}
      {canChooseRequester && selectedUser && (requesters ?? []).length > 1 && (
        <div className="mt-4" data-testid="music-edit-requester">
          <Listbox
            as="div"
            value={selectedUser}
            onChange={(value) => setSelectedUser(value)}
            className="space-y-1"
          >
            {({ open }) => (
              <>
                <Label>{intl.formatMessage(messages.requestas)}</Label>
                <div className="relative">
                  <span className="inline-block w-full rounded-md shadow-sm">
                    <ListboxButton className="focus:shadow-outline-blue relative w-full cursor-default rounded-md border border-gray-700 bg-gray-800 py-2 pl-3 pr-10 text-left text-white transition duration-150 ease-in-out focus:border-blue-300 focus:outline-none sm:text-sm sm:leading-5">
                      <span className="flex items-center">
                        <CachedImage
                          type="avatar"
                          src={selectedUser.avatar}
                          alt=""
                          className="h-6 w-6 flex-shrink-0 rounded-full object-cover"
                          width={24}
                          height={24}
                        />
                        <span className="ml-3 block">
                          {selectedUser.displayName}
                        </span>
                        {selectedUser.displayName.toLowerCase() !==
                          selectedUser.email && (
                          <span className="ml-1 truncate text-gray-400">
                            ({selectedUser.email})
                          </span>
                        )}
                      </span>
                      <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-500">
                        <ChevronDownIcon className="h-5 w-5" />
                      </span>
                    </ListboxButton>
                  </span>

                  <Transition
                    as="div"
                    show={open}
                    enter="transition-opacity ease-in duration-300"
                    enterFrom="opacity-0"
                    enterTo="opacity-100"
                    leave="transition-opacity ease-in duration-100"
                    leaveFrom="opacity-100"
                    leaveTo="opacity-0"
                    className="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 shadow-lg"
                  >
                    <ListboxOptions
                      static
                      className="shadow-xs max-h-60 overflow-auto rounded-md py-1 text-base leading-6 focus:outline-none sm:text-sm sm:leading-5"
                    >
                      {requesters?.map((candidate) => (
                        <ListboxOption key={candidate.id} value={candidate}>
                          {({ selected, active }) => (
                            <div
                              className={`${
                                active
                                  ? 'bg-indigo-600 text-white'
                                  : 'text-gray-300'
                              } relative cursor-default select-none py-2 pl-8 pr-4`}
                            >
                              <span
                                className={`${
                                  selected ? 'font-semibold' : 'font-normal'
                                } flex items-center`}
                              >
                                <CachedImage
                                  type="avatar"
                                  src={candidate.avatar}
                                  alt=""
                                  className="h-6 w-6 flex-shrink-0 rounded-full object-cover"
                                  width={24}
                                  height={24}
                                />
                                <span className="ml-3 block flex-shrink-0">
                                  {candidate.displayName}
                                </span>
                                {candidate.displayName.toLowerCase() !==
                                  candidate.email && (
                                  <span className="ml-1 truncate text-gray-400">
                                    ({candidate.email})
                                  </span>
                                )}
                              </span>
                              {selected && (
                                <span
                                  className={`${
                                    active ? 'text-white' : 'text-indigo-600'
                                  } absolute inset-y-0 left-0 flex items-center pl-1.5`}
                                >
                                  <CheckIcon className="h-5 w-5" />
                                </span>
                              )}
                            </div>
                          )}
                        </ListboxOption>
                      ))}
                    </ListboxOptions>
                  </Transition>
                </div>
              </>
            )}
          </Listbox>
        </div>
      )}
    </Modal>
  );
};

const MusicRequestEditModal = ({
  show,
  ...props
}: MusicRequestEditModalProps) => (
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
    <MusicRequestEditModalContent {...props} />
  </Transition>
);

export default MusicRequestEditModal;
