import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = new URL('./', import.meta.url);
const output = new URL('./dist/', here);
const release = JSON.parse(
  await readFile(new URL('release.json', here), 'utf8'),
);
const tag = `v${release.version}`;
if (
  release.downloadUrl !==
    `https://github.com/Barbacoa08/scratchtree/releases/download/${tag}/Scratchtree_${release.version}_aarch64.dmg` ||
  release.releaseUrl !==
    `https://github.com/Barbacoa08/scratchtree/releases/tag/${tag}` ||
  !/^macOS [\d.]+ on Apple Silicon Macs$/.test(release.testedOn)
)
  throw new Error(
    'Review the release asset and tested platform before building the landing page.',
  );
let html = await readFile(new URL('index.html', here), 'utf8');
for (const [key, value] of Object.entries(release))
  html = html.replaceAll(`{{${key}}}`, String(value));
if (html.includes('{{')) throw new Error('Unresolved landing-page content.');
await rm(output, { recursive: true, force: true });
await mkdir(new URL('assets/', output), { recursive: true });
await writeFile(new URL('index.html', output), html);
await cp(new URL('site.css', here), new URL('site.css', output));
await cp(
  fileURLToPath(import.meta.resolve('@barbajoe/css-lib')),
  new URL('barbajoe.css', output),
);
// Copy the original PNG payloads; no resampling or new artwork is introduced.
const icns = await readFile(new URL('../src-tauri/icons/icon.icns', here));
if (
  icns.toString('ascii', 0, 4) !== 'icns' ||
  icns.readUInt32BE(4) !== icns.length
)
  throw new Error('Invalid application icon container.');
const slots = new Map([
  ['icp4', 16],
  ['icp5', 32],
  ['ic12', 64],
]);
for (let offset = 8; offset < icns.length;) {
  if (offset + 8 > icns.length) throw new Error('Truncated icon entry.');
  const type = icns.toString('ascii', offset, offset + 4);
  const length = icns.readUInt32BE(offset + 4);
  if (length < 8 || offset + length > icns.length)
    throw new Error('Invalid icon entry.');
  const size = slots.get(type);
  if (size) {
    const png = icns.subarray(offset + 8, offset + length);
    if (
      png.length < 24 ||
      png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      png.readUInt32BE(16) !== size ||
      png.readUInt32BE(20) !== size
    )
      throw new Error(`Expected a ${size}px PNG icon.`);
    await writeFile(new URL(`assets/icon-${size}.png`, output), png);
    slots.delete(type);
  }
  offset += length;
}
if (slots.size) throw new Error('Missing a required application icon size.');
await cp(
  new URL('../docs/media/workspace-overview.png', here),
  new URL('assets/workspace-overview.png', output),
);
console.log(`Built landing page for ${tag} at ${fileURLToPath(output)}`);
