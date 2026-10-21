// データ層：Firebase（本番）と localStorage（デモ）を同じ形で扱う
import { firebaseConfig } from "./config.js";

const FB_VERSION = "12.19.0";
const FB = `https://www.gstatic.com/firebasejs/${FB_VERSION}/`;
export const isDemo = !firebaseConfig.apiKey;

// Firestore は undefined を受け付けないため、保存前に素の JSON にする
const clean = (v) => JSON.parse(JSON.stringify(v));

export async function createStore() {
  return isDemo ? demoStore() : firebaseStore();
}

function demoStore() {
  const KEY = "rlog-demo-v1";
  let data = {};
  try { data = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { data = {}; }
  const subs = {};
  const list = (c) => Object.entries(data[c] || {}).map(([id, v]) => ({ ...v, id }));
  const emit = (c) => (subs[c] || []).forEach((cb) => cb(list(c)));
  const save = () => localStorage.setItem(KEY, JSON.stringify(data));
  const s = {
    mode: "demo",
    user: { uid: "demo", email: "", name: "デモ" },
    async signIn() {},
    async signOut() {},
    onAuth(cb) { cb(s.user); },
    subscribe(c, cb) {
      (subs[c] ??= []).push(cb);
      queueMicrotask(() => cb(list(c)));
      return () => { subs[c] = subs[c].filter((f) => f !== cb); };
    },
    async get(c, id) { const v = data[c]?.[id]; return v ? { ...v, id } : null; },
    async put(c, id, v) {
      const prev = data[c]?.[id];
      (data[c] ??= {})[id] = clean(v);
      try { save(); } catch {
        if (prev) data[c][id] = prev; else delete data[c][id];
        throw Object.assign(new Error("quota"), { code: "quota" });
      }
      emit(c);
    },
    async remove(c, id) { if (data[c]) delete data[c][id]; save(); emit(c); },
    async all(c) { return list(c); },
  };
  return s;
}

async function firebaseStore() {
  const [appMod, authMod, fs] = await Promise.all([
    import(FB + "firebase-app.js"),
    import(FB + "firebase-auth.js"),
    import(FB + "firebase-firestore.js"),
  ]);
  const app = appMod.initializeApp(firebaseConfig);
  const auth = authMod.getAuth(app);
  let db;
  try {
    // オフラインでも読み書きでき、次回起動も速くなる
    db = fs.initializeFirestore(app, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    });
  } catch {
    db = fs.getFirestore(app);
  }
  const col = (c) => fs.collection(db, "users", s.user.uid, c);
  const s = {
    mode: "firebase",
    user: null,
    async signIn() { await authMod.signInWithPopup(auth, new authMod.GoogleAuthProvider()); },
    async signOut() { await authMod.signOut(auth); },
    onAuth(cb) {
      authMod.onAuthStateChanged(auth, (u) => {
        s.user = u ? { uid: u.uid, email: u.email || "", name: u.displayName || "" } : null;
        cb(s.user);
      });
    },
    subscribe(c, cb, onErr) {
      return fs.onSnapshot(col(c), (snap) => cb(snap.docs.map((d) => ({ ...d.data(), id: d.id }))), onErr);
    },
    async get(c, id) {
      const d = await fs.getDoc(fs.doc(col(c), id));
      return d.exists() ? { ...d.data(), id: d.id } : null;
    },
    async put(c, id, v) { await fs.setDoc(fs.doc(col(c), id), clean(v)); },
    async remove(c, id) { await fs.deleteDoc(fs.doc(col(c), id)); },
    async all(c) {
      const q = await fs.getDocs(col(c));
      return q.docs.map((d) => ({ ...d.data(), id: d.id }));
    },
  };
  return s;
}
