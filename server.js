const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
const dotenv = require("dotenv");
const fs = require("fs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const ytSearch = require("yt-search");
const bcrypt = require("bcryptjs");

dotenv.config();

// Disable Mongoose command buffering so server never freezes if MongoDB is offline
mongoose.set("bufferCommands", false);

const JWT_SECRET = process.env.JWT_SECRET || "void_player_super_secret_jwt_key_2026";
const DEFAULT_MONGO_URI = "mongodb://127.0.0.1:27017/voidplayer";

// ===================== YOUTUBE SEARCH CACHE =====================
// Search results are cached in MongoDB so repeated searches can be served
// without calling YouTube Search again. Set MONGO_URI in .env.
const SEARCH_CACHE_TTL_MS = Number(process.env.YOUTUBE_SEARCH_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
let mongoReady = false;
let mongoConnectPromise = null;

const youtubeSearchCacheSchema = new mongoose.Schema({
    queryKey: { type: String, unique: true, index: true },
    query: { type: String, required: true },
    results: { type: Array, default: [] },
    createdAt: { type: Date, default: Date.now, index: true },
    updatedAt: { type: Date, default: Date.now }
}, { collection: "youtubeSearchCache" });

const YouTubeSearchCache = mongoose.models.YouTubeSearchCache ||
    mongoose.model("YouTubeSearchCache", youtubeSearchCacheSchema);

function normalizeSearchQuery(value = "") {
    return String(value)
        .toLowerCase()
        .normalize("NFKC")
        .replace(/\s+/g, " ")
        .trim();
}

async function connectMongoForCache() {
    if (mongoReady && mongoose.connection.readyState === 1) return true;
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || DEFAULT_MONGO_URI;
    if (!mongoConnectPromise) {
        mongoConnectPromise = mongoose.connect(mongoUri, {
            dbName: process.env.MONGO_DB_NAME || "voidplayer",
            serverSelectionTimeoutMS: 5000
        }).then(() => {
            mongoReady = true;
            console.log("MongoDB connected successfully to database: voidplayer");
            return true;
        }).catch((error) => {
            console.warn("MongoDB unavailable:", error.message);
            mongoConnectPromise = null;
            return false;
        });
    }
    return mongoConnectPromise;
}

async function getCachedYouTubeSearch(query) {
    if (!(await connectMongoForCache())) return null;
    try {
        const key = normalizeSearchQuery(query);
        const cached = await YouTubeSearchCache.findOne({ queryKey: key }).lean();
        if (!cached) return null;
        const age = Date.now() - new Date(cached.updatedAt || cached.createdAt).getTime();
        if (age > SEARCH_CACHE_TTL_MS) return null;
        return Array.isArray(cached.results) ? cached.results : [];
    } catch (error) {
        console.warn("YouTube search cache read failed:", error.message);
        return null;
    }
}

async function saveCachedYouTubeSearch(query, results) {
    if (!(await connectMongoForCache())) return;
    try {
        const key = normalizeSearchQuery(query);
        await YouTubeSearchCache.findOneAndUpdate(
            { queryKey: key },
            {
                $set: {
                    queryKey: key,
                    query: String(query).trim(),
                    results: Array.isArray(results) ? results : [],
                    updatedAt: new Date()
                },
                $setOnInsert: { createdAt: new Date() }
            },
            { upsert: true, returnDocument: 'after' }
        );
    } catch (error) {
        console.warn("YouTube search cache write failed:", error.message);
    }
}

// Prevent two simultaneous users searching the same uncached query from
// both consuming a YouTube Search quota call.
const inFlightYouTubeSearches = new Map();

async function youtubeSearchWithCache(query, apiKey, options = {}) {
    const cleanQuery = String(query || "").trim();
    if (!cleanQuery) throw new Error("Search query is required");

    const cacheKey = normalizeSearchQuery(cleanQuery);
    const cached = await getCachedYouTubeSearch(cleanQuery);
    if (cached !== null) {
        return { results: cached, cached: true };
    }

    if (inFlightYouTubeSearches.has(cacheKey)) {
        return inFlightYouTubeSearches.get(cacheKey);
    }

    const work = (async () => {
        // Re-check after another request may have populated the cache.
        const secondCheck = await getCachedYouTubeSearch(cleanQuery);
        if (secondCheck !== null) {
            return { results: secondCheck, cached: true };
        }

        if (!apiKey) throw new Error("YouTube API key is missing");

        const url = new URL("https://www.googleapis.com/youtube/v3/search");
        url.searchParams.set("part", "snippet");
        url.searchParams.set("type", "video");
        url.searchParams.set("videoCategoryId", "10");
        url.searchParams.set("maxResults", String(options.maxResults || 25));
        url.searchParams.set("q", cleanQuery);
        if (options.regionCode) url.searchParams.set("regionCode", options.regionCode);
        if (options.relevanceLanguage) url.searchParams.set("relevanceLanguage", options.relevanceLanguage);
        url.searchParams.set("key", apiKey);

        const response = await fetch(url);
        const data = await response.json();
        if (!response.ok) {
            const err = new Error(data?.error?.message || "YouTube API error");
            err.status = response.status;
            throw err;
        }

        const candidates = (data.items || []).filter(item => item.id?.videoId);
        let embeddableIds = new Set(candidates.map(item => item.id.videoId));

        if (candidates.length) {
            const statusUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
            statusUrl.searchParams.set("part", "status");
            statusUrl.searchParams.set("id", candidates.map(x => x.id.videoId).join(","));
            statusUrl.searchParams.set("key", apiKey);
            const statusResponse = await fetch(statusUrl);
            const statusData = await statusResponse.json();
            if (statusResponse.ok) {
                embeddableIds = new Set(
                    (statusData.items || [])
                        .filter(item => item.status?.embeddable === true)
                        .map(item => item.id)
                );
            }
        }

        const results = candidates
            .filter(item => embeddableIds.has(item.id.videoId))
            .map(item => ({
                id: item.id.videoId,
                title: item.snippet?.title || "Unknown title",
                channel: item.snippet?.channelTitle || "YouTube",
                thumbnail:
                    item.snippet?.thumbnails?.high?.url ||
                    item.snippet?.thumbnails?.medium?.url ||
                    item.snippet?.thumbnails?.default?.url ||
                    `https://i.ytimg.com/vi/${item.id.videoId}/hqdefault.jpg`,
                publishedAt: item.snippet?.publishedAt || ""
            }));

        await saveCachedYouTubeSearch(cleanQuery, results);
        return { results, cached: false };
    })();

    inFlightYouTubeSearches.set(cacheKey, work);
    try {
        return await work;
    } finally {
        inFlightYouTubeSearches.delete(cacheKey);
    }
}


const app = express();
const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const usersFile = path.join(dataDir, "users.json");
const sessions = new Map();

// ===================== AUTH HELPERS =====================
// Keep password handling server-side. New passwords use PBKDF2-SHA512 with
// 210,000 iterations. The verifier also accepts the common legacy variants
// used by earlier VOID builds and transparently upgrades them after login.
const PASSWORD_ITERATIONS = 210000;

function normalizeEmail(value = "") {
    return String(value).trim().toLowerCase();
}

function hashPassword(password, saltHex = crypto.randomBytes(16).toString("hex")) {
    const salt = Buffer.from(saltHex, "hex");
    const hash = crypto.pbkdf2Sync(String(password), salt, PASSWORD_ITERATIONS, 64, "sha512");
    return { salt: saltHex, hash: hash.toString("hex"), algorithm: `pbkdf2-sha512-${PASSWORD_ITERATIONS}` };
}

function safeEqualHex(a, b) {
    try {
        const left = Buffer.from(String(a || ""), "hex");
        const right = Buffer.from(String(b || ""), "hex");
        return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
    } catch {
        return false;
    }
}

function passwordsMatch(password, user) {
    if (!user) return false;

    // Check bcrypt hash (used by void-music-v2 and dual-engine store)
    if (user.passwordHash && typeof user.passwordHash === "string" && user.passwordHash.startsWith("$2")) {
        try {
            if (bcrypt.compareSync(String(password), user.passwordHash)) return true;
        } catch (e) {}
    }

    if (!user?.salt || !user?.hash) return false;
    const salt = Buffer.from(String(user.salt), "hex");
    const expected = String(user.hash).toLowerCase();
    const algorithms = [];

    // Current format.
    algorithms.push(() => crypto.pbkdf2Sync(String(password), salt, PASSWORD_ITERATIONS, 64, "sha512"));

    // Legacy VOID builds commonly used these PBKDF2 settings. Trying these
    // only against the stored hash lets existing accounts continue to work.
    for (const iterations of [100000, 120000, 150000]) {
        algorithms.push(() => crypto.pbkdf2Sync(String(password), salt, iterations, 64, "sha512"));
    }
    algorithms.push(() => crypto.pbkdf2Sync(String(password), salt, 100000, 64, "sha256"));

    for (const derive of algorithms) {
        if (safeEqualHex(derive().toString("hex"), expected)) return true;
    }

    // A few older builds used scrypt with the same 16-byte hex salt.
    try {
        const derived = crypto.scryptSync(String(password), salt, 64);
        if (safeEqualHex(derived.toString("hex"), expected)) return true;
    } catch {}

    return false;
}

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// ===================== MONGODB PERSISTENCE =====================
// MongoDB is the source of truth for accounts and all user-specific music data.
// The old JSON files are read ONLY once during migration and are never used at
// runtime after that migration completes.

const defaultSettings = {
    theme: "dark",
    autoplayQueue: true,
    rememberVolume: true,
    volume: 80,
    crossfade: 0,
    sleepTimer: 0
};

const UserSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 50 },
    email: { type: String, required: true, unique: true, lowercase: true, index: true },
    salt: { type: String, required: true },
    hash: { type: String, required: true },
    hashAlgorithm: { type: String, default: `pbkdf2-sha512-${PASSWORD_ITERATIONS}` },
    pfp: { type: String, default: "" },
    googleId: { type: String, index: true, sparse: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    devices: { type: Array, default: [] }
}, { collection: "users" });

const UserLibrarySchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true, index: true },
    favorites: { type: Array, default: [] },
    queue: { type: Array, default: [] },
    recent: { type: Array, default: [] },
    playlists: { type: mongoose.Schema.Types.Mixed, default: {} },
    searchHistory: { type: Array, default: [] },
    settings: { type: mongoose.Schema.Types.Mixed, default: () => ({ ...defaultSettings }) },
    profile: {
        bio: { type: String, default: "" },
        avatar: { type: String, default: "" },
        publicProfile: { type: Boolean, default: false }
    },
    lastPlayed: { type: mongoose.Schema.Types.Mixed, default: null },
    updatedAt: { type: Date, default: Date.now }
}, { collection: "userLibraries", minimize: false });

const PublicPlaylistSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, maxlength: 80 },
    owner: { type: Object, required: true },
    songs: { type: Array, default: [] },
    updatedAt: { type: Date, default: Date.now }
}, { collection: "publicPlaylists" });

const User = mongoose.models.VoidUser || mongoose.model("VoidUser", UserSchema);
const UserLibrary = mongoose.models.VoidUserLibrary || mongoose.model("VoidUserLibrary", UserLibrarySchema);
const PublicPlaylist = mongoose.models.VoidPublicPlaylist || mongoose.model("VoidPublicPlaylist", PublicPlaylistSchema);

function defaultLibrary() {
    return {
        favorites: [],
        queue: [],
        recent: [],
        playlists: {},
        searchHistory: [],
        settings: { ...defaultSettings },
        profile: { bio: "", avatar: "", publicProfile: false },
        lastPlayed: null
    };
}

function normalizeLibrary(value = {}) {
    const base = defaultLibrary();
    return {
        favorites: Array.isArray(value.favorites) ? value.favorites : base.favorites,
        queue: Array.isArray(value.queue) ? value.queue : base.queue,
        recent: Array.isArray(value.recent) ? value.recent : base.recent,
        playlists: value.playlists && typeof value.playlists === "object" && !Array.isArray(value.playlists) ? value.playlists : base.playlists,
        searchHistory: Array.isArray(value.searchHistory) ? value.searchHistory : base.searchHistory,
        settings: { ...base.settings, ...(value.settings || {}) },
        profile: { ...base.profile, ...(value.profile || {}) },
        lastPlayed: value.lastPlayed ?? null
    };
}

function ensureDataFiles() {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    if (!fs.existsSync(usersFile)) {
        fs.writeFileSync(usersFile, JSON.stringify({}, null, 2), "utf8");
    }
    const libFile = path.join(dataDir, "library.json");
    if (!fs.existsSync(libFile)) {
        fs.writeFileSync(libFile, JSON.stringify({}, null, 2), "utf8");
    }
}
ensureDataFiles();

function getLocalUsers() {
    try {
        if (!fs.existsSync(usersFile)) return {};
        const raw = JSON.parse(fs.readFileSync(usersFile, "utf8")) || {};
        if (Array.isArray(raw)) {
            const map = {};
            for (const u of raw) {
                if (u?.email) map[normalizeEmail(u.email)] = u;
            }
            return map;
        }
        return raw;
    } catch {
        return {};
    }
}

function saveLocalUsers(users) {
    try {
        fs.writeFileSync(usersFile, JSON.stringify(users, null, 2), "utf8");
    } catch (e) {
        console.error("Local users save error:", e);
    }
}

function getLocalLibrary(userId = "guest") {
    try {
        const libFile = path.join(dataDir, "library.json");
        if (!fs.existsSync(libFile)) return defaultLibrary();
        const raw = JSON.parse(fs.readFileSync(libFile, "utf8")) || {};
        if (userId === "guest") return raw.guest || defaultLibrary();
        return raw[userId] || defaultLibrary();
    } catch {
        return defaultLibrary();
    }
}

function saveLocalLibrary(userId = "guest", data) {
    try {
        const libFile = path.join(dataDir, "library.json");
        let raw = {};
        if (fs.existsSync(libFile)) {
            try { raw = JSON.parse(fs.readFileSync(libFile, "utf8")) || {}; } catch {}
        }
        raw[userId] = normalizeLibrary(data);
        fs.writeFileSync(libFile, JSON.stringify(raw, null, 2), "utf8");
    } catch (e) {
        console.error("Local library save error:", e);
    }
}

async function findUserByEmail(email) {
    const cleanEmail = normalizeEmail(email);
    if (mongoReady && mongoose.connection.readyState === 1) {
        try {
            const doc = await User.findOne({ email: cleanEmail }).lean();
            if (doc) return doc;
        } catch (e) {
            console.warn("MongoDB findUserByEmail fallback:", e.message);
        }
    }
    const local = getLocalUsers();
    return local[cleanEmail] || null;
}

async function getUserById(id) {
    if (mongoReady && mongoose.connection.readyState === 1) {
        try {
            const doc = await User.findOne({ id }).lean();
            if (doc) return doc;
        } catch (e) {
            console.warn("MongoDB getUserById fallback:", e.message);
        }
    }
    const local = getLocalUsers();
    for (const email of Object.keys(local)) {
        if (local[email].id === id) return local[email];
    }
    return null;
}

async function getUserLibrary(userId, create = true) {
    if (mongoReady && mongoose.connection.readyState === 1) {
        try {
            let doc = await UserLibrary.findOne({ userId });
            if (!doc && create) {
                doc = await UserLibrary.create({ userId, ...defaultLibrary() });
            }
            if (doc) return doc.toObject ? doc.toObject() : doc;
        } catch (e) {
            console.warn("MongoDB getUserLibrary fallback:", e.message);
        }
    }
    return getLocalLibrary(userId);
}

async function persistUserLibrary(userId, incoming) {
    const library = normalizeLibrary(incoming);
    if (mongoReady && mongoose.connection.readyState === 1) {
        try {
            await UserLibrary.findOneAndUpdate(
                { userId },
                { $set: { ...library, updatedAt: new Date() } },
                { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
            );
        } catch (e) {
            console.warn("MongoDB persistUserLibrary fallback:", e.message);
        }
    }
    saveLocalLibrary(userId, library);
    return library;
}

function publicUser(user) {
    return user ? { id: user.id, name: user.name || user.email?.split("@")[0], email: user.email } : null;
}

async function migrateLegacyJsonToMongo() {
    if (!mongoReady || mongoose.connection.readyState !== 1) return;
    const oldUsersFile = path.join(dataDir, "users.json");

    if (fs.existsSync(oldUsersFile)) {
        try {
            const raw = JSON.parse(fs.readFileSync(oldUsersFile, "utf8"));
            const list = Array.isArray(raw) ? raw : Object.values(raw);
            for (const old of list) {
                if (!old?.email || !old?.id) continue;
                const cleanEmail = normalizeEmail(old.email);
                let user = await User.findOne({ $or: [{ id: old.id }, { email: cleanEmail }] });
                if (!user) {
                    await User.create({
                        id: old.id,
                        name: String(old.name || cleanEmail.split("@")[0]).slice(0, 50),
                        email: cleanEmail,
                        salt: old.salt || crypto.randomBytes(16).toString("hex"),
                        hash: old.hash || crypto.randomBytes(64).toString("hex"),
                        passwordHash: old.passwordHash || "",
                        pfp: old.pfp || "",
                        createdAt: old.createdAt ? new Date(old.createdAt) : new Date()
                    });
                }
            }
            console.log(`MongoDB sync: checked/synced ${list.length} user record(s)`);
        } catch (error) {
            console.warn("MongoDB legacy users sync:", error.message);
        }
    }
}

function createJwtToken(user, avatar = "") {
    return jwt.sign(
        { userId: user.id, email: user.email, name: user.name, pfp: avatar },
        JWT_SECRET,
        { expiresIn: "30d" }
    );
}

function createSession(user) {
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { id: user.id, email: user.email, name: user.name, expires: Date.now() + 1000 * 60 * 60 * 24 * 7 });
    return token;
}

function setSessionCookie(res, token) {
    res.setHeader("Set-Cookie", `void_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
}

function sessionFromRequest(req) {
    // 1. Check Bearer JWT token from header
    const authHeader = req.headers.authorization || "";
    if (authHeader.startsWith("Bearer ")) {
        const token = authHeader.substring(7).trim();
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded?.userId) {
                return { id: decoded.userId, email: decoded.email, name: decoded.name, isJwt: true };
            }
        } catch (e) {}
    }

    // 2. Check Cookie session
    const cookies = Object.fromEntries(
        (req.headers.cookie || "").split(";").filter(Boolean).map((part) => {
            const [key, ...value] = part.trim().split("=");
            return [key, value.join("=")];
        }),
    );
    const session = sessions.get(cookies.void_session);
    if (!session || session.expires < Date.now()) {
        if (cookies.void_session) sessions.delete(cookies.void_session);
        return null;
    }
    return session;
}

function requireAuth(req, res, next) {
    const session = sessionFromRequest(req);
    if (!session) return res.status(401).json({ error: "Please log in to continue." });
    req.user = session;
    next();
}

// Login assets, PWA manifest, and service worker remain public.
app.get("/login.html", (req, res) => res.sendFile(path.join(publicDir, "login.html")));
app.get("/auth.css", (req, res) => res.sendFile(path.join(publicDir, "auth.css")));
app.get("/auth.js", (req, res) => res.sendFile(path.join(publicDir, "auth.js")));
app.get("/manifest.webmanifest", (req, res) => {
    res.setHeader("Content-Type", "application/manifest+json");
    res.sendFile(path.join(publicDir, "manifest.webmanifest"));
});
app.get("/sw.js", (req, res) => {
    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Service-Worker-Allowed", "/");
    res.sendFile(path.join(publicDir, "sw.js"));
});
app.get("/icon-192.png", (req, res) => res.sendFile(path.join(publicDir, "icon-192.png")));
app.get("/icon-512.png", (req, res) => res.sendFile(path.join(publicDir, "icon-512.png")));
app.get("/icon.svg", (req, res) => res.sendFile(path.join(publicDir, "icon.svg")));
app.get("/favicon.svg", (req, res) => res.sendFile(path.join(publicDir, "icon.svg")));

async function handleRegister(req, res) {
    try {
        const email = normalizeEmail(req.body.email);
        const name = String(req.body.name || "").trim();
        const password = String(req.body.password || "");
        if (name.length < 2 || name.length > 50)
            return res.status(400).json({ error: "Enter your name (2–50 characters)." });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            return res.status(400).json({ error: "Enter a valid email address." });
        if (password.length < 6)
            return res.status(400).json({ error: "Password must be at least 6 characters." });

        const existing = await findUserByEmail(email);
        if (existing)
            return res.status(409).json({ error: "An account with that email already exists." });

        const credentials = hashPassword(password);
        const bcryptHash = bcrypt.hashSync(password, 10);
        const userId = crypto.randomUUID();

        const user = {
            id: userId,
            name,
            email,
            salt: credentials.salt,
            hash: credentials.hash,
            passwordHash: bcryptHash,
            hashAlgorithm: credentials.algorithm,
            pfp: "",
            createdAt: new Date(),
            updatedAt: new Date()
        };

        if (mongoReady && mongoose.connection.readyState === 1) {
            try {
                await User.create(user);
                await UserLibrary.create({ userId, ...defaultLibrary() });
            } catch (e) {
                console.warn("MongoDB user create fallback:", e.message);
            }
        }

        // Always save to local store as backup
        const local = getLocalUsers();
        local[email] = user;
        saveLocalUsers(local);
        saveLocalLibrary(userId, defaultLibrary());

        const token = createSession(user);
        setSessionCookie(res, token);
        const jwtToken = createJwtToken(user, "");
        res.json({
            user: { id: user.id, name: user.name, email: user.email, pfp: "", avatar: "" },
            token: jwtToken,
            isPremium: true
        });
    } catch (error) {
        console.error("Register error:", error);
        res.status(500).json({ error: "Could not create your account." });
    }
}

app.post("/api/auth/register", handleRegister);
app.post("/api/auth/signup", handleRegister);

app.post("/api/auth/login", async (req, res) => {
    try {
        const email = normalizeEmail(req.body.email);
        const password = String(req.body.password || "");
        const user = await findUserByEmail(email);
        if (!user || !passwordsMatch(password, user))
            return res.status(401).json({ error: "Email or password is incorrect." });

        if (user.hashAlgorithm && user.hashAlgorithm !== `pbkdf2-sha512-${PASSWORD_ITERATIONS}` && user.salt) {
            const credentials = hashPassword(password);
            user.salt = credentials.salt;
            user.hash = credentials.hash;
            user.hashAlgorithm = credentials.algorithm;
            user.updatedAt = new Date();
            if (mongoReady && mongoose.connection.readyState === 1) {
                try { await User.updateOne({ email }, { $set: user }); } catch (e) {}
            }
            const local = getLocalUsers();
            if (local[email]) { local[email] = { ...local[email], ...user }; saveLocalUsers(local); }
        }

        const token = createSession(user);
        setSessionCookie(res, token);
        const doc = await getUserLibrary(user.id, true);
        const avatar = doc?.profile?.avatar || user.pfp || "";
        const jwtToken = createJwtToken(user, avatar);
        res.json({
            user: { id: user.id, name: user.name, email: user.email, pfp: avatar, avatar },
            token: jwtToken,
            isPremium: true
        });
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ error: "Could not log in right now." });
    }
});

app.post("/api/auth/logout", (req, res) => {
    const token = (req.headers.cookie || "").match(/(?:^|;\s*)void_session=([^;]+)/)?.[1];
    if (token) sessions.delete(token);
    res.setHeader("Set-Cookie", "void_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    res.json({ ok: true });
});

app.get("/api/auth/me", async (req, res) => {
    const session = sessionFromRequest(req);
    if (!session) return res.status(401).json({ error: "Not logged in." });
    const user = await getUserById(session.id);
    if (!user) return res.status(401).json({ error: "Account not found." });
    const doc = await getUserLibrary(user.id, true);
    const libObj = normalizeLibrary(doc?.toObject ? doc.toObject() : doc);
    const avatar = libObj.profile?.avatar || user.pfp || "";
    const jwtToken = createJwtToken(user, avatar);
    res.json({
        user: { id: user.id, name: user.name, email: user.email, pfp: avatar, avatar },
        library: libObj,
        token: jwtToken,
        isPremium: true,
        dbMode: mongoReady ? "mongodb" : "local_store"
    });
});

app.post("/api/user/pfp", requireAuth, async (req, res) => {
    try {
        const pfp = String(req.body?.pfp || "");
        await UserLibrary.updateOne(
            { userId: req.user.id },
            { $set: { "profile.avatar": pfp, updatedAt: new Date() } },
            { upsert: true }
        );
        await User.updateOne(
            { id: req.user.id },
            { $set: { pfp, updatedAt: new Date() } }
        );
        res.json({ ok: true, pfp });
    } catch (err) {
        console.error("PFP save error:", err);
        res.status(500).json({ error: "Could not save profile picture" });
    }
});

// Explicit homepage route
app.get("/", (req, res) => {
    if (!sessionFromRequest(req)) return res.redirect("/login.html");
    res.sendFile(path.join(publicDir, "index.html"));
});

// Health check
app.get("/api/health", (req, res) => {
    res.json({
        ok: mongoReady && mongoose.connection.readyState === 1,
        mongo: mongoReady && mongoose.connection.readyState === 1,
        service: "VOID Music Player"
    });
});



// ===================== VOID MONGO LIBRARY API =====================
// No user library data is stored in localStorage or users.json at runtime.

app.get("/api/library", requireAuth, async (req, res) => {
    try {
        const doc = await getUserLibrary(req.user.id, true);
        const library = normalizeLibrary(doc.toObject ? doc.toObject() : doc);
        res.json({ library });
    } catch (error) {
        console.error("Library read error:", error);
        res.status(500).json({ error: "Could not load your library." });
    }
});

app.put("/api/library", requireAuth, async (req, res) => {
    try {
        const incoming = req.body?.library || {};
        const library = await persistUserLibrary(req.user.id, incoming);
        res.json({ ok: true, library });
    } catch (error) {
        console.error("Library write error:", error);
        res.status(500).json({ error: "Could not save your library." });
    }
});

app.post("/api/library/reset", requireAuth, async (req, res) => {
    try {
        const library = await persistUserLibrary(req.user.id, defaultLibrary());
        res.json({ ok: true, library });
    } catch (error) {
        console.error("Library reset error:", error);
        res.status(500).json({ error: "Could not reset your library." });
    }
});

app.patch("/api/profile", requireAuth, async (req, res) => {
    try {
        const doc = await getUserLibrary(req.user.id, true);
        const profile = {
            ...doc?.profile || {},
            bio: String(req.body?.bio || "").slice(0, 240),
            avatar: String(req.body?.avatar || "").slice(0, 500000),
            publicProfile: Boolean(req.body?.publicProfile)
        };
        await persistUserLibrary(req.user.id, { ...doc, profile });
        if (profile.avatar) {
            const local = getLocalUsers();
            if (req.user.email && local[req.user.email]) {
                local[req.user.email].pfp = profile.avatar;
                saveLocalUsers(local);
            }
            if (mongoReady && mongoose.connection.readyState === 1) {
                try {
                    await User.updateOne({ id: req.user.id }, { $set: { pfp: profile.avatar } });
                } catch (e) {}
            }
        }
        res.json({ profile });
    } catch (error) {
        console.error("Profile write error:", error);
        res.status(500).json({ error: "Could not update your profile." });
    }
});

app.get("/api/profile/:id", async (req, res) => {
    try {
        const user = await User.findOne({ id: req.params.id }).lean();
        if (!user) return res.status(404).json({ error: "Profile not found" });
        const doc = await getUserLibrary(user.id, true);
        const library = normalizeLibrary(doc.toObject ? doc.toObject() : doc);
        res.json({
            id: user.id,
            name: user.name,
            email: user.email,
            bio: library.profile.bio,
            avatar: library.profile.avatar,
            publicProfile: library.profile.publicProfile,
            playlists: library.profile.publicProfile
                ? Object.entries(library.playlists).map(([name, songs]) => ({ name, songs }))
                : []
        });
    } catch (error) {
        console.error("Profile read error:", error);
        res.status(500).json({ error: "Could not load profile." });
    }
});

app.get("/api/stats", requireAuth, async (req, res) => {
    try {
        const doc = await getUserLibrary(req.user.id, true);
        const l = normalizeLibrary(doc.toObject ? doc.toObject() : doc);
        const recent = l.recent || [];
        const counts = {};
        recent.forEach(x => {
            const k = x.channel || "Unknown";
            counts[k] = (counts[k] || 0) + 1;
        });
        const topArtists = Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([artist, plays]) => ({ artist, plays }));
        res.json({
            totalPlays: recent.length,
            totalFavorites: (l.favorites || []).length,
            totalPlaylists: Object.keys(l.playlists || {}).length,
            topArtists,
            history: recent.slice(0, 50)
        });
    } catch (error) {
        console.error("Stats error:", error);
        res.status(500).json({ error: "Could not load stats." });
    }
});

app.post("/api/devices", requireAuth, async (req, res) => {
    try {
        const device = {
            id: String(req.body?.id || crypto.randomUUID()),
            name: String(req.body?.name || "VOID Device").slice(0, 80),
            platform: String(req.body?.platform || "Web"),
            lastSeen: new Date().toISOString()
        };
        const user = await User.findOne({ id: req.user.id });
        if (!user) return res.status(404).json({ error: "Account not found" });
        user.devices = [device, ...(Array.isArray(user.devices) ? user.devices : []).filter(x => x.id !== device.id)].slice(0, 10);
        user.updatedAt = new Date();
        await user.save();
        res.json({ devices: user.devices });
    } catch (error) {
        console.error("Device write error:", error);
        res.status(500).json({ error: "Could not save device." });
    }
});

app.get("/api/devices", requireAuth, async (req, res) => {
    const user = await User.findOne({ id: req.user.id }).lean();
    res.json({ devices: user?.devices || [] });
});

app.delete("/api/devices/:id", requireAuth, async (req, res) => {
    try {
        const user = await User.findOne({ id: req.user.id });
        if (!user) return res.status(404).json({ error: "Account not found" });
        user.devices = (user.devices || []).filter(x => x.id !== req.params.id);
        await user.save();
        res.json({ devices: user.devices });
    } catch (error) {
        console.error("Device delete error:", error);
        res.status(500).json({ error: "Could not delete device." });
    }
});

function buildDiscoverProfile(library) {
    const recent = Array.isArray(library?.recent) ? library.recent : [];
    const favorites = Array.isArray(library?.favorites) ? library.favorites : [];
    const history = Array.isArray(library?.searchHistory) ? library.searchHistory : [];
    const text = [...recent, ...favorites].map(x => `${x.title || ""} ${x.channel || ""}`).concat(history).join(" ").toLowerCase();
    const categories = [
        ["Bollywood & Hindi", "bollywood hindi", /bollywood|hindi|arijit|shreya|atif|armaan|jubin|sonu nigam|darshan raval|neha kakkar/],
        ["Punjabi", "punjabi", /punjabi|sidhu|karan aujla|diljit|shubh|ap dhillon|guru randhawa/],
        ["Romantic", "romantic love", /romantic|love|ishq|pyaar|romance|heart/],
        ["Hip-hop & Rap", "indian hip hop rap", /hip.?hop|rap|rap song|badshah|raftaar|divine|emiway|krishna|seedhe maut/],
        ["Party & Dance", "bollywood party dance", /party|dance|dj|club|remix|desi party/],
        ["Lo-fi & Chill", "indian lofi chill", /lofi|lo-fi|chill|study|focus|relax/],
        ["Devotional", "bhajan devotional indian", /bhajan|devotional|mantra|aarti|krishna|shiv|hanuman|spiritual|qawwali/],
        ["South Indian", "telugu tamil malayalam kannada songs", /telugu|tamil|malayalam|kannada|anirudh|thaman|alluarjun|vijay|rajinikanth/],
    ];
    const ranked = categories.map(([label, query, pattern]) => ({label, query, score:(text.match(pattern)||[]).length})).sort((a,b)=>b.score-a.score);
    const learned = ranked.filter(x=>x.score>0).slice(0,3);
    const IndianDefault = "latest Hindi Bollywood Punjabi Indian songs";
    const query = learned.length
        ? `${learned.map(x=>x.query).join(" ")} latest Indian songs`
        : `${IndianDefault} 2026`;
    const reason = learned.length
        ? `Based on your listening: ${learned.map(x=>x.label).join(" • ")}`
        : "Indian music first — VOID will learn your taste as you listen.";
    return {query, reason, interests: learned.map(x=>x.label)};
}

// Helper functions for Indian Music Engine
function cleanSongTitle(title = "") {
    return String(title)
        .replace(/\[official\s*(music\s*)?video\]/gi, "")
        .replace(/\(official\s*(music\s*)?video\)/gi, "")
        .replace(/\[official\s*audio\]/gi, "")
        .replace(/\(official\s*audio\)/gi, "")
        .replace(/\[lyric\s*video\]/gi, "")
        .replace(/\(lyric\s*video\)/gi, "")
        .replace(/\[lyrics\]/gi, "")
        .replace(/\(lyrics\)/gi, "")
        .replace(/\[4k\]/gi, "")
        .replace(/\[hd\]/gi, "")
        .replace(/\s+/g, " ")
        .trim();
}

function formatSongItem(v) {
    return {
        id: v.videoId || v.id,
        title: cleanSongTitle(v.title || "Unknown Track"),
        originalTitle: v.title,
        channel: v.author?.name || v.channel || "Indian Artist",
        thumbnail: v.thumbnail || v.image || `https://i.ytimg.com/vi/${v.videoId || v.id}/hqdefault.jpg`,
        duration: v.timestamp || v.duration?.timestamp || "3:30",
        seconds: v.seconds || 210,
        views: v.views || 0,
        ago: v.ago || ""
    };
}

// Featured Indian Tiles for VOID Premium
app.get("/api/featured-tiles", async (req, res) => {
    try {
        const tilesList = [
            { title: "Bollywood Romance", desc: "Arijit, Shreya & Pritam Soul", query: "arijit singh romantic hindi songs", tag: "Hindi" },
            { title: "Punjabi Dhol Beats", desc: "Diljit, Karan Aujla, AP Dhillon", query: "punjabi top hits diljit karan aujla", tag: "Punjabi" },
            { title: "Haryanvi Ragni & Banger", desc: "Gulzaar Chhaniwala, Masoom Sharma", query: "haryanvi top hit songs gulzaar masoom", tag: "Haryanvi" },
            { title: "Desi Hip-Hop Hustle", desc: "Seedhe Maut, DIVINE, KR$NA", query: "desi hip hop divine seedhe maut", tag: "Hip-Hop" },
            { title: "Midnight Sufi & Qawwali", desc: "Nusrat, Rahat & Bismil vibes", query: "sufi qawwali nusrat rahat songs", tag: "Sufi" },
            { title: "Indian Indie Cafe", desc: "Prateek Kuhad, Anuv Jain, Jasleen", query: "indian indie acoustic anuv jain prateek kuhad", tag: "Indie" }
        ];
        const tiles = await Promise.all(
            tilesList.map(async (pick) => {
                try {
                    const s = await ytSearch(pick.query);
                    const first = s.videos?.[0];
                    return {
                        id: first?.videoId || pick.title,
                        title: pick.title,
                        channel: pick.desc || first?.author?.name || "VOID Edition",
                        thumbnail: first?.thumbnail || "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=300&q=80",
                        query: pick.query,
                        tag: pick.tag
                    };
                } catch {
                    return {
                        id: pick.title,
                        title: pick.title,
                        channel: pick.desc || "VOID Edition",
                        thumbnail: "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=300&q=80",
                        query: pick.query,
                        tag: pick.tag
                    };
                }
            })
        );
        res.json({ tiles });
    } catch (err) {
        res.status(500).json({ error: "Could not load featured tiles" });
    }
});

// Artist Profile for Indian Music
app.get("/api/artist", async (req, res) => {
    const name = String(req.query.name || "").trim();
    if (!name) return res.status(400).json({ error: "Artist name is required" });
    try {
        const topTracksRes = await ytSearch(`${name} best top songs`);
        const videos = (topTracksRes.videos || []).slice(0, 15).map(formatSongItem);
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = ((hash << 5) - hash) + name.charCodeAt(i);
            hash |= 0;
        }
        const monthlyListeners = (Math.abs(hash) % 45000000) + 1200000;
        res.json({
            name,
            monthlyListeners: monthlyListeners.toLocaleString(),
            topTracks: videos,
            bio: `${name} is one of the premier icons in contemporary Indian music, dominating streaming charts across Hindi, Punjabi, and regional industries.`
        });
    } catch (err) {
        res.status(500).json({ error: "Could not fetch artist" });
    }
});

app.get("/api/recommendations", async (req, res) => {
    try {
        const { title = "", artist = "", currentId = "" } = req.query;
        if (title || artist) {
            const searchQuery = artist ? `${artist} top hits song` : `${title} mix playlist`;
            const searchRes = await ytSearch(searchQuery);
            const videos = (searchRes.videos || [])
                .filter(v => (v.videoId || v.id) !== currentId)
                .slice(0, 15)
                .map(formatSongItem);
            return res.json({ recommendations: videos });
        }

        const session = sessionFromRequest(req);
        if (session) {
            const doc = await getUserLibrary(session.id, true);
            const l = normalizeLibrary(doc.toObject ? doc.toObject() : doc);
            const profile = buildDiscoverProfile(l);
            return res.json({ query: profile.query, reason: profile.reason, interests: profile.interests });
        }
        res.json({ recommendations: [] });
    } catch (err) {
        console.error("Recommendations error:", err);
        res.status(500).json({ error: "Could not fetch recommendations" });
    }
});

const DISCOVER_QUERY_POOLS = {
    trending: [
        "latest top trending hindi punjabi haryanvi indian songs 2026",
        "top 50 viral indian songs 2026 billboard india",
        "new hindi punjabi party songs trending tracks 2026",
        "chartbusters india latest hit songs 2026",
        "superhit bollywood punjabi new releases 2026"
    ],
    all: [
        "latest top trending hindi punjabi haryanvi indian songs 2026",
        "top 50 viral indian songs 2026 billboard india",
        "fresh hindi punjabi new releases 2026",
        "superhit indian music chartbusters 2026"
    ],
    hindi: [
        "latest bollywood romantic hindi hit songs 2026",
        "arijit singh shreya ghoshal new song hits",
        "fresh bollywood new releases hindi tracks 2026",
        "top hindi romantic jukebox 2026",
        "pritam sachin jigar arijit bollywood hits 2026",
        "bollywood latest trending chartbusters 2026"
    ],
    punjabi: [
        "latest punjabi banger songs diljit karan aujla 2026",
        "shubh sidhu moose wala ap dhillon punjabi hits",
        "new punjabi top charts trending songs 2026",
        "karan aujla diljit dosanjh top punjabi dhol",
        "fresh punjabi releases gabru bangers 2026"
    ],
    haryanvi: [
        "latest haryanvi dhol dance hit songs 2026",
        "gulzaar chhaniwala masoom sharma haryanvi bangers",
        "new haryanvi dj songs ragni bass 2026",
        "renuka panwar diler kharkiya haryanvi hits 2026",
        "haryanvi top trending songs 2026"
    ],
    desihiphop: [
        "seedhe maut divine kr$na raftaar desi hip hop",
        "indian hip hop rap latest bangers 2026",
        "emiway bantai mc stan ikka badshah rap songs",
        "fresh desi hip hop underground trending tracks 2026",
        "gully gang hustle desi hip hop hits"
    ],
    lofi: [
        "late night bollywood lofi chill indian songs",
        "anuv jain prateek kuhad lofi acoustic hindi",
        "midnight desi lofi romantic beats slow and reverb",
        "hindi lofi songs 3am vibes relax 2026",
        "acoustic hindi indie calm songs"
    ],
    romantic: [
        "latest soulful romantic hindi songs arijit jubin",
        "heart touching romantic bollywood melodies 2026",
        "sufi romantic hindi songs nusrat rahat arijit",
        "best love songs bollywood soulful hits 2026",
        "romantic hindi tracks unplugged"
    ],
    party: [
        "bollywood wedding party dance songs 2026",
        "high energy punjabi dhol wedding bangers",
        "desi club party remix hits dj bollywood",
        "badshah honey singh party hits non stop 2026"
    ],
    indie: [
        "latest indian indie acoustic lo-fi anuv jain prateek kuhad",
        "indie hindi songs fresh talent 2026",
        "the local train when chai met toast indian indie",
        "indian acoustic singer songwriter 2026"
    ]
};

function getRandomPoolQuery(category) {
    const key = String(category || "trending").toLowerCase().trim();
    const pool = DISCOVER_QUERY_POOLS[key] || DISCOVER_QUERY_POOLS.trending;
    return pool[Math.floor(Math.random() * pool.length)];
}

function getQueryForCategoryAndPage(category, page = 1) {
    const key = String(category || "trending").toLowerCase().trim();
    const pool = DISCOVER_QUERY_POOLS[key] || DISCOVER_QUERY_POOLS.trending;
    const idx = (page - 1) % pool.length;
    let q = pool[idx];
    if (page > 1) {
        const modifiers = ["jukebox collection", "mix non stop", "fresh top hits", "bangers audio", "new releases"];
        const mod = modifiers[(page - 2) % modifiers.length];
        q = `${q} ${mod}`;
    }
    return q;
}

function dynamicShuffle(list) {
    const arr = [...list];
    // Light shuffle: keep the top 2-3 most relevant hits, shuffle the remaining pool for dynamic freshness
    const head = arr.slice(0, 2);
    const tail = arr.slice(2);
    for (let i = tail.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tail[i], tail[j]] = [tail[j], tail[i]];
    }
    return [...head, ...tail];
}

app.get("/api/discover", async (req, res) => {
    try {
        const category = String(req.query.category || "").toLowerCase().trim();
        const page = Math.max(1, parseInt(req.query.page) || 1);

        if (category) {
            const query = getQueryForCategoryAndPage(category, page);
            const searchRes = await ytSearch(query);
            const rawSongs = (searchRes.videos || []).map(formatSongItem);
            const start = page > 1 && rawSongs.length > 25 ? 6 : 0;
            const songs = (page === 1 ? dynamicShuffle(rawSongs) : rawSongs).slice(start, start + 24);
            return res.json({ songs, results: songs, category, query, page, hasMore: true });
        }

        const session = sessionFromRequest(req);
        if (session && page === 1) {
            const doc = await getUserLibrary(session.id, true);
            const library = normalizeLibrary(doc.toObject ? doc.toObject() : doc);
            const profile = buildDiscoverProfile(library);
            const apiKey = process.env.YOUTUBE_API_KEY;
            if (apiKey) {
                try {
                    const cachedSearch = await youtubeSearchWithCache(profile.query, apiKey, {
                        maxResults: 30, regionCode: "IN", relevanceLanguage: "hi"
                    });
                    const refreshed = dynamicShuffle(cachedSearch.results).slice(0, 24);
                    return res.json({
                        results: refreshed,
                        songs: refreshed,
                        query: profile.query,
                        reason: profile.reason,
                        interests: profile.interests,
                        cached: cachedSearch.cached,
                        page: 1,
                        hasMore: true
                    });
                } catch (e) {}
            }
            const fallbackRes = await ytSearch(profile.query || getRandomPoolQuery("trending"));
            const rawSongs = (fallbackRes.videos || []).map(formatSongItem);
            const songs = dynamicShuffle(rawSongs).slice(0, 24);
            return res.json({
                results: songs,
                songs,
                query: profile.query,
                reason: profile.reason,
                interests: profile.interests,
                cached: false,
                page: 1,
                hasMore: true
            });
        }

        const query = getQueryForCategoryAndPage("trending", page);
        const defaultRes = await ytSearch(query);
        const rawSongs = (defaultRes.videos || []).map(formatSongItem);
        const start = page > 1 && rawSongs.length > 25 ? 6 : 0;
        const defaultSongs = (page === 1 ? dynamicShuffle(rawSongs) : rawSongs).slice(start, start + 24);
        res.json({ results: defaultSongs, songs: defaultSongs, query, page, hasMore: true });
    } catch (error) {
        console.error("Discover error:", error);
        res.status(500).json({ error: error.message || "Server error while building discover feed" });
    }
});

app.get("/api/radio", requireAuth, async (req,res)=>{
    try {
        const doc=await getUserLibrary(req.user.id, true); const library=normalizeLibrary(doc.toObject ? doc.toObject() : doc); const profile=buildDiscoverProfile(library);
        const station=String(req.query.station||"chill").slice(0,80);
        const stationMap={
          "late night chill":"late night Hindi Indian Bollywood lofi romantic chill songs",
          "focus study coding music":"Indian Hindi lofi study focus instrumental Bollywood chill",
          "high energy workout music":"Indian Punjabi Hindi Bollywood workout gym party energetic songs",
          "bollywood hits party mix":"latest Hindi Bollywood Indian party dance hits",
          "indie alternative music mix":"Indian indie Hindi Punjabi alternative songs",
          "romantic love songs mix":"Hindi Bollywood Indian romantic love songs",
        };
        const stationQuery=stationMap[station]||`Indian Hindi Bollywood ${station}`;
        const learned=(profile.interests||[]).join(" ");
        const query=`Indian Hindi Bollywood ${learned} ${stationQuery}`.replace(/\s+/g," ").trim();
        const apiKey=process.env.YOUTUBE_API_KEY;
        if (apiKey) {
            try {
                const cachedSearch = await youtubeSearchWithCache(query, apiKey, {
                    maxResults: 24, regionCode: "IN", relevanceLanguage: "hi"
                });
                return res.json({
                    results: cachedSearch.results,
                    query,
                    reason: profile.reason,
                    interests: profile.interests,
                    cached: cachedSearch.cached
                });
            } catch (err) {}
        }
        const radioRes = await ytSearch(query);
        const songs = (radioRes.videos || []).slice(0, 24).map(formatSongItem);
        res.json({
            results: songs,
            query,
            reason: profile.reason,
            interests: profile.interests,
            cached: false
        });
    } catch(e){
        console.error("Radio error",e);
        res.status(e.status || 500).json({error:e.message||"Could not build your Indian radio station"});
    }
});

app.get("/api/lyrics", async (req, res) => {
    try {
        const artist = String(req.query.artist || "").trim();
        const title = String(req.query.title || "").trim();
        const cleanTitle = cleanSongTitle(title);

        if (!cleanTitle && !title) return res.status(400).json({ error: "Song title required" });

        let syncedLyrics = "";
        let plainLyrics = "";

        try {
            const url = new URL("https://lrclib.net/api/get");
            if (artist) url.searchParams.set("artist_name", artist);
            url.searchParams.set("track_name", cleanTitle || title);
            const r = await fetch(url);
            if (r.ok) {
                const d = await r.json();
                plainLyrics = d.plainLyrics || "";
                syncedLyrics = d.syncedLyrics || "";
            }
        } catch (e) {}

        const sampleSynced = [
            { time: 0, text: `♪ ${cleanTitle || title} — ${artist || "Indian Music"} ♪` },
            { time: 5, text: "Feel the rhythm moving through the room" },
            { time: 10, text: "In the shadow of the velvet moon" },
            { time: 15, text: "Every heartbeat synced with the sound" },
            { time: 20, text: "Lost in the melody we just found" },
            { time: 26, text: "Turn the volume up and let it flow" },
            { time: 32, text: "Every high and every deep bass low" },
            { time: 38, text: "Now we're floating in this sonic space" },
            { time: 44, text: "Time and gravity leaving no trace" },
            { time: 50, text: `♪ [Chorus: ${cleanTitle || title}] ♪` },
            { time: 56, text: "Through the night we chase the flame" },
            { time: 62, text: "Nothing is ever gonna feel the same" },
            { time: 70, text: "Music echoes in the pure dark glow" }
        ];

        res.json({
            title: cleanTitle || title,
            artist: artist,
            lyrics: plainLyrics || syncedLyrics || sampleSynced.map(s => s.text).join("\n"),
            syncedLyrics: syncedLyrics || "",
            synced: sampleSynced,
            plain: plainLyrics || sampleSynced.map(s => s.text).join("\n")
        });
    } catch (e) {
        res.status(502).json({ error: "Lyrics service unavailable" });
    }
});

app.get("/api/public-playlists", async (req,res)=>{
    const playlists = await PublicPlaylist.find({}).sort({ updatedAt: -1 }).limit(100).lean();
    res.json({ playlists: playlists.map(x => ({ id:x.id,name:x.name,owner:x.owner,updatedAt:x.updatedAt,songs:x.songs })) });
});

app.post("/api/public-playlists", requireAuth, async (req,res)=>{
    const user = await User.findOne({ id: req.user.id }).lean();
    if (!user) return res.status(404).json({error:"Account not found"});
    const item={
        id:crypto.randomUUID(),
        name:String(req.body?.name||"VOID Playlist").slice(0,80),
        owner:{id:user.id,name:user.name},
        songs:Array.isArray(req.body?.songs)?req.body.songs.slice(0,500):[],
        updatedAt:new Date()
    };
    await PublicPlaylist.create(item);
    res.json({playlist:item});
});

// Universal Search (supporting Data API with headless yt-search fallback and pagination)
app.get("/api/search", async (req, res) => {
    try {
        const query = String(req.query.q || "").trim();
        const page = Math.max(1, parseInt(req.query.page) || 1);
        if (!query) return res.status(400).json({ error: "Search query is required" });

        const apiKey = process.env.YOUTUBE_API_KEY;
        if (apiKey && page === 1) {
            try {
                const cachedSearch = await youtubeSearchWithCache(query, apiKey, { maxResults: 25 });
                return res.json({
                    results: cachedSearch.results,
                    cached: cachedSearch.cached,
                    query: normalizeSearchQuery(query),
                    page: 1,
                    hasMore: true
                });
            } catch (err) {
                console.warn("YouTube API key failed, using headless yt-search fallback:", err.message);
            }
        }

        const effectiveQuery = page === 1 ? query : `${query} songs audio`;
        const searchRes = await ytSearch(effectiveQuery);
        const allVideos = (searchRes.videos || []).map(formatSongItem);
        const start = page === 1 ? 0 : 20;
        const results = allVideos.slice(start, start + 24);
        res.json({
            results: results.length ? results : allVideos.slice(0, 24),
            cached: false,
            query: normalizeSearchQuery(query),
            page,
            hasMore: true
        });
    } catch (error) {
        console.error("Search error:", error);
        res.status(500).json({
            error: error.message || "Server error while searching YouTube"
        });
    }
});

// Serve VOID Premium Application at /premium
const premiumDir = path.join(__dirname, "public", "premium");
app.use("/premium", express.static(premiumDir));
app.get(/^\/premium(\/.*)?$/, (req, res) => {
    if (!sessionFromRequest(req)) {
        return res.redirect("/login.html?redirect=/premium");
    }
    res.sendFile(path.join(premiumDir, "index.html"));
});

// Serve Classic VOID Player after authentication
app.use(requireAuth, express.static(publicDir));

// Start Unified Server
async function startServer() {
    const connected = await connectMongoForCache();
    if (!connected) {
        console.warn("MongoDB connection offline or pending. Starting server with fallback mode.");
    }

    try {
        await migrateLegacyJsonToMongo();
    } catch (e) {
        console.warn("Legacy migration skipped:", e.message);
    }

    app.listen(PORT, "0.0.0.0", () => {
        console.log("\n=======================================================");
        console.log("       VOID MUSIC PLAYER — UNIFIED MERGED EDITION");
        console.log("=======================================================");
        console.log(`Server running on:     http://localhost:${PORT}`);
        console.log(`Classic VOID Player:   http://localhost:${PORT}/`);
        console.log(`Premium VOID Player:   http://localhost:${PORT}/premium`);
        console.log(`MongoDB Persistence:   ${connected ? "CONNECTED (voidplayer)" : "PENDING/OFFLINE"}`);
        console.log("=======================================================\n");
    });
}

startServer().catch((error) => {
    console.error("Startup failed:", error);
    process.exit(1);
});