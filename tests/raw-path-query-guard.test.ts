// ITSL GW-001 (10 Oct 2026): rawRequest must refuse a path carrying a query
// string or fragment, raw or percent-encoded. A gateway read-tier check matched
// the end of the path against /query, so "/Tickets/1/Notes?x=/query" reached
// Autotask as a POST to /Tickets/1/Notes. Query parameters go in queryParams.

import { AutotaskHttpClient } from '../src/services/autotask-http';
import { _resetZoneUrlCache } from '../src/utils/config';

const logger = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };

const makeClient = () =>
  new AutotaskHttpClient(
    'user@example.com',
    'secret',
    'integration-code',
    'https://webservices18.autotask.net/ATServicesRest/',
    logger as any
  );

beforeEach(() => _resetZoneUrlCache());

describe('GW-001: rawRequest path has no query string or fragment', () => {
  test.each([
    '/Tickets/147679/Notes?x=/query',
    '/TicketNotes#/query',
    '/TicketNotes%3Fx=/query',
    '/TicketNotes%3fx=/query',
    '/TicketNotes%23/query',
  ])('refuses %s without calling Autotask', async (path) => {
    const fetchMock = jest.spyOn(global, 'fetch' as any);
    try {
      await expect(new AutotaskHttpClient('u', 's', 'c', 'https://webservices18.autotask.net/ATServicesRest/', logger as any)
        .rawRequest('POST', path, {})).rejects.toThrow(/must not contain/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  test('a GET keeps its query string (paging follows /query/next?paging=...)', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch' as any)
      .mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{"items":[]}' } as any);
    try {
      await expect(makeClient().rawRequest('GET', '/Companies/query/next?paging=abc')).resolves.toEqual({ items: [] });
    } finally {
      fetchMock.mockRestore();
    }
  });

  test('a clean /query path still goes through', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch' as any)
      .mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{"items":[]}' } as any);
    try {
      await expect(makeClient().rawRequest('POST', '/Tickets/query', {})).resolves.toEqual({ items: [] });
    } finally {
      fetchMock.mockRestore();
    }
  });
});
