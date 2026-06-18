import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Compass,
  Database,
  Download,
  FilePlus2,
  FileSearch,
  FileText,
  Lightbulb,
  Loader2,
  MessageSquareText,
  Mic,
  Paperclip,
  Play,
  Quote,
  Search,
  Send,
  Sparkles,
  Sprout,
  Upload,
  WandSparkles,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Particles from "./components/Particles";
import ParticleTitle from "./components/ParticleTitle";
import particleField from "./assets/research-particle-field.png";
import "./styles.css";

const isLocalhost = typeof window !== "undefined" && /^(localhost|127\\.0\\.0\\.1)$/i.test(window.location.hostname);
const API_URL = import.meta.env.VITE_API_URL || (isLocalhost ? "http://127.0.0.1:8000" : "");

// ── Web Speech API typings (subset) ─────────────────────────────────
type SpeechRecognitionResultList = {
  length: number;
  resultIndex: number;
  [index: number]: { isFinal: boolean; 0: { transcript: string; confidence: number } };
};
type SpeechRecognitionEvent = { resultIndex: number; results: SpeechRecognitionResultList };
type SpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
const DISCOVERY_STEPS = [
  "Expanding the research question into focused academic search intents.",
  "Checking arXiv candidates and filtering broad or off-topic matches.",
  "Ranking the strongest papers for relevance, traceability, and PDF access.",
];
const RESEARCH_MILESTONES = [
  { title: "Fetching papers", detail: "Collecting source metadata, PDFs, and uploaded material." },
  { title: "Spawning research agents", detail: "Splitting the corpus into bounded evidence packets." },
  { title: "Researching", detail: "Extracting claims, methods, findings, and limitations." },
  { title: "Brainstorming", detail: "Looking for themes, contradictions, and weak evidence." },
  { title: "Combining data", detail: "Grouping citations into a coherent synthesis structure." },
  { title: "Generating report", detail: "Producing the cited brief and preparing chat context." },
];
const CHAT_SUGGESTIONS = [
  "What are the weakest claims in this brief?",
  "Where do the papers disagree?",
  "What methods appear most often?",
  "Summarise the limitations in one paragraph.",
];
const SAMPLE_QUERIES = [
  "Memory layers in long-context LLMs and better data retrieval",
  "Diffusion model acceleration for real-time image generation",
  "Sparse mixture-of-experts vs dense transformers at scale",
  "Self-supervised pretraining for medical imaging",
];
const CAPABILITY_ROWS = [
  {
    icon: Search,
    label: "Discovery",
    title: "Find the strongest papers",
    body: "Query expansion, arXiv candidate sweeps, and relevance ranking with PDF access checks.",
  },
  {
    icon: WandSparkles,
    label: "Synthesis",
    title: "Build a cited brief",
    body: "Claim extraction, theme clustering, and citation-traceable writing grounded in source passages.",
  },
  {
    icon: MessageSquareText,
    label: "Discussion",
    title: "Ask the corpus directly",
    body: "Chat that answers from the loaded brief — never from invented sources or unsourced speculation.",
  },
];

type Stage = "landing" | "discovering" | "select" | "materials" | "researching" | "chat";

type Paper = {
  title: string;
  authors: { name: string }[];
  year?: number;
  venue?: string;
  doi?: string;
  arxiv_id?: string;
  semantic_scholar_id?: string;
  abstract?: string;
  source_provider: string;
  pdf_url?: string;
  citation_count: number;
  relevance_score: number;
};

type BriefSection = {
  theme: string;
  consensus_status: string;
  summary?: string;
  claims: { text: string; type: string; citations: string[]; paper_title?: string; section?: string; page?: number; support_excerpt?: string; confidence?: number }[];
};

type Brief = {
  id: number;
  project_id: number;
  executive_summary: string;
  sections: BriefSection[];
  citation_map: Record<string, { paper_title: string; section: string; page: number; support_excerpt: string } | { open_questions?: string[]; recommended_papers?: string[] }>;
  validation_errors: string[];
};

type ChatMessage = {
  role: "assistant" | "user";
  content: string;
};

function normalizeApiError(detail: string, statusText: string) {
  const trimmed = detail.trim();
  const lowered = trimmed.toLowerCase();
  if (!trimmed) return statusText;
  if (lowered.startsWith("<!doctype html") || lowered.startsWith("<html") || lowered.includes("<body")) {
    return "The research server timed out while processing this step. Please retry; partial progress may already be saved.";
  }
  return trimmed;
}

async function api<T>(path: string, options?: RequestInit, attempt = 0): Promise<T> {
  try {
    const response = await fetch(`${API_URL}${path}`, {
      headers: options?.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
      ...options,
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(normalizeApiError(detail, response.statusText));
    }
    return response.json() as Promise<T>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const networkish = message.includes("Failed to fetch") || message.includes("NetworkError") || message.includes("Load failed");
    if (networkish && attempt < 1) {
      await wait(700);
      return api<T>(path, options, attempt + 1);
    }
    if (networkish) {
      throw new Error("The app could not reach the research server. Please retry; the request was sent again once automatically.");
    }
    throw error;
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function App() {
  const [stage, setStage] = useState<Stage>("landing");
  const [question, setQuestion] = useState("");
  const [papers, setPapers] = useState<Paper[]>([]);
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [projectId, setProjectId] = useState<number | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [status, setStatus] = useState("Ready");
  const [busy, setBusy] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatStage, setChatStage] = useState<"idle" | "searching" | "drafting" | "streaming">("idle");
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [milestoneIndex, setMilestoneIndex] = useState(0);
  // Files attached on the landing page are stashed here and then uploaded
  // to the project once the user finishes the discovery + import flow.
  const [pendingAttachments, setPendingAttachments] = useState<{ filename: string; text: string }[]>([]);
  // Thinking depth chosen on the landing page; passed to /api/discovery/search.
  const [pendingDepth, setPendingDepth] = useState<"low" | "medium" | "high">("medium");
  // When true, speech recognition should append, not overwrite.
  const [speechHasCommitted, setSpeechHasCommitted] = useState(false);

  // ── File attachments and mic are scoped to the workspace; helpers
  // live inside <ResearchWorkspace> so they share the local ChatMessage
  // history, the file input ref, and the SpeechRecognition ref.

  const selectedPapers = useMemo(() => papers.filter((_, index) => selected[index]), [papers, selected]);
  const citationCount = useMemo(
    () => brief?.sections.reduce((count, section) => count + section.claims.reduce((inner, claim) => inner + claim.citations.length, 0), 0) ?? 0,
    [brief],
  );
  const briefMeta = useMemo(() => {
    const meta = brief?.citation_map?.__meta as { open_questions?: unknown[]; recommended_papers?: unknown[] } | undefined;
    return meta ?? {};
  }, [brief]);

  async function searchPapers(event?: FormEvent) {
    event?.preventDefault();
    if (!question.trim()) return;
    setBusy(true);
    setStage("discovering");
    setStatus("Finding the best research papers for this question...");
    try {
      const result = await api<Paper[]>("/api/discovery/search", {
        method: "POST",
        body: JSON.stringify({ question, max_results: 12, depth: pendingDepth }),
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
    setStatus("Preparing selected papers...");
    try {
      const result = await api<{ project_id: number; paper_ids: number[] }>("/api/papers/import", {
        method: "POST",
        body: JSON.stringify({ project_name: question.slice(0, 90), question, papers: selectedPapers }),
      });
      setProjectId(result.project_id);
      setStage("materials");
      setStatus(`Project ${result.project_id} prepared with ${result.paper_ids.length} papers.`);
      // Forward any text excerpts the user attached on the landing page
      // by uploading them as plain .txt files attached to a new paper.
      // We use the same upload endpoint but wrap the text in a File so
      // the existing storage pipeline accepts it.
      const carry = pendingAttachments;
      if (carry.length) {
        for (const attachment of carry) {
          const file = new File([attachment.text], attachment.filename, { type: "text/plain" });
          const form = new FormData();
          form.append("file", file);
          setStatus(`Uploading ${attachment.filename}…`);
          try {
            await api(`/api/documents/upload?project_id=${result.project_id}`, { method: "POST", body: form });
          } catch (error) {
            console.warn("attachment upload failed", error);
          }
        }
        setPendingAttachments([]);
        setStatus(`Project ${result.project_id} prepared with ${result.paper_ids.length} papers and ${carry.length} attached document(s).`);
      }
    } catch (error) {
      setStatus(`Import failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function uploadPdf(file: File) {
    if (!projectId) return;
    setBusy(true);
    const form = new FormData();
    form.append("file", file);
    setStatus("Uploading supporting material...");
    try {
      await api(`/api/documents/upload?project_id=${projectId}`, { method: "POST", body: form });
      setStatus("Material uploaded. Ready to research.");
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
    setMilestoneIndex(0);
    try {
      setStatus("Fetching paper sources and uploaded files...");
      await api(`/api/projects/${projectId}/ingest`, { method: "POST" });

      setMilestoneIndex(1);
      setStatus("Spawning research agents across the corpus...");
      await wait(350);

      setMilestoneIndex(2);
      setStatus("Researching passages and extracting grounded claims...");
      await api(`/api/projects/${projectId}/claims/extract`, { method: "POST" });

      setMilestoneIndex(3);
      setStatus("Brainstorming themes and conflicts...");
      await wait(350);

      setMilestoneIndex(4);
      setStatus("Combining data into synthesis groups...");
      await wait(250);

      setMilestoneIndex(5);
      setStatus("Generating the final cited report...");
      const nextBrief = await api<Brief>(`/api/projects/${projectId}/synthesize`, { method: "POST" });

      setBrief(nextBrief);
      setMessages([
        {
          role: "assistant",
          content:
            "Research complete. I have the cited brief loaded and I can answer from it directly. Ask for consensus, conflicts, limitations, methods, or paper-specific evidence.",
        },
      ]);
      setStage("chat");
      setStatus(nextBrief.validation_errors.length ? "Brief generated with validation warnings." : "Brief generated and citation-validated.");
    } catch (error) {
      setStatus(`Research failed: ${(error as Error).message}`);
      setStage("materials");
    } finally {
      setBusy(false);
    }
  }

  async function runChat(userText: string, activeAttachments: { filename: string; text: string }[]) {
    if (!userText.trim() || !projectId) {
      if (!projectId) {
        setMessages((current) => [
          ...current,
          { role: "assistant", content: "Chat is only available after completing research. Please finish the research run first." },
        ]);
      }
      return;
    }
    const renderedUserContent = activeAttachments.length
      ? `${userText.trim()}\n\n_${activeAttachments.map((a) => `Attached: ${a.filename}`).join(", ")}_`
      : userText.trim();
    const nextMessages = [...messages, { role: "user" as const, content: renderedUserContent }];
    setMessages(nextMessages);
    setChatInput("");
    setChatBusy(true);
    setChatStage("searching");
    // Visual fall-through: after ~700ms without seeing the first token
    // we transition the meta line to "Drafting answer…" so the user
    // gets a sense of progress even if the LLM is still warming up.
    const stageTimer = window.setTimeout(() => {
      setChatStage((current) => (current === "searching" ? "drafting" : current));
    }, 700);
    // Helper to append a new assistant bubble (or replace the last
    // empty one) with a given final content.
    const finalizeAssistant = (content: string) => {
      setMessages((current) => {
        const last = current[current.length - 1];
        if (last && last.role === "assistant" && last.content === "") {
          return [...current.slice(0, -1), { ...last, content }];
        }
        return [...current, { role: "assistant", content }];
      });
    };
    try {
      const response = await fetch(`${API_URL}/api/projects/${projectId}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages,
          attachments: activeAttachments.map((a) => ({ filename: a.filename, text: a.text })),
        }),
      });
      if (!response.ok) {
        // Capture the server-side detail if possible so the user sees
        // the real reason instead of a generic "chat failed" message.
        let detail = `chat failed (${response.status})`;
        let extraHint = "";
        if (response.status === 404) {
          extraHint = " — the chat endpoint was not found. Check that the backend is running and the route is registered.";
        } else if (response.status === 500) {
          extraHint = " — the backend hit an error. Check server logs.";
        }
        try {
          const body = (await response.json()) as { detail?: string; message?: string };
          if (body.detail) detail = body.detail;
          else if (body.message) detail = body.message;
        } catch {
          // ignore — keep the status code
        }
        throw new Error(`${detail}${extraHint}`);
      }
      if (!response.body) {
        throw new Error("no response body from server");
      }
      // Append an empty assistant bubble that we'll grow as deltas arrive.
      setMessages((current) => [...current, { role: "assistant", content: "" }]);
      setChatStage("streaming");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamedAny = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf("\n\n");
        while (idx !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of raw.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6);
            if (payload === "[DONE]") continue;
            try {
              const parsed = JSON.parse(payload) as { delta?: string; error?: string };
              if (parsed.error) {
                // Surface the provider error inside the assistant bubble
                // instead of throwing so the user keeps their streamed
                // partial answer.
                finalizeAssistant(parsed.error);
                continue;
              }
              if (parsed.delta) {
                const chunk = parsed.delta;
                streamedAny = true;
                setMessages((current) => {
                  if (current.length === 0) return current;
                  const last = current[current.length - 1];
                  if (last.role !== "assistant") return current;
                  return [...current.slice(0, -1), { ...last, content: last.content + chunk }];
                });
              }
            } catch (parseError) {
              // Ignore malformed chunks; the stream keeps going.
              void parseError;
            }
          }
          idx = buffer.indexOf("\n\n");
        }
      }
      // If the stream completed without yielding any tokens, fall back
      // to the non-streaming chat endpoint so the user still gets an
      // answer. (Some proxies strip the SSE stream and just return an
      // empty body.)
      if (!streamedAny) {
        try {
          const fallback = await fetch(`${API_URL}/api/projects/${projectId}/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: nextMessages,
              attachments: activeAttachments.map((a) => ({ filename: a.filename, text: a.text })),
            }),
          });
          if (fallback.ok) {
            const data = (await fallback.json()) as { reply?: string };
            if (data.reply) {
              finalizeAssistant(data.reply);
            } else {
              finalizeAssistant("The chat backend is reachable but returned an empty reply.");
            }
          } else {
            let fallbackDetail = `fallback chat failed (${fallback.status})`;
            try {
              const body = (await fallback.json()) as { detail?: string; message?: string };
              if (body.detail) fallbackDetail = body.detail;
              else if (body.message) fallbackDetail = body.message;
            } catch {
              // ignore
            }
            finalizeAssistant(`Streaming returned no tokens and the non-streaming endpoint also failed: ${fallbackDetail}`);
          }
        } catch (fallbackError) {
          const fallbackDetail = fallbackError instanceof Error ? fallbackError.message : "unknown";
          finalizeAssistant(`Streaming returned no tokens and I couldn't reach the fallback endpoint: ${fallbackDetail}`);
        }
      }
    } catch (error) {
      const detail = (error as Error).message || "unknown error";
      // If we hadn't yet created an assistant bubble, append a new one
      // explaining what went wrong. If we had, leave the partial stream
      // alone and append a follow-up error note.
      setMessages((current) => {
        const last = current[current.length - 1];
        if (last && last.role === "assistant" && last.content !== "") {
          return [
            ...current,
            { role: "assistant", content: `_Streaming interrupted: ${detail}_` },
          ];
        }
        return [
          ...current,
          { role: "assistant", content: `I couldn't reach the research backend (${detail}). Please try again in a moment.` },
        ];
      });
    } finally {
      window.clearTimeout(stageTimer);
      setChatBusy(false);
      setChatStage("idle");
    }
  }

  function exportUrl(format: string) {
    return brief ? `${API_URL}/api/briefs/${brief.id}/export?format=${format}` : "#";
  }

  // ── File attachments and mic are scoped to the workspace; helpers
  // live inside <ResearchWorkspace> so they share the local ChatMessage
  // history, the file input ref, and the SpeechRecognition ref.

  return (
    <main className={`product-shell stage-${stage}`}>
      {stage === "landing" ? (
        <LandingPage
          question={question}
          setQuestion={setQuestion}
          busy={busy}
          searchPapers={searchPapers}
          setPendingAttachments={setPendingAttachments}
          setPendingDepth={setPendingDepth}
        />
      ) : (
        <ResearchWorkspace
          stage={stage}
          question={question}
          setQuestion={setQuestion}
          papers={papers}
          selected={selected}
          setSelected={setSelected}
          selectedPapers={selectedPapers}
          projectId={projectId}
          brief={brief}
          status={status}
          busy={busy}
          chatBusy={chatBusy}
          citationCount={citationCount}
          briefMeta={briefMeta}
          messages={messages}
          setMessages={setMessages}
          chatInput={chatInput}
          setChatInput={setChatInput}
          chatStage={chatStage}
          milestoneIndex={milestoneIndex}
          searchPapers={searchPapers}
          createProjectAndContinue={createProjectAndContinue}
          uploadPdf={uploadPdf}
          runResearch={runResearch}
          runChat={runChat}
          exportUrl={exportUrl}
          speechHasCommitted={speechHasCommitted}
          setSpeechHasCommitted={setSpeechHasCommitted}
        />
      )}
    </main>
  );
}

function LandingPage({
  question,
  setQuestion,
  busy,
  searchPapers,
  setPendingAttachments,
  setPendingDepth,
}: {
  question: string;
  setQuestion: (value: string) => void;
  busy: boolean;
  searchPapers: (event?: FormEvent) => Promise<void>;
  setPendingAttachments: (value: { filename: string; text: string }[]) => void;
  setPendingDepth: (value: "low" | "medium" | "high") => void;
}) {
  const [recording, setRecording] = useState(false);
  const [landingAttachments, setLandingAttachments] = useState<{ filename: string; text: string }[]>([]);
  const [depth, setDepth] = useState<"low" | "medium" | "high">("medium");
  const [depthMenuOpen, setDepthMenuOpen] = useState(false);
  const depthMenuRef = useRef<HTMLDivElement | null>(null);
  const landingFileInputRef = useRef<HTMLInputElement | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  const supportsSpeech = useMemo(() => {
    if (typeof window === "undefined") return false;
    return Boolean((window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition);
  }, []);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  // Close the depth menu when the user clicks outside of it.
  useEffect(() => {
    if (!depthMenuOpen) return;
    function handle(event: MouseEvent) {
      if (depthMenuRef.current && !depthMenuRef.current.contains(event.target as Node)) {
        setDepthMenuOpen(false);
      }
    }
    function handleEsc(event: KeyboardEvent) {
      if (event.key === "Escape") setDepthMenuOpen(false);
    }
    document.addEventListener("mousedown", handle);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handle);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [depthMenuOpen]);

  const DEPTH_OPTIONS: { value: "low" | "medium" | "high"; label: string; description: string; tag: string }[] = [
    { value: "low", label: "Low", description: "Quick scan, top 8 broad results.", tag: "≈ 6 s" },
    { value: "medium", label: "Medium", description: "Balanced ranking with rerank.", tag: "≈ 18 s" },
    { value: "high", label: "High", description: "Deep expansion, 60 candidates.", tag: "≈ 45 s" },
  ];
  const selectedDepth = DEPTH_OPTIONS.find((option) => option.value === depth) ?? DEPTH_OPTIONS[1];

  function toggleRecording() {
    if (!supportsSpeech) return;
    if (recording) {
      recognitionRef.current?.stop();
      setRecording(false);
      return;
    }
    const SpeechRecognitionCtor = (window as unknown as { SpeechRecognition?: new () => SpeechRecognition; webkitSpeechRecognition?: new () => SpeechRecognition }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognition }).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      setRecording(false);
      return;
    }
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator?.language || "en-US";
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const text = Array.from(event.results)
        .slice(event.resultIndex)
        .map((result) => result[0]?.transcript ?? "")
        .join("");
      setQuestion(text);
    };
    recognition.onerror = () => {
      setRecording(false);
    };
    recognition.onend = () => {
      setRecording(false);
    };
    recognitionRef.current = recognition;
    setRecording(true);
    recognition.start();
  }

  function handleLandingFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (event.target) event.target.value = "";
    if (!file) return;
    const name = file.name;
    const lower = name.toLowerCase();
    (async () => {
      let text = "";
      try {
        if (lower.endsWith(".pdf")) {
          const form = new FormData();
          form.append("file", file);
          const response = await fetch(`${API_URL}/api/extract`, { method: "POST", body: form });
          if (!response.ok) throw new Error(`extract failed (${response.status})`);
          const data = (await response.json()) as { text?: string };
          text = (data.text || "").trim();
        } else if (lower.endsWith(".txt") || lower.endsWith(".md")) {
          text = await file.text();
        } else {
          text = await file.text();
        }
      } catch (error) {
        console.warn(`Could not read "${name}":`, error);
        return;
      }
      text = text.trim().slice(0, 8000);
      if (!text) {
        console.warn(`"${name}" was empty after extraction — not attached.`);
        return;
      }
      setLandingAttachments((current) => [...current, { filename: name, text }]);
    })();
  }

  function removeLandingAttachment(filename: string) {
    setLandingAttachments((current) => current.filter((entry) => entry.filename !== filename));
  }

  function openLandingFilePicker() {
    landingFileInputRef.current?.click();
  }

  async function handleSearch(event?: FormEvent) {
    event?.preventDefault();
    if (!question.trim()) return;
    // Forward the extracted text snippets and the chosen depth to App
    // so they can be uploaded to the new project and used by the LLM
    // during discovery.
    setPendingAttachments(landingAttachments);
    setPendingDepth(depth);
    await searchPapers(event);
    setLandingAttachments([]);
  }

  return (
    <section className="landing-screen">
      <img className="particle-backdrop" src={particleField} alt="" />
      <Particles
        className="hero-particles"
        particleColors={["#ffffff", "#93b1ff", "#f0bf86"]}
        particleCount={180}
        particleSpread={9}
        speed={0.06}
        particleBaseSize={84}
        alphaParticles
        moveParticlesOnHover
        particleHoverFactor={0.45}
      />
      <div className="landing-vignette" />
      <div className="landing-grid" />

      <header className="landing-nav">
        <div className="mark-lockup">
          <div className="mark-orbit">
            <Sparkles size={20} />
          </div>
          <span>Research synthesis engine</span>
        </div>
        <nav className="landing-nav-links">
          <span>v0.1</span>
          <span className="landing-nav-dot" />
          <span className="landing-nav-status">
            <span className="landing-nav-pulse" />
            Backend online
          </span>
        </nav>
      </header>

      <div className="landing-center">
        <div className="landing-eyebrow">
          <span className="landing-eyebrow-dot" />
          New · Citation-traceable briefs
        </div>
        <div className="title-stack">
          <ParticleTitle text="Synthora" />
          <div className="software-subtitle">From search prompt to grounded brief</div>
        </div>
        <p className="landing-tagline">
          A research workbench that expands your question, harvests academic sources, and writes
          a brief whose every claim points back to a real page in a real paper.
        </p>
        <form className="hero-search" onSubmit={handleSearch}>
          <input
            ref={landingFileInputRef}
            type="file"
            accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
            style={{ display: "none" }}
            onChange={handleLandingFile}
          />
          <button
            type="button"
            className={`add-button ${landingAttachments.length ? "active" : ""}`}
            title={landingAttachments.length ? `${landingAttachments.length} file(s) attached` : "Attach a PDF, .txt, or .md"}
            onClick={openLandingFilePicker}
          >
            <FilePlus2 size={22} />
          </button>
          <input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="What research question should we synthesize?" />
          <div className="depth-picker" ref={depthMenuRef}>
            <button
              type="button"
              className={`depth-trigger depth-${depth} ${depthMenuOpen ? "open" : ""}`}
              onClick={() => setDepthMenuOpen((current) => !current)}
              aria-haspopup="listbox"
              aria-expanded={depthMenuOpen}
              aria-label="Research depth"
              title="How deeply should we search?"
            >
              <span className="depth-trigger-glyph" aria-hidden="true">
                <span className="depth-trigger-gear" />
              </span>
              <span className="depth-trigger-text">
                <span className="depth-trigger-label">Depth</span>
                <span className="depth-trigger-value">{selectedDepth.label}</span>
              </span>
              <span className={`depth-trigger-caret ${depthMenuOpen ? "open" : ""}`} aria-hidden="true">
                <svg viewBox="0 0 12 12" width="12" height="12">
                  <path d="M2.5 4.5 L6 8 L9.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </button>
            {depthMenuOpen ? (
              <div className="depth-menu" role="listbox" aria-label="Research depth">
                <div className="depth-menu-header">
                  <span className="depth-menu-title">Thinking depth</span>
                  <span className="depth-menu-sub">Controls the discovery budget</span>
                </div>
                {DEPTH_OPTIONS.map((option, index) => (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={option.value === depth}
                    className={`depth-option depth-option-${option.value} ${option.value === depth ? "selected" : ""}`}
                    onClick={() => {
                      setDepth(option.value);
                      setPendingDepth(option.value);
                      setDepthMenuOpen(false);
                    }}
                    style={{ animationDelay: `${index * 40}ms` }}
                  >
                    <span className="depth-option-radio" aria-hidden="true">
                      <span className="depth-option-radio-dot" />
                    </span>
                    <span className="depth-option-text">
                      <span className="depth-option-row">
                        <span className="depth-option-label">{option.label}</span>
                        <span className="depth-option-tag">{option.tag}</span>
                      </span>
                      <span className="depth-option-description">{option.description}</span>
                    </span>
                    <span className="depth-option-meter" aria-hidden="true">
                      <span className="depth-option-meter-fill" style={{ width: option.value === "low" ? "33%" : option.value === "medium" ? "66%" : "100%" }} />
                    </span>
                  </button>
                ))}
                <div className="depth-menu-footer">
                  <kbd>Esc</kbd> to close
                </div>
              </div>
            ) : null}
          </div>
          {supportsSpeech ? (
            <button
              type="button"
              className={`mic-button ${recording ? "recording" : ""}`}
              title={recording ? "Stop recording" : "Voice input"}
              aria-pressed={recording}
              onClick={toggleRecording}
            >
              <Mic size={18} />
            </button>
          ) : (
            <button type="button" className="mic-button" title="Voice input (not supported in this browser)" disabled>
              <Mic size={18} />
            </button>
          )}
          <button className="submit-orb" disabled={busy || !question.trim()} title="Search papers">
            {busy ? <Loader2 className="spin" size={22} /> : <ArrowRight size={24} />}
          </button>
        </form>
        {landingAttachments.length > 0 ? (
          <div className="landing-attachments">
            {landingAttachments.map((entry) => (
              <span className="landing-attachment-chip" key={entry.filename} title={`${entry.text.length.toLocaleString()} chars will be included`}>
                <FileText size={11} />
                {entry.filename}
                <button type="button" className="chip-remove" onClick={() => removeLandingAttachment(entry.filename)} title="Remove">
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="sample-queries">
          <span className="sample-queries-label">Try a prompt</span>
          <div className="sample-queries-list">
            {SAMPLE_QUERIES.map((sample) => (
              <button
                key={sample}
                type="button"
                className="sample-query"
                onClick={() => setQuestion(sample)}
              >
                {sample}
              </button>
            ))}
          </div>
        </div>
      </div>

      <section className="landing-marquee" aria-hidden="true">
        <div className="landing-marquee-track">
          {Array.from({ length: 2 }).map((_, duplicateIndex) => (
            <div className="landing-marquee-group" key={duplicateIndex}>
              <span>arXiv</span><span>·</span>
              <span>Semantic Scholar</span><span>·</span>
              <span>PDF ingestion</span><span>·</span>
              <span>Claim extraction</span><span>·</span>
              <span>Citation guard</span><span>·</span>
              <span>Cross-source synthesis</span><span>·</span>
              <span>Grounded chat</span><span>·</span>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-capabilities">
        {CAPABILITY_ROWS.map((row) => {
          const Icon = row.icon;
          return (
            <article className="landing-capability" key={row.label}>
              <div className="landing-capability-head">
                <span className="landing-capability-icon">
                  <Icon size={16} />
                </span>
                <span className="landing-capability-label">{row.label}</span>
              </div>
              <h3>{row.title}</h3>
              <p>{row.body}</p>
            </article>
          );
        })}
      </section>

      <section className="landing-quote">
        <Quote className="landing-quote-mark" size={32} />
        <p>
          A research agent that cites where it found things &mdash; and refuses to answer
          when it cannot. No invented sources, no missing pages, no quiet hallucinations.
        </p>
        <span className="landing-quote-attribution">The Synthora citation guard</span>
      </section>
    </section>
  );
}

function ResearchWorkspace(props: {
  stage: Stage;
  question: string;
  setQuestion: (value: string) => void;
  papers: Paper[];
  selected: Record<number, boolean>;
  setSelected: (value: Record<number, boolean>) => void;
  selectedPapers: Paper[];
  projectId: number | null;
  brief: Brief | null;
  status: string;
  busy: boolean;
  chatBusy: boolean;
  citationCount: number;
  briefMeta: { open_questions?: unknown[]; recommended_papers?: unknown[] };
  messages: ChatMessage[];
  setMessages: (value: ChatMessage[] | ((current: ChatMessage[]) => ChatMessage[])) => void;
  chatInput: string;
  setChatInput: (value: string) => void;
  chatStage: "idle" | "searching" | "drafting" | "streaming";
  milestoneIndex: number;
  searchPapers: (event?: FormEvent) => Promise<void>;
  createProjectAndContinue: () => Promise<void>;
  uploadPdf: (file: File) => Promise<void>;
  runResearch: () => Promise<void>;
  runChat: (userText: string, activeAttachments: { filename: string; text: string }[]) => Promise<void>;
  exportUrl: (format: string) => string;
  speechHasCommitted: boolean;
  setSpeechHasCommitted: (value: boolean) => void;
}) {
  const {
    stage,
    question,
    setQuestion,
    papers,
    selected,
    setSelected,
    selectedPapers,
    projectId,
    brief,
    status,
    busy,
    chatBusy,
  citationCount,
  briefMeta,
  messages,
    setMessages,
    chatInput,
    setChatInput,
    chatStage,
    milestoneIndex,
    searchPapers,
    createProjectAndContinue,
    uploadPdf,
    runResearch,
    runChat,
    exportUrl,
    speechHasCommitted,
    setSpeechHasCommitted,
  } = props;

  // ── Chat composer state (attachments, mic, file picker) ─────────────
  // All chat-composer-specific UI lives in the workspace, not in App,
  // so the helpers here can read the live `messages` list, mutate
  // `chatInput` directly while recording, and own a single SpeechRecognition
  // instance for the lifetime of this workspace.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const [recording, setRecording] = useState(false);
  const [attachments, setAttachments] = useState<{ filename: string; text: string }[]>([]);
  const supportsSpeech = useMemo(() => {
    if (typeof window === "undefined") return false;
    return Boolean((window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition);
  }, []);

  async function handleChatFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (event.target) event.target.value = "";
    if (!file) return;
    const name = file.name;
    const lower = name.toLowerCase();
    let text = "";
    try {
      if (lower.endsWith(".pdf")) {
        const form = new FormData();
        form.append("file", file);
        const response = await fetch(`${API_URL}/api/extract`, { method: "POST", body: form });
        if (!response.ok) throw new Error(`extract failed (${response.status})`);
        const data = (await response.json()) as { text?: string };
        text = (data.text || "").trim();
      } else if (lower.endsWith(".txt") || lower.endsWith(".md")) {
        text = await file.text();
      } else {
        text = await file.text();
      }
    } catch (error) {
      setMessages((current) => [
        ...current,
        { role: "assistant", content: `Could not read "${name}": ${(error as Error).message}` },
      ]);
      return;
    }
    text = text.trim().slice(0, 8000);
    if (!text) {
      setMessages((current) => [
        ...current,
        { role: "assistant", content: `"${name}" was empty after extraction — nothing attached.` },
      ]);
      return;
    }
    setAttachments((current) => [...current, { filename: name, text }]);
  }

  function removeAttachment(filename: string) {
    setAttachments((current) => current.filter((entry) => entry.filename !== filename));
  }

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  function toggleRecording() {
    if (!supportsSpeech) return;
    if (recording) {
      recognitionRef.current?.stop();
      setRecording(false);
      return;
    }
    const SpeechRecognitionCtor = (window as unknown as { SpeechRecognition?: new () => SpeechRecognition; webkitSpeechRecognition?: new () => SpeechRecognition }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognition }).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      setRecording(false);
      return;
    }
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator?.language || "en-US";

    // Capture whatever the user had in the input at the moment the
    // mic was pressed. The recognizer's transcripts will be
    // *appended* to this base text rather than replacing it.
    const baseText = chatInput;

    // We keep a running transcript in a closure-local variable so we
    // can rewrite the entire chatInput on every onresult tick (the
    // final committed text, then a single interim overlay). This
    // avoids the bug where successive interim fragments accumulate
    // and the user's pre-existing text gets clobbered.
    let finalText = "";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      // Walk the result list and rebuild the committed final transcript
      // from scratch — it's cheap and avoids subtle bookkeeping. The
      // last un-final result is treated as the live interim.
      let newFinal = "";
      let latestInterim = "";
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result) continue;
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          newFinal += transcript;
        } else {
          latestInterim = transcript;
        }
      }
      finalText = newFinal;
      setChatInput(`${baseText}${newFinal}${latestInterim ? (newFinal && !newFinal.endsWith(" ") ? " " : "") + latestInterim : ""}`);
    };
    recognition.onerror = () => {
      setRecording(false);
    };
    recognition.onend = () => {
      setRecording(false);
    };
    recognitionRef.current = recognition;
    setChatInput(baseText);
    setRecording(true);
    recognition.start();
  }

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  return (
    <section className="workspace-screen">
      <aside className="workspace-sidebar">
        <div className="mark-lockup compact">
          <div className="mark-orbit">
            <Sparkles size={17} />
          </div>
          <span className="sidebar-title">Synthora</span>
        </div>
        <div className="progress-rail">
          <ProgressItem active={stage === "select"} done={papers.length > 0} label="Discover" />
          <ProgressItem active={stage === "materials"} done={!!projectId} label="Materials" />
          <ProgressItem active={stage === "researching"} done={!!brief} label="Research" />
          <ProgressItem active={stage === "chat"} done={stage === "chat"} label="Chat" />
        </div>
        <div className="source-summary">
          <Stat label="Papers" value={papers.length} />
          <Stat label="Selected" value={selectedPapers.length} />
          <Stat label="Citations" value={citationCount} />
        </div>
      </aside>

      <section className="workspace-main">
        <header className="workspace-topbar">
          <form className="compact-search" onSubmit={searchPapers}>
            <Search size={16} />
            <input value={question} onChange={(event) => setQuestion(event.target.value)} />
          </form>
          <div className={`status-chip ${busy || chatBusy ? "busy" : ""}`}>
            <span />
            {status}
          </div>
        </header>

        {stage === "discovering" && (
          <section className="discovering-view view-panel">
            <div className="discovering-shell">
              <div className="discovering-stage">
                <div className="discovering-orb">
                  <div className="discovering-orb-satellite s1" />
                  <div className="discovering-orb-satellite s2" />
                  <div className="discovering-orb-satellite s3" />
                  <div className="discovering-orb-core">
                    <Loader2 className="spin" size={44} />
                  </div>
                </div>
                <div className="discovering-copy">
                  <span className="discovering-eyebrow">Paper discovery in progress</span>
                  <h2>
                    Finding the <em>strongest</em> papers for your question
                  </h2>
                  <p>The search has already moved past the landing page. We are expanding the query, filtering weak matches, and ranking papers for relevance.</p>
                  <div className="discovering-ticker">
                    <span>Query</span>
                    <strong>"{question}"</strong>
                  </div>
                </div>
              </div>
              <div className="discovering-steps">
                {DISCOVERY_STEPS.map((step, index) => (
                  <div className={`discovering-step ${index === 0 ? "active" : ""}`} key={step}>
                    <div className="discovering-step-head">
                      <span className="discovering-step-index">{index + 1}</span>
                      <span className="discovering-step-tag">Step {index + 1} of {DISCOVERY_STEPS.length}</span>
                    </div>
                    <p className="discovering-step-text">{step}</p>
                    <div className="discovering-step-progress">
                      <div className="discovering-step-progress-bar" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {stage === "select" && (
          <section className="paper-selection view-panel">
            <div className="view-heading">
              <div>
                <span className="kicker">Paper discovery</span>
                <h2>Select papers to ingest</h2>
              </div>
              <button className="primary-action" onClick={createProjectAndContinue} disabled={!selectedPapers.length || busy}>
                Continue
                <ArrowRight size={17} />
              </button>
            </div>
            <div className="paper-grid">
              {papers.map((paper, index) => (
                <label className={`paper-card ${selected[index] ? "selected" : ""}`} key={`${paper.source_provider}-${paper.title}-${index}`}>
                  <input type="checkbox" checked={!!selected[index]} onChange={(event) => setSelected({ ...selected, [index]: event.target.checked })} />
                  <div className="paper-card-copy">
                    <div className="paper-score">{paper.relevance_score.toFixed(2)}</div>
                    <h3>{paper.title}</h3>
                    <p>{paper.abstract?.slice(0, 260) || "No abstract available."}</p>
                    <div className="paper-meta">
                      <span>{paper.year ?? "n.d."}</span>
                      <span>{paper.source_provider}</span>
                      <span>{paper.pdf_url ? "PDF" : "metadata"}</span>
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </section>
        )}

        {stage === "materials" && (
          <section className="materials-view view-panel">
            <div className="material-prompt">
              <div className="prompt-icon">
                <Paperclip size={26} />
              </div>
              <span className="kicker">Additional materials</span>
              <h2>Add PDFs, notes, or proceed with discovered papers?</h2>
              <p>Selected papers with accessible PDFs will be ingested automatically. Upload extra PDFs only when you want the brief to include private or local material.</p>
              <div className="material-actions">
                <label className="secondary-action upload-control">
                  <Upload size={17} />
                  Upload PDFs
                  <input type="file" accept="application/pdf" disabled={busy} onChange={(event) => event.target.files?.[0] && uploadPdf(event.target.files[0])} />
                </label>
                <button className="primary-action" onClick={runResearch} disabled={busy}>
                  Start research
                  <Play size={17} />
                </button>
              </div>
            </div>
          </section>
        )}

        {stage === "researching" && (
          <section className="researching-view view-panel">
            <div className="research-header">
              <div className="research-header-text">
                <span className="kicker">Research in progress</span>
                <h2>Working through the corpus</h2>
              </div>
              <div className="research-pulse">
                <span className="pulse-dot" />
                Live
              </div>
            </div>
            <div className="research-grid">
              <div className="research-stage-card">
                <div className="research-stage-glow" />
                <div className="research-stage-icon">
                  <WandSparkles size={26} />
                </div>
                <div className="research-stage-counter">
                  Milestone <strong>{milestoneIndex + 1} / {RESEARCH_MILESTONES.length}</strong>
                </div>
                <h3>{RESEARCH_MILESTONES[milestoneIndex].title}</h3>
                <p>{RESEARCH_MILESTONES[milestoneIndex].detail}</p>
                <div className="research-stage-progress">
                  <div
                    className="research-stage-progress-bar"
                    style={{ width: `${((milestoneIndex + 1) / RESEARCH_MILESTONES.length) * 100}%` }}
                  />
                </div>
                <div className="research-status-text">{status}</div>
              </div>
              <div className="milestone-list">
                {RESEARCH_MILESTONES.map((milestone, index) => {
                  const state = index < milestoneIndex ? "done" : index === milestoneIndex ? "active" : "pending";
                  return (
                    <div className={`milestone-row ${state}`} key={milestone.title}>
                      <div className="milestone-rail">
                        <div className="milestone-node">
                          {state === "done" ? <Check size={14} /> : index + 1}
                        </div>
                      </div>
                      <div className="milestone-copy">
                        <div className="milestone-copy-row">
                          <strong>{milestone.title}</strong>
                          <em>{state === "done" ? "Completed" : state === "active" ? "In progress" : "Pending"}</em>
                        </div>
                        <span>{milestone.detail}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        )}

        {stage === "chat" && brief && (
          <section className="chat-layout">
            <aside className="brief-pane">
              <div className="brief-pane-head">
                <div className="brief-pane-head-text">
                  <span className="kicker">Cited brief</span>
                  <span style={{ fontSize: 12, color: "var(--text-3)" }}>{brief.sections.length} themes · {citationCount} citations</span>
                </div>
                <div className="export-row">
                  {["markdown", "docx", "bibtex", "ris", "csl-json"].map((format) => (
                    <a className="icon-link" href={exportUrl(format)} key={format} title={`Export ${format}`}>
                      <Download size={12} />
                      {format}
                    </a>
                  ))}
                </div>
              </div>
              <div className="brief-scroll">
                <MarkdownBlock className="executive-summary" content={normalizeSummary(brief.executive_summary)} />
                {brief.validation_errors.length > 0 && <div className="warning-banner">{brief.validation_errors.join(" ")}</div>}
                {briefMeta.open_questions?.length ? (
                  <div className="brief-meta-panel">
                    <h4>Open questions</h4>
                    <ul>
                      {briefMeta.open_questions.map((item, idx) => {
                        const obj = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : null;
                        const question = obj && typeof obj.question === "string" ? obj.question
                          : obj && typeof obj.text === "string" ? obj.text
                          : typeof item === "string" ? item
                          : JSON.stringify(item);
                        const theme = obj && typeof obj.theme === "string" ? obj.theme : null;
                        const citations = obj && Array.isArray(obj.citations) ? (obj.citations as string[]) : [];
                        return (
                          <li key={`oq-${idx}-${question.slice(0, 32)}`}>
                            {theme ? <strong>{theme} — </strong> : null}
                            {question}
                            {citations.length > 0 ? (
                              <span className="meta-citation-row">
                                {citations.map((c, cidx) => (
                                  <span key={`oq-${idx}-c-${cidx}-${c}`}>{c}</span>
                                ))}
                              </span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
                {briefMeta.recommended_papers?.length ? (
                  <div className="brief-meta-panel recommended">
                    <h4>Recommended next papers</h4>
                    <ul>
                      {briefMeta.recommended_papers.map((item, idx) => {
                        const obj = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : null;
                        const title = obj && typeof obj.title === "string" ? obj.title
                          : obj && typeof obj.name === "string" ? obj.name
                          : typeof item === "string" ? item
                          : `Paper ${idx + 1}`;
                        const why = obj && typeof obj.why_relevant === "string" ? obj.why_relevant : null;
                        const citations = obj && Array.isArray(obj.citations) ? (obj.citations as string[]) : [];
                        return (
                          <li key={`rp-${idx}-${title.slice(0, 32)}`}>
                            <strong>{title}</strong>
                            {why ? <div className="meta-relevance">{why}</div> : null}
                            {citations.length > 0 ? (
                              <span className="meta-citation-row">
                                {citations.map((c, cidx) => (
                                  <span key={`rp-${idx}-c-${cidx}-${c}`}>{c}</span>
                                ))}
                              </span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
                <div className="brief-section-list">
                  {brief.sections.map((section) => (
                    <details className="brief-section" key={section.theme} open>
                      <summary>
                        <span>{section.theme}</span>
                        <em>{section.consensus_status}</em>
                        <span className="chevron"><ChevronRight size={14} /></span>
                      </summary>
                      <div className="brief-section-body">
                        {section.summary ? <MarkdownBlock className="brief-section-summary" content={normalizeSummary(section.summary)} /> : null}
                        {section.claims.map((claim, index) => (
                          <div className="brief-claim" key={`${section.theme}-${index}`}>
                            <MarkdownBlock className="brief-claim-text" content={claim.text} />
                            <div className="brief-claim-meta">
                              <span>{claim.paper_title ?? "Unknown paper"}</span>
                              <span>{claim.section ?? "Unknown section"}</span>
                              <span>{claim.page ? `p. ${claim.page}` : "page n/a"}</span>
                              <span>{claim.confidence ? `${Math.round(claim.confidence * 100)}% confidence` : "traceable"}</span>
                            </div>
                            {claim.support_excerpt ? <div className="brief-claim-excerpt">"{claim.support_excerpt}"</div> : null}
                            <div className="claim-citations">
                              {claim.citations.map((citation, cidx) => (
                                <span key={`${section.theme}-${index}-c-${cidx}-${citation}`}>{citation}</span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            </aside>

            <section className="chat-pane">
              <header className="chat-header">
                <div className="chat-header-text">
                  <span className="kicker">Research assistant</span>
                  <h3>Grounded in {brief.sections.length} themes</h3>
                </div>
                <span className="chat-status">Cited · Verified</span>
              </header>
              <div className="chat-messages">
                {messages.map((message, index) => {
                  const isLast = index === messages.length - 1;
                  const isStreamingAssistant =
                    isLast && message.role === "assistant" && chatBusy && chatStage === "streaming";
                  const isPendingAssistant =
                    isLast && message.role === "assistant" && chatBusy && (chatStage === "searching" || chatStage === "drafting");
                  return (
                    <div className={`chat-message ${message.role}`} key={`${message.role}-${index}`}>
                      {message.role === "assistant" && (
                        <div className="message-avatar"><Bot size={15} /></div>
                      )}
                      <div>
                        {isPendingAssistant ? (
                          <div className="message-bubble typing-bubble" aria-live="polite">
                            <span />
                            <span />
                            <span />
                          </div>
                        ) : (
                          <div className={`message-bubble ${isStreamingAssistant ? "streaming-bubble" : ""}`}>
                            {message.role === "assistant" ? (
                              <>
                                <MarkdownBlock content={message.content} />
                                {isStreamingAssistant ? <span className="stream-cursor" aria-hidden="true" /> : null}
                              </>
                            ) : (
                              message.content
                            )}
                          </div>
                        )}
                        <div className="message-meta">
                          <strong>{message.role === "assistant" ? "Synthora" : "You"}</strong>
                          <span>·</span>
                          <span>
                            {isPendingAssistant && chatStage === "searching" && "Searching the brief…"}
                            {isPendingAssistant && chatStage === "drafting" && "Drafting answer…"}
                            {isStreamingAssistant && "Synthesizing · streaming"}
                            {!isPendingAssistant && !isStreamingAssistant && (message.role === "assistant" ? "Cited from brief" : "Sent")}
                          </span>
                        </div>
                      </div>
                      {message.role === "user" && (
                        <div className="message-avatar">YN</div>
                      )}
                    </div>
                  );
                })}
              </div>
              {messages.length <= 1 && !chatBusy ? (
                <div className="chat-suggestions">
                  {CHAT_SUGGESTIONS.map((suggestion) => (
                    <button
                      type="button"
                      className="chat-suggestion"
                      key={suggestion}
                      onClick={() => setChatInput(suggestion)}
                    >
                      <Sparkles size={11} />
                      {suggestion}
                    </button>
                  ))}
                </div>
              ) : null}
              {attachments.length > 0 ? (
                <div className="chat-attachments">
                  {attachments.map((entry) => (
                    <div className="chat-attachment-chip" key={entry.filename} title={`${entry.text.length.toLocaleString()} chars will be included as context`}>
                      <FileText size={12} />
                      <span className="chat-attachment-name">{entry.filename}</span>
                      <button
                        type="button"
                        className="chat-attachment-remove"
                        aria-label={`Remove ${entry.filename}`}
                        onClick={() => removeAttachment(entry.filename)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <form
                className="chat-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  const text = chatInput.trim();
                  if (!text) return;
                  void runChat(text, attachments);
                  setAttachments([]);
                }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.txt,.md,text/plain,text/markdown,application/pdf"
                  style={{ display: "none" }}
                  onChange={handleChatFile}
                />
                <button type="button" className={`icon-button ${attachments.length ? "active" : ""}`} title="Attach a PDF, .txt, or .md" onClick={openFilePicker}>
                  <Paperclip size={17} />
                </button>
                <input value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder="Ask about consensus, conflicts, limitations, or evidence..." />
                {supportsSpeech ? (
                  <button
                    type="button"
                    className={`icon-button mic-button-inline ${recording ? "recording" : ""}`}
                    title={recording ? "Stop recording" : "Voice input"}
                    aria-pressed={recording}
                    onClick={toggleRecording}
                  >
                    <Mic size={17} />
                  </button>
                ) : null}
                <button className="send-button" type="submit" disabled={!chatInput.trim() || chatBusy} title="Send">
                  <Send size={17} />
                </button>
              </form>
            </section>
          </section>
        )}
      </section>
    </section>
  );
}

function MarkdownBlock({ content, className = "" }: { content: string; className?: string }) {
  const safe = typeof content === "string" ? content : normalizeSummary(content);
  return (
    <div className={`markdown-block ${className}`.trim()}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{safe}</ReactMarkdown>
    </div>
  );
}

/**
 * Backend sections sometimes return `summary` as an array of bullet
 * objects (`[{ text, citations }, ...]`) rather than a single markdown
 * string. Normalize that shape — and any other non-string content — into
 * a flat markdown string that react-markdown can parse.
 */
function normalizeSummary(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (entry == null) return "";
        if (typeof entry === "string") return entry;
        if (typeof entry === "object") {
          const obj = entry as Record<string, unknown>;
          const text = typeof obj.text === "string" ? obj.text : "";
          const citations = Array.isArray(obj.citations)
            ? (obj.citations as unknown[]).filter((c) => typeof c === "string")
            : [];
          const tail = citations.length ? ` ${citations.map((c) => `[${c}]`).join(" ")}` : "";
          return text ? `- ${text}${tail}` : "";
        }
        return String(entry);
      })
      .filter(Boolean)
      .join("\n\n");
  }
  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
  }
  return String(content);
}

function ProgressItem({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return (
    <div className={`progress-item ${active ? "active" : ""} ${done ? "done" : ""}`}>
      <span>{done ? <Check size={13} /> : null}</span>
      {label}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
