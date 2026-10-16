require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRES_IN = '7d';
const TRANSFER_FEE = 5;

// قائمة الأدمن
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ---------- قاعدة البيانات ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('supabase')
    ? { rejectUnauthorized: false }
    : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

pool.on('error', (err) => {
  console.error('❌ Unexpected DB error:', err.message);
});

// ---------- Middleware ----------
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '3mb' }));

// منع تسجيل الدخول المتكرر
const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function checkRateLimit(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.start > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, start: now });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_LOGIN_ATTEMPTS;
}

// ---------- إنشاء الجداول ----------
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id              BIGSERIAL PRIMARY KEY,
        member_number   VARCHAR(20) UNIQUE NOT NULL,
        full_name       VARCHAR(120) NOT NULL,
        username        VARCHAR(40) UNIQUE NOT NULL,
        phone           VARCHAR(20),
        password_hash   VARCHAR(200) NOT NULL,
        status          VARCHAR(20) NOT NULL DEFAULT 'active',
        balance_points  BIGINT NOT NULL DEFAULT 0 CHECK (balance_points >= 0),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS national_id VARCHAR(20)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE`);

    // جدول المستندات: قيد UNIQUE على user_id فقط (كل مستخدم له صف واحد)
    await client.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id              BIGSERIAL PRIMARY KEY,
        user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        national_id     VARCHAR(20) NOT NULL,
        full_name_4     VARCHAR(255) NOT NULL,
        date_of_birth   DATE NOT NULL,
        image_data      TEXT,
        status          VARCHAR(20) NOT NULL DEFAULT 'pending',
        reviewed_by     BIGINT REFERENCES users(id),
        reviewed_at     TIMESTAMPTZ,
        rejection_reason TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // إزالة أي قيود قديمة على national_id
    await client.query(`
      ALTER TABLE documents 
      DROP CONSTRAINT IF EXISTS documents_national_id_key
    `);

    // التأكد من وجود قيد UNIQUE على user_id
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint 
          WHERE conname = 'documents_user_id_unique'
        ) THEN
          ALTER TABLE documents ADD CONSTRAINT documents_user_id_unique UNIQUE (user_id);
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id                  BIGSERIAL PRIMARY KEY,
        reference_number    VARCHAR(30) UNIQUE NOT NULL,
        type                VARCHAR(30) NOT NULL,
        status              VARCHAR(20) NOT NULL DEFAULT 'completed',
        amount_points       BIGINT NOT NULL,
        fee_points          BIGINT NOT NULL DEFAULT 0,
        sender_user_id      BIGINT REFERENCES users(id),
        receiver_user_id    BIGINT REFERENCES users(id),
        initiated_by        BIGINT REFERENCES users(id),
        description         TEXT,
        idempotency_key     VARCHAR(64) UNIQUE,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id              BIGSERIAL PRIMARY KEY,
        actor_user_id   BIGINT REFERENCES users(id),
        action          VARCHAR(50) NOT NULL,
        target_user_id  BIGINT REFERENCES users(id),
        metadata        JSONB,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_member_number ON users(member_number)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tx_sender ON transactions(sender_user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tx_receiver ON transactions(receiver_user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_user_id)`);

    if (ADMIN_USERNAMES.length > 0) {
      await client.query(
        `UPDATE users SET is_admin = TRUE WHERE username = ANY($1::text[])`,
        [ADMIN_USERNAMES]
      );
    }

    console.log('✅ Tables ready');
    if (ADMIN_USERNAMES.length > 0) {
      console.log('👑 Admins: ' + ADMIN_USERNAMES.join(', '));
    }
  } finally {
    client.release();
  }
}

// ---------- أدوات مساعدة ----------

function generateMemberNumber() {
  const n = Math.floor(10000000 + Math.random() * 90000000);
  return `NQ-${n}`;
}

function generateReference() {
  return 'TX-' + Date.now().toString(36).toUpperCase()
       + crypto.randomBytes(2).toString('hex').toUpperCase();
}

function normalizeMemberNumber(input) {
  if (!input) return null;
  let s = String(input).trim().toUpperCase();
  if (s.startsWith('NQ-')) s = s.substring(3);
  s = s.replace(/[^0-9]/g, '');
  if (s.length === 0) return null;
  return 'NQ-' + s;
}

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

function issueToken(user) {
  return jwt.sign(
    { sub: String(user.id), username: user.username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function publicUser(row) {
  return {
    id: Number(row.id),
    memberNumber: row.member_number,
    fullName: row.full_name,
    username: row.username,
    phone: row.phone,
    status: row.status,
    balancePoints: Number(row.balance_points),
    isAdmin: !!row.is_admin,
    isVerified: !!row.is_verified,
    joinedAt: row.created_at
  };
}

// ---------- Middleware ----------

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ success: false, code: 'NO_TOKEN', message: 'لم يتم توفير رمز الدخول' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch (e) {
    return res.status(401).json({ success: false, code: 'INVALID_TOKEN', message: 'رمز الدخول غير صالح' });
  }
}

async function adminRequired(req, res, next) {
  try {
    const r = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.userId]);
    if (r.rowCount === 0 || !r.rows[0].is_admin) {
      return res.status(403).json({ success: false, code: 'ADMIN_ONLY', message: 'مخصص للمشرفين فقط' });
    }
    next();
  } catch (e) { next(e); }
}

// ---------- الصفحة الرئيسية ----------

app.get('/', async (req, res) => {
  let userCount = 0, txCount = 0, dbStatus = 'unknown';
  try {
    const r1 = await pool.query('SELECT COUNT(*) AS c FROM users');
    userCount = Number(r1.rows[0].c);
    const r2 = await pool.query('SELECT COUNT(*) AS c FROM transactions');
    txCount = Number(r2.rows[0].c);
    dbStatus = 'connected';
  } catch (e) { dbStatus = 'error: ' + e.message; }

  res.send(`
    <!DOCTYPE html>
    <html dir="rtl" lang="ar">
    <head>
      <meta charset="utf-8"><title>NOQAT API</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body{font-family:-apple-system,sans-serif;background:#102C27;color:#E0F3EB;padding:40px;max-width:600px;margin:0 auto;line-height:1.8}
        h1{color:#fff} code{background:#146752;padding:3px 8px;border-radius:6px}
        .card{background:#146752;padding:20px;border-radius:12px;margin-top:20px}
        .ok{color:#A8E6CF}.err{color:#FFB4B4}
      </style>
    </head>
    <body>
      <h1>NOQAT API ✓</h1>
      <div class="card">
        <p><strong>المستخدمون:</strong> ${userCount}</p>
        <p><strong>المعاملات:</strong> ${txCount}</p>
        <p><strong>قاعدة البيانات:</strong> <span class="${dbStatus === 'connected' ? 'ok' : 'err'}">${dbStatus}</span></p>
        <p><strong>عدد الأدمن:</strong> ${ADMIN_USERNAMES.length}</p>
      </div>
    </body></html>
  `);
});

app.get('/health', async (req, res) => {
  try {
    const r = await pool.query('SELECT COUNT(*) AS c FROM users');
    res.json({ status: 'ok', usersCount: Number(r.rows[0].c), db: 'connected' });
  } catch (e) {
    res.status(500).json({ status: 'error', db: e.message });
  }
});

// ---------- المصادقة ----------

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const { fullName, username, phone, password } = req.body || {};
    if (!fullName || !username || !password) {
      return res.status(400).json({ success: false, code: 'MISSING_FIELDS', message: 'الاسم واسم المستخدم وكلمة المرور مطلوبة' });
    }
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({ success: false, code: 'INVALID_USERNAME', message: 'اسم المستخدم غير صالح' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, code: 'WEAK_PASSWORD', message: 'كلمة المرور قصيرة جدًا' });
    }
    const exists = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (exists.rowCount > 0) {
      return res.status(409).json({ success: false, code: 'USERNAME_TAKEN', message: 'اسم المستخدم مستخدم مسبقًا' });
    }
    const passwordHash = await bcrypt.hash(password, 10);

    let inserted = null, attempts = 0;
    while (attempts < 5) {
      const memberNumber = generateMemberNumber();
      try {
        const result = await pool.query(
          `INSERT INTO users (member_number, full_name, username, phone, password_hash)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [memberNumber, fullName.trim(), username.trim(), phone || null, passwordHash]
        );
        inserted = result.rows[0];
        break;
      } catch (e) {
        if (e.code === '23505' && e.constraint && e.constraint.includes('member_number')) {
          attempts++; continue;
        }
        throw e;
      }
    }
    if (!inserted) {
      return res.status(500).json({ success: false, code: 'MEMBER_NUMBER_COLLISION', message: 'تعذر إنشاء رقم عضوية' });
    }

    if (ADMIN_USERNAMES.includes(inserted.username)) {
      await pool.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [inserted.id]);
      inserted.is_admin = true;
    }

    const token = issueToken(inserted);
    res.status(201).json({ success: true, data: { token, user: publicUser(inserted) } });
  } catch (e) { next(e); }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, code: 'MISSING_FIELDS', message: 'اسم المستخدم وكلمة المرور مطلوبان' });
    }

    const key = String(username).toLowerCase();
    if (!checkRateLimit(key)) {
      return res.status(429).json({ success: false, code: 'TOO_MANY_ATTEMPTS', message: 'محاولات كثيرة. حاول لاحقًا' });
    }

    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rowCount === 0) {
      return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', message: 'بيانات الدخول غير صحيحة' });
    }
    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', message: 'بيانات الدخول غير صحيحة' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ success: false, code: 'ACCOUNT_NOT_ACTIVE', message: 'الحساب غير نشط' });
    }
    loginAttempts.delete(key);

    const token = issueToken(user);
    res.json({ success: true, data: { token, user: publicUser(user) } });
  } catch (e) { next(e); }
});

// ---------- تغيير كلمة المرور ----------

app.post('/api/account/change-password', authRequired, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ 
        success: false, 
        code: 'MISSING_FIELDS', 
        message: 'كلمة المرور الحالية والجديدة مطلوبتان' 
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ 
        success: false, 
        code: 'WEAK_PASSWORD', 
        message: 'كلمة المرور الجديدة قصيرة جدًا (6 أحرف على الأقل)' 
      });
    }

    const userR = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
    if (userR.rowCount === 0) {
      return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: 'المستخدم غير موجود' });
    }

    const ok = await bcrypt.compare(currentPassword, userR.rows[0].password_hash);
    if (!ok) {
      return res.status(401).json({ 
        success: false, 
        code: 'INVALID_PASSWORD', 
        message: 'كلمة المرور الحالية غير صحيحة' 
      });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newHash, req.userId]
    );

    await pool.query(
      `INSERT INTO audit_logs (actor_user_id, action, metadata)
       VALUES ($1, 'change_password', $2)`,
      [req.userId, JSON.stringify({ via: 'app' })]
    );

    res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح' });
  } catch (e) { next(e); }
});

// ---------- الحساب ----------

app.get('/api/account/me', authRequired, async (req, res, next) => {
  try {
    const r = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (r.rowCount === 0) {
      return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: 'المستخدم غير موجود' });
    }
    res.json({ success: true, data: publicUser(r.rows[0]) });
  } catch (e) { next(e); }
});

app.get('/api/account/balance', authRequired, async (req, res, next) => {
  try {
    const r = await pool.query('SELECT balance_points FROM users WHERE id = $1', [req.userId]);
    if (r.rowCount === 0) {
      return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: 'المستخدم غير موجود' });
    }
    res.json({ success: true, data: { balancePoints: Number(r.rows[0].balance_points) } });
  } catch (e) { next(e); }
});

// ---------- البحث عن مستخدم ----------

app.get('/api/users/lookup', authRequired, async (req, res, next) => {
  try {
    const raw = req.query.memberNumber;
    const memberNumber = normalizeMemberNumber(raw);
    if (!memberNumber) {
      return res.status(400).json({ success: false, code: 'INVALID_MEMBER_NUMBER', message: 'رقم العضوية غير صالح' });
    }

    const r = await pool.query(
      'SELECT id, full_name, member_number, is_verified, status FROM users WHERE member_number = $1',
      [memberNumber]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: 'المستخدم غير موجود' });
    }
    const user = r.rows[0];
    res.json({
      success: true,
      data: {
        memberNumber: user.member_number,
        name: user.full_name,
        isVerified: !!user.is_verified,
        isActive: user.status === 'active'
      }
    });
  } catch (e) { next(e); }
});

// ---------- معاينة التحويل ----------

app.post('/api/transfers/preview', authRequired, async (req, res, next) => {
  try {
    const { receiverMemberNumber, amountPoints } = req.body || {};
    const memberNumber = normalizeMemberNumber(receiverMemberNumber);
    const amount = parsePositiveInt(amountPoints);

    if (!memberNumber) {
      return res.status(400).json({ success: false, code: 'INVALID_MEMBER_NUMBER', message: 'رقم العضوية غير صالح' });
    }
    if (!amount) {
      return res.status(400).json({ success: false, code: 'INVALID_AMOUNT', message: 'المبلغ يجب أن يكون عددًا صحيحًا أكبر من صفر' });
    }

    const senderR = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (senderR.rowCount === 0) {
      return res.status(404).json({ success: false, code: 'SENDER_NOT_FOUND', message: 'حسابك غير موجود' });
    }
    const sender = senderR.rows[0];

    const recR = await pool.query('SELECT * FROM users WHERE member_number = $1', [memberNumber]);
    if (recR.rowCount === 0) {
      return res.status(404).json({ success: false, code: 'RECEIVER_NOT_FOUND', message: 'المستلم غير موجود' });
    }
    const receiver = recR.rows[0];

    if (receiver.id === sender.id) {
      return res.status(400).json({ success: false, code: 'SELF_TRANSFER', message: 'لا يمكن التحويل لنفسك' });
    }

    const total = amount + TRANSFER_FEE;
    const sufficient = Number(sender.balance_points) >= total;
    const senderVerified = !!sender.is_verified;
    const receiverVerified = !!receiver.is_verified;
    const receiverActive = receiver.status === 'active';

    res.json({
      success: true,
      data: {
        receiverName: receiver.full_name,
        receiverMemberNumber: receiver.member_number,
        receiverVerified,
        receiverActive,
        amount,
        fee: TRANSFER_FEE,
        totalDebit: total,
        currentBalance: Number(sender.balance_points),
        newBalance: sufficient ? Number(sender.balance_points) - total : Number(sender.balance_points),
        canProceed: senderVerified && receiverVerified && receiverActive && sufficient
      }
    });
  } catch (e) { next(e); }
});

// ---------- التحويلات ----------

app.post('/api/transfers', authRequired, async (req, res, next) => {
  const { receiverMemberNumber, amountPoints, note, idempotencyKey } = req.body || {};

  const memberNumber = normalizeMemberNumber(receiverMemberNumber);
  const amount = parsePositiveInt(amountPoints);

  if (!memberNumber) {
    return res.status(400).json({ success: false, code: 'INVALID_MEMBER_NUMBER', message: 'رقم العضوية غير صالح' });
  }
  if (!amount) {
    return res.status(400).json({ success: false, code: 'INVALID_AMOUNT', message: 'المبلغ يجب أن يكون عددًا صحيحًا أكبر من صفر' });
  }
  if (idempotencyKey && String(idempotencyKey).length > 64) {
    return res.status(400).json({ success: false, code: 'INVALID_IDEMPOTENCY', message: 'مفتاح منع التكرار طويل جدًا' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const senderR = await client.query(
      'SELECT * FROM users WHERE id = $1 FOR UPDATE',
      [req.userId]
    );
    if (senderR.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, code: 'SENDER_NOT_FOUND', message: 'حساب المرسل غير موجود' });
    }
    const sender = senderR.rows[0];

    if (!sender.is_verified) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, code: 'NOT_VERIFIED', message: 'يجب توثيق حسابك قبل التحويل' });
    }

    if (sender.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, code: 'ACCOUNT_NOT_ACTIVE', message: 'حسابك غير نشط' });
    }

    if (idempotencyKey) {
      const dup = await client.query(
        'SELECT * FROM transactions WHERE idempotency_key = $1',
        [idempotencyKey]
      );
      if (dup.rowCount > 0) {
        const existing = dup.rows[0];
        await client.query('ROLLBACK');
        return res.json({
          success: true,
          data: {
            referenceNumber: existing.reference_number,
            amount: Number(existing.amount_points),
            fee: Number(existing.fee_points),
            totalDebited: Number(existing.amount_points) + Number(existing.fee_points),
            newBalance: Number(sender.balance_points),
            duplicate: true
          }
        });
      }
    }

    const recR = await client.query(
      'SELECT * FROM users WHERE member_number = $1 FOR UPDATE',
      [memberNumber]
    );
    if (recR.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, code: 'RECEIVER_NOT_FOUND', message: 'المستلم غير موجود' });
    }
    const receiver = recR.rows[0];

    if (receiver.id === sender.id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, code: 'SELF_TRANSFER', message: 'لا يمكن التحويل لنفسك' });
    }
    if (receiver.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, code: 'RECEIVER_NOT_ACTIVE', message: 'حساب المستلم غير نشط' });
    }
    if (!receiver.is_verified) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, code: 'RECEIVER_NOT_VERIFIED', message: 'المستلم غير موثّق' });
    }

    const total = amount + TRANSFER_FEE;
    if (Number(sender.balance_points) < total) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        code: 'INSUFFICIENT_BALANCE',
        message: `رصيدك غير كافٍ. المطلوب: ${total} (${amount} + ${TRANSFER_FEE} رسوم)`
      });
    }

    await client.query(
      'UPDATE users SET balance_points = balance_points - $1, updated_at = NOW() WHERE id = $2',
      [total, sender.id]
    );
    await client.query(
      'UPDATE users SET balance_points = balance_points + $1, updated_at = NOW() WHERE id = $2',
      [amount, receiver.id]
    );

    const ref = generateReference();
    await client.query(
      `INSERT INTO transactions
       (reference_number, type, amount_points, fee_points,
        sender_user_id, receiver_user_id, initiated_by, description, idempotency_key)
       VALUES ($1, 'transfer', $2, $3, $4, $5, $6, $7, $8)`,
      [ref, amount, TRANSFER_FEE, sender.id, receiver.id, sender.id, note || null, idempotencyKey || null]
    );

    await client.query('COMMIT');

    const newBalance = Number(sender.balance_points) - total;
    res.json({
      success: true,
      data: {
        referenceNumber: ref,
        amount,
        fee: TRANSFER_FEE,
        totalDebited: total,
        newBalance,
        receiverName: receiver.full_name,
        receiverMemberNumber: receiver.member_number
      }
    });
  } catch (e) {
    await client.query('ROLLBACK');
    next(e);
  } finally {
    client.release();
  }
});

// ---------- سجل العمليات ----------

app.get('/api/transactions', authRequired, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const r = await pool.query(
      `SELECT t.*,
              s.full_name AS sender_name, s.member_number AS sender_member,
              r.full_name AS receiver_name, r.member_number AS receiver_member
       FROM transactions t
       LEFT JOIN users s ON s.id = t.sender_user_id
       LEFT JOIN users r ON r.id = t.receiver_user_id
       WHERE t.sender_user_id = $1 OR t.receiver_user_id = $1
       ORDER BY t.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.userId, limit, offset]
    );

    const items = r.rows.map(row => {
      const isSender = Number(row.sender_user_id) === Number(req.userId);
      const incoming = Number(row.receiver_user_id) === Number(req.userId);
      return {
        id: Number(row.id),
        referenceNumber: row.reference_number,
        type: row.type,
        status: row.status,
        amountPoints: Number(row.amount_points),
        feePoints: Number(row.fee_points),
        direction: incoming ? 'in' : (isSender ? 'out' : 'other'),
        description: row.description,
        counterparty: incoming
          ? { name: row.sender_name, memberNumber: row.sender_member }
          : (isSender ? { name: row.receiver_name, memberNumber: row.receiver_member } : null),
        createdAt: row.created_at
      };
    });

    res.json({ success: true, data: { items, limit, offset } });
  } catch (e) { next(e); }
});

app.get('/api/transactions/:id', authRequired, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, code: 'INVALID_ID', message: 'معرف غير صالح' });
    }

    const r = await pool.query(
      `SELECT t.*,
              s.full_name AS sender_name, s.member_number AS sender_member,
              r.full_name AS receiver_name, r.member_number AS receiver_member
       FROM transactions t
       LEFT JOIN users s ON s.id = t.sender_user_id
       LEFT JOIN users r ON r.id = t.receiver_user_id
       WHERE t.id = $1 AND (t.sender_user_id = $2 OR t.receiver_user_id = $2)`,
      [id, req.userId]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ success: false, code: 'TX_NOT_FOUND', message: 'العملية غير موجودة' });
    }
    res.json({ success: true, data: r.rows[0] });
  } catch (e) { next(e); }
});

// ==========================================
// مسارات التوثيق
// ==========================================

// رفع مستند التوثيق
app.post('/api/documents/upload', authRequired, async (req, res, next) => {
  const { nationalId, fullName4, dateOfBirth, imageBase64 } = req.body || {};

  if (!nationalId || !fullName4 || !dateOfBirth || !imageBase64) {
    return res.status(400).json({ 
      success: false, 
      code: 'MISSING_FIELDS', 
      message: 'جميع الحقول مطلوبة (الرقم الوطني، الاسم، تاريخ الميلاد، الصورة)' 
    });
  }

  const cleanId = String(nationalId).replace(/\D/g, '');
  if (cleanId.length !== 11) {
    return res.status(400).json({ 
      success: false, 
      code: 'INVALID_NATIONAL_ID', 
      message: 'الرقم الوطني يجب أن يتكون من 11 رقمًا' 
    });
  }

  if (imageBase64.length > 2 * 1024 * 1024) {
    return res.status(413).json({ 
      success: false, 
      code: 'IMAGE_TOO_LARGE', 
      message: 'حجم الصورة كبير جدًا' 
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. تحقق إذا كان المستخدم موثقاً بالفعل
    const userCheck = await client.query(
      'SELECT is_verified FROM users WHERE id = $1 FOR UPDATE',
      [req.userId]
    );

    if (userCheck.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ 
        success: false, 
        code: 'USER_NOT_FOUND', 
        message: 'المستخدم غير موجود' 
      });
    }

    if (userCheck.rows[0].is_verified) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false, 
        code: 'ALREADY_VERIFIED', 
        message: 'حسابك موثق بالفعل. لا يمكنك إرسال طلب جديد.' 
      });
    }

    // 2. ابحث عن أي طلب سابق لهذا المستخدم
    const existing = await client.query(
      'SELECT id, status FROM documents WHERE user_id = $1 FOR UPDATE',
      [req.userId]
    );

    if (existing.rowCount > 0) {
      // المستخدم لديه طلب سابق (pending أو rejected) → نحدّثه
      const doc = existing.rows[0];
      
      await client.query(
        `UPDATE documents 
         SET national_id = $1, 
             full_name_4 = $2, 
             date_of_birth = $3, 
             image_data = $4, 
             status = 'pending', 
             rejection_reason = NULL, 
             reviewed_at = NULL,
             reviewed_by = NULL,
             created_at = NOW()
         WHERE id = $5`,
        [cleanId, fullName4, dateOfBirth, imageBase64, doc.id]
      );
    } else {
      // أول طلب للمستخدم
      await client.query(
        `INSERT INTO documents (user_id, national_id, full_name_4, date_of_birth, image_data, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [req.userId, cleanId, fullName4, dateOfBirth, imageBase64]
      );
    }

    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action, metadata)
       VALUES ($1, 'document_upload', $2)`,
      [req.userId, JSON.stringify({ nationalId: cleanId })]
    );

    await client.query('COMMIT');

    res.json({ 
      success: true, 
      message: 'تم إرسال مستند التوثيق بنجاح، وهو الآن قيد المراجعة' 
    });

  } catch (e) {
    await client.query('ROLLBACK');
    next(e);
  } finally {
    client.release();
  }
});

// جلب حالة التوثيق للمستخدم الحالي
app.get('/api/documents/status', authRequired, async (req, res, next) => {
  try {
    const r = await pool.query(
      'SELECT status, rejection_reason, created_at FROM documents WHERE user_id = $1',
      [req.userId]
    );

    if (r.rowCount === 0) {
      return res.json({ success: true, data: null });
    }

    const doc = r.rows[0];
    res.json({
      success: true,
      data: {
        status: doc.status,
        rejectionReason: doc.rejection_reason,
        submittedAt: doc.created_at
      }
    });
  } catch (e) {
    next(e);
  }
});

// ==========================================
// مسارات الأدمن - التوثيق
// ==========================================

// عرض الطلبات المعلقة
app.get('/api/admin/documents/pending', authRequired, adminRequired, async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT d.id, d.national_id, d.full_name_4, d.date_of_birth, d.image_data, d.created_at,
              u.username, u.member_number, u.full_name, u.id AS user_id
       FROM documents d
       JOIN users u ON u.id = d.user_id
       WHERE d.status = 'pending'
       ORDER BY d.created_at ASC`
    );
    res.json({ success: true, data: r.rows });
  } catch (e) {
    next(e);
  }
});

// قبول التوثيق
app.post('/api/admin/documents/:id/approve', authRequired, adminRequired, async (req, res, next) => {
  const docId = parseInt(req.params.id, 10);
  if (!Number.isFinite(docId)) {
    return res.status(400).json({ success: false, code: 'INVALID_ID', message: 'معرف غير صالح' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const docR = await client.query(
      'SELECT * FROM documents WHERE id = $1 AND status = $2 FOR UPDATE',
      [docId, 'pending']
    );

    if (docR.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, code: 'DOC_NOT_FOUND', message: 'المستند غير موجود أو تمت مراجعته' });
    }

    const doc = docR.rows[0];

    await client.query(
      'UPDATE documents SET status = $1, reviewed_by = $2, reviewed_at = NOW() WHERE id = $3',
      ['approved', req.userId, docId]
    );

    await client.query(
      `UPDATE users 
       SET is_verified = TRUE, national_id = $1, date_of_birth = $2, updated_at = NOW()
       WHERE id = $3`,
      [doc.national_id, doc.date_of_birth, doc.user_id]
    );

    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action, target_user_id, metadata)
       VALUES ($1, 'document_approve', $2, $3)`,
      [req.userId, doc.user_id, JSON.stringify({ documentId: docId })]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'تم توثيق المستخدم بنجاح' });

  } catch (e) {
    await client.query('ROLLBACK');
    next(e);
  } finally {
    client.release();
  }
});

// رفض التوثيق
app.post('/api/admin/documents/:id/reject', authRequired, adminRequired, async (req, res, next) => {
  const docId = parseInt(req.params.id, 10);
  const { reason } = req.body || {};

  if (!Number.isFinite(docId)) {
    return res.status(400).json({ success: false, code: 'INVALID_ID', message: 'معرف غير صالح' });
  }
  if (!reason || reason.trim().length === 0) {
    return res.status(400).json({ success: false, code: 'MISSING_REASON', message: 'سبب الرفض مطلوب' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const docR = await client.query(
      'SELECT * FROM documents WHERE id = $1 AND status = $2 FOR UPDATE',
      [docId, 'pending']
    );

    if (docR.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, code: 'DOC_NOT_FOUND', message: 'المستند غير موجود أو تمت مراجعته' });
    }

    const doc = docR.rows[0];

    await client.query(
      'UPDATE documents SET status = $1, reviewed_by = $2, reviewed_at = NOW(), rejection_reason = $3 WHERE id = $4',
      ['rejected', req.userId, reason.trim(), docId]
    );

    await client.query(
      'UPDATE users SET is_verified = FALSE, updated_at = NOW() WHERE id = $1',
      [doc.user_id]
    );

    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action, target_user_id, metadata)
       VALUES ($1, 'document_reject', $2, $3)`,
      [req.userId, doc.user_id, JSON.stringify({ documentId: docId, reason: reason.trim() })]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'تم رفض المستند' });

  } catch (e) {
    await client.query('ROLLBACK');
    next(e);
  } finally {
    client.release();
  }
});

// ✅ إلغاء توثيق مستخدم (من الإدارة) - يسمح له بإرسال طلب جديد
app.post('/api/admin/users/:id/unverify', authRequired, adminRequired, async (req, res, next) => {
  const userId = parseInt(req.params.id, 10);
  if (!Number.isFinite(userId)) {
    return res.status(400).json({ success: false, code: 'INVALID_ID', message: 'معرف غير صالح' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userR = await client.query(
      'SELECT id, is_verified, username FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );

    if (userR.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: 'المستخدم غير موجود' });
    }

    // إلغاء التوثيق
    await client.query(
      'UPDATE users SET is_verified = FALSE, national_id = NULL, date_of_birth = NULL, updated_at = NOW() WHERE id = $1',
      [userId]
    );

    // حذف سجل المستند ليتمكن من إرسال طلب جديد
    await client.query('DELETE FROM documents WHERE user_id = $1', [userId]);

    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action, target_user_id, metadata)
       VALUES ($1, 'admin_unverify', $2, $3)`,
      [req.userId, userId, JSON.stringify({ via: 'admin' })]
    );

    await client.query('COMMIT');

    res.json({ 
      success: true, 
      message: 'تم إلغاء توثيق المستخدم بنجاح. يمكنه الآن إرسال طلب توثيق جديد.' 
    });

  } catch (e) {
    await client.query('ROLLBACK');
    next(e);
  } finally {
    client.release();
  }
});

// ---------- الأدمن: الشحن والخصم ----------

app.post('/api/admin/credit', authRequired, adminRequired, async (req, res, next) => {
  const { memberNumber, amountPoints, reason } = req.body || {};
  const normalized = normalizeMemberNumber(memberNumber);
  const amount = parsePositiveInt(amountPoints);

  if (!normalized || !amount) {
    return res.status(400).json({ success: false, code: 'INVALID_INPUT', message: 'رقم العضوية والمبلغ الصحيح مطلوبان' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const uR = await client.query(
      'SELECT * FROM users WHERE member_number = $1 FOR UPDATE',
      [normalized]
    );
    if (uR.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: 'المستخدم غير موجود' });
    }
    const target = uR.rows[0];

    await client.query(
      'UPDATE users SET balance_points = balance_points + $1, updated_at = NOW() WHERE id = $2',
      [amount, target.id]
    );

    const ref = generateReference();
    await client.query(
      `INSERT INTO transactions
       (reference_number, type, amount_points, fee_points,
        receiver_user_id, initiated_by, description)
       VALUES ($1, 'admin_credit', $2, 0, $3, $4, $5)`,
      [ref, amount, target.id, req.userId, reason || 'شحن من الإدارة']
    );

    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action, target_user_id, metadata)
       VALUES ($1, 'credit', $2, $3)`,
      [req.userId, target.id, JSON.stringify({ amount, reason })]
    );

    await client.query('COMMIT');

    const newBalance = Number(target.balance_points) + amount;
    res.json({
      success: true,
      data: {
        referenceNumber: ref,
        targetMemberNumber: target.member_number,
        targetName: target.full_name,
        amount,
        newBalance
      }
    });
  } catch (e) {
    await client.query('ROLLBACK');
    next(e);
  } finally {
    client.release();
  }
});

app.post('/api/admin/debit', authRequired, adminRequired, async (req, res, next) => {
  const { memberNumber, amountPoints, reason } = req.body || {};
  const normalized = normalizeMemberNumber(memberNumber);
  const amount = parsePositiveInt(amountPoints);

  if (!normalized || !amount) {
    return res.status(400).json({ success: false, code: 'INVALID_INPUT', message: 'رقم العضوية والمبلغ الصحيح مطلوبان' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const uR = await client.query(
      'SELECT * FROM users WHERE member_number = $1 FOR UPDATE',
      [normalized]
    );
    if (uR.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: 'المستخدم غير موجود' });
    }
    const target = uR.rows[0];

    if (Number(target.balance_points) < amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        code: 'INSUFFICIENT_BALANCE',
        message: 'رصيد المستخدم أقل من المبلغ المطلوب خصمه'
      });
    }

    await client.query(
      'UPDATE users SET balance_points = balance_points - $1, updated_at = NOW() WHERE id = $2',
      [amount, target.id]
    );

    const ref = generateReference();
    await client.query(
      `INSERT INTO transactions
       (reference_number, type, amount_points, fee_points,
        sender_user_id, initiated_by, description)
       VALUES ($1, 'admin_debit', $2, 0, $3, $4, $5)`,
      [ref, amount, target.id, req.userId, reason || 'خصم إداري']
    );

    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action, target_user_id, metadata)
       VALUES ($1, 'debit', $2, $3)`,
      [req.userId, target.id, JSON.stringify({ amount, reason })]
    );

    await client.query('COMMIT');

    const newBalance = Number(target.balance_points) - amount;
    res.json({
      success: true,
      data: {
        referenceNumber: ref,
        targetMemberNumber: target.member_number,
        targetName: target.full_name,
        amount,
        newBalance
      }
    });
  } catch (e) {
    await client.query('ROLLBACK');
    next(e);
  } finally {
    client.release();
  }
});

// ---------- الأدمن: إدارة الأعضاء ----------

app.post('/api/admin/users/:id/suspend', authRequired, adminRequired, async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (Number(userId) === Number(req.userId)) {
      return res.status(400).json({ success: false, code: 'SELF_SUSPEND', message: 'لا يمكنك تجميد حسابك' });
    }
    const r = await pool.query(
      'UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      ['suspended', userId]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: 'المستخدم غير موجود' });
    }
    await pool.query(
      `INSERT INTO audit_logs (actor_user_id, action, target_user_id) VALUES ($1, 'suspend', $2)`,
      [req.userId, userId]
    );
    res.json({ success: true, data: publicUser(r.rows[0]) });
  } catch (e) { next(e); }
});

app.post('/api/admin/users/:id/reactivate', authRequired, adminRequired, async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const r = await pool.query(
      'UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      ['active', userId]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: 'المستخدم غير موجود' });
    }
    await pool.query(
      `INSERT INTO audit_logs (actor_user_id, action, target_user_id) VALUES ($1, 'reactivate', $2)`,
      [req.userId, userId]
    );
    res.json({ success: true, data: publicUser(r.rows[0]) });
  } catch (e) { next(e); }
});

app.post('/api/admin/users/:id/delete', authRequired, adminRequired, async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (Number(userId) === Number(req.userId)) {
      return res.status(400).json({ success: false, code: 'SELF_DELETE', message: 'لا يمكنك حذف حسابك' });
    }
    const r = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id, username', [userId]);
    if (r.rowCount === 0) {
      return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: 'المستخدم غير موجود' });
    }
    await pool.query(
      `INSERT INTO audit_logs (actor_user_id, action, target_user_id) VALUES ($1, 'delete', $2)`,
      [req.userId, userId]
    );
    res.json({ success: true, data: { deleted: userId, username: r.rows[0].username } });
  } catch (e) { next(e); }
});

app.get('/api/admin/users', authRequired, adminRequired, async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    let r;
    if (q) {
      const normalized = normalizeMemberNumber(q);
      if (normalized) {
        r = await pool.query(
          `SELECT * FROM users
           WHERE member_number = $1 OR username ILIKE $2 OR full_name ILIKE $2
           ORDER BY id DESC LIMIT 50`,
          [normalized, '%' + q + '%']
        );
      } else {
        r = await pool.query(
          `SELECT * FROM users
           WHERE username ILIKE $1 OR member_number ILIKE $1 OR full_name ILIKE $1
           ORDER BY id DESC LIMIT 50`,
          ['%' + q + '%']
        );
      }
    } else {
      r = await pool.query('SELECT * FROM users ORDER BY id DESC LIMIT 50');
    }
    res.json({ success: true, data: r.rows.map(publicUser) });
  } catch (e) { next(e); }
});

app.get('/api/admin/stats', authRequired, adminRequired, async (req, res, next) => {
  try {
    const usersCount = (await pool.query('SELECT COUNT(*) AS c FROM users')).rows[0].c;
    const verifiedCount = (await pool.query('SELECT COUNT(*) AS c FROM users WHERE is_verified = TRUE')).rows[0].c;
    const txCount = (await pool.query('SELECT COUNT(*) AS c FROM transactions')).rows[0].c;
    const totalBalance = (await pool.query('SELECT COALESCE(SUM(balance_points), 0) AS s FROM users')).rows[0].s;

    res.json({
      success: true,
      data: {
        totalUsers: Number(usersCount),
        verifiedUsers: Number(verifiedCount),
        totalTransactions: Number(txCount),
        totalBalancePoints: Number(totalBalance)
      }
    });
  } catch (e) { next(e); }
});

// ---------- معالجات الأخطاء ----------

app.use((req, res) => {
  res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'المسار غير موجود' });
});

app.use((err, req, res, next) => {
  console.error('❌ Server error:', err.message, err.stack);
  
  // معالجة خطأ تكرار المفتاح
  if (err.code === '23505') {
    return res.status(409).json({ 
      success: false, 
      code: 'DUPLICATE_KEY', 
      message: 'البيانات موجودة مسبقاً' 
    });
  }
  
  res.status(500).json({ success: false, code: 'SERVER_ERROR', message: 'حدث خطأ في الخادم' });
});

// ---------- بدء ----------

(async () => {
  try {
    await initDb();
    console.log('✅ Database connected');
    const server = app.listen(PORT, () => {
      console.log('🚀 NOQAT Server running on port ' + PORT);
    });

    const shutdown = async (signal) => {
      console.log(`\n⏹️  ${signal} received. Shutting down...`);
      server.close(async () => {
        try { await pool.end(); } catch (_) {}
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));
  } catch (e) {
    console.error('❌ Startup failed:', e.message);
    process.exit(1);
  }
})();
