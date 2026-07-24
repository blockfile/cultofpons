'use strict';

// PM2 process file. IMPORTANT: exactly ONE instance in fork mode — the claim
// scheduler runs inside the server process, and a second instance would race it
// (double claims / double burns / double airdrops / wallet-nonce contention).
//
//   pm2 start ecosystem.config.js
//   pm2 logs cultofpons-api
//   pm2 restart cultofpons-api
module.exports = {
  apps: [
    {
      name: 'cultofpons-api',
      script: 'server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '400M',
      time: true, // timestamps in pm2 logs
      env: { NODE_ENV: 'production' },
    },
  ],
};
