import React, { useEffect, useMemo, useRef, useState } from "react";
import { saveAs } from "file-saver";
import { jsPDF } from "jspdf";

// Quantum Circuit Designer – Starter (pure React + SVG)
// Upgrades in this version:
// - Select + Delete any gate (button or Delete/Backspace)
// - **Drag & Drop** gates with snap-to-grid
//    • 1-qubit gates: move across time (columns) and wires (rows)
//    • CX gates: move across time and vertically while preserving the control→target row offset
// - **Qubit labels** (q0, q1, ...) auto-update on add/delete qubits

// ---------------- Quantum math utils ----------------
const SQRT1_2 = Math.SQRT1_2; // 1/sqrt(2)

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

// Apply a 1-qubit gate (2x2) to target qubit t
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
      const j = i | bit; // pair index with bit set
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
      const j = i | tbit; // flip target when control is 1
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

// ---------------- Circuit model ----------------

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
      // MEASURE is a no-op here; we visualize probs at the end
    }
  }
  const probs = probsFromState(st);
  return { probs };
}

// ---------------- UI helpers ----------------
function uid() {
  return Math.random().toString(36).slice(2, 9);
}

const GATE_LABEL: Record<GateType, string> = { H: "H", X: "X", CX: "●⊕", MEASURE: "M" };

// Colors/themes
const THEMES = {
  light: {
    bg: "#ffffff",
    grid: "#e5e7eb",
    wire: "#9ca3af",
    gate: "#111827",
    text: "#111827",
    select: "#10b981",
    label: "#4b5563",
  },
  dark: {
    bg: "#0b1118",
    grid: "#1f2937",
    wire: "#6b7280",
    gate: "#e5e7eb",
    text: "#e5e7eb",
    select: "#34d399",
    label: "#9ca3af",
  },
};

type ThemeKey = keyof typeof THEMES;

// ---------------- Main App ----------------
export default function App() {
  const [circuit, setCircuit] = useState<Circuit>(() => emptyCircuit(2));
  const [shots, setShots] = useState(512);
  const [theme, setTheme] = useState<ThemeKey>("light");
  const [padding, setPadding] = useState(24);
  const [aspect, setAspect] = useState("auto"); // auto, 16:9, 4:3, 1:1
  const [selected, setSelected] = useState<{ t: number; id: string } | null>(null);
  const [drag, setDrag] = useState<
    | null
    | {
        id: string;
        t: number; // original moment index
        type: GateType;
        targets: number[]; // original targets
        dx: number; // mouse offset inside cell
        dy: number;
      }
  >(null);

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
    setCircuit((c) => ({ ...emptyCircuit(nClamped), moments: c.moments }));
    setCircuit(() => emptyCircuit(nClamped));
    setSelected(null);
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

  // keyboard: Delete / Backspace removes selected gate
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

  // -------------- Export helpers --------------
  const serializeSVG = () => {
    const svg = svgRef.current;
    if (!svg) return "";
    const cloned = svg.cloneNode(true) as SVGSVGElement;
    cloned.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const svgData = new XMLSerializer().serializeToString(cloned);
    return svgData;
  };

  const downloadSVG = () => {
    const data = serializeSVG();
    const blob = new Blob([data], { type: "image/svg+xml;charset=utf-8" });
    saveAs(blob, "circuit.svg");
  };

  const svgToCanvas = async (scale = 2) => {
    const data = serializeSVG();
    const img = new Image();
    const themeBg = THEMES[theme].bg;
    const can = document.createElement("canvas");
    const svg = svgRef.current!;
    const vb = svg.viewBox.baseVal;
    const w = vb && (vb.width || vb.x || vb.y) ? vb.width : svg.clientWidth;
    const h = vb && (vb.height || vb.x || vb.y) ? vb.height : svg.clientHeight;
    can.width = Math.max(1, Math.ceil(w * scale));
    can.height = Math.max(1, Math.ceil(h * scale));
    const ctx = can.getContext("2d");
    if (!ctx) throw new Error("Canvas not supported");
    await new Promise<void>((resolve) => {
      img.onload = () => {
        ctx.fillStyle = themeBg;
        ctx.fillRect(0, 0, can.width, can.height);
        ctx.drawImage(img, 0, 0, can.width, can.height);
        resolve();
      };
      img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(data)))}`;
    });
    return can;
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
      className="min-h-screen"
      style={{ background: T.bg, color: T.text, fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto" }}
    >
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: 16 }}>
        <header
          style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}
        >
          <h1 style={{ fontSize: 20, fontWeight: 700 }}>Quantum Circuit Designer – Starter</h1>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>Theme: {theme}</button>
            <label>
              Qubits
              <input
                type="number"
                min={1}
                max={12}
                value={circuit.nQubits}
                onChange={(e) => setQubits(parseInt(e.target.value || "1"))}
                style={{ width: 64, marginLeft: 6 }}
              />
            </label>
            <label>
              Shots
              <input
                type="number"
                min={1}
                max={100000}
                value={shots}
                onChange={(e) => setShots(parseInt(e.target.value || "512"))}
                style={{ width: 92, marginLeft: 6 }}
              />
            </label>
            <label>
              Padding
              <input
                type="range"
                min={0}
                max={64}
                value={padding}
                onChange={(e) => setPadding(parseInt(e.target.value))}
              />
            </label>
            <label>
              Aspect
              <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
                <option value="auto">auto</option>
                <option value="16:9">16:9</option>
                <option value="4:3">4:3</option>
                <option value="1:1">1:1</option>
              </select>
            </label>
          </div>
        </header>

        <section style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 16 }}>
          {/* Left: Controls */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ padding: 12, border: `1px solid ${T.grid}`, borderRadius: 12 }}>
              <h3 style={{ marginTop: 0 }}>Gate Palette</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
                <PaletteButton label="H" onClick={() => addGate("H", 0, circuit.moments.length)} />
                <PaletteButton label="X" onClick={() => addGate("X", 0, circuit.moments.length)} />
                <PaletteButton label="CX" onClick={() => addGate("CX", 0, circuit.moments.length, 1)} />
                <PaletteButton label="M" onClick={() => addGate("MEASURE", 0, circuit.moments.length)} />
              </div>
              <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                <button onClick={addMoment}>Add time step</button>
                <button onClick={removeLast}>Undo last</button>
              </div>
              <p style={{ fontSize: 12, opacity: 0.8, marginTop: 8 }}>
                Tip: Drag gates to move them. CX keeps its vertical spacing.
              </p>
            </div>

            <div style={{ padding: 12, border: `1px solid ${T.grid}`, borderRadius: 12 }}>
              <h3 style={{ marginTop: 0 }}>Selection</h3>
              <button onClick={deleteSelectedGate} disabled={!selected}>
                Delete selected gate
              </button>
              {!selected && <p style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>No gate selected</p>}
            </div>

            <div style={{ padding: 12, border: `1px solid ${T.grid}`, borderRadius: 12 }}>
              <h3 style={{ marginTop: 0 }}>Export</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
                <button onClick={downloadSVG}>Download SVG</button>
                <button onClick={downloadPNG}>Download PNG</button>
                <button onClick={downloadJPG}>Download JPG</button>
                <button onClick={downloadPDF}>Download PDF</button>
              </div>
            </div>

            <div style={{ padding: 12, border: `1px solid ${T.grid}`, borderRadius: 12 }}>
              <h3 style={{ marginTop: 0 }}>Measurement (shots)</h3>
              <CountsTable counts={counts} />
            </div>
          </div>

          {/* Right: Canvas + Probs */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ padding: 12, border: `1px solid ${T.grid}`, borderRadius: 12 }}>
              <h3 style={{ marginTop: 0 }}>Circuit</h3>
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
              />
            </div>

            <div style={{ padding: 12, border: `1px solid ${T.grid}`, borderRadius: 12 }}>
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
    <button onClick={onClick} style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #e5e7eb" }}>
      {label}
    </button>
  );
}

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
}: {
  circuit: Circuit;
  padding: number;
  themeKey: ThemeKey;
  aspect: string;
  svgRef: React.RefObject<SVGSVGElement | null>;
  selected: { t: number; id: string } | null;
  onDeselect: () => void;
  onSelect: (t: number, id: string) => void;
  drag: any;
  setDrag: React.Dispatch<React.SetStateAction<any>>;
  setCircuit: React.Dispatch<React.SetStateAction<Circuit>>;
}) {
  const T = THEMES[themeKey];
  const cellW = 72;
  const cellH = 56;
  const labelW = 36; // space for qubit labels
  const wires = circuit.nQubits;
  const cols = Math.max(1, circuit.moments.length || 1);
  const width = padding * 2 + labelW + cols * cellW;
  const height = padding * 2 + wires * cellH;

  const viewBox = useMemo(() => {
    if (aspect === "auto") return `0 0 ${width} ${height}`;
    const [aw, ah] = aspect.split(":").map(Number);
    const targetH = (height * aw) / ah;
    const vbH = Math.max(height, targetH);
    const vbW = (vbH * aw) / ah;
    return `0 0 ${vbW} ${vbH}`;
  }, [width, height, aspect]);

  // Helpers to convert mouse to grid coords
  const toLocal = (evt: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const ctm = svg.getScreenCTM();
    const inv = ctm ? ctm.inverse() : null;
    const p = inv ? pt.matrixTransform(inv) : { x: 0, y: 0 } as any;
    return { x: p.x - padding - labelW, y: p.y - padding };
  };

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!drag) return;
    const { x, y } = toLocal(e);
    const t = clamp(Math.round((x - drag.dx) / cellW), 0, Math.max(0, cols - 1));
    const q = clamp(Math.round((y - drag.dy) / cellH), 0, wires - 1);

    // Draw a temporary preview by updating drag state (used by GateSVG)
    setDrag({ ...drag, preview: { t, q } });
  };

  const onMouseUp = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!drag) return;
    const { x, y } = toLocal(e);
    let tNew = clamp(Math.round((x - drag.dx) / cellW), 0, Math.max(0, cols - 1));

    // Allow dropping after last column -> create a new moment
    if (tNew >= cols) {
      setCircuit((c) => {
        const ms = [...c.moments];
        ms.push({ t: ms.length, gates: [] });
        return { ...c, moments: ms };
      });
      tNew = cols; // snap to the new last index
    }

    // Vertical placement
    const qNew = clamp(Math.round((y - drag.dy) / cellH), 0, wires - 1);

    setCircuit((c) => {
      const ms = c.moments.map((m) => ({ ...m, gates: [...m.gates] }));
      // remove from original cell
      const from = ms[drag.t];
      const gIdx = from.gates.findIndex((gg) => gg.id === drag.id);
      if (gIdx >= 0) from.gates.splice(gIdx, 1);
      // destination moment (ensure exists)
      while (ms.length <= tNew) ms.push({ t: ms.length, gates: [] });
      const to = ms[tNew];

      if (drag.type === "CX") {
        // Preserve original vertical offset between control and target
        const diff = drag.targets[1] - drag.targets[0];
        const qCtrl = qNew;
        let qTgt = qCtrl + diff;
        qTgt = clamp(qTgt, 0, c.nQubits - 1);
        // if clamped moved target out of bounds, adjust control to keep diff
        if (qTgt !== qCtrl + diff) {
          // shift both so target fits
          let qCtrlAdj = clamp(qTgt - diff, 0, c.nQubits - 1);
          // ensure within range
          if (qCtrlAdj < 0 || qCtrlAdj > c.nQubits - 1) qCtrlAdj = qCtrl;
          to.gates.push({ id: drag.id, type: "CX", targets: [qCtrlAdj, qCtrlAdj + diff] });
        } else {
          to.gates.push({ id: drag.id, type: "CX", targets: [qCtrl, qTgt] });
        }
      } else {
        to.gates.push({ id: drag.id, type: drag.type as GateType, targets: [qNew] });
      }

      return { ...c, moments: ms };
    });

    setSelected({ t: tNew, id: drag.id });
    setDrag(null);
  };

  return (
    <svg
      ref={svgRef}
      viewBox={viewBox}
      width="100%"
      style={{ background: T.bg, borderRadius: 12 }}
      onClick={(e) => {
        if ((e.target as HTMLElement).tagName === "svg") onDeselect();
      }}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      <g transform={`translate(${padding}, ${padding})`}>
        {/* qubit labels */}
        {[...Array(wires)].map((_, q) => (
          <text key={q} x={0} y={q * cellH + cellH / 2 + 5} textAnchor="start" fill={T.label} fontSize={12}>
            {`q${q}`}
          </text>
        ))}

        <g transform={`translate(${labelW},0)`}>
          {/* grid */}
          {[...Array(wires + 1)].map((_, r) => (
            <line key={r} x1={0} y1={r * cellH} x2={cols * cellW} y2={r * cellH} stroke={T.grid} strokeWidth={1} />
          ))}
          {[...Array(cols + 1)].map((_, c) => (
            <line key={c} x1={c * cellW} y1={0} x2={c * cellW} y2={wires * cellH} stroke={T.grid} strokeWidth={1} />
          ))}
          {/* wires */}
          {[...Array(wires)].map((_, q) => (
            <line
              key={q}
              x1={0}
              y1={q * cellH + cellH / 2}
              x2={cols * cellW}
              y2={q * cellH + cellH / 2}
              stroke={T.wire}
              strokeWidth={2}
            />
          ))}

          {/* gates */}
          {circuit.moments.map((m) => (
            <g key={m.t} transform={`translate(${m.t * cellW},0)`}>
              {m.gates.map((g) => (
                <GateSVG
                  key={g.id}
                  gate={drag && drag.id === g.id ? { ...g, targets: drag.targets } : g}
                  cellH={cellH}
                  cellW={cellW}
                  colors={T}
                  selected={!!selected && selected.id === g.id && selected.t === m.t}
                  onMouseDown={(evt, dx, dy) => {
                    evt.stopPropagation();
                    onSelect(m.t, g.id); // <-- call the prop
                    setDrag({ id: g.id, t: m.t, type: g.type, targets: [...g.targets], dx, dy });
                  }}
                  preview={drag && drag.id === g.id ? drag.preview : undefined}
                />
              ))}
            </g>
          ))}
        </g>
      </g>
    </svg>
  );
}

function GateSVG({
  gate,
  cellH,
  cellW,
  colors,
  selected,
  onMouseDown,
  preview,
}: {
  gate: Gate;
  cellH: number;
  cellW: number;
  colors: any;
  selected: boolean;
  onMouseDown: (evt: React.MouseEvent, dx: number, dy: number) => void;
  preview?: { t: number; q: number };
}) {
  const yCenter = (q: number) => q * cellH + cellH / 2;
  const xCenter = cellW / 2;
  const gateColor = colors.gate;
  const selColor = colors.select;

  // dragging visuals
  const dragStroke = selected ? selColor : gateColor;
  const dragWidth = selected ? 3 : 2;

  const handleMouseDown = (evt: React.MouseEvent, dx = 0, dy = 0) => onMouseDown(evt, dx, dy);

  if (gate.type === "CX") {
    const [cIdx, tIdx] = gate.targets;
    const x = xCenter;
    const yC = yCenter(preview ? preview.q : cIdx);
    const diff = tIdx - cIdx;
    let yT = yCenter((preview ? preview.q : cIdx) + diff);

    return (
      <g
        onMouseDown={(e) => handleMouseDown(e, xCenter, (cellH / 2))}
        style={{ cursor: "grab" }}
      >
        <line x1={x} y1={yC} x2={x} y2={yT} stroke={dragStroke} strokeWidth={dragWidth} />
        {/* control dot */}
        <circle cx={x} cy={yC} r={6} fill={dragStroke} />
        {/* target plus */}
        <circle cx={x} cy={yT} r={12} fill="none" stroke={dragStroke} strokeWidth={dragWidth} />
        <line x1={x - 8} y1={yT} x2={x + 8} y2={yT} stroke={dragStroke} strokeWidth={dragWidth} />
        <line x1={x} y1={yT - 8} x2={x} y2={yT + 8} stroke={dragStroke} strokeWidth={dragWidth} />
      </g>
    );
  }

  const q = preview ? preview.q : gate.targets[0];
  const x = xCenter - 20;
  const y = q * cellH + cellH / 2 - 16;
  const w = 40;
  const h = 32;
  const label = GATE_LABEL[gate.type];
  return (
    <g onMouseDown={(e) => handleMouseDown(e, xCenter, cellH / 2)} style={{ cursor: "grab" }}>
      {selected && (
        <rect x={x - 4} y={y - 4} width={w + 8} height={h + 8} rx={10} ry={10} fill="none" stroke={selColor} strokeWidth={2} />
      )}
      <rect x={x} y={y} width={w} height={h} rx={8} ry={8} fill="none" stroke={selected ? selColor : gateColor} strokeWidth={selected ? 3 : 2} />
      <text x={x + w / 2} y={y + h / 2 + 5} fontSize={16} textAnchor="middle" fill={selected ? selColor : gateColor}>
        {label}
      </text>
    </g>
  );
}

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
          <div style={{ height: `${(p / max) * 160}px`, background: "#60a5fa", borderRadius: 6 }} />
          <div style={{ textAlign: "center", fontSize: 12, marginTop: 4 }}>{labels[i]}</div>
        </div>
      ))}
    </div>
  );
}
