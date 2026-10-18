import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boxAfterLanding, type LandingInput } from './searchBox';

// F2-D-341 (a): when the search box follows an address that has landed. Each
// test is a sequence the hook meets; a helper that sets the box back fails one.
const settled = (over: Partial<LandingInput>): LandingInput => ({
  box: 'children of bodom',
  debounced: 'children of bodom',
  routed: 'children of bodom',
  routedLanded: true,
  landing: 'children of bodom',
  ...over,
});

describe('boxAfterLanding', () => {
  it("changes nothing where the address that lands is the box's own settled text", () => {
    assert.deepEqual(boxAfterLanding(settled({})), {
      follow: false,
      reroute: false,
    });
    assert.deepEqual(
      boxAfterLanding(
        settled({ routedLanded: false, landing: 'children of bodom' })
      ),
      { follow: false, reroute: false }
    );
  });

  it('keeps the text typed after the address was asked: the landing of an earlier text never sets the box back', () => {
    // typed on after the debounce settled on 'chi': the landing of 'chi' arrives
    assert.deepEqual(
      boxAfterLanding({
        box: 'children of bod',
        debounced: 'chi',
        routed: 'chi',
        routedLanded: false,
        landing: 'chi',
      }),
      { follow: false, reroute: false }
    );
    // an address for a text the box has moved on from
    assert.deepEqual(
      boxAfterLanding({
        box: 'children of bod',
        debounced: 'children',
        routed: 'children',
        routedLanded: true,
        landing: 'child',
      }),
      { follow: false, reroute: false }
    );
  });

  it("keeps the typed text where a pill pressed within the debounce lands the page's earlier query", () => {
    // the page showed 'film'; 'кино' typed, the pill pressed before the typing
    // settled: its push carries 'film' and lands while the box holds 'кино'
    assert.deepEqual(
      boxAfterLanding({
        box: 'кино',
        debounced: 'film',
        routed: 'film',
        routedLanded: true,
        landing: 'film',
      }),
      { follow: false, reroute: false }
    );
    // the same from a page that was never routed to
    assert.deepEqual(
      boxAfterLanding({
        box: 'кино',
        debounced: '',
        routed: null,
        routedLanded: false,
        landing: 'film',
      }),
      { follow: false, reroute: false }
    );
  });

  it("keeps the text and asks the router for it again where a pill's address lands for an earlier text before the settled text's own", () => {
    assert.deepEqual(
      boxAfterLanding({
        box: 'кино',
        debounced: 'кино',
        routed: 'кино',
        routedLanded: false,
        landing: 'film',
      }),
      { follow: false, reroute: true }
    );
  });

  it('follows a Back, a Forward, a link or a reload: no text typed after, the settled text already landed', () => {
    for (const landing of ['film', 'abba', 'кино']) {
      assert.deepEqual(
        boxAfterLanding(
          settled({ box: 'x', debounced: 'x', routed: 'x', landing })
        ),
        { follow: true, reroute: false }
      );
    }
    // a reload: nothing routed yet
    assert.deepEqual(
      boxAfterLanding({
        box: '',
        debounced: '',
        routed: null,
        routedLanded: false,
        landing: 'children of bodom',
      }),
      { follow: true, reroute: false }
    );
  });

  it('follows a landing without a query (a page left) and never asks the router again for it', () => {
    assert.deepEqual(boxAfterLanding(settled({ landing: '' })), {
      follow: true,
      reroute: false,
    });
    assert.deepEqual(
      boxAfterLanding(settled({ routedLanded: false, landing: '' })),
      { follow: true, reroute: false }
    );
  });

  it("plays a typing run with a pill pressed within the debounce to the box's text", () => {
    // 'film' on the page; the user types 'кино' (box moves, debounce pending),
    // presses a pill (lands 'film'), the debounce settles, its own address lands
    let box = 'film';
    let debounced = 'film';
    let routed: string | null = 'film';
    let routedLanded = true;
    const land = (landing: string) => {
      if (landing === routed) {
        routedLanded = true;
      }
      const answer = boxAfterLanding({
        box,
        debounced,
        routed,
        routedLanded,
        landing,
      });
      if (answer.follow) {
        box = landing;
      }
      if (answer.reroute) {
        routed = debounced;
        routedLanded = false;
      }
    };

    box = 'кино';
    land('film'); // the pill's push of the page's earlier query
    assert.equal(box, 'кино');
    debounced = 'кино'; // the debounce settles; the hook asks for it
    routed = 'кино';
    routedLanded = false;
    land('кино'); // its address lands
    assert.equal(box, 'кино');
    assert.equal(routedLanded, true);
  });
});
