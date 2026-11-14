// Copyright IT Simply Ltd. Pins the vendored verifier and runs the shared vectors
// (tests/fixtures/s2s-v3-vectors.json, canonical copy in itsimplyltd/MCP-Gateway
// s2s/s2s-v3-vectors.json) through it. Ported from s2s/s2s-v3.test.ts.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import {
  NonceCache,
  RawBodyError,
  readRawBody,
  verifyV3,
  checkGatewayRequest,
  canonicalV3,
  parseV3Header,
  assertRequireSignedHeaders,
} from '../src/itsl/s2s-v3';

const PINNED_SHA256 = '3160ee243febcf990c4eb84f514c254a7d9a98592fa1d9b53888f1ad0dde11b0';

/* eslint-disable @typescript-eslint/no-explicit-any */
const vectors: any = JSON.parse(readFileSync(join(__dirname, 'fixtures', 's2s-v3-vectors.json'), 'utf8'));
const secret: string = vectors.secret;

function args(c: any, cache: NonceCache) {
  return {
    method: c.method,
    rawTarget: c.rawTarget,
    body: Buffer.from(c.body, 'utf8'),
    rawHeaders: c.rawHeaders,
    secret: c.secretOverride ?? secret,
    aud: c.aud,
    nowSeconds: c.nowSeconds,
    nonceCache: cache,
    headerRuleMode: c.headerRuleMode,
  };
}

describe('vendored s2s-v3.ts', () => {
  it('is byte-identical to the canonical MCP-Gateway copy (sha256 pin)', () => {
    const bytes = readFileSync(join(__dirname, '..', 'src', 'itsl', 's2s-v3.ts'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(PINNED_SHA256);
  });
});

describe('s2s-v3 vectors', () => {
  for (const c of vectors.positive) {
    it(`positive: ${c.name}`, () => {
      expect(verifyV3(args(c, new NonceCache()) as any)).toEqual({ ok: true, version: 3 });
    });
    if (!c.derivedFrom) {
      it(`positive canonical string is pinned: ${c.name}`, () => {
        const parsed = parseV3Header(c.header)!;
        const headerHashes: Record<string, string> = {};
        for (const [k, v] of Object.entries(c.signedHeaders)) {
          headerHashes[k] = createHash('sha256').update(v as string).digest('hex');
        }
        const canonical = canonicalV3({
          t: parsed.tRaw, n: parsed.n, aud: c.aud, method: c.method, path: c.rawTarget,
          bodySha256: createHash('sha256').update(c.body).digest('hex'), sh: parsed.sh, headerHashes,
        });
        expect(canonical).toBe(c.canonical);
        expect(canonical.endsWith('\n')).toBe(false);
      });
    }
  }

  for (const c of vectors.negative) {
    it(`negative: ${c.name} -> ${c.expect}`, () => {
      const cache = new NonceCache();
      if (c.replayOf) {
        const first = vectors.positive.find((p: any) => p.name === c.replayOf);
        expect(verifyV3(args(first, cache) as any).ok).toBe(true);
      }
      expect(verifyV3(args(c, cache) as any)).toEqual({ ok: false, reason: c.expect });
    });
  }

  for (const c of vectors.check) {
    it(`checkGatewayRequest: ${c.name}`, () => {
      const r: any = checkGatewayRequest({
        ...(args(c, new NonceCache()) as any),
        floor: c.floor,
        minVersion: c.minVersion,
        verifyLegacy: () => c.legacyResult ?? 0,
      });
      expect(r.ok).toBe(c.expect.ok);
      expect(r.version).toBe(c.expect.version);
      if (!c.expect.ok) expect(r.reason).toBe(c.expect.reason);
      expect(r.unsignedHeaderNames).toEqual(c.expect.unsignedHeaderNames);
    });
  }

  for (const c of vectors.readRawBody) {
    it(`readRawBody: ${c.name}`, async () => {
      const req = Object.assign(Readable.from([Buffer.from(c.body)]), { headers: c.headers }) as unknown as IncomingMessage;
      if (c.expectStatus) {
        await expect(readRawBody(req)).rejects.toMatchObject({ status: c.expectStatus });
        await expect(readRawBody(Object.assign(Readable.from([Buffer.from(c.body)]), { headers: c.headers }) as unknown as IncomingMessage))
          .rejects.toBeInstanceOf(RawBodyError);
      } else {
        expect((await readRawBody(req)).toString()).toBe(c.body);
      }
    });
  }

  for (const c of vectors.requireSigned) {
    it(`requireSigned: ${c.name}`, () => {
      const base = vectors.positive.find((p: any) => p.name === c.from);
      const rawHeaders = [...base.rawHeaders, ...(c.extraRawHeaders ?? [])];
      const r: any = verifyV3({
        ...(args(base, new NonceCache()) as any),
        rawHeaders,
        headerRuleMode: c.headerRuleMode,
        requireSignedHeaders: c.requireSignedHeaders,
      });
      expect(r.ok).toBe(c.expect.ok);
      if (!r.ok) expect(r.reason).toBe(c.expect.reason);
    });
  }

  it('requireSigned: invalid or exempt names throw at configuration time', () => {
    for (const list of vectors.requireSignedConfigErrors) {
      expect(() => assertRequireSignedHeaders(list)).toThrow(/requireSignedHeaders/);
    }
  });
});
