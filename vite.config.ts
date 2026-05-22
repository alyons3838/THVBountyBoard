import { defineConfig } from 'vite'

// Vercel zero-config Hono deployment
// Vercel detects the Hono app via the default export in src/index.tsx
// and handles routing + serverless function wrapping automatically
export default defineConfig({})
