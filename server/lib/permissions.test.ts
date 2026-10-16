import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasPermission, Permission } from '@server/lib/permissions';

describe('music permissions', () => {
  it('hold the values D-301 gives them', () => {
    assert.equal(Permission.REQUEST_MUSIC, 536870912);
    assert.equal(Permission.AUTO_APPROVE_MUSIC, 1);
  });

  describe('requesting music: [REQUEST, REQUEST_MUSIC] or', () => {
    const check = (value: number) =>
      hasPermission([Permission.REQUEST, Permission.REQUEST_MUSIC], value, {
        type: 'or',
      });

    it('passes for ADMIN, REQUEST and REQUEST_MUSIC', () => {
      assert.equal(check(Permission.ADMIN), true);
      assert.equal(check(Permission.REQUEST), true);
      assert.equal(check(Permission.REQUEST_MUSIC), true);
    });

    it('fails for a user with only REQUEST_MOVIE and REQUEST_TV', () => {
      assert.equal(
        check(Permission.REQUEST_MOVIE | Permission.REQUEST_TV),
        false
      );
    });

    it('fails for a user with the auto-approve music permission alone', () => {
      assert.equal(check(Permission.AUTO_APPROVE_MUSIC), false);
    });
  });

  describe('auto-approving music: [AUTO_APPROVE, AUTO_APPROVE_MUSIC] or', () => {
    const check = (value: number) =>
      hasPermission(
        [Permission.AUTO_APPROVE, Permission.AUTO_APPROVE_MUSIC],
        value,
        { type: 'or' }
      );

    it('passes for ADMIN, AUTO_APPROVE and AUTO_APPROVE_MUSIC', () => {
      assert.equal(check(Permission.ADMIN), true);
      assert.equal(check(Permission.AUTO_APPROVE), true);
      assert.equal(check(Permission.AUTO_APPROVE_MUSIC), true);
    });

    it('fails for a user with only REQUEST_MOVIE and REQUEST_TV', () => {
      assert.equal(
        check(Permission.REQUEST_MOVIE | Permission.REQUEST_TV),
        false
      );
    });

    it('fails for a user with the movie and series auto-approvals only', () => {
      assert.equal(
        check(Permission.AUTO_APPROVE_MOVIE | Permission.AUTO_APPROVE_TV),
        false
      );
    });
  });

  it('give nothing to a user holding every existing permission but them', () => {
    const existing = Object.values(Permission).filter(
      (v): v is number =>
        typeof v === 'number' &&
        v !== Permission.REQUEST_MUSIC &&
        v !== Permission.AUTO_APPROVE_MUSIC &&
        v !== Permission.ADMIN &&
        v !== Permission.REQUEST &&
        v !== Permission.AUTO_APPROVE
    );
    const value = existing.reduce((a, b) => a | b, 0);
    assert.equal(hasPermission(Permission.REQUEST_MUSIC, value), false);
    assert.equal(hasPermission(Permission.AUTO_APPROVE_MUSIC, value), false);
  });
});

describe('existing permissions keep their value', () => {
  const expected: Record<string, number> = {
    NONE: 0,
    ADMIN: 2,
    MANAGE_SETTINGS: 4,
    MANAGE_USERS: 8,
    MANAGE_REQUESTS: 16,
    REQUEST: 32,
    VOTE: 64,
    AUTO_APPROVE: 128,
    AUTO_APPROVE_MOVIE: 256,
    AUTO_APPROVE_TV: 512,
    REQUEST_4K: 1024,
    REQUEST_4K_MOVIE: 2048,
    REQUEST_4K_TV: 4096,
    REQUEST_ADVANCED: 8192,
    REQUEST_VIEW: 16384,
    AUTO_APPROVE_4K: 32768,
    AUTO_APPROVE_4K_MOVIE: 65536,
    AUTO_APPROVE_4K_TV: 131072,
    REQUEST_MOVIE: 262144,
    REQUEST_TV: 524288,
    MANAGE_ISSUES: 1048576,
    VIEW_ISSUES: 2097152,
    CREATE_ISSUES: 4194304,
    AUTO_REQUEST: 8388608,
    AUTO_REQUEST_MOVIE: 16777216,
    AUTO_REQUEST_TV: 33554432,
    RECENT_VIEW: 67108864,
    WATCHLIST_VIEW: 134217728,
    MANAGE_BLOCKLIST: 268435456,
    VIEW_BLOCKLIST: 1073741824,
  };

  for (const [name, value] of Object.entries(expected)) {
    it(`${name} is ${value}`, () => {
      assert.equal(Permission[name as keyof typeof Permission], value);
    });
  }

  it('the enum holds those and the two music permissions only', () => {
    const names = Object.keys(Permission).filter((k) => isNaN(Number(k)));
    assert.deepEqual(
      names.sort(),
      [...Object.keys(expected), 'REQUEST_MUSIC', 'AUTO_APPROVE_MUSIC'].sort()
    );
  });

  it('no two permissions share a bit', () => {
    const values = Object.values(expected).filter((v) => v !== 0);
    const music = [Permission.REQUEST_MUSIC, Permission.AUTO_APPROVE_MUSIC];
    const all = [...values, ...music];
    assert.equal(new Set(all).size, all.length);
    assert.equal(
      all.reduce((a, b) => a + b, 0),
      all.reduce((a, b) => a | b, 0)
    );
  });
});
