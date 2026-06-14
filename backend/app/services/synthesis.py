from collections import defaultdict
import json
import re

from sqlalchemy.orm import Session

from app.models import Brief, Claim, Paper, Passage, Project, SynthesisGroup
from app.services import llm


def _citation_key(claim: Claim) -> str:
    return f"C{claim.id}"


def _clean_text(text: str) -> str:
    text = re.sub(r"\s+", " ", text.replace("\n", " ")).strip()
    text = re.sub(r"^\d+\s*", "", text)
    return text


def _status(claims: list[Claim]) -> str:
    papers = {claim.paper_id for claim in claims}
    if len(papers) < 2:
        return "thin_evidence"
    texts = " ".join(claim.claim_text.lower() for claim in claims)
    if any(word in texts for word in ["contradict", "opposite", "decrease", "worse", "failed"]):
        return "conflict"
    return "agreement"


def validate_brief(brief: Brief) -> list[str]:
    errors: list[str] = []
    citation_ids = set(brief.citation_map.keys())
    for section in brief.sections:
        for claim in section.get("claims", []):
            refs = set(claim.get("citations", []))
            if not refs:
                errors.append(f"Claim lacks citation: {claim.get('text', '')[:80]}")
            missing = refs - citation_ids
            if missing:
                errors.append(f"Claim references missing citations: {sorted(missing)}")
    return errors


def _knowledge_graph(claims: list[Claim], papers_by_id: dict[int, Paper]) -> dict:
    claim_types = sorted({claim.claim_type for claim in claims})
    paper_ids = sorted({claim.paper_id for claim in claims})
    nodes: list[dict] = []
    edges: list[dict] = []

    for index, theme in enumerate(claim_types):
        nodes.append(
            {
                "id": f"theme:{theme}",
                "label": theme.title(),
                "kind": "theme",
                "x": 0.26,
                "y": 0.16 + (index * (0.68 / max(len(claim_types) - 1, 1))),
            }
        )

    for index, paper_id in enumerate(paper_ids):
        paper = papers_by_id.get(paper_id)
        nodes.append(
            {
                "id": f"paper:{paper_id}",
                "label": (paper.title if paper else "Unknown paper")[:48],
                "kind": "paper",
                "x": 0.76,
                "y": 0.16 + (index * (0.68 / max(len(paper_ids) - 1, 1))),
            }
        )

    counts: dict[tuple[str, int], int] = defaultdict(int)
    for claim in claims:
        counts[(claim.claim_type, claim.paper_id)] += 1
    for (theme, paper_id), weight in counts.items():
        edges.append(
            {
                "source": f"theme:{theme}",
                "target": f"paper:{paper_id}",
                "weight": weight,
            }
        )

    return {"nodes": nodes, "edges": edges}


def _valid_llm_sections(sections: object) -> bool:
    if not isinstance(sections, list) or not sections:
        return False
    for section in sections:
        if not isinstance(section, dict):
            return False
        if not isinstance(section.get("theme"), str) or not section.get("theme", "").strip():
            return False
        if not isinstance(section.get("claims"), list):
            return False
        for claim in section.get("claims", []):
            if not isinstance(claim, dict):
                return False
            if not isinstance(claim.get("text"), str) or not claim.get("text", "").strip():
                return False
            if not isinstance(claim.get("citations"), list):
                return False
    return True


def _flatten_summary(value: object) -> str:
    """The LLM occasionally returns `summary` as a list of bullet objects
    (`[{text, citations}, ...]`) instead of a single string. Flatten
    whatever shape comes back into a markdown string we can safely
    render."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        parts: list[str] = []
        for entry in value:
            if isinstance(entry, str):
                if entry.strip():
                    parts.append(entry.strip())
                continue
            if not isinstance(entry, dict):
                continue
            text = entry.get("text")
            if not isinstance(text, str) or not text.strip():
                continue
            citations = entry.get("citations")
            tail = ""
            if isinstance(citations, list):
                refs = [c for c in citations if isinstance(c, str)]
                if refs:
                    tail = " " + " ".join(f"[{c}]" for c in refs)
            parts.append(f"- {text.strip()}{tail}")
        return "\n\n".join(parts)
    if isinstance(value, dict):
        text = value.get("text")
        if isinstance(text, str):
            return text.strip()
    return str(value)


def _normalize_sections(sections: object) -> None:
    """Coerce any non-string `summary` on each section to a string in place."""
    if not isinstance(sections, list):
        return
    for section in sections:
        if isinstance(section, dict) and "summary" in section:
            section["summary"] = _flatten_summary(section.get("summary"))


async def _llm_synthesize(question: str, sections_input: list[dict], citation_map: dict[str, dict]) -> dict | None:
    if not llm.is_configured():
        return None
    system = (
        "You are synthesizing a research brief from cited claims only. Return strict JSON only. "
        "Every factual sentence must carry existing citation ids. Be specific, professional, and concise."
    )
    user = (
        f"Research question: {question}\n\n"
        f"Sections input: {json.dumps(sections_input)}\n\n"
        f"Citation map: {json.dumps(citation_map)}\n\n"
        "Return JSON with keys executive_summary, sections, open_questions, recommended_papers. "
        "Each section needs theme, consensus_status, summary, claims. "
        "Each claim needs text, type, citations. "
        "open_questions must be a list of objects, each with {theme, question, citations}. "
        "recommended_papers must be a list of objects, each with {title, why_relevant, citations}. "
        "Both lists may be empty if no strong follow-ups exist."
    )
    try:
        return await llm.chat_json(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=0.2,
            timeout=12.0,
        )
    except (llm.LLMUnavailable, ValueError):
        return None


async def synthesize_project(db: Session, project_id: int) -> Brief:
    claims = (
        db.query(Claim)
        .join(Paper, Paper.id == Claim.paper_id)
        .filter(Paper.project_id == project_id)
        .order_by(Claim.claim_type, Claim.id)
        .all()
    )
    papers_by_id = {paper.id: paper for paper in db.query(Paper).filter(Paper.project_id == project_id).all()}
    grouped: dict[str, list[Claim]] = defaultdict(list)
    for claim in claims:
        grouped[claim.claim_type].append(claim)

    db.query(SynthesisGroup).filter(SynthesisGroup.project_id == project_id).delete()
    sections: list[dict] = []
    citation_map: dict[str, dict] = {}
    synthesis_input: list[dict] = []
    for theme, theme_claims in grouped.items():
        status = _status(theme_claims)
        group = SynthesisGroup(
            project_id=project_id,
            theme=theme.title(),
            consensus_status=status,
            claim_ids=[claim.id for claim in theme_claims],
            rationale=f"{len(theme_claims)} cited claims across {len({claim.paper_id for claim in theme_claims})} papers.",
        )
        db.add(group)
        section_claims: list[dict] = []
        for claim in theme_claims[:8]:
            key = _citation_key(claim)
            paper = papers_by_id.get(claim.paper_id)
            passage = db.get(Passage, claim.passage_id)
            citation_map[key] = {
                "paper_id": claim.paper_id,
                "paper_title": paper.title if paper else "Unknown paper",
                "passage_id": claim.passage_id,
                "section": claim.section,
                "page": claim.page,
                "support_excerpt": _clean_text(claim.support_excerpt),
                "passage_text": _clean_text(passage.text if passage else ""),
            }
            section_claims.append(
                {
                    "text": _clean_text(claim.claim_text),
                    "type": claim.claim_type,
                    "citations": [key],
                    "paper_title": paper.title if paper else "Unknown paper",
                    "section": claim.section,
                    "page": claim.page,
                    "support_excerpt": _clean_text(claim.support_excerpt),
                    "confidence": round(claim.confidence, 2),
                }
            )
        section_summary = (
            f"{theme.title()} evidence spans {len(theme_claims)} cited claims across "
            f"{len({claim.paper_id for claim in theme_claims})} papers and currently reads as {status.replace('_', ' ')}."
        )
        sections.append({"theme": theme.title(), "consensus_status": status, "summary": section_summary, "claims": section_claims})
        synthesis_input.append({"theme": theme.title(), "consensus_status": status, "claims": section_claims})

    executive = (
        f"This brief synthesizes {len(claims)} traceable claims across "
        f"{len({claim.paper_id for claim in claims})} papers. All factual statements below point to stored source passages."
    )
    project = db.get(Project, project_id)
    llm_brief = None
    try:
        project_question = project.question if project else ""
        llm_brief = await _llm_synthesize(project_question, synthesis_input, citation_map)
    except Exception:
        llm_brief = None

    if llm_brief:
        llm_executive = llm_brief.get("executive_summary")
        llm_sections = llm_brief.get("sections")
        if isinstance(llm_executive, str) and len(llm_executive.strip()) > 40:
            executive = llm_executive.strip()
        if _valid_llm_sections(llm_sections):
            sections = llm_sections
            _normalize_sections(sections)
        for section in sections:
            for claim in section.get("claims", []):
                refs = claim.get("citations", [])
                if not refs:
                    continue
                source = citation_map.get(refs[0], {})
                claim.setdefault("paper_title", source.get("paper_title"))
                claim.setdefault("section", source.get("section"))
                claim.setdefault("page", source.get("page"))
                claim.setdefault("support_excerpt", source.get("support_excerpt"))

    brief = Brief(
        project_id=project_id,
        executive_summary=executive,
        sections=sections,
        citation_map=citation_map,
        validation_errors=[],
    )
    brief.citation_map["__meta"] = {
        "open_questions": llm_brief.get("open_questions", []) if llm_brief else [],
        "recommended_papers": llm_brief.get("recommended_papers", []) if llm_brief else [],
        "knowledge_graph": _knowledge_graph(claims, papers_by_id),
    }
    brief.validation_errors = validate_brief(brief)
    db.add(brief)
    db.commit()
    db.refresh(brief)
    return brief
