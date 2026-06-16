import React, { FormEvent, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowRight, Loader2, Search } from "lucide-react";
import "./styles.css";

const API_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000";

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

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || response.statusText);
  }

  return response.json() as Promise<T>;
}

function App() {
  const [question, setQuestion] = useState("");
  const [papers, setPapers] = useState<Paper[]>([]);
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [status, setStatus] = useState("Ready");
  const [busy, setBusy] = useState(false);

  const selectedPapers = useMemo(() => papers.filter((_, index) => selected[index]), [papers, selected]);

  async function searchPapers(event?: FormEvent) {
    event?.preventDefault();
    if (!question.trim()) return;

    setBusy(true);
    setStatus("Searching semantic scholar and arXiv...");

    try {
      const result = await api<Paper[]>("/api/discovery/search", {
        method: "POST",
        body: JSON.stringify({ question, max_results: 10 }),
      });
      setPapers(result);
      setSelected(Object.fromEntries(result.slice(0, 5).map((_, index) => [index, true])));
      setStatus(`Found ${result.length} ranked papers.`);
    } catch (error) {
      setStatus(`Search failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="landing">
        <div className="hero">
          <span className="eyebrow">AI research synthesis engine</span>
          <h1>Find the strongest papers before writing the brief.</h1>
          <p>
            Start with a research question, rank candidate papers, and hand-pick the evidence set you want to ingest.
          </p>
          <form className="search-form" onSubmit={searchPapers}>
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Ask a research question or describe the topic..."
            />
            <button className="primary-button" disabled={busy || !question.trim()} type="submit">
              {busy ? <Loader2 className="spin" size={16} /> : <Search size={16} />}
              Search
            </button>
          </form>
          <div className="status-pill">
            <span>{busy ? "Working" : "Idle"}</span>
            {status}
          </div>
        </div>

        {papers.length > 0 ? (
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
                    <p>{paper.abstract?.slice(0, 240) || "No abstract available for this paper yet."}</p>
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
                {selectedPapers.length} paper{selectedPapers.length === 1 ? "" : "s"} selected for the next stage.
              </div>
              <button className="primary-button" type="button">
                Continue
                <ArrowRight size={16} />
              </button>
            </div>
          </>
        ) : null}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
