'use strict';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validateEmail(email) {
  const value = normalizeEmail(email);
  if (!value || value.length > 320 || !EMAIL_RE.test(value)) {
    throw new Error('Gmail/email không hợp lệ. Ví dụ: admin@gmail.com');
  }
  return value;
}

function ownerEmail() {
  return normalizeEmail(process.env.ADMIN_EMAIL || '');
}

async function syncAdminClaim(admin, email, enabled) {
  const normalized = validateEmail(email);
  try {
    const user = await admin.auth().getUserByEmail(normalized);
    const current = user.customClaims && typeof user.customClaims === 'object' ? { ...user.customClaims } : {};
    if (enabled) {
      current.admin = true;
      current.role = 'admin';
    } else {
      delete current.admin;
      if (current.role === 'admin') delete current.role;
    }
    await admin.auth().setCustomUserClaims(user.uid, current);
    return { found: true, uid: user.uid };
  } catch (error) {
    if (error?.code === 'auth/user-not-found') return { found: false };
    console.error('sync admin custom claim:', error?.code || 'unknown', error?.message || error);
    return { found: false, error: error?.message || 'claim sync failed' };
  }
}

async function ensureOwnerAdmin(db, admin) {
  const email = ownerEmail();
  if (!email) {
    throw new Error('ADMIN_EMAIL chưa được cấu hình. Đây là tài khoản chủ hệ thống dùng để bootstrap Admin.');
  }
  validateEmail(email);
  const ref = db.collection('admins').doc(email);
  const snap = await ref.get();
  const base = {
    email,
    active: true,
    owner: true,
    source: 'env_bootstrap',
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  if (!snap.exists) {
    await ref.set({ ...base, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  } else if (snap.data()?.active !== true || snap.data()?.owner !== true) {
    await ref.set(base, { merge: true });
  }
  await syncAdminClaim(admin, email, true);
  return email;
}

async function getAdmin(db, email) {
  const normalized = validateEmail(email);
  const snap = await db.collection('admins').doc(normalized).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  if (data.active !== true) return null;
  return { id: snap.id, ...data, email: normalized };
}

async function isAdmin(db, email) {
  return Boolean(await getAdmin(db, email));
}

async function addAdmin(db, admin, email, actor = {}) {
  const normalized = validateEmail(email);
  const ref = db.collection('admins').doc(normalized);
  const snap = await ref.get();
  if (snap.exists) {
    const current = snap.data() || {};
    if (current.active === true) throw new Error(`Email ${normalized} đã là Admin.`);
    await ref.set({
      email: normalized,
      active: true,
      owner: current.owner === true,
      source: current.source || 'manual',
      reactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } else {
    await ref.set({
      email: normalized,
      active: true,
      owner: normalized === ownerEmail(),
      source: actor.source || 'manual',
      addedBy: actor.email || actor.telegramUserId || 'manual',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }
  const claim = await syncAdminClaim(admin, normalized, true);
  await db.collection('admin_audit_logs').add({
    action: 'add_admin',
    targetEmail: normalized,
    actor: actor.email || actor.telegramUserId || 'manual',
    source: actor.source || 'manual',
    claimSynced: claim.found === true,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return getAdmin(db, normalized);
}

async function deleteAdmin(db, admin, email, actor = {}) {
  const normalized = validateEmail(email);
  if (normalized === ownerEmail()) throw new Error('Không thể xóa Admin chủ hệ thống trong ADMIN_EMAIL.');
  const ref = db.collection('admins').doc(normalized);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Không tìm thấy Admin ${normalized}.`);
  const data = snap.data() || {};
  if (data.active === false) throw new Error(`Admin ${normalized} đã được xóa trước đó.`);
  await ref.set({
    active: false,
    deletedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  const claim = await syncAdminClaim(admin, normalized, false);
  await db.collection('admin_audit_logs').add({
    action: 'delete_admin',
    targetEmail: normalized,
    actor: actor.email || actor.telegramUserId || 'manual',
    source: actor.source || 'manual',
    claimSynced: claim.found === true,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return normalized;
}

async function listAdmins(db) {
  const snap = await db.collection('admins').get();
  return snap.docs
    .map(doc => ({ id: doc.id, ...(doc.data() || {}) }))
    .filter(item => item.active === true)
    .sort((a, b) => String(a.email || '').localeCompare(String(b.email || '')));
}

module.exports = { normalizeEmail, validateEmail, ownerEmail, ensureOwnerAdmin, getAdmin, isAdmin, addAdmin, deleteAdmin, listAdmins, syncAdminClaim };
