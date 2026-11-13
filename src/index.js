import { start } from './server.js';

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`Failed to start: ${err.message}`);
  process.exit(1);
});
