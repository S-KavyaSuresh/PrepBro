# PrepBro

PrepBro is an accessibility-first study companion with AI-assisted study tools, account-based progress, mentor workflows, assignments, badges, and PWA install support.

This folder is the GitHub-ready copy of the project:

- live `.env` files are excluded
- local SQLite data is excluded
- build output, virtual environments, caches, and editor folders are excluded

## Stack

- Frontend: React + Vite
- Backend: FastAPI
- Database: SQLite
- Auth: JWT + bcrypt
- Install support: PWA manifest, service worker, install UI, mobile and desktop icons

## Main Features

- Guest mode with local browser progress
- Student and Mentor accounts
- Email verification with SMTP support
- Progress dashboard, badges, assignments, classes, and reports
- Text simplification, planning, gamified learning, and break-time tools

## Environment Setup

Backend:

1. Copy `backend/.env.example` to `backend/.env`
2. Fill in your real values locally

Frontend:

1. Copy `frontend/.env.example` to `frontend/.env`
2. Set `VITE_API_BASE_URL`

Do not commit real `.env` files.

## Run Locally

Backend:

```bash
cd backend
py -m pip install -r requirements.txt
py -m uvicorn app.main:app --reload --port 8000
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

## What Was Removed From This Copy

- `backend/.env`
- `frontend/.env`
- `backend/prepbro.db`
- `backend/venv`
- `frontend/node_modules`
- `frontend/dist`
- `.vscode`
- Python cache folders

## Push Checklist

1. Create fresh local `.env` files from the examples
2. Confirm no real secrets were added to tracked files
3. Run backend and frontend once locally
4. Initialize git in this folder if needed
5. Commit and push

## Deployment Notes

- Set `APP_ENV=production`
- Use a strong `JWT_SECRET`
- Point `FRONTEND_URL` to your deployed frontend
- Put `DATABASE_URL` on durable storage
- Configure SMTP with real production credentials through environment variables
