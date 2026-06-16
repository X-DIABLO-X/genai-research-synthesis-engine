import React, { FormEvent, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowRight, CheckCircle2, Loader2, Play, Search, Upload } from "lucide-react";
import "./styles.css";

const API_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000";

type Stage = "landing" | "select" | "materials" | "researching" | "brief";

type Paper = {
  title: string;
  authors: { name: string }[];
  year?: number;
  venue?: string;
  abstract?: string;
  source_provider: string;
  pdf_url?: string;
  citation_count: number;
  relevance_score: number;
};

type Brief = {
  id: number;
  project_id: number;
  executive_summary: string;
  sections: {
    theme: string;
    consensus_status: string;
    summary?: string;
    claims: { text: string; citations: string[]; paper_title?: string; section?: string; page?: number }[];
  }[];
  citation_map: Record<string, unknown>;
  validation_errors: string[];
};

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    headers: options?.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...options,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || response.statusText);
  }

  return response.json() as Promise<T>;
}

function App() {
  const [stage, setStage] = useState<Stage>("landing");
  const [question, setQuestion] = useState("");
  const [papers, setPapers] = useState<Paper[]>([]);
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [status, setStatus] = useState("Ready");
  const [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);

  const selectedPapers = useMemo(() => papers.filter((_, index) => selected[index]), [papers, selected]);

  async function searchPapers(event?: FormEvent) {
    event?.preventDefault();
    if (!question.trim()) return;

    setBusy(true);
    setStatus("Searching semantic scholar and arXiv...");

    try {
      const result = await api<Paper[]>("/api/discovery/search", {
        method: "POST",
        body: JSON.stringify({ question, max_results: 12 }),
      });
      setPapers(result);
      setSelected(Object.fromEntries(result.slice(0, 5).map((_, index) => [index, true])));
      setStage("select");
      setStatus(`Found ${result.length} ranked papers.`);
    } catch (error) {
      setStatus(`Search failed: ${(error as Error).message}`);
      setStage("landing");
    } finally {
      setBusy(false);
    }
  }

  async function createProjectAndContinue() {
    if (!selectedPapers.length) return;

    setBusy(true);
    setStatus("Creating a project from the selected papers...");

    try {
      const result = await api<{ project_id: number; paper_ids: number[] }>("/api/papers/import", {
        method: "POST",
        body: JSON.stringify({ project_name: question.slice(0, 90), question, papers: selectedPapers }),
      });
      setProjectId(result.project_id);
      setStage("materials");
      setStatus(`Project ${result.project_id} is ready with ${result.paper_ids.length} papers.`);
    } catch (error) {
      setStatus(`Import failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function uploadPdf(file: File) {
    if (!projectId) return;

    setBusy(true);
    setStatus(`Uploading ${file.name}...`);
    const form = new FormData();
    form.append("file", file);

    try {
      await api(`/api/documents/upload?project_id=${projectId}`, { method: "POST", body: form });
      setStatus("Material uploaded. You can start the research run now.");
    } catch (error) {
      setStatus(`Upload failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function runResearch() {
    if (!projectId) return;

    setBusy(true);
    setStage("researching");

    try {
      setStatus("Ingesting PDFs and building passage chunks...");
      await api(`/api/projects/${projectId}/ingest`, { method: "POST" });

      setStatus("Extracting claims from the stored passages...");
      await api(`/api/projects/${projectId}/claims/extract`, { method: "POST" });

      setStatus("Synthesizing the cited brief...");
      const nextBrief = await api<Brief>(`/api/projects/${projectId}/synthesize`, { method: "POST" });
      setBrief(nextBrief);
      setStage("brief");
      setStatus(nextBrief.validation_errors.length ? "Brief generated with validation warnings." : "Brief generated successfully.");
    } catch (error) {
      setStatus(`Research failed: ${(error as Error).message}`);
      setStage("materials");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="landing">
        <div className="hero">
          <span className="eyebrow">AI research synthesis engine</span>
          <h1>Collect evidence first, then write the brief.</h1>
          <p>
            Search, select, upload, ingest, and synthesize the research corpus in one pipeline before you open a chat.
          </p>
          <form className="search-form" onSubmit={searchPapers}>
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Ask a research question or describe the topic..."
            />
            <button className="primary-button" disabled={busy || !question.trim()} type="submit">
              {busy && stage === "landing" ? <Loader2 className="spin" size={16} /> : <Search size={16} />}
              Search
            </button>
          </form>
          <div className="status-pill">
            <span>{busy ? "Working" : "Idle"}</span>
            {status}
          </div>
        </div>

        {stage === "select" ? (
          <>
            <div className="results">
              {papers.map((paper, index) => {
                const checked = !!selected[index];
                return (
                  <label className={`paper-card ${checked ? "selected" : ""}`} key={`${paper.title}-${index}`}>
                    <header>
                      <h3>{paper.title}</h3>
                      <input
                        checked={checked}
                        onChange={(event) => setSelected({ ...selected, [index]: event.target.checked })}
                        type="checkbox"
                      />
                    </header>
                    <p>{paper.abstract?.slice(0, 260) || "No abstract available for this paper yet."}</p>
                    <div className="paper-meta">
                      <span>{paper.year ?? "n.d."}</span>
                      <span>{paper.source_provider}</span>
                      <span>{paper.pdf_url ? "PDF" : "metadata only"}</span>
                    </div>
                    <div className="score-chip">score {paper.relevance_score.toFixed(2)}</div>
                  </label>
                );
              })}
            </div>

            <div className="selection-bar">
              <div className="selection-copy">
                {selectedPapers.length} paper{selectedPapers.length === 1 ? "" : "s"} selected for import.
              </div>
              <button className="primary-button" disabled={!selectedPapers.length || busy} onClick={createProjectAndContinue} type="button">
                Continue
                <ArrowRight size={16} />
              </button>
            </div>
          </>
        ) : null}

        {stage === "materials" ? (
          <section className="panel-grid">
            <article className="workflow-panel">
              <span className="eyebrow">Project ready</span>
              <h2>Project {projectId}</h2>
              <p>
                The selected papers are stored. Upload any private PDFs or notes you want the run to include before you start ingesting.
              </p>
              <div className="workflow-actions">
                <label className="secondary-button">
                  <Upload size={16} />
                  Upload supporting PDF
                  <input
                    hidden
                    onChange={(event) => event.target.files?.[0] && uploadPdf(event.target.files[0])}
                    type="file"
                    accept="application/pdf"
                  />
                </label>
                <button className="primary-button" disabled={busy} onClick={runResearch} type="button">
                  <Play size={16} />
                  Start research
                </button>
              </div>
            </article>
            <article className="workflow-panel">
              <span className="eyebrow">Selected corpus</span>
              <h2>{selectedPapers.length} paper stack</h2>
              <ul className="paper-list">
                {selectedPapers.map((paper) => (
                  <li key={paper.title}>{paper.title}</li>
                ))}
              </ul>
            </article>
          </section>
        ) : null}

        {stage === "researching" ? (
          <section className="workflow-panel wide">
            <span className="eyebrow">Research in progress</span>
            <h2>Running the synthesis pipeline</h2>
            <p>The backend is ingesting source files, extracting claims, and generating a citation-grounded brief.</p>
            <div className="progress-strip">
              <div className="progress-strip-bar" />
            </div>
          </section>
        ) : null}

        {stage === "brief" && brief ? (
          <section className="panel-grid brief-grid">
            <article className="workflow-panel wide">
              <span className="eyebrow">Executive summary</span>
              <h2>Research brief #{brief.id}</h2>
              <p>{brief.executive_summary}</p>
              {brief.validation_errors.length ? <div className="warning-box">{brief.validation_errors.join(" ")}</div> : null}
            </article>
            {brief.sections.map((section) => (
              <article className="workflow-panel" key={section.theme}>
                <div className="section-head">
                  <h2>{section.theme}</h2>
                  <span className="score-chip">{section.consensus_status}</span>
                </div>
                <p>{section.summary || "No section summary returned yet."}</p>
                <ul className="claim-list">
                  {section.claims.map((claim, index) => (
                    <li key={`${section.theme}-${index}`}>
                      <strong>{claim.paper_title || "Stored evidence"}</strong>
                      <span>{claim.text}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </section>
        ) : null}

        {stage === "brief" && brief ? (
          <div className="status-pill success-pill">
            <CheckCircle2 size={14} />
            Project {brief.project_id} synthesized into a traceable brief.
          </div>
        ) : null}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
