// When the search box follows an address that has landed (F2-D-341 (a)): a pure
// helper, so that it can fail a test. useSearchInput's effect that sets the box
// from router.query.query applies its answer and nothing else.

export interface LandingInput {
  // the box's text
  box: string;
  // the box's text once the typing settled (the debounced text)
  debounced: string;
  // the text the hook last asked the router to go to, none yet
  routed: string | null;
  // whether the address for that text has landed
  routedLanded: boolean;
  // the query of the address that landed
  landing: string;
}

export interface LandingAnswer {
  // set the box to the landing address's query
  follow: boolean;
  // ask the router again for the box's text
  reroute: boolean;
}

// The box follows a landing address only where no text was typed after that
// address was asked: a Back, a Forward, a link, a reload. Where text was typed
// after (the box differs from the settled text), the landing is for an earlier
// text: the box keeps its text, which the debounce routes. Where the settled
// text was asked of the router and its address has not landed, an address that
// lands is for an earlier text too (a pill's push of the page's earlier query):
// the box keeps its text and the router is asked for it again (an address with no
// query, a page left for another, is followed as it is). The landing of
// the settled text itself changes nothing.
export const boxAfterLanding = ({
  box,
  debounced,
  routed,
  routedLanded,
  landing,
}: LandingInput): LandingAnswer => {
  const keep = { follow: false, reroute: false };

  if (landing === debounced) {
    return keep;
  }

  if (box !== debounced) {
    return keep;
  }

  if (
    landing !== '' &&
    routed !== null &&
    routed === debounced &&
    !routedLanded
  ) {
    return { follow: false, reroute: true };
  }

  return { follow: true, reroute: false };
};
