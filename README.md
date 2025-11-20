# WayChat Backend (Render-ready)

Minimal WebSocket backend for encrypted chat. It stores ciphertext-only messages into Supabase and broadcasts to connected clients.

## Requirements
- Node 18+
- Supabase project with `messages` table and RLS set as instructed previously
- Supabase **service_role** key (server-only)

## Environment
Copy `.env.example` -> `.env` and set:
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- PORT (optional)

## Run locally
```bash
npm install
node index.js
# health: http://localhost:3000/health