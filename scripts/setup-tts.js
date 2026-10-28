// Telecharge ffmpeg dans tts/bin/<plateforme>/ (necessaire uniquement pour convertir les
// enregistrements des comediens et decouper les lectures a table). Les voix de synthese
// (Piper) n'ont plus besoin d'aucun programme externe : elles tournent dans Node et
// telechargent leurs modeles toutes seules (voir piper-node.js).
// Usage : node scripts/setup-tts.js [win32|linux]
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', 'tts');
const FFMPEG_ASSETS = {
  win32: { archive: 'ffmpeg-n9.0-latest-win64-lgpl-9.0.zip', innerPath: 'ffmpeg-n9.0-latest-win64-lgpl-9.0/bin/ffmpeg.exe', dest: 'bin/windows/ffmpeg.exe' },
  linux: { archive: 'ffmpeg-n9.0-latest-linux64-lgpl-9.0.tar.xz', innerPath: 'ffmpeg-n9.0-latest-linux64-lgpl-9.0/bin/ffmpeg', dest: 'bin/linux-tools/ffmpeg' },
};
function download(url, destPath, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(res.headers.location, destPath, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} pour ${url}`)); }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    }).on('error', reject);
  });
}

async function setupFfmpeg(platform) {
  const asset = FFMPEG_ASSETS[platform];
  if (!asset) { console.log('ffmpeg : pas de build prevu pour', platform, '(macOS : installe-le toi-meme, ex. `brew install ffmpeg`, et place le binaire dans tts/bin/macos/ffmpeg)'); return; }
  const destPath = path.join(ROOT, asset.dest);
  if (fs.existsSync(destPath)) { console.log('ffmpeg deja present pour', platform); return; }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const archivePath = path.join(ROOT, 'bin', asset.archive);
  const url = `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${asset.archive}`;
  console.log('Telechargement de', url);
  await download(url, archivePath);
  if (platform === 'win32') {
    const tmpDir = path.join(ROOT, 'bin', '_ffmpeg_tmp');
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path "${archivePath}" -DestinationPath "${tmpDir}" -Force`]);
    fs.copyFileSync(path.join(tmpDir, asset.innerPath), destPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } else {
    execFileSync('tar', ['-xJf', archivePath, '-C', path.dirname(destPath), asset.innerPath, '--strip-components=2']);
    fs.chmodSync(destPath, 0o755);
  }
  fs.unlinkSync(archivePath);
  console.log('ffmpeg installe dans', destPath);
}

async function main() {
  const platform = process.argv[2] || process.platform;
  await setupFfmpeg(platform);
  console.log('Installation terminee.');
}

main().catch((err) => { console.error(err); process.exit(1); });
