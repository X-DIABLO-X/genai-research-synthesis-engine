import json
import re
from datetime import datetime
from urllib.parse import quote_plus
from xml.etree import ElementTree

import httpx

from app.core.config import get_settings
from app.schemas.api import DiscoveryPaper, DiscoveryRequest
from app.services import llm


S2_FIELDS = "title,authors,year,abstract,citationCount,openAccessPdf,url,venue,externalIds,publicationDate"
GENERIC_TERMS = {
    "about",
    "across",
    "after",
    "against",
    "also",
    "analysis",
    "based",
    "better",
    "between",
    "data",
    "does",
    "from",
    "have",
    "into",
    "layer",
    "method",
    "methods",
    "model",
    "models",
    "paper",
    "papers",
    "research",
    "study",
    "system",
    "systems",
    "that",
    "their",
    "these",
    "this",
    "using",
    "with",
}


def _terms(text: str) -> list[str]:
    return [term for term in re.findall(r"[a-z0-9][a-z0-9-]{2,}", text.lower()) if term not in GENERIC_TERMS]


def _normalize_text(text: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", text.lower()))


def _title_similarity(left: str, right: str) -> float:
    left_terms = set(_terms(left) or _normalize_text(left).split())
    right_terms = set(_terms(right) or _normalize_text(right).split())
    if not left_terms or not right_terms:
        return 0.0
    overlap = len(left_terms & right_terms) / max(len(left_terms | right_terms), 1)
    ordered_bonus = 0.2 if _normalize_text(left) == _normalize_text(right) else 0.0
    if _normalize_text(left) in _normalize_text(right) or _normalize_text(right) in _normalize_text(left):
        ordered_bonus = max(ordered_bonus, 0.12)
    return min(overlap + ordered_bonus, 1.0)


def _phrase_bonus(question: str, paper: DiscoveryPaper) -> float:
    haystack = f"{paper.title} {paper.abstract or ''}".lower()
    phrases = re.findall(r'"([^"]+)"', question.lower())
    phrases.extend(chunk for chunk in re.split(r"\band\b|\bor\b|,|;", question.lower()) if len(chunk.split()) >= 2)
    cleaned = [" ".join(_terms(phrase)) for phrase in phrases]
    return min(sum(1 for phrase in cleaned if phrase and phrase in haystack) * 0.12, 0.24)


def _score(question: str, paper: DiscoveryPaper) -> float:
    q_terms = set(_terms(question))
    if not q_terms:
        q_terms = {term.lower() for term in question.split() if len(term) > 3}
    haystack = f"{paper.title} {paper.abstract or ''}".lower()
    title = paper.title.lower()
    title_hits = sum(1 for term in q_terms if term in title)
    abstract_hits = sum(1 for term in q_terms if term in haystack)
    lexical = ((title_hits * 1.65) + abstract_hits) / max((len(q_terms) * 2.65), 1)
    recency = 0.0
    if paper.year:
        recency = max(0, paper.year - 2000) / max(datetime.utcnow().year - 2000, 1)
    citation = min(paper.citation_count / 500, 1)
    pdf = 0.15 if paper.pdf_url else 0
    return round(min((lexical * 0.68) + _phrase_bonus(question, paper) + (recency * 0.07) + (citation * 0.1) + pdf, 1), 4)


async def _llm_discovery_plan(question: str) -> dict:
    if not llm.is_configured():
        return {}
    system = (
        "You design academic paper discovery searches. Return strict JSON only. "
        "Prefer known paper titles, arXiv-searchable technical terms, and canonical topic names. "
        "Avoid broad standalone words such as data, method, model, system, better, or study."
    )
    user = (
        f"Research question: {question}\n\n"
        "Return JSON with keys: queries (4 concise arXiv query phrases), "
        "expected_terms (8-14 domain terms), negative_terms (terms that indicate likely off-topic papers), "
        "and paper_titles (4-8 likely real paper titles or highly specific named works to retrieve first)."
    )
    try:
        parsed = await llm.chat_json(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=0.1,
            timeout=8.0,
        )
    except (llm.LLMUnavailable, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _fallback_queries(question: str) -> list[str]:
    important = _terms(question)
    base = " ".join(important[:6]) or question
    variants = [base]
    if "memory" in question.lower():
        variants.extend(["memory augmented retrieval", "long term memory language models", "retrieval augmented generation memory"])
    if "retrieval" in question.lower():
        variants.extend(["retrieval augmented generation", "neural information retrieval"])
    return list(dict.fromkeys(variants))[:5]


def _fallback_seed_titles(question: str) -> list[str]:
    lowered = question.lower()
    seeds: list[str] = []
    if "memory" in lowered and "retrieval" in lowered:
        seeds.extend(
            [
                "Beyond Fact Retrieval: Episodic Memory for RAG with Generative Semantic Workspaces",
                "Memory Layers at Scale: Direct Preference Optimization for Long Context",
                "MemLong: Memory-Augmented Retrieval for Long Text Generation",
            ]
        )
    if "long context" in lowered or "long-context" in lowered:
        seeds.extend(
            [
                "LongRoPE: Extending LLM Context Window Beyond 2 Million Tokens",
                "LongMem: Scaling Language Models with Memory Augmentation",
            ]
        )
    return list(dict.fromkeys(seeds))[:5]


def _to_arxiv_query(query: str) -> str:
    query = " ".join(query.split())
    if not query:
        return ""
    if ":" in query or " AND " in query or " OR " in query:
        return query
    terms = _terms(query)[:7]
    if not terms:
        terms = [term for term in query.lower().split() if len(term) > 2][:7]
    return " AND ".join(f"all:{term}" for term in terms)


def _paper_from_semantic_scholar(item: dict, question: str) -> DiscoveryPaper:
    external = item.get("externalIds") or {}
    pdf = item.get("openAccessPdf") or {}
    paper = DiscoveryPaper(
        title=item.get("title") or "Untitled",
        authors=[{"name": author.get("name")} for author in item.get("authors", [])],
        year=item.get("year"),
        venue=item.get("venue"),
        doi=external.get("DOI"),
        arxiv_id=external.get("ArXiv"),
        semantic_scholar_id=item.get("paperId"),
        abstract=item.get("abstract"),
        source_provider="semantic_scholar",
        pdf_url=pdf.get("url"),
        citation_count=item.get("citationCount") or 0,
    )
    paper.relevance_score = _score(question, paper)
    return paper


async def search_semantic_scholar(req: DiscoveryRequest, query: str | None = None, limit: int | None = None) -> list[DiscoveryPaper]:
    settings = get_settings()
    params = {"query": query or req.question, "limit": limit or req.max_results, "fields": S2_FIELDS}
    if req.year_from or req.year_to:
        params["year"] = f"{req.year_from or ''}-{req.year_to or ''}"
    headers = {"x-api-key": settings.semantic_scholar_api_key} if settings.semantic_scholar_api_key else {}
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.get("https://api.semanticscholar.org/graph/v1/paper/search", params=params, headers=headers)
        response.raise_for_status()
    items = response.json().get("data", [])
    return [_paper_from_semantic_scholar(item, req.question) for item in items]


async def search_arxiv(req: DiscoveryRequest, query: str | None = None, limit: int | None = None) -> list[DiscoveryPaper]:
    search_query = _to_arxiv_query(query or req.question)
    url = (
        "https://export.arxiv.org/api/query"
        f"?search_query={quote_plus(search_query)}&start=0&max_results={limit or req.max_results}"
        "&sortBy=relevance&sortOrder=descending"
    )
    ns = {"atom": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.get(url)
        response.raise_for_status()
    root = ElementTree.fromstring(response.text)
    papers: list[DiscoveryPaper] = []
    for entry in root.findall("atom:entry", ns):
        published = entry.findtext("atom:published", default="", namespaces=ns)
        year = int(published[:4]) if published[:4].isdigit() else None
        if req.year_from and year and year < req.year_from:
            continue
        if req.year_to and year and year > req.year_to:
            continue
        entry_id = entry.findtext("atom:id", default="", namespaces=ns)
        arxiv_id = entry_id.rsplit("/", 1)[-1]
        paper = DiscoveryPaper(
            title=" ".join(entry.findtext("atom:title", default="Untitled", namespaces=ns).split()),
            authors=[{"name": node.findtext("atom:name", default="", namespaces=ns)} for node in entry.findall("atom:author", ns)],
            year=year,
            venue="arXiv",
            arxiv_id=arxiv_id,
            abstract=" ".join(entry.findtext("atom:summary", default="", namespaces=ns).split()),
            source_provider="arxiv",
            pdf_url=f"https://arxiv.org/pdf/{arxiv_id}.pdf",
        )
        paper.relevance_score = _score(req.question, paper)
        papers.append(paper)
    return papers


def _best_title_match(seed_title: str, papers: list[DiscoveryPaper], *, minimum_similarity: float = 0.45) -> DiscoveryPaper | None:
    best: tuple[float, DiscoveryPaper] | None = None
    for paper in papers:
        similarity = _title_similarity(seed_title, paper.title)
        if similarity < minimum_similarity:
            continue
        if best is None or similarity > best[0]:
            best = (similarity, paper)
    if not best:
        return None
    paper = best[1]
    paper.relevance_score = round(max(paper.relevance_score, min(0.78 + (best[0] * 0.18), 0.98)), 4)
    return paper


async def _fetch_seed_papers(req: DiscoveryRequest, seed_titles: list[str], per_title_limit: int = 5) -> list[DiscoveryPaper]:
    fetched: list[DiscoveryPaper] = []
    for title in seed_titles:
        title = title.strip()
        if not title:
            continue
        semantic_hits: list[DiscoveryPaper] = []
        arxiv_hits: list[DiscoveryPaper] = []
        if "semantic_scholar" in req.providers:
            try:
                semantic_hits = await search_semantic_scholar(req, query=title, limit=per_title_limit)
            except Exception:
                semantic_hits = []
        if "arxiv" in req.providers:
            try:
                arxiv_hits = await search_arxiv(req, query=f'"{title}"', limit=per_title_limit)
            except Exception:
                arxiv_hits = []

        match = _best_title_match(title, semantic_hits) or _best_title_match(title, arxiv_hits)
        if match:
            fetched.append(match)
    return fetched


async def _llm_rerank(question: str, papers: list[DiscoveryPaper]) -> dict[int, float]:
    if not llm.is_configured() or not papers:
        return {}
    candidates = [
        {
            "index": index,
            "title": paper.title,
            "year": paper.year,
            "abstract": (paper.abstract or "")[:900],
        }
        for index, paper in enumerate(papers[:40])
    ]
    system = (
        "You rerank academic search results. Return strict JSON only. "
        "Score 1.0 for directly useful papers, 0.5 for adjacent background, and below 0.25 for off-topic results. "
        "Be harsh about papers that only match broad words."
    )
    user = (
        f"Research question: {question}\n\n"
        f"Candidates JSON: {json.dumps(candidates)}\n\n"
        "Return JSON: {\"scores\":[{\"index\":0,\"score\":0.0,\"reason\":\"short\"}]}"
    )
    try:
        parsed = await llm.chat_json(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=0.0,
            timeout=10.0,
        )
    except (llm.LLMUnavailable, ValueError):
        return {}
    scores = {}
    for item in parsed.get("scores", []) if isinstance(parsed, dict) else []:
        try:
            scores[int(item["index"])] = max(0.0, min(float(item["score"]), 1.0))
        except (KeyError, TypeError, ValueError):
            continue
    return scores


async def discover(req: DiscoveryRequest) -> list[DiscoveryPaper]:
    # Translate the user-facing "thinking depth" knob into concrete
    # parameters: how many arXiv queries to fire, how many candidates to
    # consider, and how strict the relevance floor is.
    depth = (req.depth or "medium").lower()
    if depth == "low":
        arxiv_query_cap = 2
        candidate_cap = max(req.max_results * 2, 15)
        relevance_minimum = 0.18
        rerank = False
    elif depth == "high":
        arxiv_query_cap = 8
        candidate_cap = max(req.max_results * 6, 60)
        relevance_minimum = 0.34
        rerank = True
    else:  # medium (default)
        arxiv_query_cap = 4
        candidate_cap = max(req.max_results * 4, 30)
        relevance_minimum = 0.24
        rerank = True

    results: list[DiscoveryPaper] = []
    plan: dict = {}
    llm_scores: dict[int, float] = {}
    if rerank:
        try:
            plan = await _llm_discovery_plan(req.question)
        except Exception:
            plan = {}
    seed_titles = [title for title in plan.get("paper_titles", []) if isinstance(title, str) and title.strip()]
    seed_titles.extend(_fallback_seed_titles(req.question))
    seed_titles = list(dict.fromkeys(seed_titles))[:8]
    arxiv_queries = [query for query in plan.get("queries", []) if isinstance(query, str) and query.strip()]
    arxiv_queries.extend(_fallback_queries(req.question))

    if seed_titles:
        results.extend(await _fetch_seed_papers(req, seed_titles, per_title_limit=5))
    if "semantic_scholar" in req.providers:
        try:
            results.extend(await search_semantic_scholar(req))
        except Exception:
            pass
    if "arxiv" in req.providers:
        for query in list(dict.fromkeys(arxiv_queries))[:arxiv_query_cap]:
            try:
                results.extend(await search_arxiv(req, query=query, limit=max(req.max_results, 12)))
            except Exception:
                continue
    deduped: dict[str, DiscoveryPaper] = {}
    for paper in results:
        key = paper.doi or paper.arxiv_id or paper.semantic_scholar_id or paper.title.lower()
        if key not in deduped or paper.relevance_score > deduped[key].relevance_score:
            deduped[key] = paper
    candidates = sorted(deduped.values(), key=lambda item: item.relevance_score, reverse=True)[:candidate_cap]
    if rerank:
        try:
            llm_scores = await _llm_rerank(req.question, candidates)
        except Exception:
            llm_scores = {}
        for index, paper in enumerate(candidates):
            if index in llm_scores:
                paper.relevance_score = round((llm_scores[index] * 0.72) + (paper.relevance_score * 0.28), 4)

    minimum = relevance_minimum if (rerank and llm_scores) else max(relevance_minimum - 0.05, 0.0)
    ranked = [paper for paper in sorted(candidates, key=lambda item: item.relevance_score, reverse=True) if paper.relevance_score >= minimum]
    return (ranked or sorted(candidates, key=lambda item: item.relevance_score, reverse=True))[: req.max_results]
