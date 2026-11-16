// seed.js - demo data + admin creation
//   npm run seed                      -> creates demo admin/buyer/seller + 28 listings (only on an empty database)
//   npm run seed -- --force           -> wipes buyers/sellers/listings/etc. and re-creates the demo data
//   node seed.js admin you@mail.com "StrongPass#1" "Your Name"   -> creates a real admin account
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { sql, run, withTransaction, closePool } = require('./db');
const PROPERTIES = require('./seed-data.json');

const THEMES = ['original', 'navy', 'emerald', 'purple', 'terracotta', 'gold', 'dark'];
const DEMO = {
  admin:  { name: 'Demo Admin',  email: 'admin@example.com',  password: 'Admin@1234',  role: 'admin',  age: 35, phone: '03007654321', city: 'Islamabad' },
  buyer:  { name: 'Demo Buyer',  email: 'buyer@example.com',  password: 'Buyer@1234',  role: 'buyer',  age: 28, phone: '03001234567', city: 'Rawalpindi', bmin: 5000000, bmax: 45000000 },
  seller: { name: 'Demo Seller', email: 'seller@example.com', password: 'Seller@1234', role: 'seller', age: 40, phone: '03219876543', city: 'Lahore', agency: 'Demo Realty', exp: 8 }
};

async function insertUser(tx, u, hash) {
  const row = (await run(
    `INSERT INTO dbo.Users (Name, Email, PasswordHash, Role, Age, City, Phone, About, BudgetMin, BudgetMax, AgencyName, ExperienceYears, IsActive)
     OUTPUT INSERTED.Id
     VALUES (@name, @email, @hash, @role, @age, @city, @phone, N'', @bmin, @bmax, @agency, @exp, 1)`,
    { name: u.name, email: u.email, hash, role: u.role, age: u.age, city: u.city || '', phone: u.phone || '',
      bmin: [sql.BigInt, u.bmin ?? null], bmax: [sql.BigInt, u.bmax ?? null], agency: u.agency ?? null, exp: [sql.Int, u.exp ?? null] }, tx))[0];
  if (u.role === 'admin') await run('INSERT INTO dbo.Admin (UserId, AdminLevel) VALUES (@id, N\'super\')', { id: row.Id }, tx);
  return row.Id;
}

/** Re-creates all demo content. Existing admin accounts are kept so nobody gets logged out. */
async function resetDemoData() {
  const [buyerHash, sellerHash] = await Promise.all([bcrypt.hash(DEMO.buyer.password, 12), bcrypt.hash(DEMO.seller.password, 12)]);
  await withTransaction(async tx => {
    await run(`DELETE FROM dbo.Favorites; DELETE FROM dbo.Reviews; DELETE FROM dbo.Deals; DELETE FROM dbo.Meetings;
               DELETE FROM dbo.Properties; DELETE FROM dbo.Announcements; DELETE FROM dbo.AppSettings;
               DELETE FROM dbo.Users WHERE Role <> N'admin';`, {}, tx);

    const buyerId = await insertUser(tx, DEMO.buyer, buyerHash);
    const sellerId = await insertUser(tx, DEMO.seller, sellerHash);

    for (const p of PROPERTIES) {     // keep the original ids (1..28) so promo/deal ids still match
      await run(
        `SET IDENTITY_INSERT dbo.Properties ON;
         INSERT INTO dbo.Properties (Id, OwnerId, Title, Type, Mode, Price, Negotiable, Months, City, Locality, AreaSize, Beds, Baths,
                                     Description, LongDescription, ApprovalStatus, Features, Images, CreatedAt)
         VALUES (@id, @owner, @title, @type, @mode, @price, @neg, @months, @city, @locality, @area, @beds, @baths,
                 @short, @long, @status, @feats, @images, @created);
         SET IDENTITY_INSERT dbo.Properties OFF;`,
        { id: p.id, owner: sellerId, title: p.title, type: p.type, mode: p.mode, price: [sql.BigInt, p.price],
          neg: [sql.Bit, p.neg === true ? 1 : p.neg === false ? 0 : null], months: [sql.Int, p.months ?? null],
          city: p.city, locality: p.locality || '', area: p.area_size || '', beds: [sql.Int, p.beds ?? null], baths: [sql.Int, p.baths ?? null],
          short: p.description || '', long: p.long || '', status: p.approvalStatus || 'approved',
          feats: JSON.stringify(p.feats || []), images: JSON.stringify(p.images || []), created: [sql.DateTime2, new Date(p.createdAt)] }, tx);
    }

    const meet = (pid, date, time, note, months, status) => run(
      `INSERT INTO dbo.Meetings (PropertyId, BuyerId, SellerId, MeetingDate, MeetingTime, Note, Months, Status)
       VALUES (@pid, @b, @s, CAST(@d AS DATE), @t, @n, @m, @st)`,
      { pid, b: buyerId, s: sellerId, d: [sql.VarChar(10), date], t: time, n: note, m: [sql.Int, months], st: status }, tx);
    await meet(1, '2026-11-18', '11:00 AM', 'I would like to visit on this day.', null, 'confirmed');
    await meet(8, '2026-11-20', '03:00 PM', 'Looking to move in next month.', 6, 'pending');

    const deal = (pid, price, stage, notes) => run(
      `INSERT INTO dbo.Deals (PropertyId, BuyerId, SellerId, OfferedPrice, Stage, Notes) VALUES (@pid, @b, @s, @p, @st, @n)`,
      { pid, b: buyerId, s: sellerId, p: [sql.BigInt, price], st: stage, n: notes }, tx);
    await deal(1, 36500000, 'negotiation', 'Buyer visited the house and submitted an offer after viewing.');
    await deal(8, 165000, 'viewing_scheduled', '6-month rental viewing requested.');

    const review = (pid, rating, comment, status) => run(
      `INSERT INTO dbo.Reviews (PropertyId, BuyerId, Rating, Comment, Status) VALUES (@pid, @b, @r, @c, @st)`,
      { pid, b: buyerId, r: rating, c: comment, st: status }, tx);
    await review(1, 5, 'Spacious front lawn, spotless modular kitchen, and very responsive seller during our tour!', 'approved');
    await review(4, 4, 'Great Clifton location with sea view and clean lobby security. Parking bay is convenient.', 'approved');
    await review(11, 5, 'Bright corner penthouse layout and peaceful sector. Highly recommended.', 'approved');
    await review(2, 4, 'High footfall boulevard spot, waiting for document verification details.', 'pending');

    for (const pid of [1, 7, 11]) await run('INSERT INTO dbo.Favorites (UserId, PropertyId) VALUES (@u, @p)', { u: buyerId, p: pid }, tx);

    const msgs = ['🎉 10% off on your first purchase', '⚡ Exclusive offer: limited-time deals on selected properties', '🏡 New listings added every day',
      '🔑 Buy or rent: houses, apartments, shops and plots', '📅 Request a meeting with the seller in one tap', '💬 Many prices are negotiable'];
    for (let i = 0; i < msgs.length; i++) await run('INSERT INTO dbo.Announcements (Message, SortOrder, IsActive) VALUES (@m, @o, 1)', { m: msgs[i], o: i + 1 }, tx);

    const setting = (k, v) => run('INSERT INTO dbo.AppSettings (SettingKey, SettingValue) VALUES (@k, @v)', { k, v: JSON.stringify(v) }, tx);
    await setting('promoDeal', { title: '10% off on first purchase', discountPercent: 10, isActive: true, propertyIds: [1, 4, 11, 14, 17, 22] });
    await setting('themeSettings', { defaultTheme: 'original', enabledThemes: THEMES });
  });
}

async function createAdmin({ name, email, password }) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email.');
  if (!password || password.length < 8) throw new Error('Admin password must be at least 8 characters.');
  const hash = await bcrypt.hash(password, 12);
  return withTransaction(async tx => {
    if ((await run('SELECT 1 AS x FROM dbo.Users WHERE Email = @e', { e: email }, tx)).length) throw new Error('That email already exists.');
    return insertUser(tx, { name: name || 'Administrator', email, role: 'admin', age: null, city: '', phone: '' }, hash);
  });
}

module.exports = { resetDemoData, createAdmin, DEMO };

if (require.main === module) {
  (async () => {
    try {
      const args = process.argv.slice(2);
      if (args[0] === 'admin') {
        const [, email, password, name] = args;
        const id = await createAdmin({ email, password, name });
        console.log(`Admin created (id ${id}): ${email}`);
      } else {
        const count = (await run('SELECT COUNT(*) AS c FROM dbo.Properties'))[0].c + (await run('SELECT COUNT(*) AS c FROM dbo.Users WHERE Role <> N\'admin\''))[0].c;
        if (count > 0 && !args.includes('--force')) {
          console.log('The database already has data. Nothing was changed.\nRun  npm run seed -- --force  to wipe buyers/sellers/listings and re-create the demo data.');
        } else {
          const adminExists = (await run('SELECT 1 AS x FROM dbo.Users WHERE Email = @e', { e: DEMO.admin.email })).length;
          if (!adminExists) {
            await withTransaction(async tx => insertUser(tx, DEMO.admin, await bcrypt.hash(DEMO.admin.password, 12)));
          }
          await resetDemoData();
          console.log('Demo data created.\n  admin@example.com  / Admin@1234\n  buyer@example.com  / Buyer@1234\n  seller@example.com / Seller@1234');
        }
      }
    } catch (err) {
      console.error('Seed failed:', err.message);
      process.exitCode = 1;
    } finally {
      await closePool();
    }
  })();
}
