import re
from pathlib import Path
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup
from pypdf import PdfReader
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import Document, Paper, Passage


SECTION_HINTS = {
    "abstract": "Abstract",
    "introduction": "Introduction",
    "method": "Methodology",
    "experiment": "Methodology",
    "result": "Findings",
    "finding": "Findings",
    "discussion": "Discussion",
    "limitation": "Limitations",
    "conclusion": "Conclusion",
}


def _guess_section(text: str) -> str:
    lowered = text[:180].lower()
    for key, label in SECTION_HINTS.items():
        if key in lowered:
            return label
    return "Body"


def _chunk_text(text: str, size: int = 1200) -> list[tuple[int, int, str]]:
    clean = re.sub(r"\n{3,}", "\n\n", text).strip()
    chunks: list[tuple[int, int, str]] = []
    start = 0
    while start < len(clean):
        end = min(start + size, len(clean))
        if end < len(clean):
            boundary = clean.rfind("\n\n", start, end)
            if boundary > start + 300:
                end = boundary
        chunk = clean[start:end].strip()
        if len(chunk) > 80:
            chunks.append((start, end, chunk))
        start = end + 1
    return chunks


async def _download_missing_project_pdfs(db: Session, project_id: int) -> None:
    settings = get_settings()
    papers = db.query(Paper).filter(Paper.project_id == project_id, Paper.pdf_url.isnot(None)).all()
    for paper in papers:
        has_document = db.query(Document).filter(Document.paper_id == paper.id).first()
        if has_document:
            continue
        try:
            async with httpx.AsyncClient(timeout=45, follow_redirects=True) as client:
                response = await client.get(paper.pdf_url)
            response.raise_for_status()
            if "pdf" not in response.headers.get("content-type", "").lower() and not response.content.startswith(b"%PDF"):
                continue
        except Exception:
            continue
        parsed_name = Path(urlparse(paper.pdf_url).path).name or f"paper-{paper.id}.pdf"
        if not parsed_name.lower().endswith(".pdf"):
            parsed_name = f"{parsed_name}.pdf"
        safe_name = f"project-{project_id}-paper-{paper.id}-{parsed_name}"
        storage_path = settings.upload_dir / safe_name
        storage_path.write_bytes(response.content)
        db.add(Document(paper_id=paper.id, filename=parsed_name, storage_path=str(storage_path), status="downloaded"))
    db.commit()


async def _try_grobid(path: Path) -> str | None:
    settings = get_settings()
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            with path.open("rb") as fh:
                files = {"input": (path.name, fh, "application/pdf")}
                response = await client.post(f"{settings.grobid_url}/api/processFulltextDocument", files=files)
        if response.status_code == 200 and response.text.strip().startswith("<"):
            return response.text
    except Exception:
        return None
    return None


def _text_from_tei(tei: str) -> tuple[str, list[dict]]:
    soup = BeautifulSoup(tei, "xml")
    spans: list[dict] = []
    parts: list[str] = []
    cursor = 0
    for div in soup.find_all("div"):
        head = div.find("head")
        section = head.get_text(" ", strip=True) if head else "Body"
        body_text = " ".join(p.get_text(" ", strip=True) for p in div.find_all("p"))
        if body_text:
            start = cursor
            parts.append(f"{section}\n{body_text}")
            cursor += len(parts[-1]) + 2
            spans.append({"section": section, "char_start": start, "char_end": cursor})
    text = "\n\n".join(parts)
    return text, spans


def _text_from_pdf(path: Path) -> tuple[str, list[dict]]:
    reader = PdfReader(str(path))
    parts: list[str] = []
    page_map: list[dict] = []
    cursor = 0
    for idx, page in enumerate(reader.pages, start=1):
        page_text = page.extract_text() or ""
        start = cursor
        parts.append(page_text)
        cursor += len(page_text) + 2
        page_map.append({"page": idx, "char_start": start, "char_end": cursor})
    return "\n\n".join(parts), page_map


async def ingest_project(db: Session, project_id: int) -> dict:
    await _download_missing_project_pdfs(db, project_id)
    documents = (
        db.query(Document)
        .join(Paper, Paper.id == Document.paper_id)
        .filter(Paper.project_id == project_id)
        .all()
    )
    passages_created = 0
    for document in documents:
        path = Path(document.storage_path)
        tei = await _try_grobid(path)
        if tei:
            text, section_spans = _text_from_tei(tei)
            page_map: list[dict] = []
        else:
            text, page_map = _text_from_pdf(path)
            section_spans = []
        document.parsed_tei = tei
        document.parsed_text = text
        document.section_spans = section_spans
        document.page_map = page_map
        document.status = "parsed"
        db.query(Passage).filter(Passage.document_id == document.id).delete()
        for start, end, chunk in _chunk_text(text):
            page = next((entry["page"] for entry in page_map if entry["char_start"] <= start <= entry["char_end"]), None)
            passage = Passage(
                paper_id=document.paper_id,
                document_id=document.id,
                section=_guess_section(chunk),
                page=page,
                page_unknown=page is None,
                text=chunk,
                char_start=start,
                char_end=end,
            )
            db.add(passage)
            passages_created += 1
    db.commit()
    return {"documents": len(documents), "passages": passages_created}
