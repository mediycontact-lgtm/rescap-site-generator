import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const need = (ok, message) => { if (!ok) throw Error(message); };
export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  // Conservative global unicast only; deny mapped/local/documentation/transition ranges.
  if (isIP(address) !== 6) return false;
  const normalized = new URL('https://[' + address + ']/').hostname.slice(1, -1);
  return /^[23][0-9a-f]{3}:/i.test(normalized) && !/^2001:(?::|0:|db8:|2:|10:|20:)/i.test(normalized) && !/^(?:2002|3fff):/i.test(normalized);
}
export function publicBase(value) {
  need(typeof value === 'string' && !/[\s\\]/.test(value) && !/%(?:2f|5c|2e)/i.test(value), 'explicit safe HTTPS base required');
  const url = new URL(value);
  need(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && (!url.port || url.port === '443'), 'HTTPS base without credentials/query/fragment/custom port required');
  need(!isIP(url.hostname.replace(/^\[|\]$/g, '')) && url.hostname.includes('.') && !/(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(url.hostname), 'public DNS hostname required');
  need(url.pathname.endsWith('/') && !/%(?:2f|5c|2e)/i.test(url.pathname), 'explicit directory base path required');
  return url.href;
}
export function publicFileURL(base, path) {
  need(typeof path === 'string' && path.split('/').every(s => s && s !== '.' && s !== '..') && !/[\\\x00-\x1f\x7f:]/.test(path), 'safe public file path required');
  return new URL(path.split('/').map(encodeURIComponent).join('/'), publicBase(base)).href;
}

// Dependency injection is for transport tests, never CLI input. No credentials or redirects.
export function publicReader({ resolve = lookup, send = request, timeout_ms = 15000, maximum_bytes = 20 * 1024 * 1024 } = {}) {
  return async (urlString, expectedBytes) => {
    const url = new URL(urlString); publicBase(new URL('.', url).href);
    need(!url.username && !url.password && !url.search && !url.hash, 'safe public URL required');
    need(Number.isSafeInteger(expectedBytes) && expectedBytes >= 0 && expectedBytes <= maximum_bytes, 'public file exceeds readback size limit');
    return new Promise((accept, reject) => {
      let req, done = false;
      const finish = (error, bytes) => { if (done) return; done = true; clearTimeout(timer); if (error) { req?.destroy(); reject(Error(error)); } else accept(bytes); };
      const timer = setTimeout(() => finish('public read timed out'), timeout_ms);
      Promise.resolve().then(() => resolve(url.hostname, { all: true, order: 'verbatim' })).then(addresses => {
        if (done) return;
        need(Array.isArray(addresses) && addresses.length > 0 && addresses.every(a => publicAddress(a.address) && isIP(a.address) === a.family), 'public DNS returned non-public address');
        const address = addresses[0];
        const pinnedLookup = (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family);
        req = send(url, { method: 'GET', agent: false, lookup: pinnedLookup, autoSelectFamily: false, headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache', 'User-Agent': 'ResCap-byte-readback/0.3.2' } }, response => {
          if (done) { response.destroy(); return; }
          response.on('error', () => finish('public response failed'));
          response.on('aborted', () => finish('public response aborted'));
          if (response.statusCode !== 200) { finish('public read requires HTTP 200 without redirects'); response.destroy(); return; }
          if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { finish('transformed public response denied'); response.destroy(); return; }
          const length = response.headers['content-length'];
          if (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== expectedBytes)) { finish('public response length differs'); response.destroy(); return; }
          const chunks = []; let total = 0;
          response.on('data', chunk => { total += chunk.length; if (total > expectedBytes || total > maximum_bytes) { finish('public response exceeds expected bytes'); response.destroy(); } else chunks.push(chunk); });
          response.on('end', () => total === expectedBytes ? finish(null, Buffer.concat(chunks)) : finish('public response length differs'));
        });
        req.on('error', () => finish('public request failed')); req.end();
      }).catch(() => finish('public destination lookup/request denied'));
    });
  };
}
