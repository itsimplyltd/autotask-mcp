// TEST HELPERS ONLY. Ports of cred-router's signers (MCP-Gateway cred-router/src/s2sV3.js
// s2sHeaderV3, and index.js s2sHeader for legacy v1). Never imported by src/.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { INGRESS_EXEMPT_HEADERS } from '../../src/itsl/s2s-v3';

const sha256hex = (v: Buffer | string): string => createHash('sha256').update(v).digest('hex');

/** Legacy v1: t=<unix>,v1=<hmac of "t=<unix>"> */
export function s2sHeaderV1(secret: string, t: number = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', secret).update(`t=${t}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

export function s2sHeaderV3(
  secret: string,
  o: { aud: string; method: string; path: string; body?: string; headers?: Record<string, string>; t?: number; n?: string },
): string {
  const t = o.t ?? Math.floor(Date.now() / 1000);
  const n = o.n ?? randomBytes(16).toString('hex');
  const entries = Object.entries(o.headers ?? {}).filter(([k]) => !INGRESS_EXEMPT_HEADERS.includes(k.toLowerCase()));
  const names = entries.map(([k]) => k.toLowerCase()).sort();
  const hashes: Record<string, string> = {};
  for (const [k, v] of entries) hashes[k.toLowerCase()] = sha256hex(Buffer.from(v, 'utf8'));
  const sh = names.join(';');
  const lines = [
    'ITSL-S2S-v3', `t=${t}`, `n=${n}`, `aud=${o.aud}`, `m=${o.method.toUpperCase()}`, `p=${o.path}`,
    `b=${sha256hex(Buffer.from(o.body ?? '', 'utf8'))}`, `sh=${sh}`,
  ];
  for (const name of names) lines.push(`${name}:${hashes[name]}`);
  const v3 = createHmac('sha256', secret).update(lines.join('\n'), 'utf8').digest('hex');
  return `t=${t},n=${n},sh=${sh},v3=${v3}`;
}
