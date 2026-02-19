import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore,
  collection,
  query,
  where,
  getDocs,
  doc,
  getDoc,
  addDoc,
  setDoc,
  updateDoc,
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
  myDayVote: null,
  myBbqVote: null,
  userVotes: [],
  dayVotes: [],
  bbqVotes: [],
  packingItems: [],
  users: [],
  userId: "",
  userName: "",
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
const LS_USER_ID = "paymogo_user_id";
const LS_USER_NAME = "paymogo_user_name";
const DAY_OPTIONS = [
  { id: "viernes", label: "Viernes", subtitle: "Solo viernes" },
  { id: "sabado", label: "Sábado", subtitle: "Solo sábado" },
  { id: "viernes_sabado", label: "Viernes y Sábado", subtitle: "Plan completo" },
];

function groupAwareCollectionRef(collectionName) {
  const col = collection(db, collectionName);
  return state.group ? query(col, where("group", "==", state.group)) : col;
}

function computeBrotherRanking() {
  const baseUsers = (state.users || []).map((u) => ({
    userId: u.id,
    userName: u.displayName || u.id,
    points: 0,
  }));

  const map = new Map(baseUsers.map((u) => [u.userId, u]));
  const ensure = (id, fallbackName = id) => {
    if (!id) return null;
    if (!map.has(id)) {
      map.set(id, { userId: id, userName: fallbackName || id, points: 0 });
    }
    return map.get(id);
  };

  state.dayVotes.forEach((v) => {
    const row = ensure(v.userId, v.userName);
    if (!row) return;
    row.points += v.optionId === "viernes_sabado" ? 3 : 1;
  });

  state.userVotes.forEach((v) => {
    if (v.bedId !== "individual1") return;
    const row = ensure(v.userId, v.userName);
    if (!row) return;
    row.points += 2;
  });

  state.bbqVotes.forEach((v) => {
    const row = ensure(v.userId, v.userName);
    if (!row) return;
    if (v.asiste) row.points += 1;
    if (v.cuentaComida) row.points += 1;
    if (v.cuentaBebida) row.points += 1;
  });

  state.packingItems.forEach((it) => {
    const row = ensure(it.addedByUserId, it.addedByUserName);
    if (!row) return;
    row.points += 1;
  });

  return [...map.values()].sort((a, b) => b.points - a.points || a.userName.localeCompare(b.userName, "es"));
}

function renderBrotherLeaderboard() {
  const podium = qs("#leaderboardPodium");
  const list = qs("#leaderboardList");
  if (!podium || !list) return;

  const ranking = computeBrotherRanking();

  const top3 = [ranking[0], ranking[1], ranking[2]];
  podium.innerHTML = top3
    .map((u, idx) => `
      <article class="card glass podium-slot podium-${idx + 1}">
        <strong>#${idx + 1}</strong>
        <span class="name">${escapeHtml(u?.userName || "-")}</span>
        <span class="meta">${u?.points ?? 0} pts</span>
      </article>
    `)
    .join("");

  list.innerHTML = "";
  if (!ranking.length) {
    list.innerHTML = "<li class=\"meta\">Sin datos todavía.</li>";
    return;
  }

  ranking.forEach((u, i) => {
    const li = document.createElement("li");
    li.className = "leader-row";
    li.innerHTML = `
      <span class="name">${i + 1}. ${escapeHtml(u.userName)}</span>
      <span class="badge">${u.points} pts</span>
    `;
    list.appendChild(li);
  });
}

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

function thankUserForVote() {
  const name = state.userName || "compa";
  toast(
    `Gracias ${name}. Este voto cuenta mucho para mí y para tu posición en la clasificación de hermano, sigue así.`,
    "success",
    5200
  );
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
  if (qs("#daysOptions")) return "dias";
  if (qs("#bbqForm")) return "barbacoa";
  if (qs("#packingForm")) return "maleta";
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

function setCurrentUser(user) {
  state.userId = user.id;
  state.userName = user.displayName || user.id;
  try {
    localStorage.setItem(LS_USER_ID, state.userId);
    localStorage.setItem(LS_USER_NAME, state.userName);
  } catch (_) {}
}

function clearCurrentUser() {
  state.userId = "";
  state.userName = "";
  try {
    localStorage.removeItem(LS_USER_ID);
    localStorage.removeItem(LS_USER_NAME);
  } catch (_) {}
}

function ensureLogoutButton() {
  const nav = qs(".nav");
  if (!nav) return;

  let btn = qs("#logoutBtn", nav);
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "logoutBtn";
    btn.type = "button";
    btn.className = "nav__link";
    nav.appendChild(btn);

    on(btn, "click", async () => {
      tapFx();
      clearCurrentUser();
      state.myVote = null;
      state.myDayVote = null;
      state.myBbqVote = null;
      toast("Sesión cerrada. Elige usuario para continuar.", "info", 3200);

      try {
        await ensureIdentity();
        await refreshData();
        renderCurrentPage();
      } catch (err) {
        toast(`No se pudo reabrir sesión: ${parseError(err)}`, "error", 3800);
        console.error("Relogin error", err);
      }
    });
  }

  btn.textContent = state.userName ? `Cerrar sesión (${state.userName})` : "Cerrar sesión";
}

async function fetchUsers() {
  try {
    const snap = await getDocs(collection(db, "users"));
    const users = snap.docs
      .map((d) => {
        const data = d.data() || {};
        return {
          id: d.id,
          displayName: String(data.displayName || d.id),
          pin: String(data.pin || ""),
          active: data.active !== false,
        };
      })
      .filter((u) => u.active)
      .sort((a, b) => a.displayName.localeCompare(b.displayName, "es"));
    state.users = users;
    return users;
  } catch (err) {
    toast(`No se pudieron cargar usuarios: ${parseError(err)}`, "error", 4200);
    console.error("Users error", err);
    return [];
  }
}

function ensureIdentityModal() {
  let modal = qs("#identityModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "identityModal";
  modal.className = "modal is-open";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "identityTitle");
  modal.innerHTML = `
    <div class="modal__backdrop"></div>
    <div class="modal__panel glass">
      <h3 id="identityTitle">¿Quién eres?</h3>
      <p class="meta">Elige tu nombre e introduce tu PIN para votar.</p>
      <label class="meta" for="identityUserSelect">Usuario</label>
      <select id="identityUserSelect" class="btn ghost" style="width:100%;justify-content:flex-start;"></select>
      <label class="meta" for="identityPinInput">PIN</label>
      <input id="identityPinInput" type="password" autocomplete="current-password"
        class="btn ghost" style="width:100%;justify-content:flex-start;" placeholder="PIN" />
      <div class="modal__actions">
        <button id="identitySubmitBtn" class="btn btn--primary" type="button">Entrar</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

async function ensureIdentity() {
  const users = await fetchUsers();
  if (!users.length) {
    throw new Error("No hay usuarios activos en /users.");
  }

  const storedId = localStorage.getItem(LS_USER_ID) || "";
  const storedUser = users.find((u) => u.id === storedId);
  if (storedUser) {
    setCurrentUser(storedUser);
    return;
  }

  const modal = ensureIdentityModal();
  const select = qs("#identityUserSelect", modal);
  const pinInput = qs("#identityPinInput", modal);
  const submitBtn = qs("#identitySubmitBtn", modal);

  select.innerHTML = users
    .map((u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.displayName)}</option>`)
    .join("");

  await new Promise((resolve) => {
    const tryLogin = () => {
      const selected = users.find((u) => u.id === select.value);
      const pin = String(pinInput.value || "");
      if (!selected) {
        toast("Selecciona un usuario.", "info");
        return;
      }
      if (!selected.pin || pin !== selected.pin) {
        toast("PIN incorrecto.", "error");
        modal.classList.remove("shake");
        void modal.offsetWidth;
        modal.classList.add("shake");
        return;
      }

      setCurrentUser(selected);
      modal.setAttribute("aria-hidden", "true");
      modal.classList.remove("is-open");
      resolve();
    };

    on(submitBtn, "click", tryLogin);
    on(pinInput, "keydown", (e) => {
      if (e.key === "Enter") tryLogin();
    });
  });
}

async function fetchBeds() {
  try {
    const snap = await getDocs(groupAwareCollectionRef("beds"));
    const rows = snap.docs.map((d) => normalizeBed(d.id, d.data()));
    return sortBeds(rows);
  } catch (err) {
    toast(`No se pudieron cargar camas: ${parseError(err)}`, "error", 3800);
    console.error("Beds error", err);
    return [];
  }
}

async function fetchMyVote() {
  if (!state.userId) return null;
  try {
    const snap = await getDoc(doc(db, "userVotes", state.userId));
    if (!snap.exists()) return null;
    return snap.data() || null;
  } catch (err) {
    toast(`No se pudo leer tu voto: ${parseError(err)}`, "error", 3600);
    console.error("Vote read error", err);
    return null;
  }
}

async function fetchAllUserVotes() {
  try {
    const snap = await getDocs(groupAwareCollectionRef("userVotes"));
    return snap.docs.map((d) => {
      const data = d.data() || {};
      return {
        id: d.id,
        bedId: String(data.bedId || ""),
        userId: String(data.userId || d.id),
        userName: String(data.userName || data.userId || d.id),
      };
    });
  } catch (err) {
    toast(`No se pudieron leer votos por cama: ${parseError(err)}`, "error", 3600);
    console.error("User votes read error", err);
    return [];
  }
}

async function fetchMyDayVote() {
  if (!state.userId) return null;
  try {
    const snap = await getDoc(doc(db, "dayVotes", state.userId));
    if (!snap.exists()) return null;
    return snap.data() || null;
  } catch (err) {
    toast(`No se pudo leer tu voto de días: ${parseError(err)}`, "error", 3600);
    console.error("Day vote read error", err);
    return null;
  }
}

async function fetchAllDayVotes() {
  try {
    const snap = await getDocs(groupAwareCollectionRef("dayVotes"));
    return snap.docs.map((d) => {
      const data = d.data() || {};
      return {
        id: d.id,
        optionId: String(data.optionId || ""),
        optionLabel: String(data.optionLabel || ""),
        userId: String(data.userId || d.id),
        userName: String(data.userName || data.userId || d.id),
      };
    });
  } catch (err) {
    toast(`No se pudieron leer votos de días: ${parseError(err)}`, "error", 3600);
    console.error("Day votes read error", err);
    return [];
  }
}

async function fetchMyBbqVote() {
  if (!state.userId) return null;
  try {
    const snap = await getDoc(doc(db, "bbqVotes", state.userId));
    if (!snap.exists()) return null;
    return snap.data() || null;
  } catch (err) {
    toast(`No se pudo leer tu voto de barbacoa: ${parseError(err)}`, "error", 3600);
    console.error("BBQ vote read error", err);
    return null;
  }
}

async function fetchAllBbqVotes() {
  try {
    const snap = await getDocs(groupAwareCollectionRef("bbqVotes"));
    return snap.docs.map((d) => {
      const data = d.data() || {};
      return {
        id: d.id,
        userId: String(data.userId || d.id),
        userName: String(data.userName || data.userId || d.id),
        asiste: !!data.asiste,
        cuentaComida: !!data.cuentaComida,
        cuentaBebida: !!data.cuentaBebida,
        peticionComida: String(data.peticionComida || ""),
        peticionBebida: String(data.peticionBebida || ""),
        noQuiere: String(data.noQuiere || ""),
        notas: String(data.notas || ""),
      };
    });
  } catch (err) {
    toast(`No se pudieron leer votos de barbacoa: ${parseError(err)}`, "error", 3600);
    console.error("BBQ votes read error", err);
    return [];
  }
}

async function fetchPackingItems() {
  try {
    const snap = await getDocs(groupAwareCollectionRef("packingItems"));
    return snap.docs
      .map((d) => {
        const data = d.data() || {};
        return {
          id: d.id,
          itemName: String(data.itemName || "").trim(),
          notes: String(data.notes || "").trim(),
          assignedUserId: String(data.assignedUserId || ""),
          assignedUserName: String(data.assignedUserName || ""),
          addedByUserId: String(data.addedByUserId || ""),
          addedByUserName: String(data.addedByUserName || ""),
          status: String(data.status || "pendiente"),
        };
      })
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === "pendiente" ? -1 : 1;
        return a.itemName.localeCompare(b.itemName, "es");
      });
  } catch (err) {
    toast(`No se pudo cargar maleta comunitaria: ${parseError(err)}`, "error", 3600);
    console.error("Packing items read error", err);
    return [];
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

  if (!state.userId) {
    btn.disabled = true;
    btn.classList.add("is-disabled");
    btn.title = "Primero identifícate.";
    return;
  }

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

function openBedInfoModal() {
  const modal = qs("#bedInfoModal");
  if (!modal) return;
  modal.setAttribute("aria-hidden", "false");
  modal.classList.add("is-open");
}

function closeBedInfoModal() {
  const modal = qs("#bedInfoModal");
  if (!modal) return;
  modal.setAttribute("aria-hidden", "true");
  modal.classList.remove("is-open");
}

function renderBedInfo(bedId) {
  const modal = qs("#bedInfoModal");
  if (!modal) return;

  const bed = state.beds.find((b) => b.id === bedId);
  const title = qs("#bedInfoTitle", modal);
  const desc = qs("#bedInfoDescription", modal);
  const voters = qs("#bedInfoVoters", modal);
  if (!bed || !title || !desc || !voters) return;

  title.textContent = bed.displayName;
  desc.textContent = bed.description || "Esta cama no tiene descripción.";

  const names = state.userVotes.filter((v) => v.bedId === bedId);
  voters.innerHTML = names.length
    ? names.map((v) => `<li>${escapeHtml(v.userName)}</li>`).join("")
    : "<li class=\"meta\">Sin votos todavía.</li>";
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
    if (e.key === "Escape") {
      closeModal();
      closeBedInfoModal();
    }
  });
}

function wireBedInfoEvents() {
  const modal = qs("#bedInfoModal");
  if (!modal) return;

  qsa("[data-close-bed-info]", modal).forEach((el) => {
    on(el, "click", () => {
      tapFx();
      closeBedInfoModal();
    });
  });
}

function renderIndexPreview() {
  const wrap = qs("#bedsPreview");
  if (!wrap) return;
  if (wrap.dataset.static === "true") return;

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
    card.dataset.bedId = bed.id;
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
  const myDayVoteSummary = qs("#myDayVoteSummary");
  const daysSummaryList = qs("#daysSummaryList");
  const myBbqSummary = qs("#myBbqSummary");
  const bbqSummaryTotals = qs("#bbqSummaryTotals");
  const bbqSummaryList = qs("#bbqSummaryList");

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
        const occupants = state.userVotes.filter((v) => v.bedId === bed.id);
        const li = document.createElement("li");
        li.className = "summary-row";
        const statusClass = bed.free === 0 ? "sold" : bed.free === 1 ? "badge--warning" : "badge";
        const statusText = bed.free === 0 ? "LLENA" : bed.free === 1 ? "ULTIMAS PLAZAS" : "LIBRE";
        const namesHtml = occupants.length
          ? occupants.map((v) => `<li>${escapeHtml(v.userName)}</li>`).join("")
          : "<li class=\"meta\">Sin nombres registrados todavía.</li>";
        li.innerHTML = `
          <button class="summary-toggle ghost" type="button" aria-expanded="false" data-bed-id="${escapeHtml(bed.id)}">
            <span class="name">${escapeHtml(bed.displayName)}</span>
            <span class="meta">${bed.taken}/${bed.capacity} ocupadas (${bed.free} libres)</span>
            <span class="${statusClass}">${statusText}</span>
          </button>
          <div class="summary-users hidden" data-users-for="${escapeHtml(bed.id)}">
            <strong>Personas en esta cama:</strong>
            <ul>${namesHtml}</ul>
          </div>
        `;
        list.appendChild(li);
      });

      qsa(".summary-toggle", list).forEach((btn) => {
        on(btn, "click", () => {
          const bedId = btn.dataset.bedId || "";
          const panel = qsa("[data-users-for]", list).find((el) => el.dataset.usersFor === bedId);
          if (!panel) return;
          const isOpen = !panel.classList.contains("hidden");
          panel.classList.toggle("hidden", isOpen);
          btn.setAttribute("aria-expanded", String(!isOpen));
        });
      });
    }
  }

  if (myDayVoteSummary) {
    myDayVoteSummary.textContent = state.myDayVote?.optionLabel
      ? `Tu voto de días: ${state.myDayVote.optionLabel}`
      : "Aún no has votado los días.";
  }

  if (daysSummaryList) {
    daysSummaryList.innerHTML = "";
    DAY_OPTIONS.forEach((opt) => {
      const voters = state.dayVotes.filter((v) => v.optionId === opt.id);
      const li = document.createElement("li");
      li.className = "summary-flat-card";
      const votersHtml = voters.length
        ? voters.map((v) => `<span class="voter-chip">${escapeHtml(v.userName)}</span>`).join("")
        : "<span class=\"meta\">Sin votos.</span>";
      li.innerHTML = `
        <div class="summary-flat-head">
          <span class="name">${escapeHtml(opt.label)}</span>
          <span class="pill">${voters.length} voto${voters.length === 1 ? "" : "s"}</span>
        </div>
        <div class="voter-row">${votersHtml}</div>
      `;
      daysSummaryList.appendChild(li);
    });
  }

  const attending = state.bbqVotes.filter((v) => v.asiste);
  const bbqComida = attending.filter((v) => v.cuentaComida).length;
  const bbqBebida = attending.filter((v) => v.cuentaBebida).length;

  if (myBbqSummary) {
    if (!state.myBbqVote) {
      myBbqSummary.textContent = "Aún no has respondido la barbacoa.";
    } else {
      myBbqSummary.textContent = state.myBbqVote.asiste
        ? "Tu estado barbacoa: Asistes."
        : "Tu estado barbacoa: No asistes.";
    }
  }

  if (bbqSummaryTotals) {
    bbqSummaryTotals.innerHTML = `
      <span class="badge">${attending.length} asistentes</span>
      <span class="badge">${bbqComida} comida</span>
      <span class="badge">${bbqBebida} bebida</span>
    `;
  }

  if (bbqSummaryList) {
    bbqSummaryList.innerHTML = "";
    if (!state.bbqVotes.length) {
      bbqSummaryList.innerHTML = "<li class=\"meta\">Sin respuestas de barbacoa todavía.</li>";
    } else {
      state.bbqVotes.forEach((v) => {
        const li = document.createElement("li");
        li.className = "summary-flat-card";
        li.innerHTML = `
          <div class="summary-flat-head">
            <span class="name">${escapeHtml(v.userName)}</span>
            <span class="${v.asiste ? "badge" : "sold"}">${v.asiste ? "ASISTE" : "NO ASISTE"}</span>
          </div>
          <span class="meta">Comida: ${v.cuentaComida ? "Si" : "No"} · Bebida: ${v.cuentaBebida ? "Si" : "No"}</span>
          ${(v.peticionComida || v.peticionBebida || v.noQuiere)
            ? `<div class="voter-row">
                ${v.peticionComida ? `<span class="voter-chip">Comida: ${escapeHtml(v.peticionComida)}</span>` : ""}
                ${v.peticionBebida ? `<span class="voter-chip">Bebida: ${escapeHtml(v.peticionBebida)}</span>` : ""}
                ${v.noQuiere ? `<span class="voter-chip">No quiere: ${escapeHtml(v.noQuiere)}</span>` : ""}
              </div>`
            : ""}
        `;
        bbqSummaryList.appendChild(li);
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

function renderDaysPage() {
  const optionsWrap = qs("#daysOptions");
  if (!optionsWrap) return;

  const myDayVoteEl = qs("#myDayVote");
  if (myDayVoteEl) {
    if (state.myDayVote?.optionLabel) {
      myDayVoteEl.textContent = `Tu voto de días: ${state.myDayVote.optionLabel}`;
    } else {
      myDayVoteEl.textContent = "Aún no has votado los días.";
    }
  }

  const counts = DAY_OPTIONS.reduce((acc, opt) => {
    acc[opt.id] = 0;
    return acc;
  }, {});
  state.dayVotes.forEach((v) => {
    if (counts[v.optionId] !== undefined) counts[v.optionId] += 1;
  });

  optionsWrap.innerHTML = "";
  DAY_OPTIONS.forEach((opt) => {
    const voters = state.dayVotes.filter((v) => v.optionId === opt.id);
    const selectedByMe = state.myDayVote?.optionId === opt.id;
    const locked = !!state.myDayVote;
    const card = document.createElement("article");
    card.className = `card glass day-card ${selectedByMe ? "celebrate" : ""}`;
    const votersHtml = voters.length
      ? voters.map((v) => `<li>${escapeHtml(v.userName)}</li>`).join("")
      : "<li class=\"meta\">Sin votos todavía.</li>";
    card.innerHTML = `
      <h3>${escapeHtml(opt.label)}</h3>
      <p class="meta">${escapeHtml(opt.subtitle)}</p>
      <span class="badge">${counts[opt.id]} voto${counts[opt.id] === 1 ? "" : "s"}</span>
      <button class="btn btn--primary choose-day-btn" data-day-option="${opt.id}" ${locked ? "disabled" : ""}>
        ${selectedByMe ? "Tu elección" : locked ? "Ya votaste" : "Votar opción"}
      </button>
      <div class="summary-users">
        <strong>Votantes:</strong>
        <ul>${votersHtml}</ul>
      </div>
    `;
    optionsWrap.appendChild(card);
  });
}

function renderBbqPage() {
  const form = qs("#bbqForm");
  if (!form) return;

  const my = state.myBbqVote || null;
  if (my) {
    const asiste = my.asiste ? "si" : "no";
    const comida = my.cuentaComida ? "si" : "no";
    const bebida = my.cuentaBebida ? "si" : "no";
    const checkRadio = (name, val) => {
      const input = qs(`input[name="${name}"][value="${val}"]`, form);
      if (input) input.checked = true;
    };
    checkRadio("asiste", asiste);
    checkRadio("cuentaComida", comida);
    checkRadio("cuentaBebida", bebida);
    const setValue = (id, v) => {
      const el = qs(`#${id}`, form);
      if (el && document.activeElement !== el) el.value = v || "";
    };
    setValue("peticionComida", my.peticionComida);
    setValue("peticionBebida", my.peticionBebida);
    setValue("noQuiere", my.noQuiere);
    setValue("bbqNotas", my.notas);
  }

  const myStatus = qs("#myBbqStatus");
  if (myStatus) {
    myStatus.textContent = my
      ? "Tu respuesta está guardada. Puedes actualizarla."
      : "Aún no has respondido la votación de barbacoa.";
  }

  const attending = state.bbqVotes.filter((v) => v.asiste);
  const comida = attending.filter((v) => v.cuentaComida).length;
  const bebida = attending.filter((v) => v.cuentaBebida).length;

  const totals = qs("#bbqTotals");
  if (totals) {
    totals.innerHTML = `
      <span class="badge">${attending.length} asistentes</span>
      <span class="badge">${comida} para comida</span>
      <span class="badge">${bebida} para bebida</span>
    `;
  }

  const requestList = qs("#bbqRequests");
  if (requestList) {
    requestList.innerHTML = "";
    const withData = state.bbqVotes.filter((v) =>
      v.peticionComida || v.peticionBebida || v.noQuiere || v.notas
    );
    if (!withData.length) {
      requestList.innerHTML = "<li class=\"meta\">Sin peticiones todavía.</li>";
    } else {
      withData.forEach((v) => {
        const li = document.createElement("li");
        li.className = "summary-row";
        li.innerHTML = `
          <span class="name">${escapeHtml(v.userName)}</span>
          ${v.peticionComida ? `<span class="meta">Comida: ${escapeHtml(v.peticionComida)}</span>` : ""}
          ${v.peticionBebida ? `<span class="meta">Bebida: ${escapeHtml(v.peticionBebida)}</span>` : ""}
          ${v.noQuiere ? `<span class="meta">No quiere: ${escapeHtml(v.noQuiere)}</span>` : ""}
          ${v.notas ? `<span class="meta">Notas: ${escapeHtml(v.notas)}</span>` : ""}
        `;
        requestList.appendChild(li);
      });
    }
  }
}

function renderPackingPage() {
  const form = qs("#packingForm");
  const list = qs("#packingList");
  if (!form || !list) return;

  const assignSelect = qs("#packingAssignedUser", form);
  if (assignSelect && !assignSelect.dataset.filled) {
    assignSelect.innerHTML = state.users
      .map((u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.displayName)}</option>`)
      .join("");
    assignSelect.dataset.filled = "true";
  }

  list.innerHTML = "";
  if (!state.packingItems.length) {
    list.innerHTML = "<li class=\"meta\">Todavía no hay cosas añadidas.</li>";
    return;
  }

  state.packingItems.forEach((item) => {
    const li = document.createElement("li");
    li.className = "summary-row";
    const done = item.status === "listo";
    li.innerHTML = `
      <span class="name">${escapeHtml(item.itemName)}</span>
      <span class="meta">Lo lleva: ${escapeHtml(item.assignedUserName || item.assignedUserId || "-")}</span>
      ${item.notes ? `<span class="meta">Nota: ${escapeHtml(item.notes)}</span>` : ""}
      <span class="${done ? "badge" : "badge--warning"}">${done ? "LISTO" : "PENDIENTE"}</span>
      <span class="meta">Añadido por: ${escapeHtml(item.addedByUserName || item.addedByUserId || "-")}</span>
      <button class="btn ghost toggle-pack-btn" type="button" data-pack-id="${escapeHtml(item.id)}" data-next-status="${done ? "pendiente" : "listo"}">
        ${done ? "Marcar pendiente" : "Marcar listo"}
      </button>
    `;
    list.appendChild(li);
  });
}

async function voteForBed(bedId) {
  if (voteInFlight) return;
  if (!state.userId) {
    toast("Primero identifícate con tu usuario.", "info");
    return;
  }
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
    const userVoteRef = doc(db, "userVotes", state.userId);
    const bedRef = doc(db, "beds", bedId);

    await runTransaction(db, async (tx) => {
      const [voteSnap, userVoteSnap, bedSnap] = await Promise.all([
        tx.get(voteRef),
        tx.get(userVoteRef),
        tx.get(bedRef),
      ]);

      if (voteSnap.exists()) throw new Error("Ya votaste.");
      if (userVoteSnap.exists()) throw new Error("Este usuario ya votó.");
      if (!bedSnap.exists()) throw new Error("La cama no existe.");

      const bed = bedSnap.data() || {};
      const capacity = Math.max(0, Number(bed.capacity) || 0);
      const taken = Math.max(0, Number(bed.taken) || 0);

      if (taken >= capacity) throw new Error("Esa cama ya está llena.");

      tx.update(bedRef, { taken: taken + 1 });
      const votePayload = {
        uid: state.uid,
        userId: state.userId,
        userName: state.userName,
        bedId,
        createdAt: serverTimestamp(),
        ...(state.group ? { group: state.group } : {}),
      };

      tx.set(voteRef, votePayload);
      tx.set(userVoteRef, votePayload);
    });

    confettiBoom();
    thankUserForVote();
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

async function voteForDay(optionId) {
  if (voteInFlight) return;
  if (!state.userId) {
    toast("Primero identifícate con tu usuario.", "info");
    return;
  }
  if (state.myDayVote) {
    toast("Ya votaste los días.", "info");
    return;
  }

  const opt = DAY_OPTIONS.find((o) => o.id === optionId);
  if (!opt) {
    toast("Opción de días no válida.", "error");
    return;
  }

  voteInFlight = true;
  setLoading(true);
  tapFx();

  try {
    if (!state.uid) throw new Error("No autenticado.");

    const ref = doc(db, "dayVotes", state.userId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists()) throw new Error("Este usuario ya votó los días.");

      tx.set(ref, {
        uid: state.uid,
        userId: state.userId,
        userName: state.userName,
        optionId: opt.id,
        optionLabel: opt.label,
        createdAt: serverTimestamp(),
        ...(state.group ? { group: state.group } : {}),
      });
    });

    confettiBoom();
    thankUserForVote();
    await refreshData();
    renderCurrentPage();
  } catch (err) {
    toast(parseError(err), "error", 3800);
    console.error("Day vote error", err);
  } finally {
    voteInFlight = false;
    setLoading(false);
  }
}

async function saveBbqVoteFromForm() {
  const form = qs("#bbqForm");
  if (!form) return;
  if (!state.userId) {
    toast("Primero identifícate con tu usuario.", "info");
    return;
  }

  const fd = new FormData(form);
  const asiste = fd.get("asiste") === "si";
  if (!fd.get("asiste")) {
    toast("Indica si asistes o no a la barbacoa.", "info");
    return;
  }
  const cuentaComida = asiste ? fd.get("cuentaComida") === "si" : false;
  const cuentaBebida = asiste ? fd.get("cuentaBebida") === "si" : false;

  const payload = {
    uid: state.uid || "",
    userId: state.userId,
    userName: state.userName,
    asiste,
    cuentaComida,
    cuentaBebida,
    peticionComida: String(fd.get("peticionComida") || "").trim(),
    peticionBebida: String(fd.get("peticionBebida") || "").trim(),
    noQuiere: String(fd.get("noQuiere") || "").trim(),
    notas: String(fd.get("bbqNotas") || "").trim(),
    updatedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
    ...(state.group ? { group: state.group } : {}),
  };

  setLoading(true);
  try {
    await setDoc(doc(db, "bbqVotes", state.userId), payload, { merge: true });
    confettiBoom();
    thankUserForVote();
    await refreshData();
    renderCurrentPage();
  } catch (err) {
    toast(`No se pudo guardar: ${parseError(err)}`, "error", 3800);
    console.error("BBQ save error", err);
  } finally {
    setLoading(false);
  }
}

async function savePackingItemFromForm() {
  const form = qs("#packingForm");
  if (!form) return;
  if (!state.userId) {
    toast("Primero identifícate con tu usuario.", "info");
    return;
  }

  const fd = new FormData(form);
  const itemName = String(fd.get("itemName") || "").trim();
  const assignedUserId = String(fd.get("assignedUserId") || "").trim();
  const notes = String(fd.get("notes") || "").trim();
  const assignedUser = state.users.find((u) => u.id === assignedUserId);

  if (!itemName) {
    toast("Escribe qué hay que llevar.", "info");
    return;
  }
  if (!assignedUserId || !assignedUser) {
    toast("Selecciona a quién se asigna.", "info");
    return;
  }

  setLoading(true);
  try {
    await addDoc(collection(db, "packingItems"), {
      itemName,
      notes,
      assignedUserId,
      assignedUserName: assignedUser.displayName || assignedUser.id,
      addedByUserId: state.userId,
      addedByUserName: state.userName,
      status: "pendiente",
      createdAt: serverTimestamp(),
      ...(state.group ? { group: state.group } : {}),
    });

    form.reset();
    const sel = qs("#packingAssignedUser", form);
    if (sel && state.users.length) sel.value = state.users[0].id;
    confettiBoom();
    thankUserForVote();
    await refreshData();
    renderCurrentPage();
  } catch (err) {
    toast(`No se pudo guardar: ${parseError(err)}`, "error", 3800);
    console.error("Packing create error", err);
  } finally {
    setLoading(false);
  }
}

async function updatePackingItemStatus(itemId, nextStatus) {
  if (!itemId || !nextStatus) return;
  setLoading(true);
  try {
    await updateDoc(doc(db, "packingItems", itemId), {
      status: nextStatus,
      updatedAt: serverTimestamp(),
    });
    await refreshData();
    renderCurrentPage();
  } catch (err) {
    toast(`No se pudo actualizar estado: ${parseError(err)}`, "error", 3800);
    console.error("Packing update error", err);
  } finally {
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

  on(grid, "click", (e) => {
    if (e.target.closest(".choose-btn")) return;
    const card = e.target.closest(".bed-card");
    if (!card) return;
    const bedId = card.dataset.bedId;
    if (!bedId) return;
    tapFx();
    renderBedInfo(bedId);
    openBedInfoModal();
  });
}

function wireDaysEvents() {
  const wrap = qs("#daysOptions");
  if (!wrap) return;

  on(wrap, "click", async (e) => {
    const btn = e.target.closest(".choose-day-btn");
    if (!btn || btn.disabled) return;
    const optionId = btn.dataset.dayOption;
    if (!optionId) return;
    await voteForDay(optionId);
  });
}

function wireBbqEvents() {
  const form = qs("#bbqForm");
  if (!form) return;
  on(form, "submit", async (e) => {
    e.preventDefault();
    await saveBbqVoteFromForm();
  });
}

function wirePackingEvents() {
  const form = qs("#packingForm");
  const list = qs("#packingList");
  if (form) {
    on(form, "submit", async (e) => {
      e.preventDefault();
      await savePackingItemFromForm();
    });
  }
  if (list) {
    on(list, "click", async (e) => {
      const btn = e.target.closest(".toggle-pack-btn");
      if (!btn) return;
      const itemId = btn.dataset.packId;
      const nextStatus = btn.dataset.nextStatus;
      await updatePackingItemStatus(itemId, nextStatus);
    });
  }
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
  const [beds, myVote, userVotes, myDayVote, dayVotes, myBbqVote, bbqVotes, packingItems] = await Promise.all([
    fetchBeds(),
    fetchMyVote(),
    fetchAllUserVotes(),
    fetchMyDayVote(),
    fetchAllDayVotes(),
    fetchMyBbqVote(),
    fetchAllBbqVotes(),
    fetchPackingItems(),
  ]);
  state.beds = beds;
  state.myVote = myVote;
  state.userVotes = userVotes;
  state.myDayVote = myDayVote;
  state.dayVotes = dayVotes;
  state.myBbqVote = myBbqVote;
  state.bbqVotes = bbqVotes;
  state.packingItems = packingItems;
}

function renderCurrentPage() {
  renderStats();
  renderMyVoteButton();
  renderMyVoteModal();

  const routeContext = qs("#routeContext");
  if (routeContext) {
    routeContext.dataset.group = state.group;
    const small = qs("small", routeContext);
    if (small && state.userName) {
      small.textContent = `Usuario: ${state.userName}${state.group ? ` · Grupo: ${state.group}` : ""}`;
    }
  }

  if (state.page === "index") {
    renderIndexPreview();
    renderIndexCTA();
    renderBrotherLeaderboard();
  } else if (state.page === "elegir") {
    renderChooseGrid();
  } else if (state.page === "dias") {
    renderDaysPage();
  } else if (state.page === "barbacoa") {
    renderBbqPage();
  } else if (state.page === "maleta") {
    renderPackingPage();
  } else if (state.page === "resumen") {
    renderSummary();
  }
}

async function bootstrap() {
  state.page = detectPage();
  setLoading(true);
  wireGeneralEffects();
  wireModalEvents();
  wireBedInfoEvents();

  try {
    await ensureAuth();
    await ensureIdentity();
    ensureLogoutButton();
    await refreshData();
    renderCurrentPage();
    wireChooseEvents();
    wireDaysEvents();
    wireBbqEvents();
    wirePackingEvents();
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
