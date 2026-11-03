import {db} from './db.js';
// Until payments exist every user confirms with the same code.
export const premiumCode=process.env.PREMIUM_CODE||'123456';
export const plans={week:{title:'Неделя',interval:'7 days'},month:{title:'Месяц',interval:'1 month'},quarter:{title:'3 месяца',interval:'3 months'},half:{title:'6 месяцев',interval:'6 months'},year:{title:'Год',interval:'1 year'}};
// Premium is valid only before premium_until; the stored role may lag until the next sweep.
export const effectiveRole="(CASE WHEN u.role='premium' AND u.premium_until>NOW() THEN 'premium' ELSE 'default' END)::user_role AS role";
// FOR UPDATE makes parallel purchases extend each other instead of overlapping.
export async function activatePremium(userId,plan){return (await db.query(`WITH cur AS (SELECT id,GREATEST(COALESCE(premium_until,NOW()),NOW()) AS starts_at FROM users WHERE id=$1 AND user_verified=TRUE FOR UPDATE),
u AS (UPDATE users SET role='premium',premium_until=cur.starts_at+$2::interval FROM cur WHERE users.id=cur.id RETURNING users.id,users.role,users.user_verified,users.premium_until,cur.starts_at),
s AS (INSERT INTO subscriptions(user_id,plan,starts_at,ends_at) SELECT id,$3,starts_at,premium_until FROM u)
SELECT id,role,user_verified,premium_until FROM u`,[userId,plans[plan].interval,plan])).rows[0]}
// Premium without an end date (the former free button) is also revoked.
export async function expirePremium(){const n=(await db.query("UPDATE users SET role='default' WHERE role='premium' AND (premium_until IS NULL OR premium_until<=NOW()) RETURNING id")).rows.length;await dropLapsed();return n}
export const isPremium=user=>`EXISTS(SELECT 1 FROM users WHERE id=${user} AND role='premium' AND premium_until>NOW())`;
// Premium-only communities drop members and requests whose premium has ended; they must join again. Owners stay.
export async function dropLapsed(community=null){await db.query(`DELETE FROM community_members m USING communities c WHERE c.id=m.community_id AND c.premium_only AND ($1::int IS NULL OR c.id=$1) AND m.user_id IS DISTINCT FROM c.owner_id AND NOT ${isPremium('m.user_id')}`,[community]);await db.query(`DELETE FROM community_requests r USING communities c WHERE c.id=r.community_id AND c.premium_only AND ($1::int IS NULL OR c.id=$1) AND NOT ${isPremium('r.user_id')}`,[community])}
export async function startPremiumExpiry(ms=60000){await expirePremium();const timer=setInterval(()=>expirePremium().catch(()=>{}),ms);timer.unref()}
