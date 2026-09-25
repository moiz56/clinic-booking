import { app } from './app.js';
import { config } from './config.js';

// Local development server. On Vercel, api/index.js serves the same app.
app.listen(config.port, () => {
  console.log(`🚀 API listening on http://localhost:${config.port}`);
});
