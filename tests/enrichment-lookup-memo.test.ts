// Per-request memoisation + concurrency cap for ID-to-name direct lookups.
// Regression for Autotask 429s: a 14-ticket search used to fan out one
// getCompany call per record (~20 in parallel), tripping the thread limit and
// the tenant-wide cooldown.

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API')),
  },
}));

import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { AutotaskService } from '../src/services/autotask.service';
import { MappingService, _resetTenantCacheStore } from '../src/utils/mapping.service';
import { createLimiter } from '../src/utils/concurrency';
import { markUntrustedContent } from '../src/utils/untrusted-content';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const mockConfig: McpServerConfig = {
  name: 'test-server',
  version: '1.0.0',
  autotask: { username: 'test-username', secret: 'test-secret', integrationCode: 'test-integration-code' },
};
const logger = new Logger('error');

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

const NAMES: Record<number, string> = { 0: 'IT Simply Ltd', 572: 'Acme Ltd' };

function makeService() {
  const service = new AutotaskService(mockConfig, logger);
  const getCompany = jest.spyOn(service, 'getCompany').mockImplementation(
    async (id: number) => ({ id, companyName: NAMES[id] } as any)
  );
  return { service, getCompany };
}

async function newMapping(service: AutotaskService) {
  // lazyLoading true: cache stays empty so every id takes the direct path.
  return MappingService.create(service, logger, { lazyLoading: true });
}

beforeEach(() => _resetTenantCacheStore());

describe('createLimiter', () => {
  test('never exceeds the limit and runs queued tasks as slots free up', async () => {
    const limit = createLimiter(2);
    const ds = [deferred<number>(), deferred<number>(), deferred<number>(), deferred<number>()];
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const runs = ds.map((d, i) => limit(async () => {
      active++; peak = Math.max(peak, active); started.push(i);
      try { return await d.promise; } finally { active--; }
    }));
    await flush();
    expect(started).toEqual([0, 1]);
    ds[0].resolve(10);
    await flush();
    expect(started).toEqual([0, 1, 2]);
    ds[1].resolve(11); ds[2].resolve(12);
    await flush();
    ds[3].resolve(13);
    expect(await Promise.all(runs)).toEqual([10, 11, 12, 13]);
    expect(peak).toBe(2);
  });

  test('a rejected task does not block the queue', async () => {
    const limit = createLimiter(1);
    const a = limit(async () => { throw new Error('boom'); });
    const b = limit(async () => 'ok');
    await expect(a).rejects.toThrow('boom');
    await expect(b).resolves.toBe('ok');
  });
});

describe('MappingService direct lookups', () => {
  test('parallel callers for the same id await ONE in-flight call', async () => {
    const { service, getCompany } = makeService();
    const gate = deferred<any>();
    getCompany.mockImplementation(() => gate.promise);
    const mapping = await newMapping(service);
    const calls = Array.from({ length: 10 }, () => mapping.getCompanyName(572));
    await flush();
    expect(getCompany).toHaveBeenCalledTimes(1);
    gate.resolve({ id: 572, companyName: 'Acme Ltd' });
    expect(await Promise.all(calls)).toEqual(Array(10).fill('Acme Ltd'));
    expect(getCompany).toHaveBeenCalledTimes(1);
  });

  test('at most 2 lookups are in flight at once', async () => {
    const { service, getCompany } = makeService();
    const gates = new Map<number, Deferred<any>>();
    let active = 0;
    let peak = 0;
    getCompany.mockImplementation(async (id: number) => {
      const g = deferred<any>();
      gates.set(id, g);
      active++; peak = Math.max(peak, active);
      try { return await g.promise; } finally { active--; }
    });
    const mapping = await newMapping(service);
    const all = [1, 2, 3, 4, 5].map((id) => mapping.getCompanyName(id));
    await flush();
    expect(getCompany).toHaveBeenCalledTimes(2);
    gates.get(1)!.resolve({ id: 1, companyName: 'C1' });
    await flush();
    expect(getCompany).toHaveBeenCalledTimes(3);
    for (const id of [2, 3, 4, 5]) {
      await flush();
      gates.get(id)?.resolve({ id, companyName: `C${id}` });
    }
    await flush();
    expect(await Promise.all(all)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5']);
    expect(peak).toBe(2);
  });

  test('a failed lookup is attempted once per request, not per record', async () => {
    const { service, getCompany } = makeService();
    getCompany.mockRejectedValue(new Error('429 threshold exceeded'));
    const mapping = await newMapping(service);
    const results = await Promise.all(Array.from({ length: 8 }, () => mapping.getCompanyName(572)));
    expect(results).toEqual(Array(8).fill(null));
    expect(await mapping.getCompanyName(572)).toBeNull();
    expect(getCompany).toHaveBeenCalledTimes(1);
  });

  test('a not-found result is memoised too', async () => {
    const { service, getCompany } = makeService();
    getCompany.mockResolvedValue(null as any);
    const mapping = await newMapping(service);
    await Promise.all([mapping.getCompanyName(9), mapping.getCompanyName(9)]);
    expect(getCompany).toHaveBeenCalledTimes(1);
  });

  test('a miss is logged once per id and the message no longer claims it is not cached', async () => {
    const { service } = makeService();
    const warn = jest.fn();
    const spyLogger = { info: jest.fn(), debug: jest.fn(), error: jest.fn(), warn } as unknown as Logger;
    const mapping = await MappingService.create(service, spyLogger, { lazyLoading: true });
    await Promise.all([0, 0, 0, 572, 572].map((id) => mapping.getCompanyName(id)));
    const missLines = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('missing from paginated cache'));
    expect(missLines).toHaveLength(2);
    expect(missLines.every((m) => !m.includes('NOT be cached') && m.includes('this request'))).toBe(true);
  });

  test('a second, separate request DOES look the id up again (no cross-request cache)', async () => {
    const { service, getCompany } = makeService();
    const first = await newMapping(service);
    await first.getCompanyName(572);
    const second = await newMapping(service);
    await second.getCompanyName(572);
    expect(getCompany).toHaveBeenCalledTimes(2);
  });
});

function makeTickets(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: 1000 + i,
    ticketNumber: `T20261009.${String(i).padStart(4, '0')}`,
    title: `Ticket ${i}`,
    status: 1,
    priority: 2,
    companyID: i % 2 === 0 ? 0 : 572,
  }));
}

describe('enrichment through the tool handler', () => {
  async function run(handler: AutotaskToolHandler, service: AutotaskService, tickets: any[]) {
    jest.spyOn(service, 'searchTickets').mockResolvedValue(tickets as any);
    return handler.callTool('autotask_search_tickets', { pageSize: 50 });
  }
  const rawText = (res: any): string => String(res.content[0].text);
  const parse = (res: any) => {
    const t = rawText(res);
    return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
  };

  test('14 tickets sharing 2 company ids (incl. 0) cause exactly 2 company lookups', async () => {
    const { service, getCompany } = makeService();
    const handler = new AutotaskToolHandler(service, logger, true);
    const res = await run(handler, service, makeTickets(14));
    expect(getCompany).toHaveBeenCalledTimes(2);
    expect(getCompany.mock.calls.map((c) => c[0]).sort()).toEqual([0, 572]);

    const body = parse(res);
    const items = body.items ?? body.data;
    expect(items).toHaveLength(14);
    // Text stays wrapped by the untrusted-content marking, exactly as before.
    expect(rawText(res)).toBe(markUntrustedContent('autotask_search_tickets', JSON.stringify(body)));
    expect(rawText(res)).not.toBe(JSON.stringify(body));
    // Output unchanged: each item still carries `company` resolved from its id.
    for (const item of items) {
      expect(item.company).toBe(item.companyID === 0 ? 'IT Simply Ltd' : 'Acme Ltd');
    }
  });

  test('a second tool call on the same handler looks the ids up again', async () => {
    const { service, getCompany } = makeService();
    const handler = new AutotaskToolHandler(service, logger, true);
    await run(handler, service, makeTickets(14));
    await run(handler, service, makeTickets(14));
    expect(getCompany).toHaveBeenCalledTimes(4);
  });

  test('a failing company id leaves the item un-enriched and is tried once', async () => {
    const { service, getCompany } = makeService();
    getCompany.mockRejectedValue(new Error('boom'));
    const handler = new AutotaskToolHandler(service, logger, true);
    const res = await run(handler, service, makeTickets(14));
    expect(getCompany).toHaveBeenCalledTimes(2);
    for (const item of parse(res).items ?? parse(res).data) expect(item.company).toBeUndefined();
  });
});
