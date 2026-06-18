# VPS Auto Deploy

This repository includes a GitHub Actions workflow at `.github/workflows/deploy-vps.yml`.

## Required GitHub Secrets

Add these repository secrets before using the workflow:

- `BACKEND_ENV_FILE`
  Paste the full contents of `.github/deploy/backend.env.example`, replacing placeholder values with the real ones.
- `VPS_HOST`
  Example: `151.243.146.217`
- `VPS_USERNAME`
  Example: `root`
- `VPS_PASSWORD`
  Your VPS SSH password.
- `VPS_PATH`
  Example: `/root/genai`

## What the workflow does

On every push to `main` and on manual runs:

1. Checks out the repo.
2. Recreates `backend/.env` from `BACKEND_ENV_FILE`.
3. Syncs the repository to the VPS with `rsync`.
4. Runs `docker compose up -d --force-recreate` in the VPS project directory.
5. Verifies that the frontend is reachable on the VPS.
