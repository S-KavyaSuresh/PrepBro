# Capacitor Android Wrapper

This folder prepares PrepBro for a future Android app build using Capacitor.

## What this folder does

- keeps the Android wrapper separate from the React frontend
- points Capacitor to the built frontend output in `../frontend/dist`
- lets you add the Android project when you are ready

## First-time setup

From this `capacitor` folder:

```bash
npm install
```

Then build the frontend:

```bash
cd ../frontend
npm install
npm run build
cd ../capacitor
```

Add Android once:

```bash
npx cap add android
```

Sync web assets after each frontend build:

```bash
npm run sync
```

Open Android Studio:

```bash
npm run open:android
```

## Notes

- The Android project is not committed yet in this placeholder setup.
- After `npx cap add android`, Capacitor will create the real `android` folder here.
- The app name and app id are already set for PrepBro in `capacitor.config.json`.
