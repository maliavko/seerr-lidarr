import { DiscoverSliderType, defaultSliders } from '@server/constants/discover';
import { getRepository } from '@server/datasource';
import DiscoverSlider from '@server/entity/DiscoverSlider';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

const musicTypes = [
  DiscoverSliderType.RECENTLY_ADDED_MUSIC,
  DiscoverSliderType.RECENT_MUSIC_REQUESTS,
  DiscoverSliderType.SIMILAR_TO_LIBRARY,
];

const saved = () =>
  getRepository(DiscoverSlider).find({ order: { order: 'ASC', id: 'ASC' } });

// The step that creates the built-in sliders (F2-D-284, F2-D-295): the three
// music sliders go after the last row saved, disabled, once, and a row saved
// is never touched.
describe('DiscoverSlider.bootstrapSliders and the music sliders', () => {
  it('gives the music slider types the values 22, 23 and 24 and renumbers none before them', () => {
    assert.equal(DiscoverSliderType.TMDB_TV_STREAMING_SERVICES, 21);
    assert.deepEqual(musicTypes, [22, 23, 24]);
    assert.equal(DiscoverSliderType.RECENTLY_ADDED, 1);
    assert.equal(DiscoverSliderType.NETWORKS, 12);
  });

  it('lists the three as built-in and disabled in the default sliders', () => {
    for (const type of musicTypes) {
      const slider = defaultSliders.find((s) => s.type === type);
      assert.ok(slider, `type ${type} is a default slider`);
      assert.equal(slider.isBuiltIn, true);
      assert.equal(slider.enabled, false);
    }
  });

  it('on a new install creates the twelve built-ins as before and the three music sliders after them, disabled, in order', async () => {
    await DiscoverSlider.bootstrapSliders();

    const rows = await saved();
    assert.equal(rows.length, 15);
    assert.deepEqual(
      rows.map((row) => row.type),
      [...Array(12).keys()].map((i) => i + 1).concat(musicTypes)
    );
    assert.deepEqual(
      rows.map((row) => row.order),
      [...Array(15).keys()]
    );
    for (const row of rows.slice(0, 12)) {
      assert.equal(row.enabled, true);
    }
    for (const row of rows.slice(12)) {
      assert.equal(row.enabled, false);
      assert.equal(row.isBuiltIn, true);
    }
  });

  it('on an upgrade creates them after the highest order saved, a custom slider among the rows, and leaves every existing row as it was', async () => {
    const repository = getRepository(DiscoverSlider);
    // an upgraded install: built-ins reordered and one disabled by the
    // administrator, and a custom slider placed last
    for (const slider of defaultSliders.slice(0, 12)) {
      await repository.save(
        new DiscoverSlider({
          ...slider,
          order: (slider.order ?? 0) * 2 + 3,
          enabled: slider.type === DiscoverSliderType.TRENDING ? false : true,
        })
      );
    }
    await repository.save(
      new DiscoverSlider({
        type: DiscoverSliderType.TMDB_SEARCH,
        title: 'Mine',
        data: 'abc',
        isBuiltIn: false,
        enabled: true,
        order: 40,
      })
    );
    const before = await saved();

    await DiscoverSlider.bootstrapSliders();

    const after = await saved();
    assert.equal(after.length, before.length + 3);
    for (const row of before) {
      const now = after.find((r) => r.id === row.id);
      assert.ok(now);
      assert.equal(now.order, row.order);
      assert.equal(now.enabled, row.enabled);
      assert.equal(now.type, row.type);
      assert.equal(now.title ?? null, row.title ?? null);
    }
    const music = after.filter((r) => musicTypes.includes(r.type));
    assert.deepEqual(
      music.map((r) => [r.type, r.order, r.enabled, r.isBuiltIn]),
      [
        [22, 41, false, true],
        [23, 42, false, true],
        [24, 43, false, true],
      ]
    );
  });

  it('creates only a missing music slider, after the highest order, and never enables or moves one that exists', async () => {
    await DiscoverSlider.bootstrapSliders();
    const repository = getRepository(DiscoverSlider);
    const requests = await repository.findOneByOrFail({
      type: DiscoverSliderType.RECENT_MUSIC_REQUESTS,
    });
    // the administrator enabled and moved it to the top, and removed a sibling
    await repository.update(requests.id, { enabled: true, order: -5 });
    await repository.delete({ type: DiscoverSliderType.SIMILAR_TO_LIBRARY });
    const before = await saved();

    await DiscoverSlider.bootstrapSliders();

    const after = await saved();
    const moved = after.find((r) => r.id === requests.id);
    assert.equal(moved?.enabled, true);
    assert.equal(moved?.order, -5);
    assert.equal(after.length, before.length + 1);
    const created = after.find(
      (r) => r.type === DiscoverSliderType.SIMILAR_TO_LIBRARY
    );
    assert.equal(created?.enabled, false);
    assert.equal(created?.order, 13); // the highest order saved (12) + 1
    for (const row of before) {
      const now = after.find((r) => r.id === row.id);
      assert.equal(now?.order, row.order);
      assert.equal(now?.enabled, row.enabled);
    }
  });

  for (const enabled of [true, false]) {
    it(`on an install holding a Popular Albums row of an earlier build (type 24, ${
      enabled ? 'enabled' : 'disabled'
    }, moved off the end) keeps it at its place and state as Similar to Your Library and adds no second type-24 row (F2-D-284, F2-D-295)`, async () => {
      const repository = getRepository(DiscoverSlider);
      // what the earlier build left: the twelve built-ins, then Recently Added
      // Music (22), Popular Albums (24, the row under test) placed in the
      // middle by the administrator, Recent Music Requests (23) last
      for (const slider of defaultSliders.slice(0, 12)) {
        await repository.save(new DiscoverSlider(slider));
      }
      await repository.save(
        new DiscoverSlider({
          type: DiscoverSliderType.RECENTLY_ADDED_MUSIC,
          isBuiltIn: true,
          enabled: false,
          order: 12,
        })
      );
      const similar = await repository.save(
        new DiscoverSlider({
          type: 24,
          isBuiltIn: true,
          enabled,
          order: 5, // moved off the end
        })
      );
      await repository.save(
        new DiscoverSlider({
          type: DiscoverSliderType.RECENT_MUSIC_REQUESTS,
          isBuiltIn: true,
          enabled: false,
          order: 14,
        })
      );
      const before = await saved();

      await DiscoverSlider.bootstrapSliders();

      const after = await saved();
      assert.equal(after.length, before.length, 'no row is added');
      assert.equal(
        after.filter((r) => r.type === DiscoverSliderType.SIMILAR_TO_LIBRARY)
          .length,
        1
      );
      const row = after.find((r) => r.id === similar.id);
      assert.equal(row?.type, DiscoverSliderType.SIMILAR_TO_LIBRARY);
      assert.equal(row?.order, 5);
      assert.equal(row?.enabled, enabled);
      assert.equal(row?.isBuiltIn, true);
      assert.deepEqual(
        after.map((r) => [r.id, r.type, r.order, r.enabled]),
        before.map((r) => [r.id, r.type, r.order, r.enabled])
      );
    });
  }

  it('names the type SIMILAR_TO_LIBRARY with the value 24 and has no POPULAR_ALBUMS', () => {
    assert.equal(DiscoverSliderType.SIMILAR_TO_LIBRARY, 24);
    assert.equal(
      (DiscoverSliderType as unknown as Record<string, unknown>)[
        'POPULAR_ALBUMS'
      ],
      undefined
    );
    assert.equal(
      defaultSliders.filter((s) => s.type === 24).length,
      1,
      'one default slider of type 24'
    );
  });

  it('is idempotent: a second run creates nothing and changes nothing', async () => {
    await DiscoverSlider.bootstrapSliders();
    const first = await saved();

    await DiscoverSlider.bootstrapSliders();

    const second = await saved();
    assert.deepEqual(
      second.map((r) => [r.id, r.type, r.order, r.enabled]),
      first.map((r) => [r.id, r.type, r.order, r.enabled])
    );
  });

  it('creates them the same way after Reset to Default clears the rows', async () => {
    await DiscoverSlider.bootstrapSliders();
    await getRepository(DiscoverSlider).clear();

    await DiscoverSlider.bootstrapSliders();

    const rows = await saved();
    assert.deepEqual(
      rows.slice(12).map((r) => [r.type, r.order, r.enabled]),
      [
        [22, 12, false],
        [23, 13, false],
        [24, 14, false],
      ]
    );
  });
});
