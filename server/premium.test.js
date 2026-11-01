import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
// TEST_DATABASE_URL runs the same checks on a real PostgreSQL pool; it must point to a disposable database.
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL||'';process.env.DATA_DIR='memory://';
const {db,init}=await import('./db.js');
const {plans,activatePremium,expirePremium,effectiveRole}=await import('./premium.js');
const newUser=async(verified=true)=>(await db.query('INSERT INTO users(user_verified) VALUES($1) RETURNING id',[verified])).rows[0].id;
const role=async id=>(await db.query(`SELECT ${effectiveRole} FROM users u WHERE u.id=$1`,[id])).rows[0].role;
const stored=async id=>(await db.query('SELECT role,premium_until FROM users WHERE id=$1',[id])).rows[0];
// Seconds between premium_until and NOW()+interval, so month lengths follow PostgreSQL calendar rules.
const drift=async(id,interval)=>Number((await db.query('SELECT ABS(EXTRACT(EPOCH FROM premium_until-(NOW()+$2::interval))) AS d FROM users WHERE id=$1',[id,interval])).rows[0].d);
before(init);
after(()=>db.end?db.end():db.close());
test('Each plan grants premium for its own term from now',async()=>{
 for(const [plan,{interval}] of Object.entries(plans)){
  const id=await newUser();const user=await activatePremium(id,plan);
  assert.equal(user.role,'premium');assert.ok(await drift(id,interval)<5,plan);
  const sub=(await db.query('SELECT plan,ends_at FROM subscriptions WHERE user_id=$1',[id])).rows;
  assert.equal(sub.length,1);assert.equal(sub[0].plan,plan);assert.equal(sub[0].ends_at.getTime(),user.premium_until.getTime());
 }
});
test('Buying while premium extends the current term',async()=>{
 const id=await newUser();const first=await activatePremium(id,'week');const second=await activatePremium(id,'week');
 assert.equal(second.premium_until-first.premium_until,7*86400000);
 const subs=(await db.query('SELECT starts_at,ends_at FROM subscriptions WHERE user_id=$1 ORDER BY id',[id])).rows;
 assert.equal(subs[1].starts_at.getTime(),subs[0].ends_at.getTime());
});
test('Parallel purchases do not overlap',async()=>{
 const id=await newUser();await Promise.all([activatePremium(id,'week'),activatePremium(id,'week')]);
 assert.ok(await drift(id,'14 days')<5);
});
test('Expired premium is denied immediately and revoked by the sweep',async()=>{
 const expired=await newUser();await activatePremium(expired,'month');
 const active=await newUser();await activatePremium(active,'week');
 await db.query("UPDATE users SET premium_until=NOW()-INTERVAL '1 second' WHERE id=$1",[expired]);
 // Requests use the effective role, so access ends before the stored role is updated.
 assert.equal((await stored(expired)).role,'premium');assert.equal(await role(expired),'default');
 assert.ok(await expirePremium()>=1);
 assert.equal((await stored(expired)).role,'default');assert.ok((await stored(expired)).premium_until,'end date is kept');
 assert.equal((await stored(active)).role,'premium');assert.equal(await role(active),'premium');
 // A new purchase after expiry starts from now, not from the old end date.
 await activatePremium(expired,'week');assert.ok(await drift(expired,'7 days')<5);assert.equal(await role(expired),'premium');
});
test('Premium without an end date is revoked',async()=>{
 const id=await newUser();await db.query("UPDATE users SET role='premium' WHERE id=$1",[id]);
 assert.equal(await role(id),'default');await expirePremium();assert.equal((await stored(id)).role,'default');
});
test('Unverified accounts cannot get premium',async()=>{
 const id=await newUser(false);assert.equal(await activatePremium(id,'year'),undefined);
 assert.equal((await stored(id)).role,'default');
 assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM subscriptions WHERE user_id=$1',[id])).rows[0].n,0);
});
