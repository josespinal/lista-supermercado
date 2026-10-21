// pm2 settings for the server (used by the Ploi deploy script).
module.exports = {
  apps: [
    {
      name: "lista-super",
      script: "src/server.js",
      node_args: "--env-file-if-exists=.env",
      cwd: __dirname,
      max_memory_restart: "300M",
    },
  ],
};
