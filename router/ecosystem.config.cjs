module.exports = {
  apps: [
    {
      name: 'rayat-mqtt-bridge',
      script: './bridge.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_restarts: 20,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
