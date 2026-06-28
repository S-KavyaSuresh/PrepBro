# PrepBro Deployment Guide

## Recommended Setup

- Frontend: Vercel or Netlify
- Backend: Render or Railway

## Backend

Root:

```bash
backend
```

Install command:

```bash
pip install -r requirements.txt
```

Start command:

```bash
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

Required environment variables:

- `DATABASE_URL`
- `DEMO_VERIFICATION_FALLBACK`
- `JWT_SECRET`
- `JWT_EXPIRE_MINUTES`
- `FRONTEND_URL`
- `BACKEND_URL`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASSWORD`
- `SMTP_FROM`
- `SMTP_TLS`

Database notes:

- Production: `DATABASE_URL=postgresql://username:password@host:5432/database`
- Local development: `DATABASE_URL=sqlite:///./prepbro.db`
- Do not deploy with local SQLite in production

Email verification note:

- Normal deployments should use SMTP for email verification.
- On Render Free demo deployments, outbound SMTP may be blocked.
- For demo access, set `DEMO_VERIFICATION_FALLBACK=true`.

## Frontend

Build command:

```bash
npm run build
```

Output directory:

```bash
dist
```

Required environment variables:

- `VITE_API_BASE_URL`
- `VITE_APP_NAME=PrepBro`

## After Deploy

1. Deploy backend first
2. Copy backend public URL
3. Set frontend `VITE_API_BASE_URL` to that backend URL
4. Deploy frontend
5. Update backend `FRONTEND_URL` to the deployed frontend URL
6. Redeploy backend if needed

## GitHub Push

```bash
git status
git add .
git commit -m "Prepare PrepBro for deployment"
git branch -M main
git remote add origin <repo-url>
git push -u origin main
```
