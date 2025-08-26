import React, { useEffect, useMemo, useRef, useState } from "react";
import { saveAs } from "file-saver";
import { jsPDF } from "jspdf";
import "./theme.css";

// ================= Quantum math utils =================
const SQRT1_2 = Math.SQRT1_2;

type Complex = { re: number; im: number };
const c = (re = 0, im = 0): Complex => ({ re, im });
const add = (a: Complex, b: Complex) => c(a.re + b.re, a.im + b.im);
const mul = (a: Complex, b: Complex) =>
  c(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const norm2 = (a: Complex) => a.re * a.re + a.im * a.im;

function zeroState(nQubits: number): Complex[] {
  const N = 1 << nQubits;
  const st = Array.from({ length: N }, () => c(0, 0));
  st[0] = c(1, 0);
  return st;
}

function apply1Q(
  st: Complex[],
  t: number,
  m00: Complex,
  m01: Complex,
  m10: Complex,
  m11: Complex
) {
  const N = st.length;
  const bit = 1 << t;
  for (let i = 0; i < N; i++) {
    if ((i & bit) === 0) {
      const j = i | bit;
      const a0 = st[i];
      const a1 = st[j];
      const r0 = add(mul(m00, a0), mul(m01, a1));
      const r1 = add(mul(m10, a0), mul(m11, a1));
      st[i] = r0;
      st[j] = r1;
    }
  }
}

function applyX(st: Complex[], t: number) {
  const N = st.length;
  const bit = 1 << t;
  for (let i = 0; i < N; i++) {
    if ((i & bit) === 0) {
      const j = i | bit;
      const tmp = st[i];
      st[i] = st[j];
      st[j] = tmp;
    }
  }
}

function applyH(st: Complex[], t: number) {
  const s = SQRT1_2;
  apply1Q(st, t, c(s, 0), c(s, 0), c(s, 0), c(-s, 0));
}

function applyCX(st: Complex[], control: number, target: number) {
  const N = st.length;
  const cbit = 1 << control;
  const tbit = 1 << target;
  for (let i = 0; i < N; i++) {
    if ((i & cbit) !== 0 && (i & tbit) === 0) {
      const j = i | tbit;
      const tmp = st[i];
      st[i] = st[j];
      st[j] = tmp;
    }
  }
}

function probsFromState(st: Complex[]): number[] {
  return st.map((z) => norm2(z));
}

function sampleCounts(probs: number[], shots: number): Record<string, number> {
  const counts: Record<string, number> = {};
  const N = probs.length;
  for (let s = 0; s < shots; s++) {
    let r = Math.random();
    let acc = 0;
    for (let i = 0; i < N; i++) {
      acc += probs[i];
      if (r <= acc) {
        const key = i.toString(2).padStart(Math.log2(N), "0");
        counts[key] = (counts[key] || 0) + 1;
        break;
      }
    }
  }
  return counts;
}

// ================= Circuit model =================
type GateType = "H" | "X" | "CX" | "MEASURE";
type Gate = { id: string; type: GateType; targets: number[] };
type Moment = { t: number; gates: Gate[] };
type Circuit = { nQubits: number; moments: Moment[] };

function emptyCircuit(nQubits = 2): Circuit {
  return { nQubits, moments: [] };
}

function simulateCircuit(circ: Circuit) {
  let st = zeroState(circ.nQubits);
  for (const m of circ.moments) {
    for (const g of m.gates) {
      if (g.type === "H") applyH(st, g.targets[0]);
      else if (g.type === "X") applyX(st, g.targets[0]);
      else if (g.type === "CX") applyCX(st, g.targets[0], g.targets[1]);
      // MEASURE: no collapse; we show probabilities
    }
  }
  const probs = probsFromState(st);
  return { probs };
}

// ================= UI & helpers =================
function uid() {
  return Math.random().toString(36).slice(2, 9);
}

const GATE_LABEL: Record<GateType, string> = {
  H: "H",
  X: "X",
  CX: "●⊕",
  MEASURE: "M",
};

const THEMES = {
  light: {
    bg: "#ffffff",
    grid: "#e5e7eb",
    wire: "#9ca3af",
    node: "#6b7280",
    text: "#1f2937",
    label: "#6b7280",
    select: "#14b8a6",
    gates: {
      hFill: "#ef4444",      // H red
      hText: "#ffffff",
      xStroke: "#3b82f6",    // ⊕ blue (X and CNOT target)
      cxControl: "#3b82f6",  // control dot
      measureStroke: "#6b7280",
    },
  },
  dark: {
    bg: "#0f172a",
    grid: "#1e293b",
    wire: "#64748b",
    node: "#94a3b8",
    text: "#f8fafc",
    label: "#94a3b8",
    select: "#22d3ee",
    gates: {
      hFill: "#ef4444",
      hText: "#ffffff",
      xStroke: "#60a5fa",
      cxControl: "#60a5fa",
      measureStroke: "#cbd5e1",
    },
  },
};
type ThemeKey = keyof typeof THEMES;

// ================= Main App =================
export default function App() {
  const [circuit, setCircuit] = useState<Circuit>(() => emptyCircuit(2));
  const [shots, setShots] = useState(512);
  const [theme, setTheme] = useState<ThemeKey>("light");
  const [selected, setSelected] = useState<{ t: number; id: string } | null>(null);

  // drag state
  const [drag, setDrag] = useState<
    | null
    | {
        id: string;
        t: number;
        type: GateType;
        targets: number[];
        dx: number;
        dy: number;
        transformPx?: { tx: number; ty: number };
      }
  >(null);

  // zoom via container scrollbars
  const [canvasZoom, setCanvasZoom] = useState(1);
  const svgContainerRef = useRef<HTMLDivElement | null>(null);
  const [fitKey, setFitKey] = useState(0);

  // Space+drag (or middle mouse) → pan by scrolling
  const [spaceDown, setSpaceDown] = useState(false);
  const panStartRef = useRef<{ x: number; y: number; sx: number; sy: number } | null>(null);

  useEffect(() => {
    const kd = (e: KeyboardEvent) => { if (e.code === "Space") setSpaceDown(true); };
    const ku = (e: KeyboardEvent) => { if (e.code === "Space") setSpaceDown(false); };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => { window.removeEventListener("keydown", kd); window.removeEventListener("keyup", ku); };
  }, []);

  const beginPanScroll = (clientX: number, clientY: number) => {
    const el = svgContainerRef.current!;
    panStartRef.current = { x: clientX, y: clientY, sx: el.scrollLeft, sy: el.scrollTop };
  };
  const movePanScroll = (clientX: number, clientY: number) => {
    const s = panStartRef.current; if (!s || !svgContainerRef.current) return;
    const el = svgContainerRef.current;
    el.scrollLeft = s.sx - (clientX - s.x);
    el.scrollTop  = s.sy - (clientY - s.y);
  };
  const endPanScroll = () => { panStartRef.current = null; };

  // Wheel/trackpad pinch to zoom (container-level) with cursor anchor
  const onContainerWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    // zoom always
    e.preventDefault();
    const el = svgContainerRef.current;
    if (!el) return;

    // Normalize deltas across devices/browsers
    // deltaMode: 0=pixel, 1=line, 2=page
    const LINE_HEIGHT = 16; // typical line height
    const deltaY =
      e.deltaMode === 1 ? e.deltaY * LINE_HEIGHT :
      e.deltaMode === 2 ? e.deltaY * window.innerHeight :
      e.deltaY;

    const delta = -deltaY; // up => zoom in
    const factor = Math.exp(delta * 0.0012); // slightly gentler
    const newZ = Math.min(3, Math.max(0.4, canvasZoom * factor));

    const rect = el.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    // Content coords (unscaled) under cursor
    const ux = (el.scrollLeft + cx) / canvasZoom;
    const uy = (el.scrollTop  + cy) / canvasZoom;

    setCanvasZoom(+newZ.toFixed(2));

    requestAnimationFrame(() => {
      el.scrollLeft = ux * newZ - cx;
      el.scrollTop  = uy * newZ - cy;
    });
  };

  useEffect(() => {
    const el = svgContainerRef.current;

    const onDbl = () => setFitKey(k => k + 1);
    el?.addEventListener("dblclick", onDbl);

    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "0") { e.preventDefault(); setFitKey(k => k + 1); }
      if ((e.ctrlKey || e.metaKey) && e.key === "1") {
        e.preventDefault();
        setCanvasZoom(1);
        const c = svgContainerRef.current; if (c) { c.scrollLeft = 0; c.scrollTop = 0; }
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === "=" || e.key === "+") { // zoom in
          const c = svgContainerRef.current; if (!c) return;
          const cx = c.clientWidth / 2, cy = c.clientHeight / 2;
          const ux = (c.scrollLeft + cx) / canvasZoom;
          const uy = (c.scrollTop  + cy) / canvasZoom;
          const z = Math.min(3, +(canvasZoom * 1.1).toFixed(2));
          setCanvasZoom(z);
          requestAnimationFrame(() => { c.scrollLeft = ux * z - cx; c.scrollTop = uy * z - cy; });
        }
        if (e.key === "-" || e.key === "_") { // zoom out
          const c = svgContainerRef.current; if (!c) return;
          const cx = c.clientWidth / 2, cy = c.clientHeight / 2;
          const ux = (c.scrollLeft + cx) / canvasZoom;
          const uy = (c.scrollTop  + cy) / canvasZoom;
          const z = Math.max(0.4, +(canvasZoom / 1.1).toFixed(2));
          setCanvasZoom(z);
          requestAnimationFrame(() => { c.scrollLeft = ux * z - cx; c.scrollTop = uy * z - cy; });
        }
        if (e.key.toLowerCase() === "f") setFitKey(k => k + 1);
        if (e.key.toLowerCase() === "s" && selected) {
          // center on selected gate
          const cellW = 72, cellH = 56, labelW = 36;
          const m = circuit.moments.find(mm => mm.t === selected.t);
          const g = m?.gates.find(gg => gg.id === selected.id);
          if (!g) return;
          const gx = 24 + labelW + selected.t * cellW + cellW / 2;
          const gy = 24 + (g.targets[0] * cellH) + cellH / 2;

          const c = svgContainerRef.current; if (!c) return;
          const targetLeft = gx * canvasZoom - c.clientWidth / 2;
          const targetTop  = gy * canvasZoom - c.clientHeight / 2;
          c.scrollLeft = Math.max(0, targetLeft);
          c.scrollTop  = Math.max(0, targetTop);
        }
      }
    };

  window.addEventListener("keydown", onKey);
  return () => {
    el?.removeEventListener("dblclick", onDbl);
    window.removeEventListener("keydown", onKey);
  };
}, [canvasZoom, selected, circuit]);


  const svgRef = useRef<SVGSVGElement | null>(null);

  const addMoment = () => {
    setCircuit((c) => ({ ...c, moments: [...c.moments, { t: c.moments.length, gates: [] }] }));
  };

  const ensureMoment = (t: number) => {
    setCircuit((c) => {
      if (t < c.moments.length) return c;
      const ms = [...c.moments];
      while (ms.length <= t) ms.push({ t: ms.length, gates: [] });
      return { ...c, moments: ms };
    });
  };

  const addGate = (type: GateType, q0: number, t: number, q1?: number) => {
    ensureMoment(t);
    setCircuit((c) => {
      const ms = c.moments.map((m) => ({ ...m, gates: [...m.gates] }));
      const gate: Gate = { id: uid(), type, targets: type === "CX" ? [q0, q1 ?? (q0 ^ 1)] : [q0] };
      ms[t].gates.push(gate);
      return { ...c, moments: ms };
    });
  };

  const removeLast = () => {
    setCircuit((c) => {
      const ms = [...c.moments];
      if (ms.length === 0) return c;
      const last = ms[ms.length - 1];
      if (last.gates.length > 0) last.gates.pop();
      else ms.pop();
      return { ...c, moments: ms };
    });
  };

  const setQubits = (n: number) => {
    const nClamped = Math.max(1, Math.min(12, n));
    setCircuit(() => emptyCircuit(nClamped));
    setSelected(null);
    setFitKey((k) => k + 1);
  };

  const deleteSelectedGate = () => {
    if (!selected) return;
    setCircuit((c) => {
      const ms = c.moments.map((m) =>
        m.t === selected.t ? { ...m, gates: m.gates.filter((g) => g.id !== selected.id) } : m
      );
      return { ...c, moments: ms };
    });
    setSelected(null);
  };

  // keyboard delete
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selected) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelectedGate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const { probs, counts } = useMemo(() => {
    const { probs } = simulateCircuit(circuit);
    const counts = sampleCounts(probs, shots);
    return { probs, counts };
  }, [circuit, shots]);

  // -------- Export helpers --------
  const serializeSVG = () => {
    const svg = svgRef.current;
    if (!svg) return "";
    const cloned = svg.cloneNode(true) as SVGSVGElement;
    cloned.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const svgData = new XMLSerializer().serializeToString(cloned);
    return svgData;
  };
  const svgToCanvas = async (scale = 3) => {
    const data = serializeSVG();
    const img = new Image();
    const themeBg = THEMES[theme].bg;
    const can = document.createElement("canvas");
    const svg = svgRef.current!;
    const vb = svg.viewBox.baseVal;
    const w = vb && vb.width ? vb.width : svg.clientWidth;
    const h = vb && vb.height ? vb.height : svg.clientHeight;
    can.width = Math.max(1, Math.ceil(w * scale));
    can.height = Math.max(1, Math.ceil(h * scale));
    const ctx = can.getContext("2d");
    if (!ctx) throw new Error("Canvas not supported");
    await new Promise<void>((resolve) => {
      img.onload = () => {
        ctx.fillStyle = themeBg as string;
        ctx.fillRect(0, 0, can.width, can.height);
        ctx.drawImage(img, 0, 0, can.width, can.height);
        resolve();
      };
      img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(data)))}`;
    });
    return can;
  };
  const downloadSVG = () => {
    const data = serializeSVG();
    const blob = new Blob([data], { type: "image/svg+xml;charset=utf-8" });
    saveAs(blob, "circuit.svg");
  };
  const downloadPNG = async () => {
    const can = await svgToCanvas(3);
    can.toBlob((blob) => blob && saveAs(blob, "circuit.png"), "image/png");
  };
  const downloadJPG = async () => {
    const can = await svgToCanvas(3);
    can.toBlob((blob) => blob && saveAs(blob, "circuit.jpg"), "image/jpeg", 0.95);
  };
  const downloadPDF = async () => {
    const can = await svgToCanvas(3);
    const imgData = can.toDataURL("image/png");
    const pdf = new jsPDF({
      orientation: can.width > can.height ? "l" : "p",
      unit: "pt",
      format: [can.width, can.height],
    });
    pdf.addImage(imgData, "PNG", 0, 0, can.width, can.height);
    pdf.save("circuit.pdf");
  };

  const T = THEMES[theme];

  // Fit to container whenever layout changes or Fit pressed
  useEffect(() => {
    const el = svgContainerRef.current;
    if (!el) return;

    // match CircuitSVG’s content metrics (NO padding)
    const cellW = 72, cellH = 56, labelW = 36;
    const cols = Math.max(1, circuit.moments.length || 1);
    const contentW = labelW + cols * cellW;
    const contentH = circuit.nQubits * cellH;

    const margin = 16;
    const fitX = contentW / Math.max(1, el.clientWidth  - margin);
    const fitY = contentH / Math.max(1, el.clientHeight - margin);
    const z = 1 / Math.max(fitX, fitY);
    const nz = Math.min(3, Math.max(0.4, +z.toFixed(2)));
    setCanvasZoom(nz);

    requestAnimationFrame(() => {
      const pxW = contentW * nz, pxH = contentH * nz;
      el.scrollLeft = Math.max(0, (pxW - el.clientWidth)  / 2);
      el.scrollTop  = Math.max(0, (pxH - el.clientHeight) / 2);
    });
  }, [fitKey, circuit.moments.length, circuit.nQubits]); // ← remove `padding` from deps

  return (
    <div className="neon-bg" style={{ color: T.text, fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto" }}>
      <div className="app-wrap">
        <header className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <h1 className="h1" style={{ fontSize: 22, fontWeight: 700 }}>Quantum Circuit Designer</h1>
          <div className="row">
            <button className="btn btn-ghost" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
              Theme: {theme}
            </button>
            <label>
              Qubits
              <input className="input" type="number" min={1} max={12} value={circuit.nQubits}
                onChange={(e) => setQubits(parseInt(e.target.value || "1"))} style={{ width: 64 }} />
            </label>
            <label>
              Shots
              <input className="input" type="number" min={1} max={100000} value={shots}
                onChange={(e) => setShots(parseInt(e.target.value || "512"))} style={{ width: 92 }} />
            </label>
          </div>
        </header>

        <section className="responsive-grid" style={{ display: "grid", gap: 16 }}>
          {/* Left: Controls */}
          <div className="stack">
            <div className="card" style={{ padding: 12 }}>
              <h3 style={{ marginTop: 0 }}>Gate Palette</h3>
              <div className="grid-2">
                <button className="btn btn-primary" onClick={() => addGate("H", 0, circuit.moments.length)}>H</button>
                <button className="btn btn-primary" onClick={() => addGate("X", 0, circuit.moments.length)}>X</button>
                <button className="btn btn-primary" onClick={() => addGate("CX", 0, circuit.moments.length, 1)}>CX</button>
                <button className="btn" onClick={() => addGate("MEASURE", 0, circuit.moments.length)}>M</button>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn btn-ghost" onClick={addMoment}>Add time step</button>
                <button className="btn btn-ghost" onClick={removeLast}>Undo last</button>
              </div>
              <p className="subtle" style={{ fontSize: 12, marginTop: 8 }}>
                Press & hold a gate, then drag. It follows your pointer and snaps on drop.
              </p>
            </div>

            <div className="card" style={{ padding: 12 }}>
              <h3 style={{ marginTop: 0 }}>Selection</h3>
              <button className="btn btn-danger" onClick={deleteSelectedGate} disabled={!selected}>
                Delete selected gate
              </button>
              {!selected && <p style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>No gate selected</p>}
            </div>

            <div className="card" style={{ padding: 12 }}>
              <h3 style={{ marginTop: 0 }}>Export</h3>
              <div className="grid-2">
                <button className="btn" onClick={downloadSVG}>Download SVG</button>
                <button className="btn" onClick={downloadPNG}>Download PNG</button>
                <button className="btn" onClick={downloadJPG}>Download JPG</button>
                <button className="btn" onClick={downloadPDF}>Download PDF</button>
              </div>
            </div>

            <div className="card" style={{ padding: 12 }}>
              <h3 style={{ marginTop: 0 }}>Measurement (shots)</h3>
              <CountsTable counts={counts} />
            </div>
          </div>

          {/* Right: Canvas + Probs */}
          <div className="stack">
            <div className="card" style={{ padding: 12 }}>
              <h3 style={{ marginTop: 0 }}>Circuit</h3>

              <div
                className={`canvas-shell${panStartRef.current ? " panning" : ""}`}
                ref={svgContainerRef}
                onWheel={onContainerWheel}
                onMouseDown={(e) => {
                  if (e.button === 1 || spaceDown) {
                    e.preventDefault();
                    beginPanScroll(e.clientX, e.clientY);
                  }
                }}
                onMouseMove={(e) => { if (panStartRef.current) movePanScroll(e.clientX, e.clientY); }}
                onMouseUp={() => endPanScroll()}
                onMouseLeave={() => endPanScroll()}
              >
                {/* Zoom toolbar */}
                <div className="zoom-toolbar">
                  <button className="btn btn-ghost" onClick={() => setFitKey((k) => k + 1)}>Fit</button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => {
                      setCanvasZoom(1);
                      const el = svgContainerRef.current;
                      if (el) { el.scrollLeft = 0; el.scrollTop = 0; }
                    }}
                  >
                    Reset
                  </button>
                  <input
                    className="zoom-range"
                    type="range"
                    min={0.4}
                    max={3}
                    step={0.05}
                    value={canvasZoom}
                    onChange={(e) => {
                      const el = svgContainerRef.current;
                      if (!el) return;
                      const rect = el.getBoundingClientRect();
                      const cx = rect.width / 2;
                      const cy = rect.height / 2;
                      const ux = (el.scrollLeft + cx) / canvasZoom;
                      const uy = (el.scrollTop + cy) / canvasZoom;
                      const z = parseFloat(e.target.value);
                      setCanvasZoom(z);
                      requestAnimationFrame(() => {
                        el.scrollLeft = ux * z - cx;
                        el.scrollTop  = uy * z - cy;
                      });
                    }}
                    title={`Zoom: ${(canvasZoom * 100).toFixed(0)}%`}
                  />
                  <span className="subtle" style={{ fontSize: 12, width: 46, textAlign: "right" }}>
                    {(canvasZoom * 100).toFixed(0)}%
                  </span>
                </div>

                <CircuitSVG
                  circuit={circuit}
                  themeKey={theme}
                  svgRef={svgRef}
                  selected={selected}
                  onDeselect={() => setSelected(null)}
                  onSelect={(t, id) => setSelected({ t, id })}
                  drag={drag}
                  setDrag={setDrag}
                  setCircuit={setCircuit}
                  zoom={canvasZoom}   // scaled pixel size → scrollbars
                />
              </div>
            </div>

            <div className="card" style={{ padding: 12 }}>
              <h3 style={{ marginTop: 0 }}>State Probabilities</h3>
              <BarChart probs={probs} />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

// ================= CircuitSVG (zoom + scroll, no padding) =================
function CircuitSVG({
  circuit,
  themeKey,
  svgRef,
  selected,
  onDeselect,
  onSelect,
  drag,
  setDrag,
  setCircuit,
  zoom,
}: {
  circuit: Circuit;
  themeKey: ThemeKey;
  svgRef: React.RefObject<SVGSVGElement | null>;
  selected: { t: number; id: string } | null;
  onDeselect: () => void;
  onSelect: (t: number, id: string) => void;
  drag: null | {
    id: string;
    t: number;
    type: GateType;
    targets: number[];
    dx: number;
    dy: number;
    transformPx?: { tx: number; ty: number };
  };
  setDrag: React.Dispatch<React.SetStateAction<any>>;
  setCircuit: React.Dispatch<React.SetStateAction<Circuit>>;
  zoom: number;
}) {
  const T = THEMES[themeKey];

  const cellW = 72;
  const cellH = 56;
  const labelW = 36;
  const wires = circuit.nQubits;
  const cols = Math.max(1, circuit.moments.length || 1);

  // base content size in SVG units (no padding)
  const contentW = labelW + cols * cellW;
  const contentH = wires * cellH;

  // scaled pixel size → drives scrollbars
  const pxW = Math.max(1, Math.round(contentW * zoom));
  const pxH = Math.max(1, Math.round(contentH * zoom));

  const viewBox = `0 0 ${contentW} ${contentH}`;

  // --- Press & Hold drag setup ---
  const HOLD_MS = 200;
  const holdTimerRef = useRef<number | null>(null);
  const pendingRef = useRef<
    | null
    | {
        id: string;
        t: number;
        type: GateType;
        targets: number[];
        dx: number;
        dy: number;
      }
  >(null);

  const startHold = (data: {
    id: string;
    t: number;
    type: GateType;
    targets: number[];
    dx: number;
    dy: number;
  }) => {
    pendingRef.current = data;
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = window.setTimeout(() => {
      if (pendingRef.current) setDrag(pendingRef.current);
    }, HOLD_MS);
  };
  const cancelHold = () => {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
    pendingRef.current = null;
  };

  // --- coords helper
  const toLocalFromXY = (clientX: number, clientY: number) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    const inv = ctm ? ctm.inverse() : null;
    const p = inv ? pt.matrixTransform(inv) : ({ x: 0, y: 0 } as any);
    // subtract only labelW on X (no padding)
    return { x: p.x - labelW, y: p.y };
  };
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  // --- smooth transform while dragging
  const rafId = useRef<number | null>(null);
  const pendingPx = useRef<{ tx: number; ty: number } | null>(null);
  const flushPx = () => {
    if (!pendingPx.current) {
      rafId.current = null;
      return;
    }
    const px = pendingPx.current;
    setDrag((d: typeof drag) => (d ? { ...d, transformPx: px } : d));
    pendingPx.current = null;
    rafId.current = null;
  };
  const schedulePx = (tx: number, ty: number) => {
    pendingPx.current = { tx, ty };
    if (rafId.current == null) rafId.current = requestAnimationFrame(flushPx);
  };
  useEffect(() => () => { if (rafId.current) cancelAnimationFrame(rafId.current); }, []);

  // --- drag move handlers
  const handleDragMove = (clientX: number, clientY: number) => {
    if (!drag) return;
    const { x, y } = toLocalFromXY(clientX, clientY);
    const baseX = drag.t * cellW + drag.dx;
    const baseQ = drag.targets[0];
    const baseY = baseQ * cellH + drag.dy;
    schedulePx(x - baseX, y - baseY);
  };

  // --- drop logic
  const dropAtLocal = (clientX: number, clientY: number) => {
    if (!drag) return;
    const { x, y } = toLocalFromXY(clientX, clientY);

    let tNew = clamp(Math.round((x - drag.dx) / cellW), 0, Math.max(0, cols - 1));
    if (tNew >= cols) {
      setCircuit((c) => {
        const ms = [...c.moments];
        ms.push({ t: ms.length, gates: [] });
        return { ...c, moments: ms };
      });
      tNew = cols;
    }
    const qNew = clamp(Math.round((y - drag.dy) / cellH), 0, circuit.nQubits - 1);

    setCircuit((c) => {
      const ms = c.moments.map((m) => ({ ...m, gates: [...m.gates] }));
      const from = ms[drag.t];
      const gIdx = from.gates.findIndex((gg) => gg.id === drag.id);
      if (gIdx >= 0) from.gates.splice(gIdx, 1);

      while (ms.length <= tNew) ms.push({ t: ms.length, gates: [] });
      const to = ms[tNew];

      if (drag.type === "CX") {
        const diff = drag.targets[1] - drag.targets[0];
        const qCtrl = qNew;
        let qTgt = clamp(qCtrl + diff, 0, c.nQubits - 1);
        if (qTgt !== qCtrl + diff) {
          const qCtrlAdj = clamp(qTgt - diff, 0, c.nQubits - 1);
          to.gates.push({ id: drag.id, type: "CX", targets: [qCtrlAdj, qCtrlAdj + diff] });
        } else {
          to.gates.push({ id: drag.id, type: "CX", targets: [qCtrl, qTgt] });
        }
      } else {
        to.gates.push({ id: drag.id, type: drag.type as GateType, targets: [qNew] });
      }

      return { ...c, moments: ms };
    });

    onSelect(tNew, drag.id);
    setDrag(null);
    cancelHold();
  };

  const onMouseUpWrapper = (e: React.MouseEvent<SVGSVGElement>) => {
    if (drag) {
      dropAtLocal(e.clientX, e.clientY);
      return;
    }
    if (pendingRef.current) cancelHold();
  };

  const onMouseMoveWrapper = (e: React.MouseEvent<SVGSVGElement>) => {
    if (drag) { handleDragMove(e.clientX, e.clientY); }
  };

  return (
  <svg
    ref={svgRef}
    viewBox={viewBox}
    width={pxW}
    height={pxH}
    style={{ background: T.bg, borderRadius: 12, touchAction: "none", display: "block" }}
    shapeRendering="geometricPrecision"
    onClick={(e) => {
      if ((e.target as Element).tagName === "svg") {
        cancelHold();
        onDeselect();
      }
    }}
    onMouseMove={onMouseMoveWrapper}
    onMouseUp={onMouseUpWrapper}
  >
    {/* Qubit labels (stay at x=0) */}
    {Array.from({ length: wires }).map((_, q) => (
      <text
        key={q}
        x={0}
        y={q * cellH + cellH / 2 + 5}
        textAnchor="start"
        fill={T.label}
        fontSize={12}
        style={{ fontFamily: "Orbitron, ui-sans-serif", letterSpacing: ".5px" }}
      >
        {`q${q}`}
      </text>
    ))}

    {/* Everything to the right of the labels is shifted by labelW */}
    <g transform={`translate(${labelW},0)`}>
      {/* grid guides (subtle) */}
      {Array.from({ length: wires + 1 }).map((_, r) => (
        <line
          key={r}
          x1={0}
          y1={r * cellH}
          x2={cols * cellW}
          y2={r * cellH}
          stroke={T.grid}
          strokeWidth={1}
          pointerEvents="none"
        />
      ))}
      {Array.from({ length: cols + 1 }).map((_, c) => (
        <line
          key={c}
          x1={c * cellW}
          y1={0}
          x2={c * cellW}
          y2={wires * cellH}
          stroke={T.wire}
          strokeWidth={1}
          pointerEvents="none"
        />
      ))}

      {/* qubit horizontal wires */}
      {Array.from({ length: wires }).map((_, q) => (
        <line
          key={q}
          x1={0}
          y1={q * cellH + cellH / 2}
          x2={cols * cellW}
          y2={q * cellH + cellH / 2}
          stroke={T.node}
          strokeWidth={2}
          pointerEvents="none"
        />
      ))}

      {/* small wire nodes at each column (like the screenshot) */}
      {(() => {
        const dots: JSX.Element[] = [];
        for (let c = 0; c < cols; c++) {
          const x = c * cellW + cellW / 2; // center of column
          for (let q = 0; q < wires; q++) {
            const y = q * cellH + cellH / 2;
            dots.push(<circle key={`nd-${c}-${q}`} cx={x} cy={y} r={3} fill="#5b6676" />);
          }
        }
        return <g pointerEvents="none">{dots}</g>;
      })()}

      {/* snap cell highlight while dragging */}
      {drag && (
        <g>
          {(() => {
            const tx = drag.transformPx?.tx ?? 0;
            const ty = drag.transformPx?.ty ?? 0;
            const px = drag.t * cellW + drag.dx + tx;
            const py = drag.targets[0] * cellH + drag.dy + ty;
            const c = Math.round((px - drag.dx) / cellW);
            const r = Math.round((py - drag.dy) / cellH);
            const x = c * cellW;
            const y = r * cellH;
            return (
              <rect
                x={x - 2}
                y={y - 2}
                width={cellW + 4}
                height={cellH + 4}
                fill="none"
                stroke={T.select}
                strokeOpacity={0.35}
                strokeDasharray="6 6"
                rx={8}
                ry={8}
              />
            );
          })()}
        </g>
      )}

      {/* gates */}
      {circuit.moments.map((m) => (
        <g key={m.t} transform={`translate(${m.t * cellW},0)`}>
          {m.gates.map((g) => (
            <GateSVG
              key={g.id}
              t={m.t}
              gate={g}
              cellH={cellH}
              cellW={cellW}
              colors={T}
              selected={!!selected && selected.id === g.id && selected.t === m.t}
              onMouseDown={(evt, dx, dy) => {
                evt.stopPropagation();
                onSelect(m.t, g.id);
                startHold({ id: g.id, t: m.t, type: g.type, targets: [...g.targets], dx, dy });
              }}
              onTouchStart={(evt, dx, dy) => {
                onSelect(m.t, g.id);
                startHold({ id: g.id, t: m.t, type: g.type, targets: [...g.targets], dx, dy });
              }}
              transformPx={drag && drag.id === g.id ? drag.transformPx : undefined}
            />
          ))}
        </g>
      ))}
    </g>
  </svg>
);
}

// ================= GateSVG (memoized, transform-based preview) =================
// === GateSVG (screenshot-style chips) ===
const GateSVG = React.memo(function GateSVG({
  t,
  gate,
  cellH,
  cellW,
  colors,       // this is T
  selected,
  onMouseDown,
  onTouchStart,
  transformPx,
}: {
  t: number;
  gate: Gate;
  cellH: number;
  cellW: number;
  colors: any;  // T
  selected: boolean;
  onMouseDown: (evt: React.MouseEvent, dx: number, dy: number) => void;
  onTouchStart?: (touch: Touch, dx: number, dy: number) => void;
  transformPx?: { tx: number; ty: number };
}) {
  const xCenter = cellW / 2;
  const yCenter = (q: number) => q * cellH + cellH / 2;

  const tx = transformPx?.tx ?? 0;
  const ty = transformPx?.ty ?? 0;

  const handleMouseDown = (evt: React.MouseEvent, dx = 0, dy = 0) => onMouseDown(evt, dx, dy);
  const handleTouchStart = (evt: React.TouchEvent, dx = 0, dy = 0) => {
    if (!onTouchStart) return;
    const t0 = evt.touches[0];
    if (t0) onTouchStart(t0, dx, dy);
  };

  // palette from theme
  const H_FILL = colors.gates.hFill;
  const H_TEXT = colors.gates.hText;
  const PLUS_STROKE = selected ? colors.select : colors.gates.xStroke;
  const CTRL_FILL = selected ? colors.select : colors.gates.cxControl;
  const MEAS_STROKE = selected ? colors.select : colors.gates.measureStroke;

  // helper
  const drawPlus = (cx: number, cy: number, r: number, sw = 2) => (
    <>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={PLUS_STROKE} strokeWidth={sw} />
      <line x1={cx - r * 0.55} y1={cy} x2={cx + r * 0.55} y2={cy} stroke={PLUS_STROKE} strokeWidth={sw} />
      <line x1={cx} y1={cy - r * 0.55} x2={cx} y2={cy + r * 0.55} stroke={PLUS_STROKE} strokeWidth={sw} />
    </>
  );

  // CNOT
  if (gate.type === "CX") {
    const [qc, qt] = gate.targets;
    const cx = xCenter, cyC = yCenter(qc), cyT = yCenter(qt);
    return (
      <g
        transform={`translate(${tx}, ${ty})`}
        style={{ cursor: "grab", willChange: "transform" }}
        onMouseDown={(e) => handleMouseDown(e, xCenter, cellH / 2)}
        onTouchStart={(e) => handleTouchStart(e, xCenter, cellH / 2)}
      >
        <line x1={cx} y1={cyC} x2={cx} y2={cyT} stroke={colors.wire} strokeWidth={2} />
        <circle cx={cx} cy={cyC} r={4.5} fill={CTRL_FILL} />
        {drawPlus(cx, cyT, 13, selected ? 3 : 2)}
      </g>
    );
  }

  // Single-qubit gates
  const q = gate.targets[0];
  const cx = xCenter;
  const cy = yCenter(q);

  if (gate.type === "X") {
    return (
      <g
        transform={`translate(${tx}, ${ty})`}
        style={{ cursor: "grab", willChange: "transform" }}
        onMouseDown={(e) => handleMouseDown(e, xCenter, cellH / 2)}
        onTouchStart={(e) => handleTouchStart(e, xCenter, cellH / 2)}
      >
        <circle cx={cx} cy={cy} r={18} fill="transparent" stroke="transparent" strokeWidth={18} pointerEvents="all" />
        {drawPlus(cx, cy, 13, selected ? 3 : 2)}
      </g>
    );
  }

  if (gate.type === "H") {
    const w = 28, h = 28;
    const x = cx - w / 2, y = cy - h / 2;
    return (
      <g
        transform={`translate(${tx}, ${ty})`}
        style={{ cursor: "grab", willChange: "transform" }}
        onMouseDown={(e) => handleMouseDown(e, xCenter, cellH / 2)}
        onTouchStart={(e) => handleTouchStart(e, xCenter, cellH / 2)}
      >
        <rect x={x} y={y} width={w} height={h} rx={4} ry={4}
          fill={H_FILL} stroke={selected ? colors.select : H_FILL} strokeWidth={selected ? 3 : 2} />
        <text x={cx} y={cy + 6} fontSize={16} textAnchor="middle" fill={H_TEXT} style={{ fontWeight: 700 }}>
          H
        </text>
      </g>
    );
  }

  if (gate.type === "MEASURE") {
    const w = 30, h = 22;
    const x = cx - w / 2, y = cy - h / 2;
    return (
      <g
        transform={`translate(${tx}, ${ty})`}
        style={{ cursor: "grab", willChange: "transform" }}
        onMouseDown={(e) => handleMouseDown(e, xCenter, cellH / 2)}
        onTouchStart={(e) => handleTouchStart(e, xCenter, cellH / 2)}
      >
        <rect x={x} y={y} width={w} height={h} rx={4} ry={4} fill="none" stroke={MEAS_STROKE} strokeWidth={selected ? 3 : 2} />
        <path d={`M ${x + 4} ${cy + 6} q 6 -16 12 0 q 6 16 12 0`} fill="none" stroke={MEAS_STROKE} strokeWidth={2} />
      </g>
    );
  }

  return null;
});
// ================= Counts & Chart =================
function CountsTable({ counts }: { counts: Record<string, number> }) {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return (
    <div style={{ maxHeight: 220, overflow: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th align="left">Bitstring</th>
            <th align="right">Counts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td align="right">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BarChart({ probs }: { probs: number[] }) {
  const max = Math.max(1e-9, ...probs);
  const labels = probs.map((_, i) => i.toString(2).padStart(Math.log2(probs.length), "0"));
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${probs.length}, 1fr)`, gap: 6, alignItems: "end", height: 180 }}>
      {probs.map((p, i) => (
        <div key={i} title={`${labels[i]}: ${(p * 100).toFixed(2)}%`}>
          <div className="bar" style={{ height: `${(p / max) * 160}px` }} />
          <div style={{ textAlign: "center", fontSize: 12, marginTop: 4 }}>{labels[i]}</div>
        </div>
      ))}
    </div>
  );
}