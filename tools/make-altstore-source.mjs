/*
 * Generates an AltStore Source (apps.json) for WHOOP Core. No native deps.
 * Download/icon URLs are templated from a public base URL you host the files under.
 *
 *   node tools/make-altstore-source.mjs --base https://host/whoop --ipa dist/WHOOP-Core.ipa \
 *        --out dist/apps.json [--version 0.1.0] [--notes "changelog text"]
 *
 * Produces both the modern `versions[]` array and the legacy top-level version fields,
 * so old and new AltStore / SideStore clients both read it. AltStore polls this file and
 * offers an OTA update whenever `version` is newer than what's installed.
 */
import { readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

function arg(name, def = undefined) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8'));
const cap = JSON.parse(readFileSync(root + 'capacitor.config.json', 'utf8'));

let base = arg('base', process.env.DIST_BASE_URL || 'https://EDIT-ME.example.com/whoop');
base = base.replace(/\/+$/, '');                       // trim trailing slash
const ipaPath = arg('ipa', 'dist/WHOOP-Core.ipa');
const out = arg('out', 'dist/apps.json');
const version = arg('version', pkg.version);
const date = arg('date', new Date().toISOString().slice(0, 10));
const notes = arg('notes', `WHOOP Core ${version}.`);

const size = statSync(ipaPath).size;
const sha256 = createHash('sha256').update(readFileSync(ipaPath)).digest('hex');

const BT = 'WHOOP Core uses Bluetooth to read data directly from your WHOOP 5.0 band.';
const description =
  'Standalone reader for the WHOOP 5.0 band over Bluetooth. Live heart rate, HRV (RMSSD), ' +
  'battery and device info, plus direct access to the band’s custom command service. ' +
  'Independent of the WHOOP app and cloud — reads your own band on your own device.';

const versionEntry = {
  version,
  date,
  localizedDescription: notes,
  downloadURL: `${base}/WHOOP-Core.ipa`,
  size,
  sha256,
  minOSVersion: '14.0',
};

const source = {
  name: cap.appName || 'WHOOP Core',
  identifier: `${cap.appId}.altsource`,
  subtitle: 'Standalone WHOOP 5.0 reader',
  apps: [{
    name: cap.appName || 'WHOOP Core',
    bundleIdentifier: cap.appId,
    developerName: pkg.author || 'Jude',
    subtitle: 'Reads a WHOOP 5.0 directly over Bluetooth',
    localizedDescription: description,
    iconURL: `${base}/icon.png`,
    tintColor: '38e1ff',
    category: 'healthcare',
    screenshotURLs: [],
    versions: [versionEntry],
    // legacy top-level (older AltStore reads these):
    version,
    versionDate: date,
    versionDescription: notes,
    downloadURL: versionEntry.downloadURL,
    size,
    appPermissions: { privacy: { NSBluetoothAlwaysUsageDescription: BT } },
  }],
  news: [],
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(source, null, 2) + '\n');
console.log(`wrote ${out}  (app ${cap.appId} v${version}, ipa ${size} bytes, base ${base})`);
if (base.includes('EDIT-ME')) console.log('  ⚠ no --base/DIST_BASE_URL given — downloadURL/iconURL are placeholders.');
