import express from 'express';
import {randomBytes} from 'node:crypto';
import {db} from './db.js';
import {isPremium,dropLapsed} from './premium.js';
import {notify} from './notifications.js';
export const communityRouter=express.Router();
const run=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const toId=v=>/^\d{1,9}$/.test(String(v))?Number(v):null;
const accesses=['public','request','private'];
const inviteCode=()=>randomBytes(9).toString('base64url');
// The owner stays internal: the viewer only learns whether they own it. Only the owner sees the invite code and pending requests.
const select=`SELECT c.id,c.name,c.description,c.created_at,c.access,c.premium_only,c.min_posts,(SELECT COUNT(*)::int FROM community_members WHERE community_id=c.id) AS members,(SELECT COUNT(*)::int FROM posts WHERE community_id=c.id) AS posts,(m.user_id IS NOT NULL) AS joined,COALESCE(m.muted,FALSE) AS muted,(c.owner_id=$1) AS is_owner,EXISTS(SELECT 1 FROM community_requests WHERE community_id=c.id AND user_id=$1) AS requested,CASE WHEN c.owner_id=$1 THEN (SELECT COUNT(*)::int FROM community_requests WHERE community_id=c.id) END AS requests,CASE WHEN c.owner_id=$1 THEN c.invite_code END AS invite_code FROM communities c LEFT JOIN community_members m ON m.community_id=c.id AND m.user_id=$1`;
const one=async(viewer,id)=>id&&(await db.query(`${select} WHERE c.id=$2`,[viewer,id])).rows[0];
const stories=n=>n%10===1&&n%100!==11?'сплетни':'сплетен';
// Conditions are checked on entry: premium if required, and at least min_posts stories in the profile.
async function refusal(community,userId){
const user=(await db.query(`SELECT ${isPremium('$1')} AS premium,(SELECT COUNT(*)::int FROM posts WHERE user_id=$1) AS posts`,[userId])).rows[0];
if(community.premium_only&&!user.premium)return 'Вступить можно только с премом';
if(user.posts<community.min_posts)return `Нужно не меньше ${community.min_posts} ${stories(community.min_posts)} в профиле, у тебя ${user.posts}`;
return null;
}
// Settings fall back to the current values; null means they are invalid.
function settings(body,current={access:'public',premium_only:false,min_posts:0}){
const s={access:body.access??current.access,premium_only:body.premium_only??current.premium_only,min_posts:body.min_posts??current.min_posts};
return accesses.includes(s.access)&&typeof s.premium_only==='boolean'&&Number.isInteger(s.min_posts)&&s.min_posts>=0&&s.min_posts<=1000?s:null;
}
const join=(id,userId)=>db.query('WITH r AS (DELETE FROM community_requests WHERE community_id=$1 AND user_id=$2) INSERT INTO community_members(community_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,userId]);
communityRouter.get('/',run(async(req,res)=>{const q=String(req.query.q||'').slice(0,100);res.json((await db.query(`${select} WHERE ($2='' OR c.name ILIKE $3 OR c.description ILIKE $3) AND ($4=FALSE OR m.user_id IS NOT NULL) ORDER BY members DESC,c.id DESC LIMIT 100`,[req.user.id,q,`%${q}%`,req.query.mine==='1'])).rows)}));
communityRouter.get('/:id',run(async(req,res)=>{const c=await one(req.user.id,toId(req.params.id));c?res.json(c):res.status(404).json({error:'Сообщество не найдено'})}));
communityRouter.post('/',run(async(req,res)=>{
if(req.user.role!=='premium')return res.status(403).json({error:'Создавать сообщества можно с премом'});
const name=typeof req.body.name==='string'?req.body.name.trim().replace(/\s+/g,' '):'';const description=typeof req.body.description==='string'?req.body.description.trim():'';const s=settings(req.body);
if(name.length<3||name.length>50||description.length>300)return res.status(400).json({error:'Название — от 3 до 50 символов, описание — до 300'});
if(!s)return res.status(400).json({error:'Проверьте тип сообщества и условия вступления'});
try{
// The creator joins right away, in the same statement.
const id=(await db.query('WITH c AS (INSERT INTO communities(owner_id,name,description,access,premium_only,min_posts,invite_code) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id) INSERT INTO community_members(community_id,user_id) SELECT id,$1 FROM c RETURNING community_id',[req.user.id,name,description,s.access,s.premium_only,s.min_posts,s.access==='public'?null:inviteCode()])).rows[0].community_id;
res.status(201).json(await one(req.user.id,id));
}catch(e){if(e.code==='23505')return res.status(409).json({error:'Сообщество с таким названием уже есть'});throw e}
}));
// Owner tools: description, access and conditions, invites, requests, deletion. After deletion its posts stay in the general feed.
const owned=async(req,res)=>{const id=toId(req.params.id);const c=await one(req.user.id,id);if(!c){res.status(404).json({error:'Сообщество не найдено'});return null}if(!c.is_owner){res.status(403).json({error:'Это может только создатель сообщества'});return null}return c};
communityRouter.patch('/:id',run(async(req,res)=>{
const c=await owned(req,res);if(!c)return;
const description=req.body.description===undefined?c.description:typeof req.body.description==='string'?req.body.description.trim():null;const s=settings(req.body,c);
if(description===null||description.length>300)return res.status(400).json({error:'Описание — до 300 символов'});
if(!s)return res.status(400).json({error:'Проверьте тип сообщества и условия вступления'});
await db.query('UPDATE communities SET description=$2,access=$3,premium_only=$4,min_posts=$5,invite_code=CASE WHEN $3=\'public\' THEN invite_code ELSE COALESCE(invite_code,$6) END WHERE id=$1',[c.id,description,s.access,s.premium_only,s.min_posts,inviteCode()]);
if(s.premium_only)await dropLapsed(c.id);
// Opening the community lets pending requests in.
if(s.access==='public')for(const r of (await db.query('DELETE FROM community_requests WHERE community_id=$1 RETURNING user_id',[c.id])).rows){if(await refusal(s,r.user_id))continue;await join(c.id,r.user_id);await notify(r.user_id,'community_accepted',{community:c.id})}
res.json(await one(req.user.id,c.id));
}));
communityRouter.delete('/:id',run(async(req,res)=>{const c=await owned(req,res);if(!c)return;await db.query('DELETE FROM communities WHERE id=$1',[c.id]);res.json({ok:true})}));
communityRouter.post('/:id/invite',run(async(req,res)=>{const c=await owned(req,res);if(!c)return;if(c.access==='public')return res.status(400).json({error:'В открытое сообщество можно вступить без приглашения'});await db.query('UPDATE communities SET invite_code=$2 WHERE id=$1',[c.id,inviteCode()]);res.json(await one(req.user.id,c.id))}));
communityRouter.get('/:id/requests',run(async(req,res)=>{const c=await owned(req,res);if(!c)return;res.json((await db.query(`SELECT r.id,r.created_at,(SELECT COUNT(*)::int FROM posts WHERE user_id=r.user_id) AS posts,${isPremium('r.user_id')} AS premium FROM community_requests r WHERE r.community_id=$1 ORDER BY r.created_at,r.id`,[c.id])).rows)}));
communityRouter.post('/:id/requests/:request',run(async(req,res)=>{
const c=await owned(req,res);if(!c)return;
if(typeof req.body.accept!=='boolean')return res.status(400).json({error:'Примите или отклоните заявку'});
const r=(await db.query('DELETE FROM community_requests WHERE id=$1 AND community_id=$2 RETURNING user_id',[toId(req.params.request),c.id])).rows[0];
if(!r)return res.status(404).json({error:'Заявка не найдена'});
const reason=req.body.accept&&await refusal(c,r.user_id);
if(req.body.accept&&!reason)await join(c.id,r.user_id);
await notify(r.user_id,req.body.accept&&!reason?'community_accepted':'community_declined',{community:c.id});
if(reason)return res.status(409).json({error:'Пользователь больше не подходит под условия, заявка отклонена'});
res.json(await one(req.user.id,c.id));
}));
// Public communities let anyone in; the others take a request, or an invite code from the owner.
async function enter(req,res,c,code){
if(c.joined)return res.json(c);
const reason=await refusal(c,req.user.id);if(reason)return res.status(403).json({error:reason});
if(c.access==='public'||code){await join(c.id,req.user.id);return res.json(await one(req.user.id,c.id))}
const added=(await db.query('INSERT INTO community_requests(community_id,user_id) SELECT $1,$2 WHERE NOT EXISTS(SELECT 1 FROM community_members WHERE community_id=$1 AND user_id=$2) ON CONFLICT DO NOTHING RETURNING id',[c.id,req.user.id])).rows.length;
if(added)await notify((await db.query('SELECT owner_id FROM communities WHERE id=$1',[c.id])).rows[0].owner_id,'community_request',{community:c.id});
res.json(await one(req.user.id,c.id));
}
communityRouter.post('/:id/join',run(async(req,res)=>{const c=await one(req.user.id,toId(req.params.id));if(!c)return res.status(404).json({error:'Сообщество не найдено'});await enter(req,res,c,false)}));
communityRouter.post('/invite/:code',run(async(req,res)=>{const id=/^[\w-]{12}$/.test(req.params.code)&&(await db.query("SELECT id FROM communities WHERE invite_code=$1 AND access<>'public'",[req.params.code])).rows[0]?.id;const c=await one(req.user.id,id);if(!c)return res.status(404).json({error:'Приглашение недействительно'});await enter(req,res,c,true)}));
// Leaving also withdraws a pending request.
communityRouter.post('/:id/leave',run(async(req,res)=>{const id=toId(req.params.id);if(!await one(req.user.id,id))return res.status(404).json({error:'Сообщество не найдено'});await db.query('DELETE FROM community_members WHERE community_id=$1 AND user_id=$2',[id,req.user.id]);await db.query('DELETE FROM community_requests WHERE community_id=$1 AND user_id=$2',[id,req.user.id]);res.json(await one(req.user.id,id))}));
communityRouter.post('/:id/mute',run(async(req,res)=>{const id=toId(req.params.id);if(typeof req.body.muted!=='boolean')return res.status(400).json({error:'Укажите режим уведомлений'});const r=await db.query('UPDATE community_members SET muted=$3 WHERE community_id=$1 AND user_id=$2 RETURNING muted',[id,req.user.id,req.body.muted]);if(!r.rows.length)return res.status(404).json({error:'Вы не участник сообщества'});res.json(await one(req.user.id,id))}));
