// Lazy Loading / Progressive Tool Discovery Tests

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API'))
  }
}));

import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const mockConfig: McpServerConfig = {
  name: 'test-server',
  version: '1.0.0',
  autotask: {
    username: 'test-username',
    secret: 'test-secret',
    integrationCode: 'test-integration-code'
  }
};

const mockLogger = new Logger('error');

describe('Lazy Loading - Tool Categories', () => {
  test('TOOL_CATEGORIES should be defined', () => {
    expect(TOOL_CATEGORIES).toBeDefined();
    expect(typeof TOOL_CATEGORIES).toBe('object');
  });

  test('should have expected categories', () => {
    const categoryNames = Object.keys(TOOL_CATEGORIES);
    expect(categoryNames).toContain('utility');
    expect(categoryNames).toContain('companies');
    expect(categoryNames).toContain('tickets');
    expect(categoryNames).toContain('financial');
    expect(categoryNames).toContain('products_and_services');
  });

  test('every category should have description and non-empty tools array', () => {
    for (const [, cat] of Object.entries(TOOL_CATEGORIES)) {
      expect(cat.description).toBeTruthy();
      expect(Array.isArray(cat.tools)).toBe(true);
      expect(cat.tools.length).toBeGreaterThan(0);
    }
  });

  test('all categorized tools should exist in TOOL_DEFINITIONS', () => {
    const toolNames = new Set(TOOL_DEFINITIONS.map(t => t.name));
    for (const [, cat] of Object.entries(TOOL_CATEGORIES)) {
      for (const toolName of cat.tools) {
        expect(toolNames.has(toolName)).toBe(true);
      }
    }
  });

  test('meta-tools should exist in TOOL_DEFINITIONS', () => {
    const toolNames = new Set(TOOL_DEFINITIONS.map(t => t.name));
    expect(toolNames.has('autotask_list_categories')).toBe(true);
    expect(toolNames.has('autotask_list_category_tools')).toBe(true);
    expect(toolNames.has('autotask_execute_tool')).toBe(true);
  });

  test('every non-meta TOOL_DEFINITIONS entry appears in exactly one category', () => {
    const META_TOOLS = new Set([
      'autotask_list_categories',
      'autotask_list_category_tools',
      'autotask_execute_tool',
      'autotask_router'
    ]);
    const categoryCounts = new Map<string, number>();
    for (const cat of Object.values(TOOL_CATEGORIES)) {
      for (const toolName of cat.tools) {
        categoryCounts.set(toolName, (categoryCounts.get(toolName) || 0) + 1);
      }
    }

    const uncategorized: string[] = [];
    const duplicated: string[] = [];
    for (const tool of TOOL_DEFINITIONS) {
      if (META_TOOLS.has(tool.name)) continue;
      const count = categoryCounts.get(tool.name) || 0;
      if (count === 0) uncategorized.push(tool.name);
      else if (count > 1) duplicated.push(tool.name);
    }

    expect(uncategorized).toEqual([]);
    expect(duplicated).toEqual([]);

    // Every categorized tool name should also be a real, defined tool (no ghost references).
    const toolNames = new Set(TOOL_DEFINITIONS.map(t => t.name));
    const ghosts = [...categoryCounts.keys()].filter(name => !toolNames.has(name));
    expect(ghosts).toEqual([]);
  });
});

describe('Lazy Loading - Tool Handler', () => {
  test('should return all tools when lazy loading is disabled', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const handler = new AutotaskToolHandler(service, mockLogger, false);
    const tools = await handler.listTools();
    expect(tools.length).toBe(TOOL_DEFINITIONS.length);
  });

  test('should return only meta-tools when lazy loading is enabled', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const handler = new AutotaskToolHandler(service, mockLogger, true);
    const tools = await handler.listTools();
    expect(tools.length).toBe(4);
    const names = tools.map(t => t.name);
    expect(names).toContain('autotask_list_categories');
    expect(names).toContain('autotask_list_category_tools');
    expect(names).toContain('autotask_execute_tool');
    expect(names).toContain('autotask_router');
  });

  test('autotask_list_categories should return all categories', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const handler = new AutotaskToolHandler(service, mockLogger, true);
    const result = await handler.callTool('autotask_list_categories', {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data.length).toBe(Object.keys(TOOL_CATEGORIES).length);
    // Each category should have name, description, and toolCount
    for (const cat of parsed.data) {
      expect(cat.name).toBeTruthy();
      expect(cat.description).toBeTruthy();
      expect(typeof cat.toolCount).toBe('number');
    }
  });

  test('autotask_list_category_tools should return tools for valid category', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const handler = new AutotaskToolHandler(service, mockLogger, true);
    const result = await handler.callTool('autotask_list_category_tools', { category: 'companies' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data.length).toBe(TOOL_CATEGORIES.companies.tools.length);
    // Each tool should have full schema
    for (const tool of parsed.data) {
      expect(tool.name).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    }
  });

  test('autotask_list_category_tools should error for invalid category', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const handler = new AutotaskToolHandler(service, mockLogger, true);
    const result = await handler.callTool('autotask_list_category_tools', { category: 'nonexistent' });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('Unknown category');
  });
});

describe('autotask_list_category_tools - keyword search', () => {
  test('errors when neither category nor query is given', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const handler = new AutotaskToolHandler(service, mockLogger, true);
    const result = await handler.callTool('autotask_list_category_tools', {});
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('autotask_list_categories');
  });

  test('a query with no matches returns an empty result, not an error', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const handler = new AutotaskToolHandler(service, mockLogger, true);
    const result = await handler.callTool('autotask_list_category_tools', { query: 'zzznomatchxyz999' });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data).toEqual([]);
  });

  test('ranks a name match above a description-only match, and attaches the owning category', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const handler = new AutotaskToolHandler(service, mockLogger, true);
    const result = await handler.callTool('autotask_list_category_tools', { query: 'ticket note' });
    const parsed = JSON.parse(result.content[0].text);
    const names = parsed.data.map((t: any) => t.name);
    // autotask_search_ticket_notes / autotask_create_ticket_note / autotask_get_ticket_note match
    // both query tokens directly in the tool name, so they should rank at (or near) the top.
    expect(names[0]).toMatch(/ticket_note/);
    const top = parsed.data[0];
    expect(top.category).toBe('tickets');
    expect(top.inputSchema).toBeDefined();
  });

  test('respects a custom limit and caps it at 25', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const handler = new AutotaskToolHandler(service, mockLogger, true);

    const limited = await handler.callTool('autotask_list_category_tools', { query: 'ticket', limit: 3 });
    const limitedParsed = JSON.parse(limited.content[0].text);
    expect(limitedParsed.data.length).toBeLessThanOrEqual(3);

    const overLimit = await handler.callTool('autotask_list_category_tools', { query: 'ticket', limit: 999 });
    const overLimitParsed = JSON.parse(overLimit.content[0].text);
    expect(overLimitParsed.data.length).toBeLessThanOrEqual(25);
  });

  test('defaults to 10 results when no limit is given', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const handler = new AutotaskToolHandler(service, mockLogger, true);
    const result = await handler.callTool('autotask_list_category_tools', { query: 'ticket' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data.length).toBeLessThanOrEqual(10);
  });

  test('a query scoped to a category only searches within that category', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const handler = new AutotaskToolHandler(service, mockLogger, true);
    const result = await handler.callTool('autotask_list_category_tools', { category: 'financial', query: 'ticket' });
    const parsed = JSON.parse(result.content[0].text);
    for (const tool of parsed.data) {
      expect(TOOL_CATEGORIES.financial.tools).toContain(tool.name);
      expect(tool.category).toBe('financial');
    }
  });
});

describe('Decision Tree Router', () => {
  test('should route ticket search intent', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const handler = new AutotaskToolHandler(service, mockLogger);
    const result = await handler.callTool('autotask_router', { intent: 'find tickets for Acme Corp' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data.suggestedTool).toBe('autotask_search_tickets');
  });

  test('should route time entry intent with extracted params', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const handler = new AutotaskToolHandler(service, mockLogger);
    const result = await handler.callTool('autotask_router', { intent: 'log 2 hours on ticket 12345' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data.suggestedTool).toBe('autotask_create_time_entry');
    expect(parsed.data.suggestedParams.hoursWorked).toBe(2);
    expect(parsed.data.suggestedParams.ticketID).toBe(12345);
  });

  test('should route quote creation intent', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const handler = new AutotaskToolHandler(service, mockLogger);
    const result = await handler.callTool('autotask_router', { intent: 'create a new quote for client' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data.suggestedTool).toBe('autotask_create_quote');
  });

  test('should fallback to list_categories for unknown intent', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const handler = new AutotaskToolHandler(service, mockLogger);
    const result = await handler.callTool('autotask_router', { intent: 'do something random' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data.suggestedTool).toBe('autotask_list_categories');
  });

  test('should route company search with quoted name', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const handler = new AutotaskToolHandler(service, mockLogger);
    const result = await handler.callTool('autotask_router', { intent: 'search companies for "Wyre Technology"' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data.suggestedTool).toBe('autotask_search_companies');
    expect(parsed.data.suggestedParams.searchTerm).toBe('Wyre Technology');
  });
});

describe('autotask_update_ticket schema', () => {
  const updateTicketTool = TOOL_DEFINITIONS.find(t => t.name === 'autotask_update_ticket');

  test('tool definition exists', () => {
    expect(updateTicketTool).toBeDefined();
  });

  test('exposes issueType as an optional number', () => {
    const props = updateTicketTool!.inputSchema.properties as Record<string, any>;
    expect(props.issueType).toBeDefined();
    expect(props.issueType.type).toBe('number');
    expect(updateTicketTool!.inputSchema.required).not.toContain('issueType');
  });

  test('exposes subIssueType as an optional number', () => {
    const props = updateTicketTool!.inputSchema.properties as Record<string, any>;
    expect(props.subIssueType).toBeDefined();
    expect(props.subIssueType.type).toBe('number');
    expect(updateTicketTool!.inputSchema.required).not.toContain('subIssueType');
  });

  test('buildTicketPayload (via handler) forwards issueType and subIssueType to updateTicket', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const updateSpy = jest.spyOn(service, 'updateTicket').mockResolvedValue(undefined as any);
    const handler = new AutotaskToolHandler(service, mockLogger);
    await handler.callTool('autotask_update_ticket', {
      ticketId: 42,
      issueType: 7,
      subIssueType: 13
    });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const [id, payload] = updateSpy.mock.calls[0];
    expect(id).toBe(42);
    expect(payload).toEqual(expect.objectContaining({ issueType: 7, subIssueType: 13 }));
  });
});
