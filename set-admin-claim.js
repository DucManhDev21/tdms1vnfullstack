require('dotenv').config();
const admin = require('firebase-admin');

function loadServiceAccount() {
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) throw new Error('Thiếu FIREBASE_SERVICE_ACCOUNT_JSON');
  const serviceAccount = JSON.parse(raw);
  serviceAccount.private_key = String(serviceAccount.private_key || '').replace(/\\n/g, '\n');
  return serviceAccount;
}

async function main() {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error('Dùng: npm run set-admin -- admin@email.com');
  const serviceAccount = loadServiceAccount();
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const user = await admin.auth().getUserByEmail(email);
  await admin.auth().setCustomUserClaims(user.uid, { ...(user.customClaims || {}), admin: true, role: 'admin' });
  console.log(`Đã cấp quyền Admin cho ${user.email} (${user.uid}). Đăng xuất/đăng nhập lại để token mới nhận claim.`);
  await admin.app().delete();
}

main().catch(error => { console.error(error.message); process.exit(1); });
