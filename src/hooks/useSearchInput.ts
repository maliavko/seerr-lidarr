/* eslint-disable react-hooks/exhaustive-deps */
import { boxAfterLanding } from '@app/utils/searchBox';
import { readKeptSearchType, tabStorage } from '@app/utils/searchKeptType';
import { newSearchAddress } from '@app/utils/searchLoading';
import type { Nullable } from '@app/utils/typeHelpers';
import { useRouter } from 'next/router';
import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { UrlObject } from 'url';
import useDebouncedState from './useDebouncedState';

type Url = string | UrlObject;

interface SearchObject {
  searchValue: string;
  searchOpen: boolean;
  setIsOpen: Dispatch<SetStateAction<boolean>>;
  setSearchValue: Dispatch<SetStateAction<string>>;
  clear: () => void;
}

const useSearchInput = (): SearchObject => {
  const router = useRouter();
  const [searchOpen, setIsOpen] = useState(false);
  const [lastRoute, setLastRoute] = useState<Nullable<Url>>(null);
  const [searchValue, debouncedValue, setSearchValue] = useDebouncedState(
    (router.query.query as string) ?? ''
  );

  // The text this hook last asked the router to go to, and whether its address
  // has landed (F2-D-341 (a)): what tells an address that lands for an earlier
  // text from the one asked for.
  const routed = useRef<string | null>(null);
  const routedLanded = useRef(false);

  const route = (text: string) => {
    routed.current = text;
    routedLanded.current = false;

    // the type last chosen by a pill press in this tab, read now (F2-D-341)
    const address = newSearchAddress(
      { pathname: router.pathname, query: router.query },
      text,
      readKeptSearchType(tabStorage())
    );

    if (router.pathname.startsWith('/search')) {
      router.replace(address);
    } else {
      setLastRoute(router.asPath);
      router.push(address).then(() => window.scrollTo(0, 0));
    }
  };

  /**
   * This effect handles routing when the debounced search input
   * value changes.
   *
   * If we are not already on the /search route, then we push
   * in a new route. If we are, then we only replace the history.
   */
  useEffect(() => {
    if (debouncedValue !== '' && searchOpen) {
      route(debouncedValue);
    }
  }, [debouncedValue]);

  /**
   * This effect is handling behavior when the search input is closed.
   *
   * If we have a lastRoute, we will route back to it. If we don't
   * (in the case of a deeplink) we take the user back to the index route
   */
  useEffect(() => {
    if (
      searchValue === '' &&
      router.pathname.startsWith('/search') &&
      !searchOpen
    ) {
      if (lastRoute) {
        router.push(lastRoute).then(() => window.scrollTo(0, 0));
      } else {
        router.replace('/').then(() => window.scrollTo(0, 0));
      }
    }
  }, [searchOpen]);

  /**
   * This effect handles behavior for when the route is changed.
   *
   * If after a route change, the new debounced value is not the same
   * as the query value then we will update the searchValue to either the
   * new query or to an empty string (in the case of null) - but only as
   * boxAfterLanding answers (F2-D-341 (a)): never where text was typed after
   * that address was asked, which the debounce then routes. This makes sure
   * that the value in the searchbox is whatever the user last entered regardless
   * of routing to something like a detail page.
   *
   * If the new route is not /search and query is null, then we will close the
   * search if it is open.
   *
   * In the final case, we want the search to always be open in the case the user
   * is on /search
   */
  useEffect(() => {
    const landing = (router.query.query as string | undefined) ?? '';

    if (landing === routed.current) {
      routedLanded.current = true;
    }

    const answer = boxAfterLanding({
      box: searchValue,
      debounced: debouncedValue,
      routed: routed.current,
      routedLanded: routedLanded.current,
      landing,
    });

    if (answer.reroute) {
      route(debouncedValue);
    }

    if (answer.follow) {
      setSearchValue(
        router.query.query
          ? decodeURIComponent(router.query.query as string)
          : ''
      );
    }

    if (
      router.query.query !== debouncedValue &&
      (answer.follow || searchValue === '') &&
      !router.pathname.startsWith('/search') &&
      !router.query.query
    ) {
      setIsOpen(false);
    }

    if (router.pathname.startsWith('/search')) {
      setIsOpen(true);
    }
  }, [router, setSearchValue]);

  const clear = () => {
    setIsOpen(false);
    setSearchValue('');
  };

  return {
    searchValue,
    searchOpen,
    setIsOpen,
    setSearchValue,
    clear,
  };
};

export default useSearchInput;
