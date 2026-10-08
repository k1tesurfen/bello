import { expect, it } from 'vitest';
import {
  cookiesFromSetCookieRecords,
  isFirstPartyDomain,
} from '../../src/capture/storage/index.js';

it('1st/3rd-Party anhand der registrierbaren Domain', () => {
  expect(isFirstPartyDomain('.kunde-test.de', 'https://www.kunde-test.de/')).toBe(true);
  expect(isFirstPartyDomain('www.google-analytics.com', 'https://www.kunde-test.de/')).toBe(false);
  expect(isFirstPartyDomain('shop.example.co.uk', 'https://www.example.co.uk/')).toBe(true);
});

it('wandelt Set-Cookie-Records (auch blockierte) in CookieRecords', () => {
  const [c, b] = cookiesFromSetCookieRecords(
    [
      {
        raw: 'id=abc123; Domain=.doubleclick.net; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=3600',
      },
      { raw: '_x=1; Path=/a', name: '_x', blockedReasons: ['SameSiteUnspecifiedTreatedAsLax'] },
    ],
    'stats.g.doubleclick.net',
    'https://www.kunde-test.de/',
    'nach-laden',
  );
  expect(c).toMatchObject({
    name: 'id',
    domain: 'doubleclick.net',
    secure: true,
    httpOnly: true,
    sameSite: 'None',
    firstParty: false,
    source: 'set-cookie',
    checkpoint: 'nach-laden',
  });
  expect(c!.expires).toBeGreaterThan(Date.now() / 1000);
  expect(b).toMatchObject({
    name: '_x',
    domain: 'stats.g.doubleclick.net',
    path: '/a',
    expires: -1,
  });
});

it('private Suffixe (github.io): fremde Subdomain ist Third Party', () => {
  expect(isFirstPartyDomain('tracker.github.io', 'https://kunde.github.io/')).toBe(false);
  expect(isFirstPartyDomain('.kunde.github.io', 'https://kunde.github.io/')).toBe(true);
});
