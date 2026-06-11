# AI Research Synthesis Engine

Full-stack MVP for paper discovery, PDF ingestion, claim extraction, cross-source synthesis, and citation-traceable brief generation.

## Quick Start

```powershell
docker compose up
```

Open `http://localhost:5173`. The backend runs at `http://localhost:8000`.

Optional environment variables:

```powershell
$env:GEMINI_API_KEY="..."
$env:SEMANTIC_SCHOLAR_API_KEY="..."
```

Without `GEMINI_API_KEY`, claim extraction uses a deterministic local fallback so the app remains testable.

## Local Backend

```powershell
cd backend
python -m venv .venv
.\\.venv\\Scripts\\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload
```

## Local Frontend

```powershell
cd frontend
npm install
npm run dev
```

## Citation Guard

Briefs are generated only from stored claims. Claims are accepted only when they reference an existing passage with a known page. Export is blocked if any brief claim lacks a citation or points to a missing source passage.
