import json
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse, Response, StreamingResponse
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import get_db
from app.models import Brief, Document, Paper, Project
from app.schemas.api import BriefResponse, ChatRequest, ChatResponse, DiscoveryRequest, ImportPapersRequest, ImportPapersResponse, ProjectRunResponse
from app.services.chat import generate_chat_reply, stream_chat_reply
from app.services.claims import extract_claims
from app.services.discovery import discover
from app.services.export import export_bibtex, export_csl_json, export_docx, export_markdown, export_ris
from app.services.ingestion import ingest_project
from app.services.synthesis import synthesize_project


router = APIRouter(prefix="/api")


@router.post("/discovery/search")
async def discovery_search(req: DiscoveryRequest):
    return await discover(req)


@router.post("/papers/import", response_model=ImportPapersResponse)
def import_papers(req: ImportPapersRequest, db: Session = Depends(get_db)):
    project = Project(name=req.project_name, question=req.question)
    db.add(project)
    db.flush()
    ids: list[int] = []
    for item in req.papers:
        paper = Paper(project_id=project.id, **item.model_dump(exclude={"relevance_score"}))
        db.add(paper)
        db.flush()
        ids.append(paper.id)
    db.commit()
    return ImportPapersResponse(project_id=project.id, paper_ids=ids)


@router.post("/documents/upload")
async def upload_document(project_id: int, file: UploadFile = File(...), paper_id: int | None = None, db: Session = Depends(get_db)):
    settings = get_settings()
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if paper_id:
        paper = db.get(Paper, paper_id)
    else:
        paper = Paper(project_id=project.id, title=Path(file.filename or "Uploaded PDF").stem, authors=[], source_provider="upload")
        db.add(paper)
        db.flush()
    if not paper or paper.project_id != project.id:
        raise HTTPException(status_code=404, detail="Paper not found in project")
    safe_name = f"project-{project.id}-paper-{paper.id}-{Path(file.filename or 'paper.pdf').name}"
    storage_path = settings.upload_dir / safe_name
    with storage_path.open("wb") as fh:
        fh.write(await file.read())
    document = Document(paper_id=paper.id, filename=file.filename or safe_name, storage_path=str(storage_path))
    db.add(document)
    db.commit()
    return {"document_id": document.id, "paper_id": paper.id, "status": document.status}


@router.post("/projects/{project_id}/ingest", response_model=ProjectRunResponse)
async def run_ingest(project_id: int, db: Session = Depends(get_db)):
    result = await ingest_project(db, project_id)
    return ProjectRunResponse(project_id=project_id, status="parsed", detail=f"Parsed {result['documents']} documents into {result['passages']} passages.")


@router.post("/projects/{project_id}/claims/extract", response_model=ProjectRunResponse)
async def run_claims(project_id: int, db: Session = Depends(get_db)):
    count = await extract_claims(db, project_id)
    return ProjectRunResponse(project_id=project_id, status="claims_extracted", detail=f"Stored {count} traceable claims.")


@router.post("/projects/{project_id}/synthesize", response_model=BriefResponse)
async def run_synthesis(project_id: int, db: Session = Depends(get_db)):
    brief = await synthesize_project(db, project_id)
    return BriefResponse.model_validate(brief, from_attributes=True)


@router.post("/projects/{project_id}/chat", response_model=ChatResponse)
async def project_chat(project_id: int, req: ChatRequest, db: Session = Depends(get_db)):
    reply = await generate_chat_reply(db, project_id, req.messages)
    return ChatResponse(reply=reply)


@router.post("/projects/{project_id}/chat/stream")
async def project_chat_stream(project_id: int, req: ChatRequest, db: Session = Depends(get_db)):
    """Stream a chat reply as Server-Sent Events.

    Each event has a ``data: <json>\\n\\n`` frame. The JSON body is
    ``{"delta": "<text>"}`` for incremental tokens, ``{"error": "<msg>"}``
    for failures, and the sentinel ``data: [DONE]`` to close the stream.
    """
    async def event_source():
        try:
            async for delta in stream_chat_reply(db, project_id, req.messages, req.attachments):
                payload = json.dumps({"delta": delta})
                yield f"data: {payload}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as exc:  # noqa: BLE001
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(event_source(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/extract")
async def extract_text(file: UploadFile = File(...)):
    """Extract plain text from a PDF or text file.

    Used by the chat composer's Paperclip affordance so that users can
    attach supplementary material (a paper PDF, a notes file) to a chat
    message. PDF extraction uses ``pypdf`` when available and a simple
    binary stream reader as a fallback. The response is ``{"text": "..."}``
    truncated to ~50k characters to keep the prompt bounded.
    """
    name = (file.filename or "").lower()
    raw = await file.read()
    text = ""
    if name.endswith(".pdf") or (file.content_type or "").endswith("pdf"):
        try:
            from pypdf import PdfReader  # type: ignore
            from io import BytesIO

            reader = PdfReader(BytesIO(raw))
            pages: list[str] = []
            for page in reader.pages:
                try:
                    pages.append(page.extract_text() or "")
                except Exception:  # noqa: BLE001
                    pages.append("")
            text = "\n".join(pages)
        except Exception:  # noqa: BLE001
            # Fallback: try naive decode of any embedded latin-1 text.
            text = raw.decode("latin-1", errors="ignore")
    else:
        # Treat anything else as text-ish and decode.
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("latin-1", errors="ignore")
    text = text.strip()
    if len(text) > 50_000:
        text = text[:50_000]
    return {"text": text, "filename": file.filename, "chars": len(text)}


@router.get("/briefs/{brief_id}", response_model=BriefResponse)
def get_brief(brief_id: int, db: Session = Depends(get_db)):
    brief = db.get(Brief, brief_id)
    if not brief:
        raise HTTPException(status_code=404, detail="Brief not found")
    return BriefResponse.model_validate(brief, from_attributes=True)


@router.get("/briefs/{brief_id}/export")
def export_brief(brief_id: int, format: str = "markdown", db: Session = Depends(get_db)):
    brief = db.get(Brief, brief_id)
    if not brief:
        raise HTTPException(status_code=404, detail="Brief not found")
    if brief.validation_errors:
        raise HTTPException(status_code=409, detail={"message": "Brief has citation validation errors", "errors": brief.validation_errors})
    if format == "markdown":
        return PlainTextResponse(export_markdown(brief), media_type="text/markdown")
    if format == "bibtex":
        return PlainTextResponse(export_bibtex(db, brief), media_type="application/x-bibtex")
    if format == "ris":
        return PlainTextResponse(export_ris(db, brief), media_type="application/x-research-info-systems")
    if format == "csl-json":
        return Response(export_csl_json(db, brief), media_type="application/json")
    if format == "docx":
        return StreamingResponse(
            export_docx(brief),
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers={"Content-Disposition": f'attachment; filename="research-brief-{brief.id}.docx"'},
        )
    raise HTTPException(status_code=400, detail="Unsupported export format")
