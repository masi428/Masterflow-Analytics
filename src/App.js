import { useState, useEffect, useCallback, useRef } from "react";

const TICKERS = ["SPY", "QQQ", "DIA"];
const PROXY = "https://api.allorigins.win/raw?url=";
const YF_QUOTE = (sym) => `${PROXY}https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=5m&range=5d`;
const YF_OPTIONS = (sym) => `${PROXY}https://query1.finance.yahoo.com/v7/finance/options/${sym}`;

const erf = (x) => {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const r = 1 - poly * Math.exp(-x * x);
  return x >= 0 ? r : -r;
};
const normCDF = (x) => (1 + erf(x / Math.SQRT2)) / 2;
const normPDF = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

const blackScholes = (S, K, T, r, sigma, type = "call") => {
  if (T <= 0 || sigma <= 0) return { price: 0, delta: 0, gamma: 0, vega: 0, theta: 0 };
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const Nd1 = normCDF(d1), Nd2 = normCDF(d2);
  const price = type === "call" ? S * Nd1 - K * Math.exp(-r * T) * Nd2 : K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
  const delta = type === "call" ? Nd1 : Nd1 - 1;
  const gamma = normPDF(d1) / (S * sigma * Math.sqrt(T));
  const vega = (S * normPDF(d1) * Math.sqrt(T)) / 100;
  const theta = type === "call"
    ? (-(S * normPDF(d1) * sigma) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * Nd2) / 365
    : (-(S * normPDF(d1) * sigma) / (2 * Math.sqrt(T)) + r * K * Math.exp(-r * T) * normCDF(-d2)) / 365;
  return { price, delta, gamma, vega, theta };
};

const shannonEntropy = (rets) => {
  const bins = 20;
  const min = Math.min(...rets), max = Math.max(...rets);
  const range = max - min || 0.0001;
  const counts = new Array(bins).fill(0);
  rets.forEach((r) => {
    const idx = Math.min(bins - 1, Math.floor(((r - min) / range) * bins));
    counts[idx]++;
  });
  const probs = counts.filter(c => c > 0).map(c => c / rets.length);
  return -probs.reduce((sum, p) => sum + p * Math.log2(p), 0);
};

const detectRegime = (closes) => {
  if (closes.length < 20) return { regime: "LOADING", confidence: 0, color: "#888", vol: "0", entropy: 0 };
  const rets = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
  const recent = rets.slice(-20);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const variance = recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length;
  const vol = Math.sqrt(variance) * Math.sqrt(252);
  const momentum = recent.slice(-5).reduce((a, b) => a + b, 0);
  const entropy = shannonEntropy(recent);
  let regime, color, confidence;
  if (vol < 0.12 && entropy < 3.5) {
    regime = "MEAN REVERT"; color = "#00d4aa"; confidence = Math.min(95, 60 + (3.5 - entropy) * 15);
  } else if (vol > 0.22 || entropy > 4.5) {
    regime = "TRANSITIONAL"; color = "#ff6b35"; confidence = Math.min(95, 50 + (entropy - 3) * 20);
  } else if (Math.abs(momentum) > 0.02) {
    regime = "BREAKOUT"; color = momentum > 0 ? "#39ff14" : "#ff3366"; confidence = Math.min(95, 55 + Math.abs(momentum) * 500);
  } else {
    regime = "CHOP"; color = "#ffcc00"; confidence = 60;
  }
  return { regime, confidence: Math.round(confidence), color, vol: (vol * 100).toFixed(1), entropy: entropy.toFixed(2) };
};

const calcVRP = (closes, ivEstimate) => {
  if (closes.length < 21) return 0;
  const rets = closes.slice(-21).map((c, i, a) => i === 0 ? 0 : Math.log(c / a[i - 1]));
  const hv = Math.sqrt(rets.slice(1).reduce((s, r) => s + r * r, 0) / 20) * Math.sqrt(252) * 100;
  return (ivEstimate - hv).toFixed(2);
};

const calcGEX = (optionChain, spot) => {
  if (!optionChain || !optionChain.optionChain || !optionChain.optionChain.result) return { gex: 0, dex: 0, regime: "NEUTRAL", topLevels: [] };
  try {
    const options = optionChain.optionChain.result[0].options;
    const all = [];
    options.forEach(exp => {
      exp.calls?.forEach(call => {
        if (call.strike && call.openInterest) {
          const S = spot, K = call.strike, T = (new Date(exp.expirationDate) - new Date()) / (365 * 24 * 60 * 60 * 1000);
          const gamma = blackScholes(S, K, T, 0.05, 0.2, "call").gamma;
          const gex = gamma * call.openInterest * 100 * S;
          all.push({ strike: K, gex, type: "call" });
        }
      });
      exp.puts?.forEach(put => {
        if (put.strike && put.openInterest) {
          const S = spot, K = put.strike, T = (new Date(exp.expirationDate) - new Date()) / (365 * 24 * 60 * 60 * 1000);
          const gamma = blackScholes(S, K, T, 0.05, 0.2, "put").gamma;
          const gex = gamma * put.openInterest * 100 * S;
          all.push({ strike: K, gex: -gex, type: "put" });
        }
      });
    });
    const byStrike = new Map();
    all.forEach(l => { byStrike.set(l.strike, (byStrike.get(l.strike) || 0) + l.gex); });
    const levels = Array.from(byStrike.entries()).map(([strike, gex]) => ({ strike, gex }));
    levels.sort((a,b) => b.gex - a.gex);
    const netGex = levels.reduce((sum, l) => sum + l.gex, 0);
    const dex = levels.reduce((sum, l) => sum + l.gex * l.strike, 0) / (spot || 1);
    const topLevels = levels.slice(0, 12);
    const regime = netGex > 0 ? "POSITIVE" : "NEGATIVE";
    return { gex: (netGex / 1e6).toFixed(2), dex: (dex / 1e3).toFixed(0), regime, topLevels };
  } catch(e) { return { gex: "0", dex: "0", regime: "NEUTRAL", topLevels: [] }; }
};

const Sparkline = ({ data, color, width = 120, height = 36 }) => {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * width},${height - ((v - min) / range) * height}`).join(" ");
  return <svg width={width} height={height} style={{ display: "block" }}><polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" /></svg>;
};

const GEXBar = ({ levels, spot }) => {
  if (!levels || levels.length === 0) return <div style={{ color: "#555", fontSize: 11 }}>No GEX data</div>;
  const max = Math.max(...levels.map(l => Math.abs(l.gex)));
  return <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
    {levels.slice(0, 10).map((l, i) => <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 10, color: "#888", width: 44, textAlign: "right" }}>{l.strike}</span>
      <div style={{ flex: 1, height: 10, background: "#111", borderRadius: 2 }}>
        <div style={{ height: "100%", width: `${Math.abs(l.gex) / max * 100}%`, background: l.gex > 0 ? "#00d4aa" : "#ff3366" }} />
      </div>
    </div>)}
  </div>;
};

const App = () => {
  const [data, setData] = useState({});
  const [optData, setOptData] = useState({});
  const [lastUpdate, setLastUpdate] = useState("");
  const [loading, setLoading] = useState(true);
  const [activeTicker, setActiveTicker] = useState("SPY");
  const [tab, setTab] = useState("overview");
  const intervalRef = useRef();

  const fetchQuote = useCallback(async (sym) => {
    try {
      const res = await fetch(YF_QUOTE(sym));
      const json = await res.json();
      const chart = json?.chart?.result?.[0];
      if (!chart) return null;
      const closes = chart.indicators.quote[0].close.filter(c => c !== null);
      const meta = chart.meta;
      return { closes, meta };
    } catch { return null; }
  }, []);

  const fetchOptions = useCallback(async (sym) => {
    try {
      const res = await fetch(YF_OPTIONS(sym));
      const json = await res.json();
      return json;
    } catch { return null; }
  }, []);

  const loadAll = useCallback(async () => {
    const quotes = await Promise.all(TICKERS.map(fetchQuote));
    const opts = await Promise.all(TICKERS.map(fetchOptions));
    const newData = {}, newOpt = {};
    quotes.forEach((q, i) => { if (q) newData[TICKERS[i]] = q; });
    opts.forEach((o, i) => { if (o) newOpt[TICKERS[i]] = o; });
    setData(newData);
    setOptData(newOpt);
    setLastUpdate(new Date().toLocaleTimeString());
    setLoading(false);
  }, [fetchQuote, fetchOptions]);

  useEffect(() => {
    loadAll();
    intervalRef.current = setInterval(loadAll, 60000);
    return () => clearInterval(intervalRef.current);
  }, [loadAll]);

  const analytics = {};
  TICKERS.forEach(sym => {
    const q = data[sym];
    if (!q || q.closes.length < 5) return;
    const spot = q.meta.regularMarketPrice || q.closes[q.closes.length - 1];
    const prev = q.meta.chartPreviousClose || q.closes[0];
    const chg = ((spot - prev) / prev) * 100;
    const regime = detectRegime(q.closes);
    const gexData = calcGEX(optData[sym], spot);
    const ivProxy = parseFloat(regime.vol) / 100 * 1.15;
    const vrp = calcVRP(q.closes, ivProxy * 100);
    analytics[sym] = { spot, prev, chg, regime, gexData, vrp, q };
  });
  const active = analytics[activeTicker];
  const chgColor = (c) => (c >= 0 ? "#39ff14" : "#ff3366");
  const gexColor = (g) => (parseFloat(g) >= 0 ? "#00d4aa" : "#ff3366");

  const s = {
    root: { minHeight: "100vh", background: "#080a0d", fontFamily: "'DM Mono', 'Fira Mono', monospace", color: "#e0e0e0", paddingBottom: 20 },
    header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderBottom: "1px solid #1a1e2a", flexWrap: "wrap" },
    logo: { fontSize: 18, fontWeight: 800, background: "linear-gradient(135deg,#00d4aa,#39ff14)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" },
    refreshBtn: { background: "#111", border: "1px solid #2a2e3a", color: "#ccc", borderRadius: 4, padding: "4px 10px", fontSize: 10, cursor: "pointer" },
    badge: { background: "#ff3366", color: "#fff", fontSize: 10, padding: "2px 8px", borderRadius: 12 },
    tickerBar: { display: "flex", gap: 8, padding: "12px 20px", borderBottom: "1px solid #1a1e2a", overflowX: "auto" },
    tickerBtn: (sym) => ({ background: activeTicker === sym ? "#1a1e2a" : "transparent", border: "1px solid #2a2e3a", borderRadius: 8, padding: "8px 16px", cursor: "pointer", minWidth: 80 }),
    tabBar: { display: "flex", gap: 2, padding: "0 20px", borderBottom: "1px solid #1a1e2a" },
    tabBtn: (isActive) => ({ background: isActive ? "#1a1e2a" : "transparent", border: "none", color: isActive ? "#fff" : "#666", padding: "10px 16px", fontSize: 11, fontWeight: 700, cursor: "pointer" }),
    grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, padding: 20 },
    card: { background: "#0c0f16", border: "1px solid #1a1e2a", borderRadius: 12, padding: 16 },
    cardTitle: { fontSize: 11, color: "#888", letterSpacing: 1, marginBottom: 12, textTransform: "uppercase" },
    bigNum: (col) => ({ fontSize: 28, fontWeight: 700, color: col || "#fff" }),
    sub: { fontSize: 11, color: "#555", marginTop: 6 },
    table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
    td: { padding: "6px 0", borderBottom: "1px solid #1a1e2a" },
    regimePill: (col) => ({ background: col + "20", color: col, padding: "2px 8px", borderRadius: 12, fontSize: 10 })
  };

  if (loading || !active) return <div style={s.root}><div style={{ padding: 40, textAlign: "center" }}>Loading market data...</div></div>;

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div><div style={s.logo}>MA$FLOW ANALYTICS</div><div style={{ fontSize: 10, color: "#333" }}>FREE · OPEN · NO GATEKEEPERS</div></div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}><span style={{ fontSize: 10, color: "#333" }}>UPD {lastUpdate}</span><button style={s.refreshBtn} onClick={loadAll}>⟳ REFRESH</button><div style={s.badge}>LIVE</div></div>
      </div>
      <div style={s.tickerBar}>{TICKERS.map(sym => {
        const a = analytics[sym];
        return <button key={sym} style={s.tickerBtn(sym)} onClick={() => setActiveTicker(sym)}><div style={{ fontSize: 13, fontWeight: 700 }}>{sym}</div>{a ? <><div style={{ fontSize: 12 }}>${a.spot?.toFixed(2)}</div><div style={{ fontSize: 10, color: chgColor(a.chg) }}>{a.chg >= 0 ? "+" : ""}{a.chg?.toFixed(2)}%</div></> : <div>loading</div>}</button>;
      })}</div>
      <div style={s.tabBar}>{["overview", "gex", "volatility", "regime"].map(t => <button key={t} style={s.tabBtn(tab === t)} onClick={() => setTab(t)}>{t.toUpperCase()}</button>)}</div>
      
      {tab === "overview" && <div style={s.grid}>
        <div style={s.card}><div style={s.cardTitle}>Price · {activeTicker}</div><div style={s.bigNum(chgColor(active.chg))}>${active.spot?.toFixed(2)}</div><div style={{ fontSize: 13, color: chgColor(active.chg) }}>{active.chg >= 0 ? "+" : ""}{active.chg.toFixed(2)}%</div><Sparkline data={active.q.closes.slice(-78)} color={chgColor(active.chg)} width={200} /><div style={s.sub}>Prev close: ${active.prev?.toFixed(2)} · 5d range</div></div>
        <div style={s.card}><div style={s.cardTitle}>Regime · {active.regime.regime}</div><div style={s.bigNum(active.regime.color)}>{active.regime.regime}</div><div style={s.sub}>Confidence: {active.regime.confidence}%</div><div><div style={{ fontSize: 11 }}>HV: {active.regime.vol}%</div><div style={{ fontSize: 11 }}>Entropy: {active.regime.entropy} bits</div><div style={{ fontSize: 11 }}>VRP: {active.vrp > 0 ? "+" : ""}{active.vrp}</div></div></div>
        <div style={s.card}><div style={s.cardTitle}>GEX Summary</div><div style={s.bigNum(gexColor(active.gexData.gex))}>{active.gexData.gex >= 0 ? "+" : ""}{active.gexData.gex}M</div><div style={s.sub}>DEX: {active.gexData.dex}K · {active.gexData.regime === "POSITIVE" ? "LONG GAMMA" : "SHORT GAMMA"}</div></div>
        <div style={{ ...s.card, gridColumn: "1 / -1" }}><div style={s.cardTitle}>Cross-Market Overview</div><table style={s.table}><thead><tr><th>Ticker</th><th>Spot</th><th>Chg</th><th>GEX</th><th>Regime</th></tr></thead><tbody>{TICKERS.map(sym => { const a = analytics[sym]; if(!a) return null; return <tr key={sym}><td style={s.td}>{sym}</td><td style={s.td}>${a.spot.toFixed(2)}</td><td style={{ ...s.td, color: chgColor(a.chg) }}>{a.chg >= 0 ? "+" : ""}{a.chg.toFixed(2)}%</td><td style={{ ...s.td, color: gexColor(a.gexData.gex) }}>{a.gexData.gex}M</td><td style={{ ...s.td, color: a.regime.color }}>{a.regime.regime}</td></tr>; })}</tbody>}</table></div>
      </div>}
      
      {tab === "gex" && <div style={s.grid}><div style={{ ...s.card, gridColumn: "1 / -1" }}><div style={s.cardTitle}>GEX Strike Distribution · {activeTicker}</div><div><div>NET GEX: <span style={{ color: gexColor(active.gexData.gex), fontSize: 22, fontWeight: 700 }}>{active.gexData.gex}M</span></div><div>DELTA EXPOSURE: {active.gexData.dex}K</div><div>DEALER MODE: {active.gexData.regime === "POSITIVE" ? "LONG GAMMA · Pinning" : "SHORT GAMMA · Amplified"}</div></div><GEXBar levels={active.gexData.topLevels} spot={active.spot} /><div style={{ marginTop: 16, fontSize: 11, color: "#555" }}>Positive GEX = dealers long gamma → they sell rallies/buy dips → price pins. Negative GEX = dealers short gamma → they buy rallies/sell dips → price accelerates.</div></div></div>}
      
      {tab === "volatility" && <div style={s.grid}>
        <div style={s.card}><div style={s.cardTitle}>Realized Volatility</div><div style={s.bigNum()}>{active.regime.vol}%</div><div style={s.sub}>20-day HV annualized</div><Sparkline data={(() => { const c = active.q.closes; const out = []; for(let i=21;i<c.length;i++){ const window = c.slice(i-21,i); const rets = window.slice(1).map((v,j)=>Math.log(v/window[j])); const hv = Math.sqrt(rets.reduce((s,r)=>s+r*r,0)/20)*Math.sqrt(252)*100; out.push(hv); } return out; })()} color="#0088ff" width={220} /></div>
        <div style={s.card}><div style={s.cardTitle}>Volatility Risk Premium</div><div style={s.bigNum(parseFloat(active.vrp) > 0 ? "#ffcc00" : "#888")}>{active.vrp > 0 ? "+" : ""}{active.vrp}</div><div style={s.sub}>IV est. − HV (vol seller edge)</div><div style={{ marginTop: 12, fontSize: 11 }}>{parseFloat(active.vrp) > 2 ? "▲ ELEVATED VRP" : parseFloat(active.vrp) < -1 ? "▼ NEGATIVE VRP" : "→ NEUTRAL VRP"}</div></div>
        <div style={s.card}><div style={s.cardTitle}>Shannon Entropy</div><div style={s.bigNum(parseFloat(active.regime.entropy) > 4 ? "#ff6b35" : "#00d4aa")}>{active.regime.entropy}</div><div style={s.sub}>bits · price disorder</div><div style={{ marginTop: 12, fontSize: 11 }}>{parseFloat(active.regime.entropy) > 4.5 ? "HIGH ENTROPY → transitional" : parseFloat(active.regime.entropy) < 3 ? "LOW ENTROPY → compressed" : "MODERATE ENTROPY"}</div></div>
        <div style={{ ...s.card, gridColumn: "1 / -1" }}><div style={s.cardTitle}>Price Distribution (5d returns)</div><div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 80 }}>{(() => { const rets = active.q.closes.slice(1).map((c,i)=>((c-active.q.closes[i])/active.q.closes[i])*100); const bins=24, min=Math.min(...rets), max=Math.max(...rets), range=max-min||1, counts=new Array(bins).fill(0); rets.forEach(r=>{const idx=Math.min(bins-1,Math.floor(((r-min)/range)*bins)); counts[idx]++;}); const maxCount=Math.max(...counts); return counts.map((c,i)=><div key={i} style={{flex:1, background: (min+(i/bins)*range)>0?"#39ff1466":"#ff336666", height:`${(c/maxCount)*100}%`, borderRadius:"2px 2px 0 0"}} />); })()}</div></div>
      </div>}
      
      {tab === "regime" && <div style={s.grid}><div style={{ ...s.card, gridColumn: "1 / -1" }}><div style={s.cardTitle}>HMM-Based Regime Engine</div><div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}><div><div style={{ fontSize: 10, color: "#444" }}>CURRENT STATE</div><div style={{ fontSize: 20, fontWeight: 700, color: active.regime.color }}>{active.regime.regime}</div></div><div><div style={{ fontSize: 10, color: "#444" }}>CONFIDENCE</div><div style={{ fontSize: 20, fontWeight: 700 }}>{active.regime.confidence}%</div></div><div><div style={{ fontSize: 10, color: "#444" }}>ANN. VOL</div><div style={{ fontSize: 20, fontWeight: 700 }}>{active.regime.vol}%</div></div><div><div style={{ fontSize: 10, color: "#444" }}>ENTROPY</div><div style={{ fontSize: 20, fontWeight: 700 }}>{active.regime.entropy} bits</div></div></div><div style={s.cardTitle}>Interpretation</div><div style={{ fontSize: 12, color: "#888" }}>{active.regime.regime === "MEAN REVERT" && "Price compressed, mean reversion expected."}{active.regime.regime === "BREAKOUT" && "Strong directional momentum."}{active.regime.regime === "TRANSITIONAL" && "High entropy, structural break likely."}{active.regime.regime === "CHOP" && "No clear direction, range-bound."}</div></div></div>}
      <div style={{ padding: "20px 20px 0", fontSize: 10, color: "#222" }}>DATA: Yahoo Finance · OPTIONS: YF Chain · ANALYTICS: Black-Scholes<br />Built by MadMaS · No gatekeepers · Refreshes every 60s</div>
    </div>
  );
};
export default App;
