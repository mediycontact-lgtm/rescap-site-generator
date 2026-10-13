import { stable, hash } from './index.mjs';
import { publicBase, publicFileURL } from './public-reader.mjs';

export const HOSTING_FORMAT = 'rescap.static-hosting-profile.v1';
const need = (ok, message) => { if (!ok) throw Error(message); };
const shape = (v, keys) => need(v && typeof v === 'object' && !Array.isArray(v) && stable(Object.keys(v).sort()) === stable([...keys].sort()), 'invalid hosting contract keys');
const filePath = v => need(typeof v === 'string' && !/[\\\x00-\x1f\x7f:]/.test(v) && v.split('/').every(p => p && p !== '.' && p !== '..'), 'safe hosting file path required');
export function validateHostingProfile(profile) {
  shape(profile, ['format', 'provider', 'routes', 'unserved_files']);
  need(profile.format === HOSTING_FORMAT && profile.provider === 'cloudflare-pages-static', 'supported explicit static hosting profile required');
  need(Array.isArray(profile.routes) && profile.routes.length > 0 && profile.routes.length <= 1000 && Array.isArray(profile.unserved_files) && profile.unserved_files.length <= 2, 'bounded explicit hosting routes required');
  const files = new Set(), urls = new Set();
  for (const route of profile.routes) {
    shape(route, ['file', 'path']); filePath(route.file);
    need(typeof route.path === 'string' && route.path.startsWith('/') && !/[\\\x00-\x1f\x7f:]/.test(route.path), 'safe relative hosted path required');
    if (route.path !== '/') filePath(route.path.slice(1).replace(/\/$/, ''));
    const url = hostedURL('https://example.com/', route.path);
    need(!files.has(route.file) && !urls.has(url), 'duplicate hosting file or URL'); files.add(route.file); urls.add(url);
    need(!['_headers', '_redirects'].includes(route.file), 'Cloudflare configuration must be explicitly unserved');
  }
  for (const file of profile.unserved_files) {
    shape(file, ['file', 'reason']);
    need(['_headers', '_redirects'].includes(file.file) && file.reason === 'cloudflare_pages_static_configuration_not_served', 'only named Cloudflare static configuration may be unserved');
    need(!files.has(file.file), 'duplicate unserved file'); files.add(file.file);
  }
  return profile;
}
export function hostedURL(base, path) {
  const root = publicBase(base);
  if (path === '/') return root;
  const trailing = path.endsWith('/'), rel = path.slice(1).replace(/\/$/, '');
  const url = publicFileURL(root, rel); return trailing ? url + '/' : url;
}
export function hostingInventory(profileBytes, files) {
  if (!profileBytes) return { profile_sha256: null, provider: null, served: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, bytes]) => ({ file, path: '/' + file, bytes: bytes.length, sha256: hash(bytes) })), unserved: [] };
  const profile = validateHostingProfile(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(profileBytes)));
  const declared = [...profile.routes.map(r => r.file), ...profile.unserved_files.map(r => r.file)].sort();
  need(stable(declared) === stable([...files.keys()].sort()), 'hosting profile must cover every deployment file exactly');
  need(![...files.keys()].some(p => p === '_worker.js' || p === '_routes.json' || p.startsWith('functions/')), 'Functions/Worker hosting requires a separate profile');
  return { profile_sha256: hash(profileBytes), provider: profile.provider,
    served: profile.routes.map(r => ({ ...r, bytes: files.get(r.file).length, sha256: hash(files.get(r.file)) })).sort((a, b) => a.file < b.file ? -1 : 1),
    unserved: profile.unserved_files.map(r => ({ ...r, bytes: files.get(r.file).length, sha256: hash(files.get(r.file)), remotely_verified: false })).sort((a, b) => a.file < b.file ? -1 : 1) };
}
