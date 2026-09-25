// Vercel serverless function: every /api/* request is rewritten here (see vercel.json).
// Imports the compiled server, which `npm run build` produces before functions are bundled.
import { app } from '../server/dist/app.js';

export default app;
