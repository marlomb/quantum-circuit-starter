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

type Gate = {
  id: string;
  type: GateType;
  targets: number[]; // [q] or [control, target] for CX
};

type Moment = { t: number; gates: Gate[] };

type Circuit = {
  nQubits: number;
  moments: Moment[];
};

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
      // MEASURE: no collapse here; we display probabilities
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
    bg: "rgba(255,255,255,0.02)",
    grid: "rgba(255,255,255,0.10)",
    wire: "rgba(255,255,255,0.35)",
    gate: "#e6eef9",
    text: "#e6eef9",
    select: "#53d7f0",
    label: "#a4b2cc",
  },
  dark: {
    bg: "rgba(255,255,255,0.02)",
    grid: "rgba(255,255,255,0.10)",
    wire: "rgba(255,255,255,0.35)",
    gate: "#e6eef9",
    text: "#e6eef9",
    select: "#53d7f0",
    label: "#a4b2cc",
  },
};
type ThemeKey = keyof typeof THEMES;

// ================= Main App =================
export default function App() {
  const [circuit, setCircuit] = useState<Circuit>(() => emptyCircuit(2));
  const [shots, setShots] = useState(512);
  const [theme, setTheme] = useState<ThemeKey>("light");
  const [padding, setPadding] = useState(24);
  const [aspect, setAspect] = useState("auto"); // auto, 16:9, 4:3, 1:1
  const [selected, setSelected] = useState<{ t: number; id: string } | null>(null);

  // drag state (active drag only)
  const [drag, setDrag] = useState<
    | null
    | {
        id: string;
        t: number;
        type: GateType;
        targets: number[];
        dx: number; // local offset inside cell (xCenter)
        dy: number; // local offset inside cell (yCenter)
        transformPx?: { tx: number; ty: number }; // live pixel transform for smooth tracking
      }
  >(null);

  // zoom & pan state for the circuit canvas
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const svgContainerRef = useRef<HTMLDivElement | null>(null);
  const [fitKey, setFitKey] = useState(0); // bump to trigger "fit to view"

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
    // refit on qubit change
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

  return (
    <div
      className="neon-bg"
      style={{ color: T.text, fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto" }}
    >
      <div className="app-wrap">
        <header className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <h1 className="h1" style={{ fontSize: 22, fontWeight: 700 }}>
            Quantum Circuit Designer
          </h1>
          <div className="row">
            <button className="btn btn-ghost" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
              Theme: {theme}
            </button>
            <label>
              Qubits
              <input
                className="input"
                type="number"
                min={1}
                max={12}
                value={circuit.nQubits}
                onChange={(e) => setQubits(parseInt(e.target.value || "1"))}
                style={{ width: 64 }}
              />
            </label>
            <label>
              Shots
              <input
                className="input"
                type="number"
                min={1}
                max={100000}
                value={shots}
                onChange={(e) => setShots(parseInt(e.target.value || "512"))}
                style={{ width: 92 }}
              />
            </label>
            <label>
              Padding
              <input
                className="range"
                type="range"
                min={0}
                max={64}
                value={padding}
                onChange={(e) => setPadding(parseInt(e.target.value))}
              />
            </label>
            <label>
              Aspect
              <select className="select" value={aspect} onChange={(e) => setAspect(e.target.value)}>
                <option value="auto">auto</option>
                <option value="16:9">16:9</option>
                <option value="4:3">4:3</option>
                <option value="1:1">1:1</option>
              </select>
            </label>
          </div>
        </header>

        <section className="responsive-grid" style={{ display: "grid", gap: 16 }}>
          {/* Left: Controls */}
          <div className="stack">
            <div className="card" style={{ padding: 12 }}>
              <h3 style={{ marginTop: 0 }}>Gate Palette</h3>
              <div className="grid-2">
                <button className="btn btn-primary" onClick={() => addGate("H", 0, circuit.moments.length)}>
                  H
                </button>
                <button className="btn btn-primary" onClick={() => addGate("X", 0, circuit.moments.length)}>
                  X
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => addGate("CX", 0, circuit.moments.length, 1)}
                >
                  CX
                </button>
                <button className="btn" onClick={() => addGate("MEASURE", 0, circuit.moments.length)}>
                  M
                </button>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn btn-ghost" onClick={addMoment}>
                  Add time step
                </button>
                <button className="btn btn-ghost" onClick={removeLast}>
                  Undo last
                </button>
              </div>
              <p className="subtle" style={{ fontSize: 12, marginTop: 8 }}>
                Press & hold a gate, then drag. It follows your pointer smoothly and snaps on drop.
              </p>
            </div>

            <div className="card" style={{ padding: 12 }}>
              <h3 style={{ marginTop: 0 }}>Selection</h3>
              <button className="btn btn-danger" onClick={deleteSelectedGate} disabled={!selected}>
                Delete selected gate
              </button>
              {!selected && (
                <p style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>No gate selected</p>
              )}
            </div>

            <div className="card" style={{ padding: 12 }}>
              <h3 style={{ marginTop: 0 }}>Export</h3>
              <div className="grid-2">
                <button className="btn" onClick={downloadSVG}>
                  Download SVG
                </button>
                <button className="btn" onClick={downloadPNG}>
                  Download PNG
                </button>
                <button className="btn" onClick={downloadJPG}>
                  Download JPG
                </button>
                <button className="btn" onClick={downloadPDF}>
                  Download PDF
                </button>
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

              <div className="canvas-shell" ref={svgContainerRef}>
                {/* Zoom toolbar */}
                <div className="zoom-toolbar">
                  <button className="btn btn-ghost" onClick={() => setFitKey((k) => k + 1)}>
                    Fit
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => {
                      setCanvasZoom(1);
                      setPan({ x: 0, y: 0 });
                    }}
                  >
                    Reset
                  </button>
                  <input
                    className="zoom-range"
                    type="range"
                    min={0.4}
                    max={2.5}
                    step={0.05}
                    value={canvasZoom}
                    onChange={(e) => setCanvasZoom(parseFloat(e.target.value))}
                    title={`Zoom: ${(canvasZoom * 100).toFixed(0)}%`}
                  />
                  <span className="subtle" style={{ fontSize: 12, width: 46, textAlign: "right" }}>
                    {(canvasZoom * 100).toFixed(0)}%
                  </span>
                </div>

                <CircuitSVG
                  circuit={circuit}
                  padding={padding}
                  themeKey={theme}
                  aspect={aspect}
                  svgRef={svgRef}
                  selected={selected}
                  onDeselect={() => setSelected(null)}
                  onSelect={(t, id) => setSelected({ t, id })}
                  drag={drag}
                  setDrag={setDrag}
                  setCircuit={setCircuit}
                  // zoom/pan props
                  zoom={canvasZoom}
                  pan={pan}
                  setPan={setPan}
                  containerRef={svgContainerRef}
                  fitKey={fitKey}
                  onZoomChange={setCanvasZoom}
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

function PaletteButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="btn btn-primary" onClick={onClick}>
      {label}
    </button>
  );
}

// ================= CircuitSVG (press-and-hold + smooth drag + zoom/pan) =================
function CircuitSVG({
  circuit,
  padding,
  themeKey,
  aspect,
  svgRef,
  selected,
  onDeselect,
  onSelect,
  drag,
  setDrag,
  setCircuit,
  // zoom/pan
  zoom,
  pan,
  setPan,
  containerRef,
  fitKey,
  onZoomChange,
}: {
  circuit: Circuit;
  padding: number;
  themeKey: ThemeKey;
  aspect: string;
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
  pan: { x: number; y: number };
  setPan: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  fitKey: number;
  onZoomChange: (z: number) => void;
}) {
  const T = THEMES[themeKey];
  const cellW = 72;
  const cellH = 56;
  const labelW = 36;
  const wires = circuit.nQubits;
  const cols = Math.max(1, circuit.moments.length || 1);
  const width = padding * 2 + labelW + cols * cellW;
  const height = padding * 2 + wires * cellH;

  // --- viewBox with zoom/pan ---
  const contentW = width;
  const contentH = height;

  const [vx, vy, vw, vh] = useMemo(() => {
    const vw = contentW / zoom;
    const vh = contentH / zoom;
    return [pan.x, pan.y, vw, vh];
  }, [contentW, contentH, zoom, pan]);
  const viewBox = `${vx} ${vy} ${vw} ${vh}`;

  // --- Press & Hold to start drag
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

  // --- coords helpers (respects viewBox; CTM handles transforms)
  const toLocalFromXY = (clientX: number, clientY: number) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    const inv = ctm ? ctm.inverse() : null;
    const p = inv ? pt.matrixTransform(inv) : ({ x: 0, y: 0 } as any);
    return { x: p.x - padding - labelW, y: p.y - padding };
  };
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  // --- rAF for smooth pixel transform during drag
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

  // --- panning (Space+drag or middle mouse)
  const [spaceDown, setSpaceDown] = useState(false);
  const panStart = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  useEffect(() => {
    const kd = (e: KeyboardEvent) => { if (e.code === "Space") setSpaceDown(true); };
    const ku = (e: KeyboardEvent) => { if (e.code === "Space") setSpaceDown(false); };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => { window.removeEventListener("keydown", kd); window.removeEventListener("keyup", ku); };
  }, []);

  const startPan = (clientX: number, clientY: number) => {
    panStart.current = { x: clientX, y: clientY, vx: pan.x, vy: pan.y };
  };
  const movePan = (clientX: number, clientY: number) => {
    if (!panStart.current || !containerRef.current) return;
    // convert pixel delta to SVG units (depends on zoom and container size)
    const dxPx = clientX - panStart.current.x;
    const dyPx = clientY - panStart.current.y;
    const pw = containerRef.current.clientWidth || 1;
    const ph = containerRef.current.clientHeight || 1;
    const dx = dxPx * (contentW / (pw * zoom));
    const dy = dyPx * (contentH / (ph * zoom));
    setPan({ x: panStart.current.vx - dx, y: panStart.current.vy - dy });
  };
  const endPan = () => { panStart.current = null; };

  // --- pointer move handlers (continuous tracking for gate drag)
  const handleDragMove = (clientX: number, clientY: number) => {
    if (!drag) return;
    const { x, y } = toLocalFromXY(clientX, clientY);
    const baseX = drag.t * cellW + drag.dx;
    const baseQ = drag.targets[0]; // for CX, this is control row
    const baseY = baseQ * cellH + drag.dy;
    schedulePx(x - baseX, y - baseY);
  };

  // --- drop logic (snap to grid on release)
  const dropAtLocal = (clientX: number, clientY: number) => {
    const { x, y } = toLocalFromXY(clientX, clientY);
    let tNew = clamp(Math.round((x - drag!.dx) / cellW), 0, Math.max(0, cols - 1));
    if (tNew >= cols) {
      setCircuit((c) => {
        const ms = [...c.moments];
        ms.push({ t: ms.length, gates: [] });
        return { ...c, moments: ms };
      });
      tNew = cols;
    }
    const qNew = clamp(Math.round((y - drag!.dy) / cellH), 0, circuit.nQubits - 1);

    setCircuit((c) => {
      const ms = c.moments.map((m) => ({ ...m, gates: [...m.gates] }));
      const from = ms[drag!.t];
      const gIdx = from.gates.findIndex((gg) => gg.id === drag!.id);
      if (gIdx >= 0) from.gates.splice(gIdx, 1);

      while (ms.length <= tNew) ms.push({ t: ms.length, gates: [] });
      const to = ms[tNew];

      if (drag!.type === "CX") {
        const diff = drag!.targets[1] - drag!.targets[0];
        const qCtrl = qNew;
        let qTgt = clamp(qCtrl + diff, 0, c.nQubits - 1);
        if (qTgt !== qCtrl + diff) {
          const qCtrlAdj = clamp(qTgt - diff, 0, c.nQubits - 1);
          to.gates.push({ id: drag!.id, type: "CX", targets: [qCtrlAdj, qCtrlAdj + diff] });
        } else {
          to.gates.push({ id: drag!.id, type: "CX", targets: [qCtrl, qTgt] });
        }
      } else {
        to.gates.push({ id: drag!.id, type: drag!.type as GateType, targets: [qNew] });
      }

      return { ...c, moments: ms };
    });

    onSelect(tNew, drag!.id);
    setDrag(null);
    cancelHold();
  };

  // --- Fit to container whenever fitKey changes or content size changes
  useEffect(() => {
    const el = containerRef.current;
    const svg = svgRef.current;
    if (!el || !svg) return;
    const pw = el.clientWidth;
    const ph = el.clientHeight;
    if (pw <= 0 || ph <= 0) return;

    const margin = 16; // px
    const fitX = contentW / Math.max(1, pw - margin);
    const fitY = contentH / Math.max(1, ph - margin);
    const z = 1 / Math.max(fitX, fitY);

    const vw = contentW / z;
    const vh = contentH / z;
    const nx = (contentW - vw) / 2;
    const ny = (contentH - vh) / 2;

    onZoomChange(+z.toFixed(2));
    setPan({ x: nx, y: ny });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, contentW, contentH]);

  // --- SVG event bindings (wrap panning + dragging)
  const onMouseDownWrapper = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button === 1 /* middle */ || (e.button === 0 && (e as any).nativeEvent?.buttons === 1 && (e as any).nativeEvent?.shiftKey) || (e.button === 0 && (e as any).nativeEvent && (e as any).nativeEvent?.which === 1 && (e as any).nativeEvent?.ctrlKey)) {
      // alt/ctrl/shift optional variants if you want, but primary: middle or Space in move handler
      e.preventDefault();
    }
    if (e.button === 1 || (e.button === 0 && (e as any).nativeEvent?.buttons === 1 && (e as any).nativeEvent?.altKey)) {
      // middle or left+Alt starts pan (optional)
      startPan(e.clientX, e.clientY);
    }
  };

  const onMouseMoveWrapper = (e: React.MouseEvent<SVGSVGElement>) => {
    if (spaceDown || panStart.current) {
      // pan mode
      if (!panStart.current) startPan(e.clientX, e.clientY);
      movePan(e.clientX, e.clientY);
      return;
    }
    // gate drag preview
    if (drag) handleDragMove(e.clientX, e.clientY);
  };

  const onMouseUpWrapper = (e: React.MouseEvent<SVGSVGElement>) => {
    if (panStart.current) {
      endPan();
      return;
    }
    if (drag) {
      dropAtLocal(e.clientX, e.clientY);
      return;
    }
    if (pendingRef.current) cancelHold();
  };

  const onTouchMoveWrapper = (e: React.TouchEvent<SVGSVGElement>) => {
    if (!drag) return;
    const t0 = e.touches[0];
    if (!t0) return;
    handleDragMove(t0.clientX, t0.clientY);
    e.preventDefault();
  };

  const onTouchEndWrapper = (e: React.TouchEvent<SVGSVGElement>) => {
    if (drag) {
      const t0 = e.changedTouches[0];
      if (t0) dropAtLocal(t0.clientX, t0.clientY);
      else {
        setDrag(null);
        cancelHold();
      }
      e.preventDefault();
      return;
    }
    if (pendingRef.current) cancelHold();
  };

  const onWheelWrapper = (e: React.WheelEvent<SVGSVGElement>) => {
    // Ctrl/Meta wheel zoom (also catches pinch on many trackpads)
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = -e.deltaY; // up => positive
      const factor = Math.exp(delta * 0.0015);
      const newZ = Math.min(2.5, Math.max(0.4, zoom * factor));

      const svg = svgRef.current!;
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const inv = ctm.inverse();
      const p = pt.matrixTransform(inv); // svg coords

      const vw0 = contentW / zoom;
      const vh0 = contentH / zoom;
      const vw1 = contentW / newZ;
      const vh1 = contentH / newZ;

      const nx = pan.x + (p.x - pan.x) - (p.x - pan.x) * (vw1 / vw0);
      const ny = pan.y + (p.y - pan.y) - (p.y - pan.y) * (vh1 / vh0);

      onZoomChange(+newZ.toFixed(2));
      setPan({ x: nx, y: ny });
    }
  };

  return (
    <svg
      ref={svgRef}
      viewBox={viewBox}
      width="100%"
      height="100%" // fill the shell
      style={{ background: T.bg, borderRadius: 12, touchAction: "none", display: "block" }}
      shapeRendering="geometricPrecision"
      onClick={(e) => {
        if ((e.target as Element).tagName === "svg") {
          cancelHold();
          onDeselect();
        }
      }}
      // wrappers
      onMouseDown={onMouseDownWrapper}
      onMouseMove={onMouseMoveWrapper}
      onMouseUp={onMouseUpWrapper}
      onMouseLeave={() => { if (panStart.current) endPan(); }}
      onTouchMove={onTouchMoveWrapper}
      onTouchEnd={onTouchEndWrapper}
      onWheel={onWheelWrapper}
    >
      <g transform={`translate(${padding}, ${padding})`}>
        {/* qubit labels */}
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

        <g transform={`translate(${labelW},0)`}>
          {/* grid */}
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
              stroke={T.grid}
              strokeWidth={1}
              pointerEvents="none"
            />
          ))}
          {/* wires */}
          {Array.from({ length: wires }).map((_, q) => (
            <line
              key={q}
              x1={0}
              y1={q * cellH + cellH / 2}
              x2={cols * cellW}
              y2={q * cellH + cellH / 2}
              stroke={T.wire}
              strokeWidth={2}
              pointerEvents="none"
            />
          ))}

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
                  onTouchStart={(touch, dx, dy) => {
                    onSelect(m.t, g.id);
                    startHold({ id: g.id, t: m.t, type: g.type, targets: [...g.targets], dx, dy });
                  }}
                  transformPx={drag && drag.id === g.id ? drag.transformPx : undefined}
                />
              ))}
            </g>
          ))}
        </g>
      </g>
    </svg>
  );
}

// ================= GateSVG (memoized, transform-based preview) =================
const GateSVG = React.memo(function GateSVG({
  t,
  gate,
  cellH,
  cellW,
  colors,
  selected,
  onMouseDown,
  onTouchStart,
  transformPx,
}: {
  t: number;
  gate: Gate;
  cellH: number;
  cellW: number;
  colors: any;
  selected: boolean;
  onMouseDown: (evt: React.MouseEvent, dx: number, dy: number) => void;
  onTouchStart?: (touch: Touch, dx: number, dy: number) => void;
  transformPx?: { tx: number; ty: number };
}) {
  const yCenter = (q: number) => q * cellH + cellH / 2;
  const xCenter = cellW / 2;
  const gateColor = colors.gate;
  const selColor = colors.select;

  // Continuous transform while dragging (falls back to 0,0 when idle)
  const tx = transformPx ? transformPx.tx : 0;
  const ty = transformPx ? transformPx.ty : 0;

  const dragStroke = selected ? selColor : gateColor;
  const dragWidth = selected ? 3 : 2;

  const handleMouseDown = (evt: React.MouseEvent, dx = 0, dy = 0) => onMouseDown(evt, dx, dy);
  const handleTouchStart = (evt: React.TouchEvent, dx = 0, dy = 0) => {
    if (!onTouchStart) return;
    const t0 = evt.touches[0];
    if (t0) onTouchStart(t0, dx, dy);
  };

  if (gate.type === "CX") {
    const [cIdx, tIdx] = gate.targets;
    const x = xCenter;
    const yC = yCenter(cIdx);
    const diff = tIdx - cIdx;
    const yT = yCenter(cIdx + diff);

    return (
      <g
        className={selected ? "glow-strong" : "glow-soft"}
        transform={`translate(${tx}, ${ty})`}
        style={{ cursor: "grab", willChange: "transform" }}
        onMouseDown={(e) => handleMouseDown(e, xCenter, cellH / 2)}
        onTouchStart={(e) => handleTouchStart(e, xCenter, cellH / 2)}
      >
        {/* big invisible hit area for easier grabbing */}
        <line x1={x} y1={yC} x2={x} y2={yT} stroke="transparent" strokeWidth={18} pointerEvents="stroke" />
        <line x1={x} y1={yC} x2={x} y2={yT} stroke={dragStroke} strokeWidth={dragWidth} />
        <circle cx={x} cy={yC} r={6} fill={dragStroke} />
        <circle cx={x} cy={yT} r={12} fill="none" stroke={dragStroke} strokeWidth={dragWidth} />
        <line x1={x - 8} y1={yT} x2={x + 8} y2={yT} stroke={dragStroke} strokeWidth={dragWidth} />
        <line x1={x} y1={yT - 8} x2={x} y2={yT + 8} stroke={dragStroke} strokeWidth={dragWidth} />
      </g>
    );
  }

  const q = gate.targets[0];
  const x = xCenter - 20;
  const y = q * cellH + cellH / 2 - 16;
  const w = 40;
  const h = 32;
  const label = GATE_LABEL[gate.type];

  return (
    <g
      className={selected ? "glow-strong" : "glow-soft"}
      transform={`translate(${tx}, ${ty})`}
      style={{ cursor: "grab", willChange: "transform" }}
      onMouseDown={(e) => handleMouseDown(e, xCenter, cellH / 2)}
      onTouchStart={(e) => handleTouchStart(e, xCenter, cellH / 2)}
    >
      {/* invisible hit area to make grabbing easier */}
      <rect
        x={x - 6}
        y={y - 6}
        width={w + 12}
        height={h + 12}
        fill="transparent"
        stroke="transparent"
        strokeWidth={12}
        pointerEvents="all"
      />
      {selected && (
        <rect
          x={x - 4}
          y={y - 4}
          width={w + 8}
          height={h + 8}
          rx={10}
          ry={10}
          fill="none"
          stroke={selColor}
          strokeWidth={2}
        />
      )}
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={8}
        ry={8}
        fill="none"
        stroke={selected ? selColor : gateColor}
        strokeWidth={selected ? 3 : 2}
      />
      <text x={x + w / 2} y={y + h / 2 + 5} fontSize={16} textAnchor="middle" fill={selected ? selColor : gateColor}>
        {label}
      </text>
    </g>
  );
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
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${probs.length}, 1fr)`,
        gap: 6,
        alignItems: "end",
        height: 180,
      }}
    >
      {probs.map((p, i) => (
        <div key={i} title={`${labels[i]}: ${(p * 100).toFixed(2)}%`}>
          <div className="bar" style={{ height: `${(p / max) * 160}px` }} />
          <div style={{ textAlign: "center", fontSize: 12, marginTop: 4 }}>{labels[i]}</div>
        </div>
      ))}
    </div>
  );
}