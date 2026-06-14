import pytest
import httpx

from app.models import Brief, Claim, Paper, Passage, Project
from app.services.claims import extract_claims
from app.services.discovery import _score
from app.services.export import export_bibtex, export_csl_json, export_ris
from app.services.synthesis import validate_brief
from app.schemas.api import DiscoveryPaper


def test_discovery_score_rewards_pdf_and_query_match():
    paper = DiscoveryPaper(title="Retrieval augmented generation for citations", abstract="Citations improve grounded synthesis.", source_provider="test", pdf_url="x")
    assert _score("citation grounded synthesis", paper) > 0.4


def test_brief_validation_rejects_unsourced_claim():
    brief = Brief(project_id=1, executive_summary="x", sections=[{"theme": "Findings", "claims": [{"text": "Unsourced", "citations": []}]}], citation_map={})
    assert validate_brief(brief)


def test_exports(db_session):
    project = Project(name="T", question="Q")
    db_session.add(project)
    db_session.flush()
    paper = Paper(project_id=project.id, title="A Study", authors=[{"name": "Ada Lovelace"}], year=2024, doi="10.1/test", venue="Journal")
    db_session.add(paper)
    db_session.flush()
    passage = Passage(paper_id=paper.id, section="Findings", page=1, page_unknown=False, text="The method improves results.", char_start=0, char_end=28)
    db_session.add(passage)
    db_session.flush()
    claim = Claim(paper_id=paper.id, passage_id=passage.id, claim_text="The method improves results.", claim_type="finding", support_excerpt="The method improves results.", section="Findings", page=1)
    db_session.add(claim)
    db_session.flush()
    brief = Brief(project_id=project.id, executive_summary="Summary", sections=[{"theme": "Findings", "claims": [{"text": claim.claim_text, "citations": ["C1"]}]}], citation_map={"C1": {"paper_id": paper.id}})
    assert "A Study" in export_bibtex(db_session, brief)
    assert "TY  - JOUR" in export_ris(db_session, brief)
    assert "A Study" in export_csl_json(db_session, brief)


@pytest.mark.asyncio
async def test_claim_extraction_falls_back_when_provider_errors(db_session, monkeypatch):
    project = Project(name="Fallback", question="Q")
    db_session.add(project)
    db_session.flush()
    paper = Paper(project_id=project.id, title="A Study", authors=[{"name": "Ada Lovelace"}], year=2024, venue="Journal")
    db_session.add(paper)
    db_session.flush()
    passage = Passage(
        paper_id=paper.id,
        section="Findings",
        page=1,
        page_unknown=False,
        text="The results show the method improves grounded citations across benchmark tasks.",
        char_start=0,
        char_end=80,
    )
    db_session.add(passage)
    db_session.commit()

    class Settings:
        llm_type = "ANT"
        llm_url = "https://example.com"
        llm_model = "m"
        llm_key = "x"
        # Provide the alias attribute names that pydantic uses internally too,
        # so the real `is_configured()` helper also reports True.
        TYPE = "ANT"
        URL = "https://example.com"
        MODEL = "m"
        KEY = "x"

    async def fail(*args, **kwargs):
        request = httpx.Request("POST", "https://example.com")
        response = httpx.Response(503, request=request)
        raise httpx.HTTPStatusError("provider unavailable", request=request, response=response)

    monkeypatch.setattr("app.services.claims.get_settings", lambda: Settings())
    monkeypatch.setattr("app.services.claims._extract_with_llm", fail)

    count = await extract_claims(db_session, project.id)
    assert count == 1
