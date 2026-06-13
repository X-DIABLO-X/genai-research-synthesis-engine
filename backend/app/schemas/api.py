from typing import Union

from pydantic import BaseModel, Field


class DiscoveryRequest(BaseModel):
    question: str
    providers: list[str] = Field(default_factory=lambda: ["semantic_scholar", "arxiv"])
    year_from: int | None = None
    year_to: int | None = None
    max_results: int = 10
    # "low" = quick scan, top 8 broad results.
    # "medium" = default balanced ranking.
    # "high" = extra expansion + tighter relevance filter.
    depth: str = "medium"


class DiscoveryPaper(BaseModel):
    title: str
    authors: list[dict] = []
    year: int | None = None
    venue: str | None = None
    doi: str | None = None
    arxiv_id: str | None = None
    semantic_scholar_id: str | None = None
    abstract: str | None = None
    source_provider: str
    pdf_url: str | None = None
    citation_count: int = 0
    relevance_score: float = 0


class ImportPapersRequest(BaseModel):
    project_name: str = "Untitled review"
    question: str
    papers: list[DiscoveryPaper]


class ImportPapersResponse(BaseModel):
    project_id: int
    paper_ids: list[int]


class ProjectRunResponse(BaseModel):
    project_id: int
    status: str
    detail: str


# ── Brief meta entries ──────────────────────────────────────────────────────
# The LLM is asked to return rich objects (with theme/question/citations) for
# open_questions and (with title/why_relevant/citations) for
# recommended_papers. Plain strings are still accepted for backward
# compatibility with earlier prompts.
OpenQuestionEntry = Union[str, dict]
RecommendedPaperEntry = Union[str, dict]


class BriefMeta(BaseModel):
    open_questions: list[OpenQuestionEntry] = Field(default_factory=list)
    recommended_papers: list[RecommendedPaperEntry] = Field(default_factory=list)
    knowledge_graph: dict = Field(default_factory=dict)


class BriefResponse(BaseModel):
    id: int
    project_id: int
    executive_summary: str
    sections: list[dict]
    citation_map: dict
    validation_errors: list[str]


class ChatRequest(BaseModel):
    messages: list[dict]
    # Optional file attachments. Each entry is {filename, text} where
    # `text` is already extracted content (PDF text, raw .txt, etc.) and
    # is prepended to the prompt as user-supplied context.
    attachments: list[dict] = Field(default_factory=list)


class ChatResponse(BaseModel):
    reply: str
