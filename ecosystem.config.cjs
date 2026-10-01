module.exports = {
  apps: [
    {
      name: 'pulim-api',
      cwd: __dirname,
      script: 'dist/server.js',
      instances: 1,
      autorestart: true,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'pulim-worker',
      cwd: __dirname,
      script: 'dist/worker.js',
      instances: 1,
      autorestart: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
