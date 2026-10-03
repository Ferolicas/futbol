const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
module.exports = {
  apps: [{
    name: 'cfanalisis-web',
    script: '.next/standalone/server.js',
    cwd: '/apps/futbol',
    uid: 'cfanalisis',
    gid: 'cfanalisis',
    env: { ...process.env, PORT: 3000, HOSTNAME: '127.0.0.1' },
    max_memory_restart: '1G',
  }],
};
