// server.js - PropDeal backend (Node.js + Express + SQL Server)
require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { sql, run, withTransaction, getPool } = require('./db');
const { resetDemoData } = require('./seed');

/* ===================================================================
   0. SETTINGS
   =================================================================== */
const PORT = parseInt(process.env.PORT || '3000', 10);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('\n[config] JWT_SECRET is missing or too short (need 32+ characters). Fix it in the .env file.\n');
  process.exit(1);
}
const COOKIE_NAME = 'pd_token';
const COOKIE_SECURE = String(process.env.COOKIE_SECURE).toLowerCase() === 'true';
const REMEMBER_DAYS = parseInt(process.env.REMEMBER_DAYS || '14', 10);
const SESSION_EXPIRES = process.env.JWT_EXPIRES_IN || '12h';
const SELLER_AUTO_APPROVED = String(process.env.SELLER_LISTINGS_AUTO_APPROVED ?? 'true').toLowerCase() !== 'false';
const ALLOW_DEMO_RESET = String(process.env.ALLOW_DEMO_RESET ?? 'true').toLowerCase() === 'true';

const ROLES = ['buyer', 'seller', 'admin'];
const PROP_TYPES = ['house', 'apartment', 'shop', 'plot'];
const PROP_MODES = ['sale', 'rent'];
const APPROVAL = ['approved', 'pending', 'rejected'];
const MEETING_STATUS = ['pending', 'confirmed', 'declined', 'completed', 'cancelled'];
const DEAL_STAGES = ['inquiry', 'viewing_scheduled', 'negotiation', 'offer_accepted', 'closed', 'cancelled'];
const REVIEW_STATUS = ['pending', 'approved', 'rejected'];
const ALL_THEMES = ['original', 'navy', 'emerald', 'purple', 'terracotta', 'gold', 'dark'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = msg => new HttpError(400, msg);
const forbidden = (msg = 'You are not allowed to do that.') => new HttpError(403, msg);
const notFound = msg => new HttpError(404, msg);

/* ===================================================================
   1. VALIDATION HELPERS (same rules as the frontend, enforced again here)
   =================================================================== */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_RE = /^[\p{L}][\p{L} .'-]{1,49}$/u;
const CITY_RE = /^[\p{L}][\p{L} .,'-]{1,79}$/u;
const PHONE_RE = /^\+?\d{10,14}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(v, label, { min = 0, max = 255, required = false } = {}) {
  if (v == null || v === '') {
    if (required) throw bad(`${label} is required.`);
    return '';
  }
  if (typeof v !== 'string') throw bad(`${label} is invalid.`);
  const t = v.trim();
  if (required && !t) throw bad(`${label} is required.`);
  if (t.length < min) throw bad(`${label} must be at least ${min} characters.`);
  if (t.length > max) throw bad(`${label} must be ${max} characters or less.`);
  return t;
}
function int(v, label, { min = 0, max = 2147483647, nullable = false } = {}) {
  if (v == null || v === '') {
    if (nullable) return null;
    throw bad(`${label} is required.`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label} must be a whole number between ${min} and ${max}.`);
  return n;
}
function oneOf(v, list, label) {
  if (!list.includes(v)) throw bad(`${label} is invalid.`);
  return v;
}
const cleanEmail = v => {
  const e = String(v || '').trim().toLowerCase();
  if (!e) throw bad('Email is required.');
  if (e.length > 255 || !EMAIL_RE.test(e)) throw bad('Enter a valid email address.');
  return e;
};
function cleanPassword(v) {
  if (typeof v !== 'string' || !v) throw bad('Password is required.');
  if (v.length < 6) throw bad('Password must be at least 6 characters.');
  if (Buffer.byteLength(v, 'utf8') > 72) throw bad('Password is too long (max 72 characters).');
  return v;
}
function cleanName(v) {
  const n = String(v || '').trim().replace(/\s+/g, ' ');
  if (!n) throw bad('Full name is required.');
  if (!NAME_RE.test(n)) throw bad('Use letters only (2 to 50 characters).');
  return n;
}
function cleanCity(v) {
  const c = String(v || '').trim();
  if (!c) return '';
  if (!CITY_RE.test(c)) throw bad('Enter a valid city name (letters only).');
  return c;
}
function cleanPhone(v) {
  const p = String(v || '').trim();
  if (!p) return '';
  if (p.length > 30 || !PHONE_RE.test(p.replace(/[\s-]/g, ''))) throw bad('Enter a valid phone number (10 to 14 digits).');
  return p;
}
function cleanAge(v, nullable) {
  const n = int(v, 'Age', { min: 18, max: 100, nullable });
  return n;
}
function cleanDate(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v) || isNaN(new Date(v + 'T00:00:00Z'))) throw bad('Please choose a valid date.');
  const earliest = new Date(Date.now() - 24 * 3600e3).toISOString().slice(0, 10); // 1 day grace for time zones
  if (v < earliest) throw bad('Choose a date from today onwards.');
  return v;
}

/* ===================================================================
   2. ROW -> FRONTEND SHAPE MAPPERS
   =================================================================== */
const iso = d => (d ? new Date(d).toISOString() : null);
const parseJson = (t, fallback) => { try { return t ? JSON.parse(t) : fallback; } catch { return fallback; } };

const USER_COLS = `u.Id, u.Name, u.Email, u.Role, u.Age, u.City, u.Phone, u.About, u.BudgetMin, u.BudgetMax,
  u.AgencyName, u.ExperienceYears, u.IsActive, u.CreatedAt, u.LastLoginAt`;

function mapUser(r, level = 'full') {
  const base = { id: r.Id, email: r.Email, role: r.Role, name: r.Name, city: r.City || '', isActive: !!r.IsActive };
  if (level === 'public') {
    return { ...base, agencyName: r.AgencyName || '', experienceYears: r.ExperienceYears, about: '', phone: '' };
  }
  if (level === 'contact') {
    return { ...base, phone: r.Phone || '', agencyName: r.AgencyName || '', experienceYears: r.ExperienceYears, about: '' };
  }
  const u = {
    ...base, age: r.Age, phone: r.Phone || '', about: r.About || '',
    createdAt: iso(r.CreatedAt), lastLoginAt: iso(r.LastLoginAt)
  };
  if (r.Role === 'buyer') { u.budgetMin = r.BudgetMin == null ? null : Number(r.BudgetMin); u.budgetMax = r.BudgetMax == null ? null : Number(r.BudgetMax); }
  if (r.Role === 'seller') { u.agencyName = r.AgencyName || ''; u.experienceYears = r.ExperienceYears; }
  return u;
}
const mapProperty = r => ({
  id: r.Id, owner: r.OwnerEmail, sellerName: r.SellerName, title: r.Title, type: r.Type, mode: r.Mode,
  price: Number(r.Price), neg: r.Negotiable == null ? null : !!r.Negotiable, months: r.Months,
  city: r.City, locality: r.Locality || '', area_size: r.AreaSize || '', beds: r.Beds, baths: r.Baths,
  description: r.Description || '', long: r.LongDescription || '', approvalStatus: r.ApprovalStatus,
  feats: parseJson(r.Features, []), images: parseJson(r.Images, []), createdAt: iso(r.CreatedAt)
});
const mapMeeting = r => ({
  id: r.Id, propId: r.PropertyId, buyer: r.BuyerEmail, buyerName: r.BuyerName, seller: r.SellerEmail, sellerName: r.SellerName,
  date: r.D, time: r.MeetingTime, note: r.Note || '', months: r.Months, status: r.Status, createdAt: iso(r.CreatedAt)
});
const mapDeal = r => ({
  id: r.Id, propId: r.PropertyId, buyer: r.BuyerEmail, seller: r.SellerEmail, offeredPrice: Number(r.OfferedPrice),
  stage: r.Stage, notes: r.Notes || '', createdAt: iso(r.CreatedAt), updatedAt: iso(r.UpdatedAt)
});
const mapReview = r => ({
  id: r.Id, propId: r.PropertyId, buyerEmail: r.BuyerEmail, buyerName: r.BuyerName, rating: r.Rating,
  comment: r.Comment, status: r.Status, createdAt: iso(r.CreatedAt)
});

/* ===================================================================
   3. LOAD EVERYTHING THE LOGGED-IN USER IS ALLOWED TO SEE
   =================================================================== */
const DEFAULT_PROMO = { title: '', discountPercent: 10, isActive: false, propertyIds: [] };
const DEFAULT_THEMES = { defaultTheme: 'original', enabledThemes: ALL_THEMES.slice() };

async function getSetting(key, fallback, tx = null) {
  const rows = await run('SELECT SettingValue FROM dbo.AppSettings WHERE SettingKey = @k', { k: key }, tx);
  return rows.length ? parseJson(rows[0].SettingValue, fallback) : fallback;
}

async function buildState(user) {
  const uid = user.Id, isAdmin = user.Role === 'admin';
  const p = { uid, role: user.Role };

  const COUNTERPARTS = `SELECT BuyerId AS Id FROM dbo.Meetings WHERE SellerId = @uid
      UNION SELECT SellerId FROM dbo.Meetings WHERE BuyerId = @uid
      UNION SELECT BuyerId FROM dbo.Deals WHERE SellerId = @uid
      UNION SELECT SellerId FROM dbo.Deals WHERE BuyerId = @uid`;

  const [users, props, meetings, deals, reviews, favs, anns, promo, themes] = await Promise.all([
    isAdmin
      ? run(`SELECT ${USER_COLS}, 1 AS Self, 0 AS Contact FROM dbo.Users u ORDER BY u.Id`)
      : run(`SELECT ${USER_COLS},
               CASE WHEN u.Id = @uid THEN 1 ELSE 0 END AS Self,
               CASE WHEN u.Id IN (${COUNTERPARTS}) THEN 1 ELSE 0 END AS Contact
             FROM dbo.Users u
             WHERE u.Id = @uid OR u.Id IN (${COUNTERPARTS})
                OR u.Id IN (SELECT OwnerId FROM dbo.Properties WHERE ApprovalStatus = N'approved')
             ORDER BY u.Id`, p),
    run(`SELECT pr.*, o.Email AS OwnerEmail, o.Name AS SellerName
         FROM dbo.Properties pr JOIN dbo.Users o ON o.Id = pr.OwnerId
         WHERE @role = N'admin' OR pr.ApprovalStatus = N'approved' OR (@role = N'seller' AND pr.OwnerId = @uid)
         ORDER BY pr.CreatedAt DESC, pr.Id ASC`, p),
    run(`SELECT m.Id, m.PropertyId, m.MeetingTime, m.Note, m.Months, m.Status, m.CreatedAt,
                CONVERT(varchar(10), m.MeetingDate, 23) AS D,
                b.Email AS BuyerEmail, b.Name AS BuyerName, s.Email AS SellerEmail, s.Name AS SellerName
         FROM dbo.Meetings m JOIN dbo.Users b ON b.Id = m.BuyerId JOIN dbo.Users s ON s.Id = m.SellerId
         WHERE @role = N'admin' OR m.BuyerId = @uid OR m.SellerId = @uid
         ORDER BY m.CreatedAt DESC, m.Id DESC`, p),
    run(`SELECT d.Id, d.PropertyId, d.OfferedPrice, d.Stage, d.Notes, d.CreatedAt, d.UpdatedAt,
                b.Email AS BuyerEmail, s.Email AS SellerEmail
         FROM dbo.Deals d JOIN dbo.Users b ON b.Id = d.BuyerId JOIN dbo.Users s ON s.Id = d.SellerId
         WHERE @role = N'admin' OR d.BuyerId = @uid OR d.SellerId = @uid
         ORDER BY d.CreatedAt DESC, d.Id DESC`, p),
    run(`SELECT r.Id, r.PropertyId, r.Rating, r.Comment, r.Status, r.CreatedAt, b.Email AS BuyerEmail, b.Name AS BuyerName
         FROM dbo.Reviews r JOIN dbo.Users b ON b.Id = r.BuyerId
         WHERE @role = N'admin' OR r.Status = N'approved' OR r.BuyerId = @uid
         ORDER BY r.CreatedAt DESC, r.Id DESC`, p),
    run(`SELECT f.PropertyId, u.Email FROM dbo.Favorites f JOIN dbo.Users u ON u.Id = f.UserId
         WHERE @role = N'admin' OR f.UserId = @uid`, p),
    run(`SELECT Id, Message, SortOrder, IsActive FROM dbo.Announcements
         WHERE @role = N'admin' OR IsActive = 1 ORDER BY SortOrder, Id`, p),
    getSetting('promoDeal', DEFAULT_PROMO),
    getSetting('themeSettings', DEFAULT_THEMES)
  ]);

  const favoritesByUser = {};
  favs.forEach(f => { (favoritesByUser[f.Email] = favoritesByUser[f.Email] || []).push(f.PropertyId); });

  return {
    users: users.map(r => (isAdmin || r.Self ? mapUser(r, 'full') : mapUser(r, r.Contact ? 'contact' : 'public'))),
    properties: props.map(mapProperty),
    favoritesByUser,
    meetings: meetings.map(mapMeeting),
    deals: deals.map(mapDeal),
    reviews: reviews.map(mapReview),
    announcements: anns.map(a => ({ id: a.Id, message: a.Message, sortOrder: a.SortOrder, isActive: !!a.IsActive })),
    promoDeal: { ...DEFAULT_PROMO, ...promo },
    themeSettings: { ...DEFAULT_THEMES, ...themes }
  };
}

async function authPayload(userRow) {
  const fresh = (await run(`SELECT ${USER_COLS} FROM dbo.Users u WHERE u.Id = @id`, { id: userRow.Id }))[0];
  const full = mapUser(fresh, 'full');
  const state = await buildState({ Id: fresh.Id, Role: fresh.Role });
  return { user: full, state };
}

/* ===================================================================
   4. SESSION (JWT inside an httpOnly cookie)
   =================================================================== */
function startSession(res, userId, remember) {
  const token = jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: remember ? `${REMEMBER_DAYS}d` : SESSION_EXPIRES });
  const opts = { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, path: '/' };
  if (remember) opts.maxAge = REMEMBER_DAYS * 24 * 3600e3;     // otherwise a "session cookie"
  res.cookie(COOKIE_NAME, token, opts);
}
const endSession = res => res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, path: '/' });

async function requireAuth(req, res, next) {
  try {
    const token = req.cookies && req.cookies[COOKIE_NAME];
    if (!token) throw new HttpError(401, 'Please sign in.');
    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); } catch { endSession(res); throw new HttpError(401, 'Your session expired. Please sign in again.'); }
    const rows = await run('SELECT Id, Email, Name, Role, IsActive FROM dbo.Users WHERE Id = @id', { id: payload.uid });
    if (!rows.length || !rows[0].IsActive) { endSession(res); throw new HttpError(401, 'This account is not available.'); }
    req.user = rows[0];
    next();
  } catch (err) { next(err); }
}
const requireAdmin = (req, res, next) => (req.user.Role === 'admin' ? next() : next(forbidden('Admin access only.')));
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ===================================================================
   5. EXPRESS APP + SECURITY MIDDLEWARE
   =================================================================== */
const app = express();
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],          // the single-file frontend uses inline <script>
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"]
    }
  }
}));
app.use(express.json({ limit: '30mb' }));                 // property photos are sent as data URLs
app.use(cookieParser());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' }
});
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests.' } });
app.use('/api', apiLimiter);

/* ===================================================================
   6. AUTH ROUTES
   =================================================================== */
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);   // keeps timing equal when the email does not exist

app.post('/api/auth/register', authLimiter, wrap(async (req, res) => {
  const b = req.body || {};
  const name = cleanName(b.name);
  const email = cleanEmail(b.email);
  const password = cleanPassword(b.password);
  const role = oneOf(b.role, ['buyer', 'seller'], 'Account type');   // admins can never self-register
  const age = cleanAge(b.age, false);
  const city = cleanCity(b.city);

  const exists = await run('SELECT 1 AS x FROM dbo.Users WHERE Email = @email', { email });
  if (exists.length) throw new HttpError(409, 'An account with this email already exists.');

  const hash = await bcrypt.hash(password, 12);
  let row;
  try {
    row = (await run(
      `INSERT INTO dbo.Users (Name, Email, PasswordHash, Role, Age, City, Phone, About, IsActive, LastLoginAt)
       OUTPUT INSERTED.Id
       VALUES (@name, @email, @hash, @role, @age, @city, N'', N'', 1, SYSUTCDATETIME())`,
      { name, email, hash, role, age, city }))[0];
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) throw new HttpError(409, 'An account with this email already exists.');
    throw err;
  }
  startSession(res, row.Id, true);
  res.status(201).json(await authPayload({ Id: row.Id }));
}));

app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const password = typeof b.password === 'string' ? b.password : '';
  const role = b.role;
  if (!email || !password) throw bad('Email and password are required.');
  if (!ROLES.includes(role)) throw bad('Please choose Buyer, Seller or Admin.');

  const rows = await run('SELECT Id, Role, PasswordHash, IsActive FROM dbo.Users WHERE Email = @email', { email });
  const u = rows[0];
  const ok = await bcrypt.compare(password, u ? u.PasswordHash : DUMMY_HASH);
  if (!u || !ok) throw new HttpError(401, 'Incorrect email or password.');
  if (u.Role !== role) throw new HttpError(403, `This account is registered as a ${u.Role}, not a ${role}.`);
  if (!u.IsActive) throw new HttpError(403, 'Your account has been disabled by an administrator.');

  await run('UPDATE dbo.Users SET LastLoginAt = SYSUTCDATETIME() WHERE Id = @id', { id: u.Id });
  startSession(res, u.Id, !!b.remember);
  res.json(await authPayload(u));
}));

app.post('/api/auth/logout', (req, res) => { endSession(res); res.json({ ok: true }); });

app.get('/api/auth/me', requireAuth, wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await authPayload(req.user));
}));

// Public data needed before sign-in (colour themes + ticker messages)
app.get('/api/public', wrap(async (req, res) => {
  const [themeSettings, anns] = await Promise.all([
    getSetting('themeSettings', DEFAULT_THEMES),
    run('SELECT Id, Message, SortOrder, IsActive FROM dbo.Announcements WHERE IsActive = 1 ORDER BY SortOrder, Id')
  ]);
  res.json({
    themeSettings: { ...DEFAULT_THEMES, ...themeSettings },
    announcements: anns.map(a => ({ id: a.Id, message: a.Message, sortOrder: a.SortOrder, isActive: true }))
  });
}));

app.get('/api/health', wrap(async (req, res) => {
  await run('SELECT 1 AS ok');
  res.json({ ok: true });
}));

/* ===================================================================
   7. DATA CHANGES  (POST /api/sync)  -  every change is re-checked here
   =================================================================== */
const getProperty = async (tx, id) => (await run('SELECT Id, OwnerId, ApprovalStatus, Mode, Price FROM dbo.Properties WHERE Id = @id', { id }, tx))[0];
const getUserByEmail = async (tx, email) => (await run('SELECT Id, Role, IsActive FROM dbo.Users WHERE Email = @e', { e: String(email || '').trim().toLowerCase() }, tx))[0];
const isTemp = id => Number(id) >= 1e9;
const bigint = v => [sql.BigInt, v];

function cleanProperty(d) {
  const mode = oneOf(d.mode, PROP_MODES, 'Listing mode');
  const price = Number(d.price);
  if (!Number.isFinite(price) || price < 1 || price > 1e13) throw bad('Price must be a positive number.');
  const images = Array.isArray(d.images) ? d.images : [];
  if (images.length > 12) throw bad('A listing can have at most 12 photos.');
  images.forEach(src => {
    if (typeof src !== 'string' || src.length > 4e6 || !/^(https?:\/\/|data:image\/(jpeg|png|webp|gif);base64,)/i.test(src)) throw bad('One of the photos is not valid.');
  });
  const feats = Array.isArray(d.feats) ? d.feats : [];
  if (feats.length > 30) throw bad('Too many features listed.');
  feats.forEach(f => { if (typeof f !== 'string' || f.length > 100) throw bad('A feature is too long.'); });
  return {
    title: str(d.title, 'Title', { required: true, min: 2, max: 150 }),
    type: oneOf(d.type, PROP_TYPES, 'Property type'),
    mode,
    price: Math.round(price),
    neg: d.neg === true ? 1 : d.neg === false ? 0 : null,
    months: mode === 'rent' ? int(d.months, 'Rental months', { min: 1, max: 600 }) : null,
    city: str(d.city, 'City', { required: true, max: 80 }),
    locality: str(d.locality, 'Locality', { max: 150 }),
    area: str(d.area_size, 'Area size', { max: 60 }),
    beds: int(d.beds, 'Bedrooms', { min: 0, max: 50, nullable: true }),
    baths: int(d.baths, 'Bathrooms', { min: 0, max: 50, nullable: true }),
    short: str(d.description, 'Short description', { max: 500 }),
    long: str(d.long, 'Description', { max: 20000 }),
    feats: JSON.stringify(feats.map(f => f.trim()).filter(Boolean)),
    images: JSON.stringify(images)
  };
}

const handlers = {
  /* ---------------- properties ---------------- */
  property: {
    async create(tx, user, op, ctx) {
      let ownerId, status;
      if (user.Role === 'seller') {
        ownerId = user.Id;
        status = SELLER_AUTO_APPROVED ? 'approved' : 'pending';
      } else if (user.Role === 'admin') {
        const o = await getUserByEmail(tx, op.data.owner);
        if (!o || o.Role !== 'seller') throw bad('Owner must be an existing seller.');
        ownerId = o.Id;
        status = oneOf(op.data.approvalStatus || 'approved', APPROVAL, 'Approval status');
      } else throw forbidden('Only sellers can add properties.');
      const f = cleanProperty(op.data);
      const row = (await run(
        `INSERT INTO dbo.Properties (OwnerId, Title, Type, Mode, Price, Negotiable, Months, City, Locality, AreaSize, Beds, Baths,
                                     Description, LongDescription, ApprovalStatus, Features, Images)
         OUTPUT INSERTED.Id
         VALUES (@owner, @title, @type, @mode, @price, @neg, @months, @city, @locality, @area, @beds, @baths,
                 @short, @long, @status, @feats, @images)`,
        { owner: ownerId, title: f.title, type: f.type, mode: f.mode, price: bigint(f.price), neg: [sql.Bit, f.neg], months: [sql.Int, f.months],
          city: f.city, locality: f.locality, area: f.area, beds: [sql.Int, f.beds], baths: [sql.Int, f.baths],
          short: f.short, long: f.long, status, feats: f.feats, images: f.images }, tx))[0];
      ctx.map('property', op.id, row.Id);
    },
    async update(tx, user, op, ctx) {
      const id = ctx.rid('property', op.id);
      const cur = await getProperty(tx, id);
      if (!cur) throw notFound('That property no longer exists.');
      if (user.Role === 'seller' && cur.OwnerId !== user.Id) throw forbidden('You can only edit your own properties.');
      if (user.Role === 'buyer') throw forbidden();
      const f = cleanProperty(op.data);
      const status = user.Role === 'admin' ? oneOf(op.data.approvalStatus, APPROVAL, 'Approval status') : cur.ApprovalStatus;
      await run(
        `UPDATE dbo.Properties SET Title=@title, Type=@type, Mode=@mode, Price=@price, Negotiable=@neg, Months=@months, City=@city,
                Locality=@locality, AreaSize=@area, Beds=@beds, Baths=@baths, Description=@short, LongDescription=@long,
                ApprovalStatus=@status, Features=@feats, Images=@images
         WHERE Id=@id`,
        { id, title: f.title, type: f.type, mode: f.mode, price: bigint(f.price), neg: [sql.Bit, f.neg], months: [sql.Int, f.months],
          city: f.city, locality: f.locality, area: f.area, beds: [sql.Int, f.beds], baths: [sql.Int, f.baths],
          short: f.short, long: f.long, status, feats: f.feats, images: f.images }, tx);
    },
    async delete(tx, user, op, ctx) {
      const id = ctx.rid('property', op.id);
      const cur = await getProperty(tx, id);
      if (!cur) return;                                         // already gone
      if (user.Role === 'seller' && cur.OwnerId === user.Id) { /* ok */ }
      else if (user.Role !== 'admin') throw forbidden('You can only delete your own properties.');
      await run('DELETE FROM dbo.Properties WHERE Id = @id', { id }, tx);   // meetings, deals, reviews, favourites cascade
    }
  },

  /* ---------------- meetings ---------------- */
  meeting: {
    async create(tx, user, op, ctx) {
      if (user.Role !== 'buyer') throw forbidden('Only buyers can request meetings.');
      const d = op.data;
      const prop = await getProperty(tx, ctx.rid('property', d.propId));
      if (!prop || prop.ApprovalStatus !== 'approved') throw notFound('That property is not available.');
      const date = cleanDate(d.date);
      const time = str(d.time, 'Time', { required: true, max: 20 });
      const note = str(d.note, 'Note', { max: 1000 });
      const months = prop.Mode === 'rent' ? int(d.months, 'Rental period', { min: 1, max: 60 }) : null;
      const row = (await run(
        `INSERT INTO dbo.Meetings (PropertyId, BuyerId, SellerId, MeetingDate, MeetingTime, Note, Months, Status)
         OUTPUT INSERTED.Id
         VALUES (@pid, @buyer, @seller, CAST(@date AS DATE), @time, @note, @months, N'pending')`,
        { pid: prop.Id, buyer: user.Id, seller: prop.OwnerId, date: [sql.VarChar(10), date], time, note, months: [sql.Int, months] }, tx))[0];
      ctx.map('meeting', op.id, row.Id);
    },
    async update(tx, user, op, ctx) {
      const id = ctx.rid('meeting', op.id);
      const cur = (await run('SELECT Id, BuyerId, SellerId, Status FROM dbo.Meetings WHERE Id = @id', { id }, tx))[0];
      if (!cur) throw notFound('That meeting no longer exists.');
      const status = oneOf(op.data.status, MEETING_STATUS, 'Meeting status');
      if (status === cur.Status) return;
      if (user.Role === 'admin') { /* any status */ }
      else if (user.Role === 'buyer' && cur.BuyerId === user.Id && status === 'cancelled') { /* buyer may cancel */ }
      else if (user.Role === 'seller' && cur.SellerId === user.Id && ['confirmed', 'declined', 'completed'].includes(status)) { /* seller answers */ }
      else throw forbidden('You cannot change this meeting.');
      await run('UPDATE dbo.Meetings SET Status = @s WHERE Id = @id', { s: status, id }, tx);
    },
    async delete(tx, user, op, ctx) {
      if (user.Role !== 'admin') throw forbidden('Only an admin can delete meetings.');
      await run('DELETE FROM dbo.Meetings WHERE Id = @id', { id: ctx.rid('meeting', op.id) }, tx);
    }
  },

  /* ---------------- deals ---------------- */
  deal: {
    async create(tx, user, op, ctx) {
      const d = op.data;
      const prop = await getProperty(tx, ctx.rid('property', d.propId));
      if (!prop) throw notFound('Property not found.');
      let buyerId, stage;
      if (user.Role === 'buyer') {
        if (prop.ApprovalStatus !== 'approved') throw notFound('That property is not available.');
        buyerId = user.Id;
        stage = oneOf(d.stage, ['inquiry', 'viewing_scheduled'], 'Deal stage');
      } else if (user.Role === 'admin') {
        const b = await getUserByEmail(tx, d.buyer);
        if (!b || b.Role !== 'buyer') throw bad('Buyer email not found.');
        buyerId = b.Id;
        stage = oneOf(d.stage, DEAL_STAGES, 'Deal stage');
      } else throw forbidden('Only buyers can make offers.');
      const price = Number(d.offeredPrice);
      if (!Number.isFinite(price) || price <= 0 || price > 1e13) throw bad('Enter a valid offer amount.');
      const row = (await run(
        `INSERT INTO dbo.Deals (PropertyId, BuyerId, SellerId, OfferedPrice, Stage, Notes)
         OUTPUT INSERTED.Id VALUES (@pid, @buyer, @seller, @price, @stage, @notes)`,
        { pid: prop.Id, buyer: buyerId, seller: prop.OwnerId, price: bigint(Math.round(price)), stage, notes: str(d.notes, 'Notes', { max: 1000 }) }, tx))[0];
      ctx.map('deal', op.id, row.Id);
    },
    async update(tx, user, op, ctx) {
      const id = ctx.rid('deal', op.id);
      const cur = (await run('SELECT Id, BuyerId, SellerId, Stage, Notes, OfferedPrice FROM dbo.Deals WHERE Id = @id', { id }, tx))[0];
      if (!cur) throw notFound('That deal no longer exists.');
      const stage = oneOf(op.data.stage, DEAL_STAGES, 'Deal stage');
      if (user.Role === 'admin') {
        let price = Number(cur.OfferedPrice);                      // blank offer box = keep the current offer
        if (op.data.offeredPrice != null && op.data.offeredPrice !== '') {
          price = Number(op.data.offeredPrice);
          if (!Number.isFinite(price) || price <= 0 || price > 1e13) throw bad('Enter a valid offer amount.');
        }
        await run('UPDATE dbo.Deals SET Stage=@stage, Notes=@notes, OfferedPrice=@price, UpdatedAt=SYSUTCDATETIME() WHERE Id=@id',
          { id, stage, notes: str(op.data.notes, 'Notes', { max: 1000 }), price: bigint(Math.round(price)) }, tx);
      } else if (user.Role === 'seller' && cur.SellerId === user.Id) {
        if (stage !== cur.Stage) await run('UPDATE dbo.Deals SET Stage=@stage, UpdatedAt=SYSUTCDATETIME() WHERE Id=@id', { id, stage }, tx);
      } else if (user.Role === 'buyer' && cur.BuyerId === user.Id) {
        if (stage !== cur.Stage) {
          if (stage !== 'cancelled') throw forbidden('Buyers can only cancel their own deals.');
          await run('UPDATE dbo.Deals SET Stage=@stage, UpdatedAt=SYSUTCDATETIME() WHERE Id=@id', { id, stage }, tx);
        }
      } else throw forbidden('You cannot change this deal.');
    },
    async delete(tx, user, op, ctx) {
      if (user.Role !== 'admin') throw forbidden('Only an admin can delete deals.');
      await run('DELETE FROM dbo.Deals WHERE Id = @id', { id: ctx.rid('deal', op.id) }, tx);
    }
  },

  /* ---------------- reviews ---------------- */
  review: {
    async create(tx, user, op, ctx) {
      if (user.Role !== 'buyer') throw forbidden('Only buyers can write reviews.');
      const d = op.data;
      const prop = await getProperty(tx, ctx.rid('property', d.propId));
      if (!prop || prop.ApprovalStatus !== 'approved') throw notFound('That property is not available.');
      const rating = int(d.rating, 'Rating', { min: 1, max: 5 });
      const comment = str(d.comment, 'Review', { required: true, min: 5, max: 1000 });
      const row = (await run(
        `INSERT INTO dbo.Reviews (PropertyId, BuyerId, Rating, Comment, Status)
         OUTPUT INSERTED.Id VALUES (@pid, @buyer, @rating, @comment, N'pending')`,
        { pid: prop.Id, buyer: user.Id, rating, comment }, tx))[0];
      ctx.map('review', op.id, row.Id);
    },
    async update(tx, user, op, ctx) {
      if (user.Role !== 'admin') throw forbidden('Only an admin can moderate reviews.');
      await run('UPDATE dbo.Reviews SET Status = @s WHERE Id = @id',
        { s: oneOf(op.data.status, REVIEW_STATUS, 'Review status'), id: ctx.rid('review', op.id) }, tx);
    },
    async delete(tx, user, op, ctx) {
      if (user.Role !== 'admin') throw forbidden('Only an admin can delete reviews.');
      await run('DELETE FROM dbo.Reviews WHERE Id = @id', { id: ctx.rid('review', op.id) }, tx);
    }
  },

  /* ---------------- announcements ---------------- */
  announcement: {
    async create(tx, user, op, ctx) {
      if (user.Role !== 'admin') throw forbidden('Admin access only.');
      const d = op.data;
      const row = (await run(
        'INSERT INTO dbo.Announcements (Message, SortOrder, IsActive) OUTPUT INSERTED.Id VALUES (@m, @o, @a)',
        { m: str(d.message, 'Message', { required: true, max: 500 }), o: int(d.sortOrder, 'Order', { min: 0, max: 100000, nullable: true }) || 0, a: [sql.Bit, d.isActive === false ? 0 : 1] }, tx))[0];
      ctx.map('announcement', op.id, row.Id);
    },
    async update(tx, user, op, ctx) {
      if (user.Role !== 'admin') throw forbidden('Admin access only.');
      const d = op.data;
      await run('UPDATE dbo.Announcements SET Message=@m, SortOrder=@o, IsActive=@a WHERE Id=@id',
        { id: ctx.rid('announcement', op.id), m: str(d.message, 'Message', { required: true, max: 500 }),
          o: int(d.sortOrder, 'Order', { min: 0, max: 100000, nullable: true }) || 0, a: [sql.Bit, d.isActive ? 1 : 0] }, tx);
    },
    async delete(tx, user, op, ctx) {
      if (user.Role !== 'admin') throw forbidden('Admin access only.');
      await run('DELETE FROM dbo.Announcements WHERE Id = @id', { id: ctx.rid('announcement', op.id) }, tx);
    }
  },

  /* ---------------- users ---------------- */
  user: {
    async create(tx, user, op, ctx) {
      if (user.Role !== 'admin') throw forbidden('Admin access only.');
      const d = op.data;
      const email = cleanEmail(d.email);
      const role = oneOf(d.role, ROLES, 'Role');
      const hash = await bcrypt.hash(cleanPassword(d.password), 12);
      if ((await run('SELECT 1 AS x FROM dbo.Users WHERE Email = @email', { email }, tx)).length) throw new HttpError(409, 'Email already exists.');
      const row = (await run(
        `INSERT INTO dbo.Users (Name, Email, PasswordHash, Role, Age, City, Phone, About, IsActive)
         OUTPUT INSERTED.Id VALUES (@name, @email, @hash, @role, @age, @city, @phone, N'', 1)`,
        { name: cleanName(d.name), email, hash, role, age: [sql.Int, cleanAge(d.age, true)], city: cleanCity(d.city), phone: cleanPhone(d.phone) }, tx))[0];
      if (role === 'admin') await run('INSERT INTO dbo.Admin (UserId, AdminLevel) VALUES (@id, N\'standard\')', { id: row.Id }, tx);
      ctx.map('user', op.id, row.Id);
    },
    async update(tx, user, op, ctx) {
      const id = ctx.rid('user', op.id);
      const isSelf = id === user.Id;
      if (!isSelf && user.Role !== 'admin') throw forbidden('You can only edit your own profile.');
      const cur = (await run('SELECT Id, Role FROM dbo.Users WHERE Id = @id', { id }, tx))[0];
      if (!cur) throw notFound('That user no longer exists.');
      const d = op.data, sets = [], params = { id };
      const set = (col, key, value, type) => { sets.push(`${col} = @${key}`); params[key] = type ? [type, value] : value; };

      if ('name' in d) set('Name', 'name', cleanName(d.name));
      if ('age' in d) set('Age', 'age', cleanAge(d.age, true), sql.Int);
      if ('city' in d) set('City', 'city', cleanCity(d.city));
      if ('phone' in d) set('Phone', 'phone', cleanPhone(d.phone));
      if ('about' in d) set('About', 'about', str(d.about, 'About', { max: 1000 }));
      if (cur.Role === 'buyer' && ('budgetMin' in d || 'budgetMax' in d)) {
        const lo = d.budgetMin == null || d.budgetMin === '' ? null : Number(d.budgetMin);
        const hi = d.budgetMax == null || d.budgetMax === '' ? null : Number(d.budgetMax);
        [lo, hi].forEach(v => { if (v != null && (!Number.isFinite(v) || v < 0 || v > 1e12)) throw bad('Budget is invalid.'); });
        if (lo != null && hi != null && lo > hi) throw bad('Maximum budget must be at least the minimum.');
        set('BudgetMin', 'bmin', lo, sql.BigInt); set('BudgetMax', 'bmax', hi, sql.BigInt);
      }
      if (cur.Role === 'seller') {
        if ('agencyName' in d) set('AgencyName', 'agency', str(d.agencyName, 'Agency name', { max: 120 }));
        if ('experienceYears' in d) set('ExperienceYears', 'exp', int(d.experienceYears, 'Experience', { min: 0, max: 60, nullable: true }), sql.Int);
      }
      if (user.Role === 'admin' && 'isActive' in d) {
        if (isSelf && !d.isActive) throw bad('You cannot disable your own admin account.');
        set('IsActive', 'active', d.isActive ? 1 : 0, sql.Bit);
      }
      if (sets.length) await run(`UPDATE dbo.Users SET ${sets.join(', ')} WHERE Id = @id`, params, tx);
    },
    async delete(tx, user, op, ctx) {
      if (user.Role !== 'admin') throw forbidden('Admin access only.');
      const id = ctx.rid('user', op.id);
      if (id === user.Id) throw bad('You cannot delete your own admin account.');
      if (!(await run('SELECT 1 AS x FROM dbo.Users WHERE Id = @id', { id }, tx)).length) return;
      // remove everything that points at this user, then the user
      await run(`DELETE FROM dbo.Favorites WHERE UserId = @id;
                 DELETE FROM dbo.Reviews   WHERE BuyerId = @id;
                 DELETE FROM dbo.Deals     WHERE BuyerId = @id OR SellerId = @id;
                 DELETE FROM dbo.Meetings  WHERE BuyerId = @id OR SellerId = @id;
                 DELETE FROM dbo.Properties WHERE OwnerId = @id;
                 DELETE FROM dbo.Users     WHERE Id = @id;`, { id }, tx);
    }
  },

  /* ---------------- favourites (own list only) ---------------- */
  favorite: {
    async create(tx, user, op, ctx) {
      const pid = int(op.data && op.data.propertyId, 'Property', { min: 1 });
      const prop = await getProperty(tx, ctx.rid('property', pid));
      if (!prop) return;
      await run(`IF NOT EXISTS (SELECT 1 FROM dbo.Favorites WHERE UserId = @u AND PropertyId = @p)
                   INSERT INTO dbo.Favorites (UserId, PropertyId) VALUES (@u, @p)`, { u: user.Id, p: prop.Id }, tx);
    },
    async update() { /* nothing to update */ },
    async delete(tx, user, op, ctx) {
      await run('DELETE FROM dbo.Favorites WHERE UserId = @u AND PropertyId = @p',
        { u: user.Id, p: ctx.rid('property', int(op.data && op.data.propertyId, 'Property', { min: 1 })) }, tx);
    }
  },

  /* ---------------- site settings (admin) ---------------- */
  promo: {
    async update(tx, user, op) {
      if (user.Role !== 'admin') throw forbidden('Admin access only.');
      const d = op.data || {};
      const ids = Array.isArray(d.propertyIds) ? d.propertyIds : [];
      if (ids.length > 500) throw bad('Too many properties in the discount list.');
      const value = {
        title: str(d.title, 'Title', { max: 120 }) || 'Special Discount',
        discountPercent: int(d.discountPercent, 'Discount', { min: 1, max: 90 }),
        isActive: !!d.isActive,
        propertyIds: ids.map(x => int(x, 'Property id', { min: 1 }))
      };
      await saveSetting(tx, 'promoDeal', value);
    }
  },
  theme: {
    async update(tx, user, op) {
      if (user.Role !== 'admin') throw forbidden('Admin access only.');
      const d = op.data || {};
      const enabled = Array.isArray(d.enabledThemes) ? d.enabledThemes : [];
      if (!enabled.length || enabled.some(t => !ALL_THEMES.includes(t))) throw bad('Select at least one valid theme.');
      await saveSetting(tx, 'themeSettings', { enabledThemes: [...new Set(enabled)], defaultTheme: oneOf(d.defaultTheme, ALL_THEMES, 'Default theme') });
    }
  }
};

async function saveSetting(tx, key, value) {
  await run(`UPDATE dbo.AppSettings SET SettingValue = @v WHERE SettingKey = @k;
             IF @@ROWCOUNT = 0 INSERT INTO dbo.AppSettings (SettingKey, SettingValue) VALUES (@k, @v);`,
    { k: key, v: JSON.stringify(value) }, tx);
}

app.post('/api/sync', requireAuth, wrap(async (req, res) => {
  const ops = req.body && req.body.ops;
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 300) throw bad('Invalid request.');
  const idMap = {};
  const ctx = {
    map(entity, tempId, realId) { (idMap[entity] = idMap[entity] || {})[tempId] = realId; },
    rid(entity, id) { const n = Number(id); return (idMap[entity] && idMap[entity][n]) || n; }
  };
  await withTransaction(async tx => {
    for (const op of ops) {
      const h = op && handlers[op.entity] && handlers[op.entity][op.action];
      if (!h) throw bad('Unknown change request.');
      if (op.action !== 'delete' && (op.data == null || typeof op.data !== 'object')) throw bad('Missing data.');
      if (op.action === 'create' && op.id != null && !isTemp(op.id) && op.entity !== 'favorite') { /* client supplied id is ignored */ }
      await h(tx, req.user, op, ctx);
    }
  });
  res.json({ ok: true, idMap });
}));

/* ===================================================================
   8. ADMIN: RESET DEMO DATA
   =================================================================== */
app.post('/api/admin/reset-demo', requireAuth, requireAdmin, wrap(async (req, res) => {
  if (!ALLOW_DEMO_RESET) throw forbidden('Demo reset is disabled on this server.');
  await resetDemoData();
  res.json(await authPayload(req.user));
}));

/* ===================================================================
   9. STATIC FRONTEND + ERRORS
   =================================================================== */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'The data is too large (try smaller photos).' });
  if (err && (err.number === 2627 || err.number === 2601)) return res.status(409).json({ error: 'That record already exists.' });
  if (err && err.number === 547) return res.status(409).json({ error: 'This record is linked to other data and cannot be changed that way.' });
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

/* ===================================================================
   10. START
   =================================================================== */
(async () => {
  try {
    const pool = await getPool();
    const who = (await pool.request().query('SELECT DB_NAME() AS db, @@VERSION AS v')).recordset[0];
    console.log(`[db] connected to "${who.db}"  (${String(who.v).split('\n')[0]})`);
  } catch (err) {
    console.error('\n[db] COULD NOT CONNECT TO SQL SERVER:', err.message);
    console.error('     Check .env (DB_SERVER, DB_USER, DB_PASSWORD, DB_NAME), that SQL Server is running,');
    console.error('     that TCP/IP is enabled, and that you ran database.sql. (Troubleshooting tips are in the setup steps.)\n');
    process.exit(1);
  }
  app.listen(PORT, () => console.log(`[server] PropDeal running at http://localhost:${PORT}`));
})();
