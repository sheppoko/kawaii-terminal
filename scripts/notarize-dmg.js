const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');

const env = process.env;

const requireEnv = (name) => {
  if (!env[name]) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return env[name];
};

const run = (cmd, args, options = {}) => {
  console.log(`> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', ...options });
};

const findDmgsFromArtifacts = (artifactPaths) => {
  if (Array.isArray(artifactPaths)) {
    return artifactPaths.filter((p) => typeof p === 'string' && p.toLowerCase().endsWith('.dmg'));
  }
  return [];
};

const findDmgsFromDist = () => {
  if (!fs.existsSync(DIST_DIR)) return [];
  return fs.readdirSync(DIST_DIR)
    .filter((name) => name.toLowerCase().endsWith('.dmg'))
    .map((name) => path.join(DIST_DIR, name));
};

const resolveIdentity = () => {
  if (env.DMG_SIGN_IDENTITY) return env.DMG_SIGN_IDENTITY;
  if (env.CSC_NAME) return env.CSC_NAME;

  try {
    const output = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
    const matches = [];
    output.split('\n').forEach((line) => {
      const match = line.match(/"Developer ID Application: .+?"/);
      if (match) matches.push(match[0].slice(1, -1));
    });
    const unique = [...new Set(matches)];
    if (unique.length === 1) return unique[0];
    if (unique.length > 1) {
      throw new Error('Multiple Developer ID Application identities found. Set DMG_SIGN_IDENTITY or CSC_NAME.');
    }
  } catch (err) {
    throw new Error(`Failed to resolve signing identity: ${err.message}`);
  }
  throw new Error('No Developer ID Application identity found. Set DMG_SIGN_IDENTITY or CSC_NAME.');
};

const notarizeDmg = (dmgPath, identity) => {
  console.log(`\n== DMG notarize: ${dmgPath} ==`);
  if (!fs.existsSync(dmgPath)) {
    throw new Error(`DMG not found: ${dmgPath}`);
  }

  run('codesign', ['--sign', identity, '--timestamp', dmgPath]);

  const apiKey = requireEnv('APPLE_API_KEY');
  const keyId = requireEnv('APPLE_API_KEY_ID');
  const issuer = requireEnv('APPLE_API_ISSUER');

  run('xcrun', ['notarytool', 'submit', dmgPath, '--key', apiKey, '--key-id', keyId, '--issuer', issuer, '--wait']);
  run('xcrun', ['stapler', 'staple', dmgPath]);
  run('xcrun', ['stapler', 'validate', dmgPath]);
  run('spctl', ['-a', '-vv', '--type', 'install', dmgPath]);
};

module.exports = async (context = {}) => {
  if (process.platform !== 'darwin') {
    console.log('Notarize DMG: skipped (non-macOS)');
    return;
  }

  const dmgs = findDmgsFromArtifacts(context.artifactPaths);
  const targets = dmgs.length ? dmgs : findDmgsFromDist();
  if (!targets.length) {
    console.log('Notarize DMG: no dmg artifacts found');
    return;
  }

  const identity = resolveIdentity();
  targets.forEach((dmgPath) => notarizeDmg(dmgPath, identity));
};
