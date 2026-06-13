import json
import re
from typing import Literal

from pydantic import BaseModel, Field, ValidationError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import Claim, Paper, Passage
from app.services import llm


ClaimType = Literal["finding", "hypothesis", "limitation", "method", "background"]


class ExtractedClaim(BaseModel):
    source_passage_id: int
    claim_text: str
    claim_type: ClaimType
    verbatim_support_excerpt: str
    section: str
    page: int | None = None
    confidence: float = Field(ge=0, le=1)


class ClaimBatch(BaseModel):
    claims: list[ExtractedClaim]


CLAIM_SCHEMA = ClaimBatch.model_json_schema()


def _fallback_claims(passages: list[Passage]) -> list[ExtractedClaim]:
    claims: list[ExtractedClaim] = []
    patterns = [
        ("limitation", re.compile(r"\b(limitations?|future work|cannot|did not|small sample|threats?)\b", re.I)),
        ("finding", re.compile(r"\b(results?|found|shows?|demonstrates?|improves?|outperforms?|reduces?)\b", re.I)),
        ("hypothesis", re.compile(r"\b(hypothesi[sz]e|we expect|may|might|could)\b", re.I)),
        ("method", re.compile(r"\b(method|approach|model|dataset|experiment|we use|we propose)\b", re.I)),
    ]
    for passage in passages:
        sentences = re.split(r"(?<=[.!?])\s+", passage.text)
        for sentence in sentences[:10]:
            clean = sentence.strip()
            if len(clean) < 60:
                continue
            claim_type: ClaimType = "background"
            for candidate, pattern in patterns:
                if pattern.search(clean):
                    claim_type = candidate  # type: ignore[assignment]
                    break
            claims.append(
                ExtractedClaim(
                    source_passage_id=passage.id,
                    claim_text=clean[:600],
                    claim_type=claim_type,
                    verbatim_support_excerpt=clean[:400],
                    section=passage.section,
                    page=passage.page,
                    confidence=0.55,
                )
            )
            break
    return claims


def _validate_and_store(db: Session, project_id: int, extracted: list[ExtractedClaim]) -> int:
    valid_passages = {
        passage.id: passage
        for passage in db.query(Passage).join(Paper, Paper.id == Passage.paper_id).filter(Paper.project_id == project_id).all()
    }
    db.query(Claim).filter(Claim.paper_id.in_([p.id for p in db.query(Paper).filter(Paper.project_id == project_id).all()])).delete(synchronize_session=False)
    count = 0
    for item in extracted:
        passage = valid_passages.get(item.source_passage_id)
        if not passage or passage.page_unknown:
            continue
        db.add(
            Claim(
                paper_id=passage.paper_id,
                passage_id=passage.id,
                claim_text=item.claim_text,
                claim_type=item.claim_type,
                support_excerpt=item.verbatim_support_excerpt,
                section=item.section or passage.section,
                page=item.page or passage.page,
                confidence=item.confidence,
            )
        )
        count += 1
    db.commit()
    return count


async def _extract_with_llm(payload: list[dict], *, timeout: float = 12.0) -> list[ExtractedClaim]:
    """Ask the unified LLM to extract claims as strict JSON."""
    system = (
        "You extract factual paper claims from supplied passages. "
        "Return strict JSON only matching this schema: "
        f"{json.dumps(CLAIM_SCHEMA)}. "
        "Do not invent passage ids. Each claim must use an existing source_passage_id, "
        "copy a verbatim support excerpt from that same passage, and classify the claim as "
        "finding, hypothesis, limitation, method, or background."
    )
    user = json.dumps(payload)
    try:
        data = await llm.chat_json(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=0.1,
            timeout=timeout,
        )
    except (llm.LLMUnavailable, ValueError):
        return []
    if not isinstance(data, dict):
        return []
    try:
        return ClaimBatch.model_validate(data).claims
    except ValidationError:
        return []


async def extract_claims(db: Session, project_id: int) -> int:
    passages = (
        db.query(Passage)
        .join(Paper, Paper.id == Passage.paper_id)
        .filter(Paper.project_id == project_id, Passage.page_unknown.is_(False))
        .limit(48)
        .all()
    )
    if not llm.is_configured():
        return _validate_and_store(db, project_id, _fallback_claims(passages))

    extracted: list[ExtractedClaim] = []
    batches = [passages[idx : idx + 8] for idx in range(0, len(passages), 8)]
    if not batches:
        return _validate_and_store(db, project_id, [])

    first_batch = batches[0]
    first_payload = [{"id": p.id, "section": p.section, "page": p.page, "text": p.text[:3000]} for p in first_batch]
    try:
        first_result = await _extract_with_llm(first_payload, timeout=8.0)
    except Exception:
        first_result = []
    if not first_result:
        return _validate_and_store(db, project_id, _fallback_claims(passages))
    extracted.extend(first_result)

    for batch in batches[1:]:
        payload = [{"id": p.id, "section": p.section, "page": p.page, "text": p.text[:3000]} for p in batch]
        try:
            batch_result = await _extract_with_llm(payload, timeout=12.0)
            extracted.extend(batch_result or _fallback_claims(batch))
        except Exception:
            extracted.extend(_fallback_claims(batch))
    if not extracted:
        extracted = _fallback_claims(passages)
    return _validate_and_store(db, project_id, extracted)
