import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore,
  collection,
  getDocs,
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const firebaseConfig = {
 apiKey: "AIzaSyDZTTTEoMlvBS603PbJQZUbw50jHijQWS8",
  authDomain: "paymogo-b63ca.firebaseapp.com",
  projectId: "paymogo-b63ca",
  storageBucket: "paymogo-b63ca.firebasestorage.app",
  messagingSenderId: "181510242911",
  appId: "1:181510242911:web:a975a12e3a85a6925f11ea"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const params = new URLSearchParams(window.location.search);
const state = {
  uid: null,
  beds: [],
  myVote: null,
  page: "unknown",
  group: params.get("group") || "",
  isAdmin: params.get("admin") === "1",
};

let toastTimer = null;
let voteInFlight = false;

const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const on = (el, evt, fn, opts) => el && el.addEventListener(evt, fn, opts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeHtml = (s = "") =>
  String(s).replace(/[&<>"']/g, (ch) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[ch] || ch;
  });

function setLoading(isLoading) {
  document.body.classList.toggle("loading", !!isLoading);
}

function formatBedName(name = "") {
  const raw = String(name).trim();
  if (!raw) return "Cama";

  const normalized = raw
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (normalized.includes("matrimonio")) {
    const n = normalized.match(/\d+/)?.[0];
    return `Matrimonio${n ? ` ${n}` : ""}`;
  }
  if (normalized.includes("colchon")) return "Colchón 2p";
  if (normalized.includes("individual")) {
    const n = normalized.match(/\d+/)?.[0];
    return `Individual${n ? ` ${n}` : ""}`;
  }

  return normalized.replace(/\b\w/g, (c) => c.toUpperCase());
}

function toast(message, type = "info", duration = 2600) {
  const el = qs("#toast");
  if (!el) {
    console.log(`[${type}] ${message}`);
    return;
  }

  clearTimeout(toastTimer);
  el.textContent = message;
  el.dataset.type = type;
  el.classList.add("show");

  toastTimer = setTimeout(() => {
    el.classList.remove("show");
  }, duration);
}

function confettiBoom() {
  const c = window.confetti;
  if (typeof c !== "function") return;
  c({
    particleCount: 120,
    spread: 80,
    origin: { y: 0.7 },
  });
}

function tapFx() {
  try {
    if (navigator.vibrate) navigator.vibrate(15);
  } catch (_) {}

  const audio = qs("#clickSound");
  if (!audio) return;

  try {
    audio.volume = 0.12;
    audio.currentTime = 0;
    audio.play().catch(() => {});
  } catch (_) {}
}

function detectPage() {
  if (qs("#bedsGrid")) return "elegir";
  if (qs("#summary")) return "resumen";
  if (qs("#bedsPreview")) return "index";
  return "unknown";
}

function parseError(err) {
  const raw =
    err?.details?.message || err?.message || err?.toString() || "Error inesperado";
  const msg = String(raw).replace(/^functions\//, "").trim();

  if (/ya votaste/i.test(msg)) return "Ya votaste.";
  if (/llena|sin plazas|agotad/i.test(msg)) return "Esa cama ya está llena.";
  if (/permission|denied|unauth/i.test(msg))
    return "No autorizado. Revisa reglas de Firebase.";
  if (/network|fetch/i.test(msg)) return "Problema de conexión. Intenta de nuevo.";

  return msg;
}

function normalizeBed(id, data = {}) {
  const capacity = Math.max(0, Number(data.capacity) || 0);
  const takenRaw = Math.max(0, Number(data.taken) || 0);
  const taken = Math.min(takenRaw, capacity || takenRaw);
  const free = Math.max(0, capacity - taken);
  const ratio = capacity > 0 ? Math.round((taken / capacity) * 100) : 0;

  return {
    id,
    name: data.name || id,
    displayName: formatBedName(data.name || id),
    description: String(data.description || "").trim(),
    capacity,
    taken,
    free,
    ratio,
  };
}

function bedOrder(bed) {
  const n = bed.displayName.toLowerCase();
  const index = n.includes("matrimonio")
    ? 1
    : n.includes("colchón")
      ? 2
      : n.includes("individual")
        ? 3
        : 9;
  const num = Number(n.match(/\d+/)?.[0] || 0);
  return [index, num, n];
}

function sortBeds(beds) {
  return [...beds].sort((a, b) => {
    const ak = bedOrder(a);
    const bk = bedOrder(b);
    if (ak[0] !== bk[0]) return ak[0] - bk[0];
    if (ak[1] !== bk[1]) return ak[1] - bk[1];
    return ak[2].localeCompare(bk[2], "es");
  });
}

function getTotals() {
  const totalCapacity = state.beds.reduce((sum, b) => sum + b.capacity, 0);
  const totalTaken = state.beds.reduce((sum, b) => sum + b.taken, 0);
  const totalFree = Math.max(0, totalCapacity - totalTaken);
  return { totalCapacity, totalTaken, totalFree };
}

function findMyBed() {
  if (!state.myVote?.bedId) return null;
  return state.beds.find((b) => b.id === state.myVote.bedId) || null;
}

async function ensureAuth() {
  try {
    if (!auth.currentUser) {
      await signInAnonymously(auth);
    }
    state.uid = auth.currentUser?.uid || null;
  } catch (err) {
    state.uid = null;
    toast(`Auth: ${parseError(err)}`, "error", 3800);
    console.error("Auth error", err);
  }
}

async function fetchBeds() {
  try {
    const snap = await getDocs(collection(db, "beds"));
    const rows = snap.docs.map((d) => normalizeBed(d.id, d.data()));
    return sortBeds(rows);
  } catch (err) {
    toast(`No se pudieron cargar camas: ${parseError(err)}`, "error", 3800);
    console.error("Beds error", err);
    return [];
  }
}

async function fetchMyVote() {
  if (!state.uid) return null;
  try {
    const snap = await getDoc(doc(db, "votes", state.uid));
    if (!snap.exists()) return null;
    return snap.data() || null;
  } catch (err) {
    toast(`No se pudo leer tu voto: ${parseError(err)}`, "error", 3600);
    console.error("Vote read error", err);
    return null;
  }
}

function renderStats() {
  const el = qs("#stats");
  if (!el) return;
  const { totalCapacity, totalTaken, totalFree } = getTotals();
  el.innerHTML = `
    <strong>Plazas libres: ${totalFree}/${totalCapacity}</strong>
    <span>Ocupadas: ${totalTaken}</span>
  `;
}

function renderMyVoteButton() {
  const btn = qs("#myVoteBtn");
  if (!btn) return;

  const hasVote = !!state.myVote;
  btn.disabled = !hasVote;
  btn.classList.toggle("is-disabled", !hasVote);
  btn.title = hasVote ? "Ver mi voto" : "Aún no has votado";
}

function renderMyVoteModal() {
  const modal = qs("#myVoteModal");
  if (!modal) return;

  const myVoteTextEl = qs("#myVoteText", modal);
  const content = qs(".modal__content", modal);
  const myBed = findMyBed();

  if (!state.myVote) {
    if (myVoteTextEl) {
      myVoteTextEl.textContent = "Aún no has votado.";
    } else if (content) {
      content.innerHTML = "<p>Aún no has votado.</p>";
    }
    return;
  }

  const bedText = myBed ? myBed.displayName : state.myVote.bedId || "Desconocida";
  if (myVoteTextEl) {
    myVoteTextEl.textContent = `Tu cama: ${bedText}. Tu voto ya está registrado.`;
  } else if (content) {
    content.innerHTML = `
      <p><strong>Tu cama:</strong> ${escapeHtml(bedText)}</p>
      <p>Tu voto ya está registrado.</p>
    `;
  }
}

function openModal() {
  const modal = qs("#myVoteModal");
  if (!modal) return;
  modal.setAttribute("aria-hidden", "false");
  modal.classList.add("is-open");
}

function closeModal() {
  const modal = qs("#myVoteModal");
  if (!modal) return;
  modal.setAttribute("aria-hidden", "true");
  modal.classList.remove("is-open");
}

function wireModalEvents() {
  const modal = qs("#myVoteModal");
  if (!modal) return;

  on(qs("#myVoteBtn"), "click", () => {
    if (!state.myVote) {
      toast("Aún no has votado.", "info");
      return;
    }
    tapFx();
    renderMyVoteModal();
    openModal();
  });

  qsa("[data-close-modal]", modal).forEach((el) => {
    on(el, "click", () => {
      tapFx();
      closeModal();
    });
  });

  on(document, "keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
}

function renderIndexPreview() {
  const wrap = qs("#bedsPreview");
  if (!wrap) return;

  if (!state.beds.length) {
    wrap.innerHTML = `<article class="card glass"><p>No hay camas disponibles para mostrar.</p></article>`;
    return;
  }

  const preview = [...state.beds]
    .sort((a, b) => b.free - a.free || b.capacity - a.capacity)
    .slice(0, 5);

  wrap.innerHTML = "";
  preview.forEach((bed) => {
    const card = document.createElement("article");
    card.className = `card glass ${bed.free === 0 ? "is-full" : ""}`;
    card.innerHTML = `
      <h3>${escapeHtml(bed.displayName)}</h3>
      <p>Capacidad: ${bed.capacity} · Ocupadas: ${bed.taken} · Libres: ${bed.free}</p>
      ${bed.description ? `<p class="meta">${escapeHtml(bed.description)}</p>` : ""}
      <span class="badge">${bed.free === 0 ? "LLENA" : "Disponible"}</span>
    `;
    wrap.appendChild(card);
  });
}

function renderIndexCTA() {
  const cta = qs("#ctaVote");
  if (!cta) return;

  if (state.myVote) {
    cta.textContent = "Ya votaste - ver resumen";
    cta.setAttribute("href", "./resumen.html");
  } else {
    cta.textContent = "Empezar a votar";
    cta.setAttribute("href", "./elegir.html");
  }
}

function renderChooseGrid() {
  const grid = qs("#bedsGrid");
  if (!grid) return;

  const hasVote = !!state.myVote;

  if (!state.beds.length) {
    grid.innerHTML = `<article class="card glass"><p>No se encontraron camas.</p></article>`;
    return;
  }

  grid.innerHTML = "";
  state.beds.forEach((bed) => {
    const full = bed.free === 0;
    const disabled = full || hasVote;
    const card = document.createElement("article");
    card.className = `card bed-card glass ${full ? "is-full" : ""}`;
    card.innerHTML = `
      <header class="bed-card__head">
        <h3>${escapeHtml(bed.displayName)}</h3>
        <span class="badge">${full ? "LLENA" : `${bed.free} libres`}</span>
      </header>
      ${bed.description ? `<p class="meta">${escapeHtml(bed.description)}</p>` : ""}
      <p>Capacidad: <strong>${bed.capacity}</strong></p>
      <p>Ocupadas: <strong>${bed.taken}</strong></p>
      <p>Libres: <strong>${bed.free}</strong></p>
      <div class="progress">
        <span style="width:${bed.ratio}%"></span>
      </div>
      <button class="btn btn--primary choose-btn" data-bed-id="${bed.id}" ${disabled ? "disabled" : ""}>
        ${hasVote ? "Ya has votado" : full ? "Sin plazas" : "Elegir"}
      </button>
    `;
    grid.appendChild(card);
  });
}

function renderSummary() {
  const summary = qs("#summary");
  const list = qs("#list");
  const myVote = qs("#myVote");

  if (myVote) {
    const myBed = findMyBed();
    if (state.myVote) {
      myVote.textContent = `Tu voto: ${myBed ? myBed.displayName : state.myVote.bedId}`;
    } else {
      myVote.textContent = "Aún no has votado.";
    }
  }

  if (list) {
    list.innerHTML = "";
    if (!state.beds.length) {
      const li = document.createElement("li");
      li.textContent = "No hay datos de camas.";
      list.appendChild(li);
    } else {
      state.beds.forEach((bed) => {
        const li = document.createElement("li");
        li.className = "summary-row";
        li.textContent = `${bed.displayName}: ${bed.taken}/${bed.capacity} ocupadas (${bed.free} libres)`;
        list.appendChild(li);
      });
    }
  }

  if (summary && !state.myVote) {
    let cta = qs(".summary-cta", summary);
    if (!cta) {
      cta = document.createElement("a");
      cta.className = "btn btn--primary summary-cta";
      cta.href = "./elegir.html";
      cta.textContent = "Ir a elegir cama";
      summary.appendChild(cta);
    }
  }
}

async function voteForBed(bedId) {
  if (voteInFlight) return;
  if (state.myVote) {
    toast("Ya votaste.", "info");
    return;
  }

  voteInFlight = true;
  setLoading(true);
  tapFx();

  try {
    if (!state.uid) {
      throw new Error("No autenticado.");
    }

    const voteRef = doc(db, "votes", state.uid);
    const bedRef = doc(db, "beds", bedId);

    await runTransaction(db, async (tx) => {
      const [voteSnap, bedSnap] = await Promise.all([
        tx.get(voteRef),
        tx.get(bedRef),
      ]);

      if (voteSnap.exists()) throw new Error("Ya votaste.");
      if (!bedSnap.exists()) throw new Error("La cama no existe.");

      const bed = bedSnap.data() || {};
      const capacity = Math.max(0, Number(bed.capacity) || 0);
      const taken = Math.max(0, Number(bed.taken) || 0);

      if (taken >= capacity) throw new Error("Esa cama ya está llena.");

      tx.update(bedRef, { taken: taken + 1 });
      tx.set(voteRef, {
        uid: state.uid,
        bedId,
        createdAt: serverTimestamp(),
        ...(state.group ? { group: state.group } : {}),
      });
    });

    confettiBoom();
    toast("Voto registrado. Perfecto!", "success");
    await sleep(180);

    await refreshData();
    renderCurrentPage();
    renderMyVoteModal();
    openModal();

    const goSummary = qs("#goSummaryBtn");
    if (goSummary) goSummary.removeAttribute("hidden");
  } catch (err) {
    toast(parseError(err), "error", 3800);
    console.error("Vote error", err);
  } finally {
    voteInFlight = false;
    setLoading(false);
  }
}

function wireChooseEvents() {
  const grid = qs("#bedsGrid");
  if (!grid) return;

  on(grid, "click", async (e) => {
    const btn = e.target.closest(".choose-btn");
    if (!btn) return;
    e.preventDefault();

    if (btn.disabled) return;
    const bedId = btn.dataset.bedId;
    if (!bedId) return;

    await voteForBed(bedId);
  });
}

function wireGeneralEffects() {
  on(document, "mouseover", (e) => {
    const target = e.target.closest("a, button, .card");
    if (!target) return;
    const rel = e.relatedTarget;
    if (rel && target.contains(rel)) return;
    const audio = qs("#clickSound");
    if (!audio) return;
    try {
      audio.volume = 0.06;
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } catch (_) {}
  });

  on(document, "click", (e) => {
    const interactive = e.target.closest("a, button, [role='button']");
    if (!interactive) return;
    tapFx();
  });
}

async function handleAdminReset() {
  const btn = qs("#adminResetBtn");
  if (!btn || !state.isAdmin) return;

  btn.hidden = false;
  on(btn, "click", async () => {
    toast("Reset por admin no disponible sin Cloud Functions.", "info", 4200);
  });
}

async function refreshData() {
  const [beds, myVote] = await Promise.all([fetchBeds(), fetchMyVote()]);
  state.beds = beds;
  state.myVote = myVote;
}

function renderCurrentPage() {
  renderStats();
  renderMyVoteButton();
  renderMyVoteModal();

  const routeContext = qs("#routeContext");
  if (routeContext) routeContext.dataset.group = state.group;

  if (state.page === "index") {
    renderIndexPreview();
    renderIndexCTA();
  } else if (state.page === "elegir") {
    renderChooseGrid();
  } else if (state.page === "resumen") {
    renderSummary();
  }
}

async function bootstrap() {
  state.page = detectPage();
  setLoading(true);
  wireGeneralEffects();
  wireModalEvents();

  try {
    await ensureAuth();
    await refreshData();
    renderCurrentPage();
    wireChooseEvents();
    await handleAdminReset();
  } catch (err) {
    console.error("Bootstrap error", err);
    toast(`Error de inicio: ${parseError(err)}`, "error", 4000);
  } finally {
    setLoading(false);
  }
}

if (document.readyState === "loading") {
  on(document, "DOMContentLoaded", () => {
    bootstrap().catch((err) => {
      console.error(err);
      toast("No se pudo iniciar la app.", "error");
    });
  });
} else {
  bootstrap().catch((err) => {
    console.error(err);
    toast("No se pudo iniciar la app.", "error");
  });
}
