// Copyright IT Simply Ltd. S2S v3 phase A through a REAL http server: the
// gateway wrapper, the legacy v1 floor, the signed-header rule, routing, boot
// check and start-up log. Signers are test helpers ported from cred-router.

import { request as httpRequest, createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AutotaskMcpServer, REQUIRE_SIGNED_HEADERS } from '../src/mcp/server';
import { AutotaskHttpClient } from '../src/services/autotask-http';
import type { EnvironmentConfig } from '../src/utils/config';
import type { McpServerConfig } from '../src/types/mcp';
import { s2sHeaderV1, s2sHeaderV3 } from './helpers/s2s-signers';

const SECRET = 'test-s2s-secret-0123456789abcdefghijklmnopqrstuvwxyz';
const CREDS: Record<string, string> = {
  'x-api-key': 'api-user@example.com',
  'x-api-secret': 'api-secret-value',
  'x-integration-code': 'integration-code',
  'x-impersonation-resource-id': '30',
};
const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
});

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function envConfig(port: number): EnvironmentConfig {
  return {
    autotask: {},
    server: { name: 'autotask-mcp-test', version: '0.0.0-test' },
    transport: { type: 'http', port, host: '127.0.0.1' },
    logging: { level: 'error', format: 'simple' },
    auth: { mode: 'gateway' },
  };
}

const mcpConfig = { name: 'autotask-mcp-test', version: '0.0.0-test', autotask: { username: '', secret: '', integrationCode: '' } } as McpServerConfig;

type Resp = { status: number; body: string };

function send(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string }): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const body = opts.body ?? '';
    const req = httpRequest(
      {
        host: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path ?? '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': String(Buffer.byteLength(body)),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const v3Headers = (signed: Record<string, string>, unsignedExtra: Record<string, string> = {}, body = INIT_BODY) => ({
  ...signed,
  ...unsignedExtra,
  'x-gateway-s2s': s2sHeaderV3(SECRET, { aud: 'autotask', method: 'POST', path: '/mcp', body, headers: signed }),
});

let seq = 0;
const nextPort = () => 41000 + ((process.pid + seq++ * 7) % 900);

async function boot(env: Record<string, string | undefined> = {}) {
  const saved: Record<string, string | undefined> = {};
  const all = { CONDUIT_S2S_SECRET: SECRET, ITSL_S2S_MIN_VERSION: undefined, ...env };
  for (const [k, v] of Object.entries(all)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const logger = makeLogger();
  const port = nextPort();
  const server = new AutotaskMcpServer(mcpConfig, logger as never, envConfig(port));
  try {
    await server.start();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return { server, logger, port };
}

describe('S2S v3 phase A (autotask)', () => {
  let ctx: Awaited<ReturnType<typeof boot>> | undefined;
  afterEach(async () => {
    await ctx?.server.stop();
    ctx = undefined;
  });

  it('requireSignedHeaders covers credential, identity, impersonation and base-URL headers', () => {
    expect(REQUIRE_SIGNED_HEADERS).toEqual(
      expect.arrayContaining(['x-api-key', 'x-api-secret', 'x-integration-code', 'x-impersonation-resource-id', 'x-api-url']),
    );
  });

  it('logs the effective min version and report mode once at boot', async () => {
    ctx = await boot();
    const lines = ctx.logger.info.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('effective minimum version 1') && l.includes('report mode'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain(SECRET);
  });

  it('logs enforced header rule at min 3', async () => {
    ctx = await boot({ ITSL_S2S_MIN_VERSION: '3' });
    const lines = ctx.logger.info.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('effective minimum version 3') && l.includes('header rule enforced'))).toBe(true);
  });

  it('refuses to start without a secret, or with one under 32 characters', async () => {
    await expect(boot({ CONDUIT_S2S_SECRET: undefined })).rejects.toThrow(/CONDUIT_S2S_SECRET/);
    await expect(boot({ CONDUIT_S2S_SECRET: 'short-secret' })).rejects.toThrow(/at least 32/);
  });

  it('accepts legacy v1 at the floor', async () => {
    ctx = await boot();
    const r = await send(ctx.port, { headers: { ...CREDS, 'x-gateway-s2s': s2sHeaderV1(SECRET) }, body: INIT_BODY });
    expect(r.status).toBe(200);
  });

  it('refuses a bad legacy signature and a missing header', async () => {
    ctx = await boot();
    expect((await send(ctx.port, { headers: { ...CREDS, 'x-gateway-s2s': s2sHeaderV1('x'.repeat(40)) }, body: INIT_BODY })).status).toBe(401);
    expect((await send(ctx.port, { headers: { ...CREDS }, body: INIT_BODY })).status).toBe(401);
  });

  it('accepts v3 with the credential headers signed', async () => {
    ctx = await boot();
    const r = await send(ctx.port, { headers: v3Headers(CREDS), body: INIT_BODY });
    expect(r.status).toBe(200);
  });

  it('refuses a replayed v3 nonce', async () => {
    ctx = await boot();
    const headers = v3Headers(CREDS);
    expect((await send(ctx.port, { headers, body: INIT_BODY })).status).toBe(200);
    expect((await send(ctx.port, { headers, body: INIT_BODY })).status).toBe(401);
  });

  it('refuses v3 whose body differs from the signed body', async () => {
    ctx = await boot();
    const r = await send(ctx.port, { headers: v3Headers(CREDS, {}, INIT_BODY), body: INIT_BODY.replace('"id":1', '"id":2') });
    expect(r.status).toBe(401);
  });

  for (const name of ['x-api-key', 'x-api-secret', 'x-integration-code', 'x-impersonation-resource-id']) {
    it(`refuses v3 with ${name} present but unsigned, even in report mode`, async () => {
      ctx = await boot(); // min 1 = report mode
      const signed = { ...CREDS };
      const value = signed[name];
      delete signed[name];
      const r = await send(ctx.port, { headers: v3Headers(signed, { [name]: value }), body: INIT_BODY });
      expect(r.status).toBe(401);
    });
  }

  it('refuses v3 carrying an unsigned x-api-url (base-URL header)', async () => {
    ctx = await boot();
    const r = await send(ctx.port, { headers: v3Headers(CREDS, { 'x-api-url': 'https://evil.example/' }), body: INIT_BODY });
    expect(r.status).toBe(401);
  });

  it('honours v3 with x-api-url signed', async () => {
    ctx = await boot();
    const r = await send(ctx.port, {
      headers: v3Headers({ ...CREDS, 'x-api-url': 'https://webservices1.autotask.net/ATServicesRest/' }),
      body: INIT_BODY,
    });
    expect(r.status).toBe(200);
  });

  it('refuses legacy at min 3, accepts v3', async () => {
    ctx = await boot({ ITSL_S2S_MIN_VERSION: '3' });
    expect((await send(ctx.port, { headers: { ...CREDS, 'x-gateway-s2s': s2sHeaderV1(SECRET) }, body: INIT_BODY })).status).toBe(401);
    expect((await send(ctx.port, { headers: v3Headers(CREDS), body: INIT_BODY })).status).toBe(200);
  });

  it('still requires the gateway credential headers after S2S passes', async () => {
    ctx = await boot();
    const r = await send(ctx.port, { headers: { 'x-gateway-s2s': s2sHeaderV1(SECRET) }, body: INIT_BODY });
    expect(r.status).toBe(401);
    expect(r.body).toContain('missing required gateway credentials');
  });

  it('survives an aborted upload and still answers /health', async () => {
    ctx = await boot();
    await new Promise<void>((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1', port: ctx!.port, method: 'POST', path: '/mcp',
        headers: { 'content-type': 'application/json', 'content-length': '5000', ...CREDS, 'x-gateway-s2s': s2sHeaderV1(SECRET) },
      });
      req.on('error', () => resolve());
      req.write('{"partial":');
      setTimeout(() => { req.destroy(); resolve(); }, 50);
    });
    await new Promise((r) => setTimeout(r, 100));
    const h = await send(ctx.port, { method: 'GET', path: '/health' });
    expect(h.status).toBe(200);
    expect(JSON.parse(h.body).status).toBe('ok');
  });

  it('answers /health without auth', async () => {
    ctx = await boot();
    expect((await send(ctx.port, { method: 'GET', path: '/health' })).status).toBe(200);
  });

  it('returns 404 for unknown paths before auth', async () => {
    ctx = await boot();
    expect((await send(ctx.port, { method: 'GET', path: '/nope' })).status).toBe(404);
    expect((await send(ctx.port, { path: '/mcp/extra', headers: { 'x-gateway-s2s': 'junk' } })).status).toBe(404);
  });
});

describe('vendor redirects fail closed', () => {
  it('a 3xx from the Autotask API is an error and the target is never contacted', async () => {
    let targetHit = false;
    const target = createHttpServer((_req, res) => { targetHit = true; res.end('{}'); });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    const targetPort = (target.address() as AddressInfo).port;
    const redirector = createHttpServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/stolen` });
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    const redirPort = (redirector.address() as AddressInfo).port;
    try {
      const logger = makeLogger();
      const client = new AutotaskHttpClient('u@example.com', 's', 'ic', `http://127.0.0.1:${redirPort}/`, logger as never);
      await expect(client.get('Companies', 1)).rejects.toThrow(/network error/);
      expect(targetHit).toBe(false);
    } finally {
      await new Promise((r) => redirector.close(r));
      await new Promise((r) => target.close(r));
    }
  });
});
