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
const MAINTENANCE_MODE = false;

if (MAINTENANCE_MODE && !/maintenance\.html$/i.test(window.location.pathname)) {
  const qs = window.location.search || "";
  window.location.replace(`./maintenance.html${qs}`);
}

const params = new URLSearchParams(window.location.search);
const state = {
  uid: null,
  beds: [],
  myVote: null,
  myBedPreferences: null,
  myDayVote: null,
  myBbqVote: null,
  myCarVote: null,
  userVotes: [],
  bedPreferences: [],
  bedAssignment: null,
  dayVotes: [],
  bbqVotes: [],
  carVotes: [],
  carJoins: [],
  packingItems: [],
  packingVotes: [],
  taskItems: [],
  taskVotes: [],
  users: [],
  userId: "",
  userName: "",
  page: "unknown",
  group: params.get("group") || "",
  isAdmin: params.get("admin") === "1",
};

let toastTimer = null;
let voteInFlight = false;
let bedPreferenceDraft = [];
let bedPreferenceDraftDirty = false;
let homeScoreInfoShown = false;

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
  { id: "viernes", label: "Viernes", subtitle: "Llegada", emoji: "🌇" },
  { id: "sabado", label: "Sábado", subtitle: "Barbacoa", emoji: "☀️" },
  { id: "domingo", label: "Domingo", subtitle: "Vuelta", emoji: "🌊" },
];
const DAY_OPTION_ID_SET = new Set(DAY_OPTIONS.map((o) => o.id));
const DAY_TRAVEL_ORDER = ["viernes", "sabado", "domingo"];
const DAY_LABEL = {
  viernes: "Viernes",
  sabado: "Sábado",
  domingo: "Domingo",
};
let dayDraftSelection = [];

function normalizeDaySelection(vote = {}) {
  const arr = Array.isArray(vote?.selectedDayIds) ? vote.selectedDayIds : [];
  const normalizedArray = arr
    .map((id) => String(id || "").trim().toLowerCase())
    .filter((id) => DAY_OPTION_ID_SET.has(id));
  let ids = normalizedArray;

  if (!ids.length) {
    const legacyId = String(vote?.optionId || "").trim().toLowerCase();
    if (legacyId === "viernes_sabado") {
      ids = ["viernes", "sabado"];
    } else if (legacyId) {
      ids = legacyId
        .split(/[_\s,;+/.-]+/)
        .map((id) => id.trim().toLowerCase())
        .filter((id) => DAY_OPTION_ID_SET.has(id));
    }
  }

  if (!ids.length) {
    const label = String(vote?.optionLabel || "").toLowerCase();
    ids = DAY_OPTIONS.filter((opt) => label.includes(opt.label.toLowerCase())).map((opt) => opt.id);
  }

  const unique = new Set(ids);
  return DAY_OPTIONS.map((opt) => opt.id).filter((id) => unique.has(id));
}

function buildDayVoteMeta(selectedDayIds = []) {
  const ids = normalizeDaySelection({ selectedDayIds });
  const labels = DAY_OPTIONS.filter((opt) => ids.includes(opt.id)).map((opt) => opt.label);

  let optionLabel = "";
  if (labels.length === 1) {
    optionLabel = labels[0];
  } else if (labels.length === 2) {
    optionLabel = `${labels[0]} y ${labels[1]}`;
  } else if (labels.length >= 3) {
    optionLabel = `${labels.slice(0, -1).join(", ")} y ${labels[labels.length - 1]}`;
  }

  return {
    ids,
    optionId: ids.join("_"),
    optionLabel,
  };
}

function voteIncludesDay(vote, dayId) {
  return normalizeDaySelection(vote).includes(dayId);
}

function buildTripTextFromDayVote(vote) {
  const selected = normalizeDaySelection(vote || {});
  if (!selected.length) {
    return {
      daysText: "Sin días votados",
      idaId: "",
      idaText: "-",
      vueltaId: "",
      vueltaText: "-",
    };
  }

  const ordered = DAY_TRAVEL_ORDER.filter((id) => selected.includes(id));
  const first = ordered[0];
  let last = ordered[ordered.length - 1];
  if (last === "viernes") {
    // Regla de negocio solicitada: viernes no puede ser vuelta.
    last = "sabado";
  }

  const dayLabels = ordered.map((id) => DAY_LABEL[id] || id);
  const daysText = dayLabels.join(" · ");
  return {
    daysText,
    idaId: first || "",
    idaText: DAY_LABEL[first] || "-",
    vueltaId: last || "",
    vueltaText: DAY_LABEL[last] || "-",
  };
}

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
    const dayIds = normalizeDaySelection(v);
    const dayCount = dayIds.length;
    if (dayCount > 0) {
      const isFriSatCombo =
        dayCount === 2 && dayIds.includes("viernes") && dayIds.includes("sabado");
      row.points += isFriSatCombo || dayCount === 3 ? 3 : dayCount;
    } else if (v.optionId === "viernes_sabado") {
      row.points += 3;
    } else if (v.optionId) {
      row.points += 1;
    }
  });

  state.bbqVotes.forEach((v) => {
    const row = ensure(v.userId, v.userName);
    if (!row) return;
    if (v.asiste) row.points += 1;
    if (v.cuentaComida) row.points += 1;
    if (v.cuentaBebida) row.points += 1;
  });

  state.packingItems.forEach((it) => {
    const assignee = ensure(it.assignedUserId, it.assignedUserName || it.assignedUserId);
    if (assignee) assignee.points += 1;

    const creator = ensure(it.addedByUserId, it.addedByUserName || it.addedByUserId);
    if (creator) creator.points += 0.5;
  });

  state.carVotes.forEach((car) => {
    if (!car.hasCar) return;
    const row = ensure(car.userId, car.userName);
    if (!row) return;
    const passengers = state.carJoins.filter((j) => j.driverUserId === car.userId).length;
    row.points += 1;
    row.points += passengers * 0.25;
  });

  state.taskItems.forEach((task) => {
    const creator = ensure(task.createdByUserId, task.createdByUserName || task.createdByUserId);
    if (creator) creator.points += 1;
  });

  const taskById = new Map(state.taskItems.map((task) => [task.id, task]));
  const taskVotesCountByUser = new Map();
  const taskYesCountByUser = new Map();
  state.taskVotes.forEach((vote) => {
    taskVotesCountByUser.set(vote.userId, (taskVotesCountByUser.get(vote.userId) || 0) + 1);
    if (vote.vote !== 1) return;
    taskYesCountByUser.set(vote.userId, (taskYesCountByUser.get(vote.userId) || 0) + 1);
    const voter = ensure(vote.userId, vote.userName || vote.userId);
    if (voter) voter.points += 0.5;

    const task = taskById.get(vote.taskId);
    if (!task) return;
    const creator = ensure(task.createdByUserId, task.createdByUserName || task.createdByUserId);
    if (creator) creator.points += 0.1;
  });

  if (state.taskItems.length > 0) {
    map.forEach((row) => {
      const votesCount = taskVotesCountByUser.get(row.userId) || 0;
      const yesCount = taskYesCountByUser.get(row.userId) || 0;
      if (votesCount === 0 || yesCount === 0) {
        row.points -= 0.5;
      }
      row.points = Number(row.points.toFixed(2));
    });
  }

  const daysParticipants = new Set(state.dayVotes.map((v) => v.userId));
  const carParticipants = new Set(state.carVotes.map((v) => v.userId));
  const taskParticipants = new Set([
    ...state.taskItems.map((t) => t.createdByUserId),
    ...state.taskVotes.map((v) => v.userId),
  ]);
  const packingParticipants = new Set([
    ...state.packingItems.map((it) => it.addedByUserId),
    ...state.packingVotes.map((v) => v.userId),
  ]);

  map.forEach((row) => {
    const inAllCoreSections =
      daysParticipants.has(row.userId) &&
      carParticipants.has(row.userId) &&
      taskParticipants.has(row.userId) &&
      packingParticipants.has(row.userId);
    if (inAllCoreSections) {
      row.points += 0.5;
    }
    row.points = Number(row.points.toFixed(2));
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
}

function detectPage() {
  if (qs("#bedsGrid")) return "elegir";
  if (qs("#daysOptions")) return "dias";
  if (qs("#bbqForm")) return "barbacoa";
  if (qs("#carForm")) return "coche";
  if (qs("#packingForm")) return "maleta";
  if (qs("#taskForm")) return "tareas";
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

function normalizeBedPreferenceChoices(choices = [], beds = state.beds) {
  const hasBedCatalog = Array.isArray(beds) && beds.length > 0;
  const validIds = new Set((beds || []).map((b) => b.id));
  const unique = [];
  (Array.isArray(choices) ? choices : []).forEach((id) => {
    const key = String(id || "").trim();
    if (!key || unique.includes(key)) return;
    if (hasBedCatalog && !validIds.has(key)) return;
    unique.push(key);
  });
  return unique.slice(0, 3);
}

function computeFridayPriorityBedIds(beds, fridayUserCount) {
  const sorted = sortBeds(beds || []);
  const ids = [];
  let covered = 0;
  sorted.forEach((bed) => {
    if (covered >= fridayUserCount) return;
    ids.push(bed.id);
    covered += Math.max(0, Number(bed.capacity) || 0);
  });
  return ids;
}

function computeBedAssignments(beds, bedPreferences, usersRanking) {
  const bedMap = new Map((beds || []).map((b) => [b.id, b]));
  const capacityMap = new Map((beds || []).map((b) => [b.id, Math.max(0, Number(b.capacity) || 0)]));
  const preferencesMap = new Map(
    (bedPreferences || []).map((p) => [p.userId, normalizeBedPreferenceChoices(p.topChoices, beds)])
  );
  const ranking = Array.isArray(usersRanking) ? usersRanking : [];
  const rankedUsersWithPrefs = ranking.filter((u) => (preferencesMap.get(u.userId) || []).length > 0);

  const fridayUsers = rankedUsersWithPrefs.filter((u) => {
    const v = state.dayVotes.find((d) => d.userId === u.userId);
    return voteIncludesDay(v, "viernes");
  });
  const otherUsers = rankedUsersWithPrefs.filter((u) => !fridayUsers.some((fu) => fu.userId === u.userId));
  const fridayPriorityBedIds = computeFridayPriorityBedIds(beds, fridayUsers.length);
  const fridayPrioritySet = new Set(fridayPriorityBedIds);

  const assignments = [];
  const unassigned = [];
  const assignUser = (u, fridayPhase) => {
    const prefs = preferencesMap.get(u.userId) || [];
    const pools = fridayPhase
      ? [
          prefs.filter((id) => fridayPrioritySet.has(id)),
          prefs,
          fridayPriorityBedIds,
          beds.map((b) => b.id),
        ]
      : [
          prefs.filter((id) => !fridayPrioritySet.has(id)),
          prefs,
          beds.map((b) => b.id).filter((id) => !fridayPrioritySet.has(id)),
          beds.map((b) => b.id),
        ];

    let chosenBedId = "";
    for (const pool of pools) {
      const candidate = pool.find((id) => (capacityMap.get(id) || 0) > 0);
      if (candidate) {
        chosenBedId = candidate;
        break;
      }
    }

    if (!chosenBedId) {
      unassigned.push(u);
      return;
    }

    const preferenceRank = prefs.indexOf(chosenBedId) + 1;
    capacityMap.set(chosenBedId, Math.max(0, (capacityMap.get(chosenBedId) || 0) - 1));
    assignments.push({
      userId: u.userId,
      userName: u.userName,
      bedId: chosenBedId,
      bedName: bedMap.get(chosenBedId)?.displayName || chosenBedId,
      preferenceRank: preferenceRank > 0 ? preferenceRank : 0,
      isFridayUser: !!fridayPhase,
      inFridayPriorityBed: fridayPrioritySet.has(chosenBedId),
    });
  };

  fridayUsers.forEach((u) => assignUser(u, true));
  otherUsers.forEach((u) => assignUser(u, false));

  return {
    assignments,
    unassigned,
    fridayPriorityBedIds,
    fridayUsers: fridayUsers.map((u) => u.userId),
  };
}

function applyAssignmentsToBeds(beds, assignments) {
  const countByBed = new Map();
  (assignments || []).forEach((v) => {
    countByBed.set(v.bedId, (countByBed.get(v.bedId) || 0) + 1);
  });
  return (beds || []).map((b) => {
    const capacity = Math.max(0, Number(b.capacity) || 0);
    const taken = Math.min(capacity, countByBed.get(b.id) || 0);
    const free = Math.max(0, capacity - taken);
    const ratio = capacity > 0 ? Math.round((taken / capacity) * 100) : 0;
    return { ...b, taken, free, ratio };
  });
}

function getTotals() {
  const totalCapacity = state.beds.reduce((sum, b) => sum + (Number(b.capacity) || 0), 0);
  const totalTaken = state.userVotes.length;
  const totalFree = Math.max(0, totalCapacity - totalTaken);
  return { totalCapacity, totalTaken, totalFree };
}

function findMyBed() {
  const myAssigned = state.userVotes.find((v) => v.userId === state.userId) || state.myVote;
  if (!myAssigned?.bedId) return null;
  return state.beds.find((b) => b.id === myAssigned.bedId) || null;
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
      state.myBedPreferences = null;
      state.bedPreferences = [];
      state.bedAssignment = null;
      state.myDayVote = null;
      state.myBbqVote = null;
      state.myCarVote = null;
      bedPreferenceDraft = [];
      bedPreferenceDraftDirty = false;
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

async function fetchMyBedPreferences() {
  if (!state.userId) return null;
  try {
    const snap = await getDoc(doc(db, "bedPreferences", state.userId));
    if (!snap.exists()) return null;
    const data = snap.data() || {};
    return {
      userId: String(data.userId || state.userId),
      userName: String(data.userName || state.userName || state.userId),
      topChoices: normalizeBedPreferenceChoices(data.topChoices || []),
    };
  } catch (err) {
    toast(`No se pudieron leer tus preferencias de cama: ${parseError(err)}`, "error", 3600);
    console.error("Bed preferences read error", err);
    return null;
  }
}

async function fetchAllBedPreferences() {
  try {
    const snap = await getDocs(groupAwareCollectionRef("bedPreferences"));
    return snap.docs
      .map((d) => {
        const data = d.data() || {};
        return {
          id: d.id,
          userId: String(data.userId || d.id),
          userName: String(data.userName || data.userId || d.id),
          topChoices: normalizeBedPreferenceChoices(data.topChoices || []),
        };
      })
      .filter((v) => v.userId && v.topChoices.length > 0);
  } catch (err) {
    toast(`No se pudieron leer preferencias de cama: ${parseError(err)}`, "error", 3600);
    console.error("Bed preferences list read error", err);
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
        selectedDayIds: Array.isArray(data.selectedDayIds) ? data.selectedDayIds : [],
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

async function fetchMyCarVote() {
  if (!state.userId) return null;
  try {
    const snap = await getDoc(doc(db, "carVotes", state.userId));
    if (!snap.exists()) return null;
    return snap.data() || null;
  } catch (err) {
    toast(`No se pudo leer tu voto de coche: ${parseError(err)}`, "error", 3600);
    console.error("Car vote read error", err);
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

async function fetchAllCarVotes() {
  try {
    const snap = await getDocs(groupAwareCollectionRef("carVotes"));
    return snap.docs.map((d) => {
      const data = d.data() || {};
      const seats = Math.max(0, Number(data.seats) || 0);
      return {
        id: d.id,
        userId: String(data.userId || d.id),
        userName: String(data.userName || data.userId || d.id),
        hasCar: !!data.hasCar,
        seats,
        notes: String(data.notes || ""),
      };
    });
  } catch (err) {
    toast(`No se pudieron leer votos de coche: ${parseError(err)}`, "error", 3600);
    console.error("Car votes read error", err);
    return [];
  }
}

async function fetchAllCarJoins() {
  try {
    const snap = await getDocs(groupAwareCollectionRef("carJoins"));
    return snap.docs.map((d) => {
      const data = d.data() || {};
      return {
        id: d.id,
        userId: String(data.userId || d.id),
        userName: String(data.userName || data.userId || d.id),
        driverUserId: String(data.driverUserId || ""),
      };
    }).filter((j) => j.userId && j.driverUserId);
  } catch (err) {
    toast(`No se pudieron leer uniones de coche: ${parseError(err)}`, "error", 3600);
    console.error("Car joins read error", err);
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

async function fetchPackingVotes() {
  try {
    const snap = await getDocs(groupAwareCollectionRef("packingVotes"));
    return snap.docs.map((d) => {
      const data = d.data() || {};
      const raw = Number(data.vote || 0);
      const vote = raw === -1 ? -1 : raw === 1 ? 1 : 0;
      return {
        id: d.id,
        itemId: String(data.itemId || ""),
        userId: String(data.userId || ""),
        userName: String(data.userName || data.userId || ""),
        vote,
      };
    }).filter((v) => v.itemId && v.userId && v.vote !== 0);
  } catch (err) {
    toast(`No se pudieron leer votos de maleta: ${parseError(err)}`, "error", 3600);
    console.error("Packing votes read error", err);
    return [];
  }
}

async function fetchTaskItems() {
  try {
    const snap = await getDocs(groupAwareCollectionRef("taskItems"));
    return snap.docs
      .map((d) => {
        const data = d.data() || {};
        return {
          id: d.id,
          title: String(data.title || "").trim(),
          dueDate: String(data.dueDate || "").trim(),
          notes: String(data.notes || "").trim(),
          createdByUserId: String(data.createdByUserId || ""),
          createdByUserName: String(data.createdByUserName || ""),
        };
      })
      .filter((t) => t.id && t.title)
      .sort((a, b) => {
        const da = a.dueDate || "9999-12-31";
        const db = b.dueDate || "9999-12-31";
        if (da !== db) return da.localeCompare(db);
        return a.title.localeCompare(b.title, "es");
      });
  } catch (err) {
    toast(`No se pudieron leer tareas: ${parseError(err)}`, "error", 3600);
    console.error("Tasks read error", err);
    return [];
  }
}

async function fetchTaskVotes() {
  try {
    const snap = await getDocs(groupAwareCollectionRef("taskVotes"));
    return snap.docs
      .map((d) => {
        const data = d.data() || {};
        const raw = Number(data.vote || 0);
        const vote = raw === 1 ? 1 : raw === -1 ? -1 : 0;
        return {
          id: d.id,
          taskId: String(data.taskId || ""),
          userId: String(data.userId || ""),
          userName: String(data.userName || data.userId || ""),
          vote,
        };
      })
      .filter((v) => v.taskId && v.userId && v.vote !== 0);
  } catch (err) {
    toast(`No se pudieron leer votos de tareas: ${parseError(err)}`, "error", 3600);
    console.error("Task votes read error", err);
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

  const hasPrefs = normalizeBedPreferenceChoices(state.myBedPreferences?.topChoices || []).length > 0;
  btn.disabled = !hasPrefs;
  btn.classList.toggle("is-disabled", !hasPrefs);
  btn.title = hasPrefs ? "Ver mis preferencias y asignación" : "Aún no has enviado tus 3 preferencias";
}

function renderMyVoteModal() {
  const modal = qs("#myVoteModal");
  if (!modal) return;

  const myVoteTextEl = qs("#myVoteText", modal);
  const content = qs(".modal__content", modal);
  const myBed = findMyBed();
  const myPrefs = normalizeBedPreferenceChoices(state.myBedPreferences?.topChoices || []);
  const prefLabels = myPrefs
    .map((id) => state.beds.find((b) => b.id === id)?.displayName || id)
    .filter(Boolean);

  if (!prefLabels.length) {
    if (myVoteTextEl) {
      myVoteTextEl.textContent = "Aún no has enviado tus 3 preferencias.";
    } else if (content) {
      content.innerHTML = "<p>Aún no has enviado tus 3 preferencias.</p>";
    }
    return;
  }

  const bedText = myBed ? myBed.displayName : "Sin asignación todavía";
  const prefText = prefLabels.join(" · ");
  if (myVoteTextEl) {
    myVoteTextEl.textContent = `Preferencias: ${prefText}. Asignada: ${bedText}.`;
  } else if (content) {
    content.innerHTML = `
      <p><strong>Tus preferencias:</strong> ${escapeHtml(prefText)}</p>
      <p><strong>Cama asignada:</strong> ${escapeHtml(bedText)}</p>
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

function openBedLayoutModal() {
  const modal = qs("#bedLayoutModal");
  if (!modal) return;
  modal.setAttribute("aria-hidden", "false");
  modal.classList.add("is-open");
}

function closeBedLayoutModal() {
  const modal = qs("#bedLayoutModal");
  if (!modal) return;
  modal.setAttribute("aria-hidden", "true");
  modal.classList.remove("is-open");
}

function openScoreInfoModal() {
  const modal = qs("#scoreInfoModal");
  if (!modal) return;
  modal.setAttribute("aria-hidden", "false");
  modal.classList.add("is-open");
}

function closeScoreInfoModal() {
  const modal = qs("#scoreInfoModal");
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
    : "<li class=\"meta\">Sin personas asignadas todavía.</li>";
}

function wireModalEvents() {
  const modal = qs("#myVoteModal");
  if (!modal) return;

  on(qs("#myVoteBtn"), "click", () => {
    if (!normalizeBedPreferenceChoices(state.myBedPreferences?.topChoices || []).length) {
      toast("Aún no has enviado tus 3 preferencias.", "info");
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
      closeBedLayoutModal();
      closeScoreInfoModal();
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

function wireScoreInfoEvents() {
  const modal = qs("#scoreInfoModal");
  if (!modal) return;
  qsa("[data-close-score-info]", modal).forEach((el) => {
    on(el, "click", () => {
      tapFx();
      closeScoreInfoModal();
    });
  });
}

function wireBedLayoutEvents() {
  const btn = qs("#showBedLayoutBtn");
  const modal = qs("#bedLayoutModal");
  if (!btn || !modal) return;

  on(btn, "click", () => {
    tapFx();
    openBedLayoutModal();
  });

  qsa("[data-close-bed-layout]", modal).forEach((el) => {
    on(el, "click", () => {
      tapFx();
      closeBedLayoutModal();
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

  if (normalizeBedPreferenceChoices(state.myBedPreferences?.topChoices || []).length) {
    cta.textContent = "Ya enviaste preferencias - ver resumen";
    cta.setAttribute("href", "./resumen.html");
  } else {
    cta.textContent = "Elegir 3 preferencias de cama";
    cta.setAttribute("href", "./elegir.html");
  }
}

function renderHomeCardAlerts() {
  const menu = qs("#bedsPreview");
  if (!menu) return;

  const cards = qsa(".home-menu-card", menu);
  const getCardByFile = (fileName) => {
    const norm = String(fileName || "").toLowerCase();
    return cards.find((card) => {
      const href = String(card.getAttribute("href") || "").toLowerCase();
      return href.endsWith(`/${norm}`) || href.endsWith(norm);
    }) || null;
  };

  const setAlert = (fileName, message) => {
    const card = getCardByFile(fileName);
    if (!card) return;

    const existing = qs(".home-menu-card__alert", card);
    if (!message) {
      if (existing) existing.remove();
      card.classList.remove("has-alert");
      return;
    }

    const badge = existing || document.createElement("span");
    badge.className = "home-menu-card__alert";
    badge.textContent = message;
    if (!existing) card.appendChild(badge);
    card.classList.add("has-alert");
  };

  const prefCount = normalizeBedPreferenceChoices(state.myBedPreferences?.topChoices || []).length;
  const daysCount = normalizeDaySelection(state.myDayVote || {}).length;
  const hasBbq = !!state.myBbqVote;
  const hasCar = !!state.myCarVote;
  const myTaskVoteTaskIds = new Set(
    state.taskVotes.filter((v) => v.userId === state.userId).map((v) => v.taskId)
  );
  const pendingTaskVotes = Math.max(0, state.taskItems.length - myTaskVoteTaskIds.size);
  const myAssignedPackingPending = state.packingItems.filter(
    (it) => it.assignedUserId === state.userId && it.status !== "listo"
  ).length;

  setAlert("elegir.html", prefCount < 3 ? `Faltan preferencias (${prefCount}/3)` : "");
  setAlert("dias.html", daysCount < 1 ? "Falta votar días" : "");
  setAlert("barbacoa.html", !hasBbq ? "Falta responder barbacoa" : "");
  setAlert("coche.html", !hasCar ? "Falta responder coche" : "");
  setAlert(
    "tareas.html",
    pendingTaskVotes > 0
      ? `Faltan ${pendingTaskVotes} tarea${pendingTaskVotes === 1 ? "" : "s"} por votar`
      : ""
  );
  setAlert(
    "maleta.html",
    myAssignedPackingPending > 0
      ? `Tienes ${myAssignedPackingPending} pendiente${myAssignedPackingPending === 1 ? "" : "s"}`
      : ""
  );
}

function renderChooseGrid() {
  const grid = qs("#bedsGrid");
  if (!grid) return;

  if (!state.beds.length) {
    grid.innerHTML = `<article class="card glass"><p>No se encontraron camas.</p></article>`;
    return;
  }

  const savedPrefs = normalizeBedPreferenceChoices(state.myBedPreferences?.topChoices || [], state.beds);
  if (!bedPreferenceDraftDirty) {
    bedPreferenceDraft = [...savedPrefs];
  } else {
    bedPreferenceDraft = normalizeBedPreferenceChoices(bedPreferenceDraft, state.beds);
  }

  const myAssigned = state.userVotes.find((v) => v.userId === state.userId) || null;
  const assignedBedLabel = myAssigned
    ? (state.beds.find((b) => b.id === myAssigned.bedId)?.displayName || myAssigned.bedId)
    : "Sin asignación todavía";
  const prefLabel = bedPreferenceDraft.length
    ? bedPreferenceDraft
        .map((id, idx) => {
          const bed = state.beds.find((b) => b.id === id);
          return `${idx + 1}. ${bed?.displayName || id}`;
        })
        .join(" · ")
    : "Aún no has seleccionado preferencias.";
  const summaryHref = `./resumen.html${window.location.search || ""}#orden-asignacion`;

  grid.innerHTML = "";
  const introCard = document.createElement("article");
  introCard.className = "card bed-card glass choose-pref-card";
  introCard.innerHTML = `
    <header class="bed-card__head">
      <h3>Tus 3 preferencias</h3>
      <span class="badge">${bedPreferenceDraft.length}/3</span>
    </header>
    <p class="meta">${escapeHtml(prefLabel)}</p>
    <p>Asignación provisional: <strong>${escapeHtml(assignedBedLabel)}</strong></p>
    <button class="btn btn--primary save-bed-prefs-btn" type="button" ${bedPreferenceDraft.length !== 3 ? "disabled" : ""}>
      Guardar preferencias
    </button>
    <a class="btn ghost choose-results-link" href="${escapeHtml(summaryHref)}">Ver resultados</a>
  `;
  grid.appendChild(introCard);

  state.beds.forEach((bed) => {
    const full = bed.free === 0;
    const prefIndex = bedPreferenceDraft.indexOf(bed.id);
    const isSelected = prefIndex !== -1;
    const disabled = !isSelected && bedPreferenceDraft.length >= 3;
    const actionText = isSelected
      ? `Quitar preferencia #${prefIndex + 1}`
      : `Añadir como #${bedPreferenceDraft.length + 1}`;
    const card = document.createElement("article");
    card.className = `card bed-card glass ${full ? "is-full" : ""} ${isSelected ? "is-pref-selected" : ""}`;
    card.dataset.bedId = bed.id;
    card.innerHTML = `
      <header class="bed-card__head">
        <h3>${escapeHtml(bed.displayName)}</h3>
        <span class="badge">${isSelected ? `Preferencia #${prefIndex + 1}` : full ? "LLENA" : `${bed.free} libres`}</span>
      </header>
      ${bed.description ? `<p class="meta">${escapeHtml(bed.description)}</p>` : ""}
      <p>Capacidad: <strong>${bed.capacity}</strong></p>
      <p>Ocupadas: <strong>${bed.taken}</strong></p>
      <p>Libres: <strong>${bed.free}</strong></p>
      <div class="progress">
        <span style="width:${bed.ratio}%"></span>
      </div>
      <button class="btn btn--primary choose-btn" data-bed-id="${bed.id}" ${disabled ? "disabled" : ""}>
        ${actionText}
      </button>
    `;
    grid.appendChild(card);
  });
}

function renderSummary() {
  const summary = qs("#summary");
  const list = qs("#list");
  const myVote = qs("#myVote");
  const assignmentOrderList = qs("#assignmentOrderList");
  const myDayVoteSummary = qs("#myDayVoteSummary");
  const daysSummaryList = qs("#daysSummaryList");
  const myBbqSummary = qs("#myBbqSummary");
  const bbqSummaryTotals = qs("#bbqSummaryTotals");
  const bbqSummaryList = qs("#bbqSummaryList");

  if (myVote) {
    const myBed = findMyBed();
    const myPrefs = normalizeBedPreferenceChoices(state.myBedPreferences?.topChoices || []);
    const prefLabel = myPrefs.length
      ? myPrefs
          .map((id) => state.beds.find((b) => b.id === id)?.displayName || id)
          .join(" · ")
      : "";
    if (myPrefs.length) {
      myVote.textContent = `Tus preferencias: ${prefLabel}. Asignada: ${myBed ? myBed.displayName : "Sin asignación todavía"}`;
    } else {
      myVote.textContent = "Aún no has enviado tus preferencias de cama.";
    }
  }

  if (assignmentOrderList) {
    const ranking = computeBrotherRanking();
    const rankingPos = new Map(ranking.map((row, idx) => [row.userId, { pos: idx + 1, points: row.points }]));
    const prefMap = new Map(
      (state.bedPreferences || []).map((p) => [p.userId, normalizeBedPreferenceChoices(p.topChoices || [], state.beds)])
    );
    const orderedAssignments = state.bedAssignment?.assignments || [];
    const unassigned = state.bedAssignment?.unassigned || [];

    if (!orderedAssignments.length && !unassigned.length) {
      assignmentOrderList.innerHTML = "<li class=\"meta\">Todavía no hay asignaciones para mostrar.</li>";
    } else {
      const rowsHtml = orderedAssignments.map((a, idx) => {
        const rankingInfo = rankingPos.get(a.userId) || { pos: "-", points: 0 };
        const prefs = prefMap.get(a.userId) || [];
        const prefLabel = prefs.length
          ? prefs
              .map((bedId, pIdx) => {
                const bed = state.beds.find((b) => b.id === bedId);
                return `${pIdx + 1}. ${bed?.displayName || bedId}`;
              })
              .join(" · ")
          : "Sin preferencias";
        const reason = a.preferenceRank
          ? `Entró por su ${a.preferenceRank}ª preferencia`
          : "Entró por hueco disponible (fallback)";
        return `
          <li class="assignment-order-item">
            <div class="assignment-order-item__head">
              <span class="name">${idx + 1}. ${escapeHtml(a.userName)}</span>
              <span class="pill">#${rankingInfo.pos} · ${rankingInfo.points} pts</span>
            </div>
            <span class="meta">Asignada: <strong>${escapeHtml(a.bedName || a.bedId)}</strong></span>
            <span class="meta">${escapeHtml(reason)}</span>
            <span class="meta">Preferencias: ${escapeHtml(prefLabel)}</span>
          </li>
        `;
      });

      const unassignedHtml = unassigned.map((u) => {
        const rankingInfo = rankingPos.get(u.userId) || { pos: "-", points: 0 };
        return `
          <li class="assignment-order-item assignment-order-item--warning">
            <div class="assignment-order-item__head">
              <span class="name">${escapeHtml(u.userName)}</span>
              <span class="pill">#${rankingInfo.pos} · ${rankingInfo.points} pts</span>
            </div>
            <span class="meta">Sin asignación: sin camas disponibles para sus opciones.</span>
          </li>
        `;
      });

      assignmentOrderList.innerHTML = [...rowsHtml, ...unassignedHtml].join("");
    }
  }

  if (list) {
    const unassignedNames = (state.bedAssignment?.unassigned || []).map((u) => u.userName).filter(Boolean);
    list.innerHTML = "";
    if (!state.beds.length) {
      const li = document.createElement("li");
      li.textContent = "No hay datos de camas.";
      list.appendChild(li);
    } else {
      const infoLi = document.createElement("li");
      infoLi.className = "summary-row";
      infoLi.innerHTML = `
        <span class="meta">${unassignedNames.length ? `Sin asignación: ${escapeHtml(unassignedNames.join(", "))}` : "Todas las personas con preferencias están asignadas."}</span>
      `;
      list.appendChild(infoLi);

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
    const myDays = normalizeDaySelection(state.myDayVote || {});
    const myLabel =
      state.myDayVote?.optionLabel || buildDayVoteMeta(myDays).optionLabel;
    myDayVoteSummary.textContent = myLabel
      ? `Tu voto de días: ${myLabel}`
      : "Aún no has votado los días.";
  }

  if (daysSummaryList) {
    daysSummaryList.innerHTML = "";
    DAY_OPTIONS.forEach((opt) => {
      const voters = state.dayVotes.filter((v) => voteIncludesDay(v, opt.id));
      const li = document.createElement("li");
      li.className = "summary-flat-card";
      const votersHtml = voters.length
        ? voters.map((v) => `<span class="voter-chip">${escapeHtml(v.userName)}</span>`).join("")
        : "<span class=\"meta\">Sin votos.</span>";
      li.innerHTML = `
        <div class="summary-flat-head">
          <span class="name">${escapeHtml(opt.label)} · ${escapeHtml(opt.subtitle)}</span>
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

  if (summary) {
    const hasPrefs = normalizeBedPreferenceChoices(state.myBedPreferences?.topChoices || []).length > 0;
    let cta = qs(".summary-cta", summary);
    if (!hasPrefs) {
      if (!cta) {
        cta = document.createElement("a");
        cta.className = "btn btn--primary summary-cta";
        cta.href = "./elegir.html";
        cta.textContent = "Elegir mis 3 preferencias";
        summary.appendChild(cta);
      }
    } else if (cta) {
      cta.remove();
    }
  }

  renderSummaryDashboard();
}

function renderSummaryDashboard() {
  const bedsEl = qs("#chartBedsPie");
  const daysEl = qs("#chartDaysPie");
  const bbqEl = qs("#chartBbqPie");
  const carsEl = qs("#chartCarsPie");
  const tasksEl = qs("#chartTasksPie");
  const rankingEl = qs("#chartRanking");
  if (!bedsEl && !daysEl && !bbqEl && !carsEl && !tasksEl && !rankingEl) return;

  const renderDonut = (rootEl, rows, totalLabel) => {
    const total = rows.reduce((sum, row) => sum + row.value, 0);
    if (!total) {
      rootEl.innerHTML = "<p class=\"meta\">Sin datos todavía.</p>";
      return;
    }

    let angleCursor = 0;
    const gradientParts = rows.map((row) => {
      const pct = row.value / total;
      const from = Math.round(angleCursor * 360);
      angleCursor += pct;
      const to = Math.round(angleCursor * 360);
      return `${row.color} ${from}deg ${to}deg`;
    });

    const legendHtml = rows
      .map((row) => {
        const pct = Math.round((row.value / total) * 100);
        return `
          <li class="donut-legend__item">
            <span class="dot" style="background:${row.color}"></span>
            <span class="label">${escapeHtml(row.label)}</span>
            <span class="value">${row.value} (${pct}%)</span>
          </li>
        `;
      })
      .join("");

    rootEl.innerHTML = `
      <div class="donut-chart">
        <div class="donut-chart__ring" style="background: conic-gradient(${gradientParts.join(", ")});">
          <div class="donut-chart__center">
            <strong>${total}</strong>
            <small>${escapeHtml(totalLabel)}</small>
          </div>
        </div>
        <ul class="donut-legend">${legendHtml}</ul>
      </div>
    `;
  };

  if (bedsEl) {
    const rows = state.beds.map((bed, idx) => ({
      label: bed.displayName,
      value: state.userVotes.filter((v) => v.bedId === bed.id).length,
      color: ["#5b8def", "#33c39f", "#f28b52", "#8c6cf3", "#e6638f", "#2cb0e8"][idx % 6],
    }));
    renderDonut(bedsEl, rows, "asignaciones");
  }

  if (daysEl) {
    const rows = DAY_OPTIONS.map((opt, idx) => ({
      label: `${opt.label} (${opt.subtitle})`,
      value: state.dayVotes.filter((v) => voteIncludesDay(v, opt.id)).length,
      color: ["#18be86", "#42b6f5", "#8c6cf3"][idx % 3],
    }));
    renderDonut(daysEl, rows, "selecciones");
  }

  if (bbqEl) {
    const attending = state.bbqVotes.filter((v) => v.asiste).length;
    const notAttending = Math.max(0, state.bbqVotes.length - attending);
    const comida = state.bbqVotes.filter((v) => v.asiste && v.cuentaComida).length;
    const bebida = state.bbqVotes.filter((v) => v.asiste && v.cuentaBebida).length;
    const rows = [
      { label: "Asisten", value: attending, color: "#18be86" },
      { label: "No asisten", value: notAttending, color: "#f15372" },
      { label: "Comida", value: comida, color: "#f29a3d" },
      { label: "Bebida", value: bebida, color: "#4f82ff" },
    ];
    renderDonut(bbqEl, rows, "respuestas");
  }

  if (carsEl) {
    const carries = state.carVotes.filter((v) => v.hasCar).length;
    const noCar = state.carVotes.filter((v) => !v.hasCar).length;
    const pending = Math.max(0, (state.users?.length || 0) - (carries + noCar));
    const rows = [
      { label: "Lleva coche", value: carries, color: "#18be86" },
      { label: "No lleva coche", value: noCar, color: "#f29a3d" },
      { label: "Sin responder", value: pending, color: "#8fa3c2" },
    ];
    renderDonut(carsEl, rows, "usuarios");
  }

  if (tasksEl) {
    const yesVotes = state.taskVotes.filter((v) => v.vote === 1).length;
    const noVotes = state.taskVotes.filter((v) => v.vote === -1).length;
    const possibleVotes = (state.taskItems?.length || 0) * (state.users?.length || 0);
    const pendingVotes = Math.max(0, possibleVotes - (yesVotes + noVotes));
    const rows = [
      { label: "Sí", value: yesVotes, color: "#18be86" },
      { label: "No", value: noVotes, color: "#f15372" },
      { label: "Sin responder", value: pendingVotes, color: "#8fa3c2" },
    ];
    renderDonut(tasksEl, rows, "respuestas");
  }

  if (rankingEl) {
    const ranking = computeBrotherRanking();
    if (!ranking.length) {
      rankingEl.innerHTML = "<li class=\"meta\">Sin ranking todavía.</li>";
    } else {
      rankingEl.innerHTML = ranking
        .slice(0, 8)
        .map((row, idx) => {
          return `
            <li class="chart-row chart-row--ranking">
              <div class="chart-row__top">
                <span class="name">${idx + 1}. ${escapeHtml(row.userName || "-")}</span>
                <span class="pill">${row.points || 0} pts</span>
              </div>
            </li>
          `;
        })
        .join("");
    }
  }
}

function renderDaysPage() {
  const optionsWrap = qs("#daysOptions");
  if (!optionsWrap) return;

  const myDayVoteEl = qs("#myDayVote");
  const locked = !!state.myDayVote;
  const mySelectedIds = normalizeDaySelection(state.myDayVote || {});
  const myLabel = state.myDayVote?.optionLabel || buildDayVoteMeta(mySelectedIds).optionLabel;
  if (myDayVoteEl) {
    if (myLabel) {
      myDayVoteEl.textContent = `Tu voto de días: ${myLabel}`;
    } else {
      myDayVoteEl.textContent = "Aún no has votado los días.";
    }
  }

  if (locked) {
    dayDraftSelection = [...mySelectedIds];
  } else {
    dayDraftSelection = normalizeDaySelection({ selectedDayIds: dayDraftSelection });
  }

  const selectedIds = locked ? mySelectedIds : dayDraftSelection;
  const cardsHtml = DAY_OPTIONS.map((opt) => {
    const count = state.dayVotes.filter((v) => voteIncludesDay(v, opt.id)).length;
    const selected = selectedIds.includes(opt.id);
    return `
      <button
        type="button"
        class="day-option-card ${selected ? "is-selected" : ""}"
        data-day-toggle="${opt.id}"
        aria-pressed="${selected ? "true" : "false"}"
        ${locked ? "disabled" : ""}
      >
        <span class="day-option-card__emoji">${escapeHtml(opt.emoji || "📅")}</span>
        <span class="day-option-card__label">${escapeHtml(opt.label)}</span>
        <span class="day-option-card__meta">${escapeHtml(opt.subtitle)}</span>
        <span class="day-option-card__count">${count}</span>
      </button>
    `;
  }).join("");

  optionsWrap.innerHTML = `
    <article class="card glass day-picker ${locked ? "is-locked" : ""}">
      <div class="day-picker__head">
        <span class="day-picker__icon" aria-hidden="true">🗓️</span>
        <div>
          <h3>¿Qué días vas?</h3>
          <p>Selecciona todos los que apliquen</p>
        </div>
      </div>
      <div class="day-picker__grid">${cardsHtml}</div>
      <button
        class="btn btn--primary day-submit-btn"
        type="button"
        ${locked || !selectedIds.length ? "disabled" : ""}
      >
        ${locked ? "Ya votaste los días" : "Guardar selección"}
      </button>
    </article>
  `;
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
        li.className = "bbq-request-card";
        const detailChips = [
          v.peticionComida ? `<span class="voter-chip"><strong>Comida:</strong> ${escapeHtml(v.peticionComida)}</span>` : "",
          v.peticionBebida ? `<span class="voter-chip"><strong>Bebida:</strong> ${escapeHtml(v.peticionBebida)}</span>` : "",
          v.noQuiere ? `<span class="voter-chip"><strong>No quiere:</strong> ${escapeHtml(v.noQuiere)}</span>` : "",
          v.notas ? `<span class="voter-chip"><strong>Notas:</strong> ${escapeHtml(v.notas)}</span>` : "",
        ].filter(Boolean).join("");
        li.innerHTML = `
          <div class="summary-flat-head">
            <span class="name">${escapeHtml(v.userName)}</span>
            <span class="${v.asiste ? "badge" : "sold"}">${v.asiste ? "ASISTE" : "NO ASISTE"}</span>
          </div>
          <div class="voter-row">${detailChips}</div>
        `;
        requestList.appendChild(li);
      });
    }
  }
}

function renderCarPage() {
  const form = qs("#carForm");
  if (!form) return;

  const my = state.myCarVote || null;
  const myStatus = qs("#myCarStatus");
  if (myStatus) {
    if (!my) {
      myStatus.textContent = "Aún no has respondido la votación de coche.";
    } else if (my.hasCar) {
      myStatus.textContent = `Tu estado: llevas coche (${my.seats || 0} plazas).`;
    } else {
      myStatus.textContent = "Tu estado: no llevas coche.";
    }
  }

  const setRadio = (name, val) => {
    const input = qs(`input[name="${name}"][value="${val}"]`, form);
    if (input) input.checked = true;
  };
  if (my) {
    setRadio("hasCar", my.hasCar ? "si" : "no");
    const seatsInput = qs("#carSeats", form);
    const notesInput = qs("#carNotes", form);
    if (seatsInput && document.activeElement !== seatsInput) seatsInput.value = String(my.seats || "");
    if (notesInput && document.activeElement !== notesInput) notesInput.value = my.notes || "";
  } else {
    // Evita que el navegador deje radios/inputs pre-rellenados al recargar.
    form.reset();
    qsa('input[name="hasCar"]', form).forEach((el) => { el.checked = false; });
  }
  toggleCarExtraFields(form);

  const carriers = state.carVotes.filter((v) => v.hasCar);
  const iAmCarrier = !!(state.myCarVote?.hasCar || state.carVotes.find((v) => v.userId === state.userId && v.hasCar));
  const totalSeats = carriers.reduce((sum, v) => sum + (Number(v.seats) || 0), 0);
  const myJoin = state.carJoins.find((j) => j.userId === state.userId) || null;
  const totals = qs("#carTotals");
  if (totals) {
    const usedSeats = state.carJoins.filter((j) => j.driverUserId).length;
    totals.innerHTML = `
      <span class="badge">${carriers.length} conductores</span>
      <span class="badge">${totalSeats} plazas</span>
      <span class="badge">${usedSeats}/${totalSeats} ocupadas</span>
      <span class="badge">${state.carVotes.length} respuestas</span>
    `;
  }

  const list = qs("#carVotesList");
  if (list) {
    list.innerHTML = "";
    if (!carriers.length) {
      list.innerHTML = "<li class=\"meta\">Sin respuestas de coche todavía.</li>";
    } else {
      const tripGroups = new Map();
      carriers.forEach((v) => {
        const dayVote = state.dayVotes.find((dv) => dv.userId === v.userId) || null;
        const trip = buildTripTextFromDayVote(dayVote);
        const tripKey = `${trip.idaId || "none"}|${trip.vueltaId || "none"}`;
        const current = tripGroups.get(tripKey) || { trip, drivers: [] };
        current.drivers.push(v);
        tripGroups.set(tripKey, current);
      });

      const dayIdx = (id) => {
        const idx = DAY_TRAVEL_ORDER.indexOf(id);
        return idx === -1 ? 99 : idx;
      };

      const sortedGroups = Array.from(tripGroups.values()).sort((a, b) => {
        const idaDiff = dayIdx(a.trip.idaId) - dayIdx(b.trip.idaId);
        if (idaDiff !== 0) return idaDiff;
        return dayIdx(a.trip.vueltaId) - dayIdx(b.trip.vueltaId);
      });

      sortedGroups.forEach((group) => {
        const titleLi = document.createElement("li");
        titleLi.className = "car-trip-group-title";
        titleLi.textContent = `Ida ${group.trip.idaText} · Vuelta ${group.trip.vueltaText}`;
        list.appendChild(titleLi);

        group.drivers.forEach((v) => {
        const joins = state.carJoins.filter((j) => j.driverUserId === v.userId);
        const seats = Math.max(0, Number(v.seats) || 0);
        const occupied = joins.length;
        const available = Math.max(0, seats - occupied);
        const isMyCar = v.userId === state.userId;
        const isJoinedByMe = myJoin?.driverUserId === v.userId;
        const hasMyOtherJoin = !!myJoin && myJoin.driverUserId !== v.userId;

        const dayVote = state.dayVotes.find((dv) => dv.userId === v.userId) || null;
        const trip = buildTripTextFromDayVote(dayVote);
        const passengersHtml = joins.length
          ? joins.map((j) => `<span class="voter-chip">${escapeHtml(j.userName)}</span>`).join("")
          : "<span class=\"meta\">Sin pasajeros aún.</span>";

        let actionHtml = "";
        if (!isMyCar && state.userId) {
          if (iAmCarrier) {
            actionHtml = `<button class="btn ghost" type="button" disabled>Llevas coche (no puedes unirte)</button>`;
          } else if (isJoinedByMe) {
            actionHtml = `<button class="btn ghost car-leave-btn" type="button" data-car-leave="${escapeHtml(v.userId)}">Salir de este coche</button>`;
          } else if (hasMyOtherJoin) {
            actionHtml = `<button class="btn ghost" type="button" disabled>Ya te uniste a otro coche</button>`;
          } else if (available <= 0) {
            actionHtml = `<button class="btn ghost" type="button" disabled>Coche completo</button>`;
          } else {
            actionHtml = `<button class="btn btn--primary car-join-btn" type="button" data-car-join="${escapeHtml(v.userId)}">Unirme al coche</button>`;
          }
        }

        const li = document.createElement("li");
        li.className = "summary-flat-card";
        li.innerHTML = `
          <div class="summary-flat-head">
            <span class="name">${escapeHtml(v.userName)}</span>
            <span class="badge">LLEVA COCHE</span>
          </div>
          <span class="meta">Plazas libres: ${available}/${seats}</span>
          <span class="meta">Días: ${escapeHtml(trip.daysText)}</span>
          <span class="meta">Ida: ${escapeHtml(trip.idaText)} · Vuelta: ${escapeHtml(trip.vueltaText)}</span>
          <div class="voter-row">${passengersHtml}</div>
          ${v.notes ? `<span class="meta">Notas: ${escapeHtml(v.notes)}</span>` : ""}
          ${isMyCar ? "<span class=\"meta\">Este es tu coche.</span>" : actionHtml}
        `;
        list.appendChild(li);
        });
      });
    }
  }
}

function toggleCarExtraFields(form) {
  if (!form) return;
  const selectedHasCar = qs('input[name="hasCar"]:checked', form)?.value === "si";
  const seatsField = qs("#carSeats", form)?.closest(".car-extra-field") || qs("#carSeats", form)?.closest("label.card") || qs("#carSeats", form)?.parentElement;
  const notesField = qs("#carNotes", form)?.closest(".car-extra-field") || qs("#carNotes", form)?.closest("label.card") || qs("#carNotes", form)?.parentElement;
  if (seatsField) seatsField.hidden = !selectedHasCar;
  if (notesField) notesField.hidden = !selectedHasCar;
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
    const isAssignee = !!state.userId && state.userId === item.assignedUserId;
    const votesForItem = state.packingVotes.filter((v) => v.itemId === item.id);
    const upVotes = votesForItem.filter((v) => v.vote === 1).length;
    const downVotes = votesForItem.filter((v) => v.vote === -1).length;
    const myVote = votesForItem.find((v) => v.userId === state.userId)?.vote || 0;
    li.innerHTML = `
      <span class="name">${escapeHtml(item.itemName)}</span>
      <span class="meta">Lo lleva: ${escapeHtml(item.assignedUserName || item.assignedUserId || "-")}</span>
      ${item.notes ? `<span class="meta">Nota: ${escapeHtml(item.notes)}</span>` : ""}
      <span class="${done ? "badge" : "badge--warning"}">${done ? "LISTO" : "PENDIENTE"}</span>
      <span class="meta">Añadido por: ${escapeHtml(item.addedByUserName || item.addedByUserId || "-")}</span>
      ${isAssignee
        ? `<button class="btn ghost toggle-pack-btn" type="button" data-pack-id="${escapeHtml(item.id)}" data-next-status="${done ? "pendiente" : "listo"}">
            ${done ? "Marcar pendiente" : "Marcar listo"}
          </button>`
        : `<div class="pack-vote-row">
            <button class="btn ghost pack-vote-btn ${myVote === 1 ? "is-active" : ""}" type="button" data-pack-vote="1" data-pack-id="${escapeHtml(item.id)}">
              👍 <span>${upVotes}</span>
            </button>
            <button class="btn ghost pack-vote-btn ${myVote === -1 ? "is-active" : ""}" type="button" data-pack-vote="-1" data-pack-id="${escapeHtml(item.id)}">
              👎 <span>${downVotes}</span>
            </button>
          </div>`
      }
    `;
    list.appendChild(li);
  });
}

function formatTaskDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "Sin fecha";
  const dt = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return raw;
  return dt.toLocaleDateString("es-ES", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  });
}

function renderTaskPage() {
  const form = qs("#taskForm");
  const list = qs("#taskList");
  if (!form || !list) return;

  const totals = qs("#taskTotals");
  if (totals) {
    totals.innerHTML = `
      <span class="badge">${state.taskItems.length} tareas</span>
      <span class="badge">${state.taskVotes.filter((v) => v.vote === 1).length} sí</span>
      <span class="badge">${state.taskVotes.filter((v) => v.vote === -1).length} no</span>
    `;
  }

  list.innerHTML = "";
  if (!state.taskItems.length) {
    list.innerHTML = "<li class=\"meta\">Todavía no hay tareas creadas.</li>";
    return;
  }

  state.taskItems.forEach((task) => {
    const votes = state.taskVotes.filter((v) => v.taskId === task.id);
    const yes = votes.filter((v) => v.vote === 1).length;
    const no = votes.filter((v) => v.vote === -1).length;
    const myVote = votes.find((v) => v.userId === state.userId)?.vote || 0;
    const yesNames = [...new Set(votes.filter((v) => v.vote === 1).map((v) => v.userName || v.userId || ""))].filter(Boolean);
    const noNames = [...new Set(votes.filter((v) => v.vote === -1).map((v) => v.userName || v.userId || ""))].filter(Boolean);
    const yesNamesHtml = yesNames.length
      ? yesNames.map((name) => `<span class="voter-chip">${escapeHtml(name)}</span>`).join("")
      : "<span class=\"meta\">Nadie ha dicho sí todavía.</span>";
    const noNamesHtml = noNames.length
      ? noNames.map((name) => `<span class="voter-chip">${escapeHtml(name)}</span>`).join("")
      : "<span class=\"meta\">Nadie ha dicho no todavía.</span>";

    const li = document.createElement("li");
    li.className = "summary-row task-row";
    li.innerHTML = `
      <span class="name">${escapeHtml(task.title)}</span>
      <span class="meta">Fecha: ${escapeHtml(formatTaskDate(task.dueDate))}</span>
      <span class="meta">Creada por: ${escapeHtml(task.createdByUserName || task.createdByUserId || "-")}</span>
      ${task.notes ? `<span class="meta">Detalle: ${escapeHtml(task.notes)}</span>` : ""}
      <div class="pack-vote-row task-vote-row">
        <button class="btn ghost pack-vote-btn ${myVote === 1 ? "is-active" : ""}" type="button" data-task-vote="1" data-task-id="${escapeHtml(task.id)}">
          ✅ Sí <span>${yes}</span>
        </button>
        <button class="btn ghost pack-vote-btn ${myVote === -1 ? "is-active" : ""}" type="button" data-task-vote="-1" data-task-id="${escapeHtml(task.id)}">
          ❌ No <span>${no}</span>
        </button>
      </div>
      <div class="task-voters-grid">
        <div class="task-voters-col">
          <span class="meta"><strong>✅ Quién dijo sí</strong></span>
          <div class="voter-row">${yesNamesHtml}</div>
        </div>
        <div class="task-voters-col">
          <span class="meta"><strong>❌ Quién dijo no</strong></span>
          <div class="voter-row">${noNamesHtml}</div>
        </div>
      </div>
    `;
    list.appendChild(li);
  });
}

function toggleBedPreference(bedId) {
  const id = String(bedId || "").trim();
  if (!id) return;
  const current = normalizeBedPreferenceChoices(bedPreferenceDraft, state.beds);
  const idx = current.indexOf(id);
  if (idx >= 0) {
    current.splice(idx, 1);
    bedPreferenceDraft = current;
    bedPreferenceDraftDirty = true;
    renderChooseGrid();
    return;
  }
  if (current.length >= 3) {
    toast("Solo puedes elegir 3 preferencias.", "info");
    return;
  }
  current.push(id);
  bedPreferenceDraft = current;
  bedPreferenceDraftDirty = true;
  renderChooseGrid();
}

async function saveBedPreferences() {
  if (!state.userId || !state.uid) {
    toast("Primero identifícate con tu usuario.", "info");
    return;
  }
  const topChoices = normalizeBedPreferenceChoices(bedPreferenceDraft, state.beds);
  if (topChoices.length !== 3) {
    toast("Debes elegir exactamente 3 camas.", "info");
    return;
  }

  setLoading(true);
  try {
    await setDoc(doc(db, "bedPreferences", state.userId), {
      uid: state.uid,
      userId: state.userId,
      userName: state.userName,
      topChoices,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      ...(state.group ? { group: state.group } : {}),
    }, { merge: true });
    bedPreferenceDraftDirty = false;
    confettiBoom();
    toast("Preferencias guardadas.", "success", 2800);
    await refreshData();
    renderCurrentPage();
  } catch (err) {
    toast(`No se pudieron guardar preferencias: ${parseError(err)}`, "error", 3800);
    console.error("Bed preferences save error", err);
  } finally {
    setLoading(false);
  }
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

async function voteForDay(selectedDayIds) {
  if (voteInFlight) return;
  if (!state.userId) {
    toast("Primero identifícate con tu usuario.", "info");
    return;
  }
  if (state.myDayVote) {
    toast("Ya votaste los días.", "info");
    return;
  }

  const dayMeta = buildDayVoteMeta(selectedDayIds);
  if (!dayMeta.ids.length) {
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
        optionId: dayMeta.optionId,
        optionLabel: dayMeta.optionLabel,
        selectedDayIds: dayMeta.ids,
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

async function saveCarVoteFromForm() {
  const form = qs("#carForm");
  if (!form) return;
  if (!state.userId) {
    toast("Primero identifícate con tu usuario.", "info");
    return;
  }

  const fd = new FormData(form);
  const hasCarRaw = fd.get("hasCar");
  if (!hasCarRaw) {
    toast("Indica si llevas coche o no.", "info");
    return;
  }
  const hasCar = hasCarRaw === "si";
  const seatsRaw = Number(fd.get("seats") || 0);
  const seats = hasCar ? Math.max(0, Math.min(8, seatsRaw)) : 0;
  const notes = String(fd.get("carNotes") || "").trim();

  const payload = {
    uid: state.uid || "",
    userId: state.userId,
    userName: state.userName,
    hasCar,
    seats,
    notes,
    updatedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
    ...(state.group ? { group: state.group } : {}),
  };

  setLoading(true);
  try {
    await setDoc(doc(db, "carVotes", state.userId), payload, { merge: true });
    confettiBoom();
    thankUserForVote();
    await refreshData();
    renderCurrentPage();
  } catch (err) {
    toast(`No se pudo guardar: ${parseError(err)}`, "error", 3800);
    console.error("Car save error", err);
  } finally {
    setLoading(false);
  }
}

async function joinCar(driverUserId) {
  if (!driverUserId || !state.userId || !state.uid) return;
  if (driverUserId === state.userId) {
    toast("No puedes unirte a tu propio coche.", "info");
    return;
  }
  const iAmCarrier = !!(state.myCarVote?.hasCar || state.carVotes.find((v) => v.userId === state.userId && v.hasCar));
  if (iAmCarrier) {
    toast("Si llevas coche, no puedes unirte a otro.", "info");
    return;
  }

  const driver = state.carVotes.find((v) => v.userId === driverUserId && v.hasCar);
  if (!driver) {
    toast("Ese coche ya no está disponible.", "info");
    return;
  }

  const seats = Math.max(0, Number(driver.seats) || 0);
  const occupied = state.carJoins.filter((j) => j.driverUserId === driverUserId).length;
  if (occupied >= seats) {
    toast("Ese coche está completo.", "info");
    return;
  }

  setLoading(true);
  try {
    await setDoc(doc(db, "carJoins", state.userId), {
      uid: state.uid,
      userId: state.userId,
      userName: state.userName,
      driverUserId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      ...(state.group ? { group: state.group } : {}),
    }, { merge: true });
    await refreshData();
    renderCurrentPage();
  } catch (err) {
    toast(`No se pudo unir al coche: ${parseError(err)}`, "error", 3600);
    console.error("Car join error", err);
  } finally {
    setLoading(false);
  }
}

async function leaveCar(driverUserId) {
  if (!state.userId || !state.uid) return;
  const myJoin = state.carJoins.find((j) => j.userId === state.userId);
  if (!myJoin || myJoin.driverUserId !== driverUserId) return;

  setLoading(true);
  try {
    await updateDoc(doc(db, "carJoins", state.userId), {
      driverUserId: "",
      updatedAt: serverTimestamp(),
    });
    await refreshData();
    renderCurrentPage();
  } catch (err) {
    toast(`No se pudo salir del coche: ${parseError(err)}`, "error", 3600);
    console.error("Car leave error", err);
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
  const item = state.packingItems.find((it) => it.id === itemId);
  if (!item) return;
  if (!state.userId || state.userId !== item.assignedUserId) {
    toast("Solo la persona asignada puede cambiar LISTO/PENDIENTE.", "info", 3200);
    return;
  }
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

async function votePackingItem(itemId, voteValueRaw) {
  if (!itemId) return;
  if (!state.userId || !state.uid) {
    toast("Primero identifícate con tu usuario.", "info");
    return;
  }
  const vote = Number(voteValueRaw) === -1 ? -1 : 1;
  const voteDocId = `${itemId}_${state.userId}`;

  setLoading(true);
  try {
    await setDoc(doc(db, "packingVotes", voteDocId), {
      itemId,
      userId: state.userId,
      userName: state.userName,
      uid: state.uid,
      vote,
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      ...(state.group ? { group: state.group } : {}),
    }, { merge: true });
    await refreshData();
    renderCurrentPage();
  } catch (err) {
    toast(`No se pudo guardar tu voto: ${parseError(err)}`, "error", 3600);
    console.error("Packing vote error", err);
  } finally {
    setLoading(false);
  }
}

async function saveTaskFromForm() {
  const form = qs("#taskForm");
  if (!form) return;
  if (!state.userId || !state.uid) {
    toast("Primero identifícate con tu usuario.", "info");
    return;
  }

  const fd = new FormData(form);
  const title = String(fd.get("taskTitle") || "").trim();
  const dueDate = String(fd.get("taskDate") || "").trim();
  const notes = String(fd.get("taskNotes") || "").trim();

  if (!title) {
    toast("Escribe una tarea.", "info");
    return;
  }
  if (!dueDate) {
    toast("Selecciona una fecha.", "info");
    return;
  }

  setLoading(true);
  try {
    await addDoc(collection(db, "taskItems"), {
      title,
      dueDate,
      notes,
      createdByUserId: state.userId,
      createdByUserName: state.userName,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      ...(state.group ? { group: state.group } : {}),
    });
    form.reset();
    await refreshData();
    renderCurrentPage();
    toast("Tarea creada.", "success");
  } catch (err) {
    toast(`No se pudo crear la tarea: ${parseError(err)}`, "error", 3600);
    console.error("Task create error", err);
  } finally {
    setLoading(false);
  }
}

async function voteTask(taskId, voteValueRaw) {
  if (!taskId || !state.userId || !state.uid) {
    toast("Primero identifícate con tu usuario.", "info");
    return;
  }

  const vote = Number(voteValueRaw) === -1 ? -1 : 1;
  const task = state.taskItems.find((t) => t.id === taskId);
  if (!task) {
    toast("La tarea ya no existe.", "info");
    return;
  }

  const voteId = `${taskId}__${state.userId}`;
  setLoading(true);
  try {
    await setDoc(doc(db, "taskVotes", voteId), {
      taskId,
      userId: state.userId,
      userName: state.userName,
      uid: state.uid,
      vote,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      ...(state.group ? { group: state.group } : {}),
    }, { merge: true });
    await refreshData();
    renderCurrentPage();
  } catch (err) {
    toast(`No se pudo registrar tu respuesta: ${parseError(err)}`, "error", 3600);
    console.error("Task vote error", err);
  } finally {
    setLoading(false);
  }
}

function wireChooseEvents() {
  const grid = qs("#bedsGrid");
  if (!grid) return;

  on(grid, "click", async (e) => {
    const saveBtn = e.target.closest(".save-bed-prefs-btn");
    if (saveBtn) {
      if (saveBtn.disabled) return;
      e.preventDefault();
      await saveBedPreferences();
      return;
    }

    const btn = e.target.closest(".choose-btn");
    if (!btn) return;
    e.preventDefault();

    if (btn.disabled) return;
    const bedId = btn.dataset.bedId;
    if (!bedId) return;
    toggleBedPreference(bedId);
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
    const toggleBtn = e.target.closest("[data-day-toggle]");
    if (toggleBtn) {
      if (toggleBtn.disabled || state.myDayVote) return;
      const dayId = String(toggleBtn.dataset.dayToggle || "");
      if (!DAY_OPTION_ID_SET.has(dayId)) return;

      if (dayDraftSelection.includes(dayId)) {
        dayDraftSelection = dayDraftSelection.filter((id) => id !== dayId);
      } else {
        dayDraftSelection = [...dayDraftSelection, dayId];
      }
      dayDraftSelection = normalizeDaySelection({ selectedDayIds: dayDraftSelection });
      renderDaysPage();
      return;
    }

    const submitBtn = e.target.closest(".day-submit-btn");
    if (!submitBtn || submitBtn.disabled || state.myDayVote) return;
    await voteForDay(dayDraftSelection);
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

function wireCarEvents() {
  const form = qs("#carForm");
  const list = qs("#carVotesList");
  if (!form) return;
  on(form, "change", (e) => {
    const target = e.target;
    if (!target || target.name !== "hasCar") return;
    toggleCarExtraFields(form);
  });
  on(form, "submit", async (e) => {
    e.preventDefault();
    await saveCarVoteFromForm();
  });
  if (list) {
    on(list, "click", async (e) => {
      const joinBtn = e.target.closest(".car-join-btn");
      if (joinBtn) {
        const driverUserId = joinBtn.dataset.carJoin;
        await joinCar(driverUserId);
        return;
      }

      const leaveBtn = e.target.closest(".car-leave-btn");
      if (!leaveBtn) return;
      const driverUserId = leaveBtn.dataset.carLeave;
      await leaveCar(driverUserId);
    });
  }
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
      if (btn) {
        const itemId = btn.dataset.packId;
        const nextStatus = btn.dataset.nextStatus;
        await updatePackingItemStatus(itemId, nextStatus);
        return;
      }

      const voteBtn = e.target.closest(".pack-vote-btn");
      if (!voteBtn) return;
      const itemId = voteBtn.dataset.packId;
      const vote = voteBtn.dataset.packVote;
      await votePackingItem(itemId, vote);
    });
  }
}

function wireTaskEvents() {
  const form = qs("#taskForm");
  const list = qs("#taskList");
  if (form) {
    on(form, "submit", async (e) => {
      e.preventDefault();
      await saveTaskFromForm();
    });
  }
  if (list) {
    on(list, "click", async (e) => {
      const btn = e.target.closest("[data-task-vote]");
      if (!btn) return;
      await voteTask(btn.dataset.taskId, btn.dataset.taskVote);
    });
  }
}

function wireGeneralEffects() {
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
  const [bedsRaw, myBedPreferences, bedPreferences, myDayVote, dayVotes, myBbqVote, bbqVotes, myCarVote, carVotes, carJoins, packingItems, packingVotes, taskItems, taskVotes] = await Promise.all([
    fetchBeds(),
    fetchMyBedPreferences(),
    fetchAllBedPreferences(),
    fetchMyDayVote(),
    fetchAllDayVotes(),
    fetchMyBbqVote(),
    fetchAllBbqVotes(),
    fetchMyCarVote(),
    fetchAllCarVotes(),
    fetchAllCarJoins(),
    fetchPackingItems(),
    fetchPackingVotes(),
    fetchTaskItems(),
    fetchTaskVotes(),
  ]);
  state.myBedPreferences = myBedPreferences;
  state.bedPreferences = bedPreferences;
  state.myDayVote = myDayVote;
  state.dayVotes = dayVotes;
  state.myBbqVote = myBbqVote;
  state.bbqVotes = bbqVotes;
  state.myCarVote = myCarVote;
  state.carVotes = carVotes;
  state.carJoins = carJoins;
  state.packingItems = packingItems;
  state.packingVotes = packingVotes;
  state.taskItems = taskItems;
  state.taskVotes = taskVotes;

  const ranking = computeBrotherRanking();
  const assignment = computeBedAssignments(bedsRaw, bedPreferences, ranking);
  const beds = applyAssignmentsToBeds(bedsRaw, assignment.assignments);
  const myAssigned = assignment.assignments.find((v) => v.userId === state.userId) || null;

  state.beds = beds;
  state.userVotes = assignment.assignments;
  state.myVote = myAssigned ? { userId: myAssigned.userId, userName: myAssigned.userName, bedId: myAssigned.bedId } : null;
  state.bedAssignment = assignment;
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
    renderHomeCardAlerts();
    renderBrotherLeaderboard();
    if (!homeScoreInfoShown) {
      openScoreInfoModal();
      homeScoreInfoShown = true;
    }
  } else if (state.page === "elegir") {
    renderChooseGrid();
  } else if (state.page === "dias") {
    renderDaysPage();
  } else if (state.page === "barbacoa") {
    renderBbqPage();
  } else if (state.page === "coche") {
    renderCarPage();
  } else if (state.page === "maleta") {
    renderPackingPage();
  } else if (state.page === "tareas") {
    renderTaskPage();
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
  wireBedLayoutEvents();
  wireScoreInfoEvents();

  try {
    await ensureAuth();
    // Identity must stay interactive (PIN modal/buttons), so do not keep global loading lock here.
    setLoading(false);
    await ensureIdentity();
    ensureLogoutButton();
    setLoading(true);
    await refreshData();
    renderCurrentPage();
    wireChooseEvents();
    wireDaysEvents();
    wireBbqEvents();
    wireCarEvents();
    wirePackingEvents();
    wireTaskEvents();
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
