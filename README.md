# PrepBro

PrepBro is an accessibility-first study companion with student and mentor workflows, assignments, badges, account progress, email verification, and PWA install support.

## Project Structure

- `frontend/` — React + Vite app
- `backend/` — FastAPI API
- `backend/prepbro.db` — local development SQLite database file

## Environment Files

Do not commit real secrets.

Backend:

1. Copy `backend/.env.example` to `backend/.env`
2. Fill in real values locally

Frontend:

1. Copy `frontend/.env.example` to `frontend/.env`
2. Set the API URL for the current environment

## Local Run Commands

Backend:

```bash
cd backend
py -m pip install -r requirements.txt
py -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

## Production Backend Start Command

```bash
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

## Frontend Build Command

```bash
npm run build
```

## Deployment Notes

- Set `APP_ENV=production`
- Set a strong `JWT_SECRET`
- Set `FRONTEND_URL` to the deployed frontend origin
- Set `VITE_API_BASE_URL` to the deployed backend URL
- Use PostgreSQL in production with `DATABASE_URL=postgresql://username:password@host:5432/database`
- Keep SQLite only for local development with `DATABASE_URL=sqlite:///./prepbro.db`
- Do not use local `prepbro.db` in production
- SMTP is optional in development, but required for real email verification in production
- Email verification uses SMTP in normal deployments. On Render Free demo deployments, SMTP may be unavailable, so demo verification fallback can be enabled using `DEMO_VERIFICATION_FALLBACK=true`.
- Production CORS is restricted to `FRONTEND_URL`

## Recommended Platforms

- Frontend: Vercel or Netlify
- Backend: Render or Railway

These fit the current React + FastAPI split without changing app logic.
