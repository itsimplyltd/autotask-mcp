// autotask_create_ticket and autotask_update_ticket advertised
// assignedResourceRoleID (and say Autotask requires it alongside
// assignedResourceID) but TICKET_WRITABLE_FIELDS omitted it, so the role was
// silently stripped and Autotask answered "When assigning a Resource, you must
// assign both a assignedResourceID and assignedResourceRoleID" (HTTP 500).
// Found 2026-10-04 creating a Monitoring Alert ticket; upstream has the same fix.

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API'))
  }
}));

import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
import { _resetZoneUrlCache } from '../src/utils/config';

const logger = new Logger('error');

const config: McpServerConfig = {
  name: 'test-server',
  version: '0.0.0',
  autotask: {
    username: 'user@example.com',
    secret: 'secret',
    integrationCode: 'integration-code',
    apiUrl: 'https://webservices2.autotask.net/ATServicesRest/',
  },
};

function mockFetchOk(body: unknown): jest.SpyInstance {
  return jest.spyOn(global, 'fetch' as any).mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

function lastRequestBody(fetchMock: jest.SpyInstance): any {
  const calls = fetchMock.mock.calls;
  return JSON.parse((calls[calls.length - 1][1] as RequestInit).body as string);
}

beforeEach(() => {
  _resetZoneUrlCache();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('assignedResourceRoleID reaches the ticket payload', () => {
  test('on autotask_create_ticket', async () => {
    const fetchMock = mockFetchOk({ itemId: 19999 });
    const handler = new AutotaskToolHandler(new AutotaskService(config, logger), logger);

    const result = await handler.callTool('autotask_create_ticket', {
      companyID: 1,
      title: 'EDR disconnected',
      description: 'Assigned with a role',
      dueDateTime: '2026-10-07T04:00:00Z',
      assignedResourceID: 29682898,
      assignedResourceRoleID: 29683355,
    });

    expect(result.isError).toBeFalsy();
    const body = lastRequestBody(fetchMock);
    expect(body.assignedResourceID).toBe(29682898);
    expect(body.assignedResourceRoleID).toBe(29683355);
  });

  test('on autotask_update_ticket', async () => {
    const fetchMock = mockFetchOk({ itemId: 19999 });
    const handler = new AutotaskToolHandler(new AutotaskService(config, logger), logger);

    const result = await handler.callTool('autotask_update_ticket', {
      ticketId: 19999,
      assignedResourceID: 29682898,
      assignedResourceRoleID: 29683355,
    });

    expect(result.isError).toBeFalsy();
    const body = lastRequestBody(fetchMock);
    expect(body.assignedResourceID).toBe(29682898);
    expect(body.assignedResourceRoleID).toBe(29683355);
  });
});
