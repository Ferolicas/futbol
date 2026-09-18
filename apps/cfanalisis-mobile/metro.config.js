// Metro aislado del repositorio web: prioriza el node_modules de esta app y
// bloquea el react/react-native del Next.js de la raíz (versiones distintas)
// para que nunca se dupliquen en el bundle.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '..', '..');
const config = getDefaultConfig(projectRoot);

config.watchFolders = [projectRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];
config.resolver.blockList = [
  new RegExp(`^${repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/node_modules/(react|react-dom|react-native|scheduler)/.*`),
];

module.exports = config;
