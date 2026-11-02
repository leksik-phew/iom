import express from 'express';
import {db} from './db.js';
export const communityRouter=express.Router();
const run=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const toId=v=>/^\d{1,9}$/.test(String(v))?Number(v):null;
// The owner stays internal: the viewer only learns whether they own it.
const select=`SELECT c.id,c.name,c.description,c.created_at,(SELECT COUNT(*)::int FROM community_members WHERE community_id=c.id) AS members,(SELECT COUNT(*)::int FROM posts WHERE community_id=c.id) AS posts,(m.user_id IS NOT NULL) AS joined,COALESCE(m.muted,FALSE) AS muted,(c.owner_id=$1) AS is_owner FROM communities c LEFT JOIN community_members m ON m.community_id=c.id AND m.user_id=$1`;
const one=async(viewer,id)=>id&&(await db.query(`${select} WHERE c.id=$2`,[viewer,id])).rows[0];
communityRouter.get('/',run(async(req,res)=>{const q=String(req.query.q||'').slice(0,100);res.json((await db.query(`${select} WHERE ($2='' OR c.name ILIKE $3 OR c.description ILIKE $3) AND ($4=FALSE OR m.user_id IS NOT NULL) ORDER BY members DESC,c.id DESC LIMIT 100`,[req.user.id,q,`%${q}%`,req.query.mine==='1'])).rows)}));
communityRouter.get('/:id',run(async(req,res)=>{const c=await one(req.user.id,toId(req.params.id));c?res.json(c):res.status(404).json({error:'Сообщество не найдено'})}));
communityRouter.post('/',run(async(req,res)=>{
if(req.user.role!=='premium')return res.status(403).json({error:'Создавать сообщества можно с премом'});
const name=typeof req.body.name==='string'?req.body.name.trim().replace(/\s+/g,' '):'';const description=typeof req.body.description==='string'?req.body.description.trim():'';
if(name.length<3||name.length>50||description.length>300)return res.status(400).json({error:'Название — от 3 до 50 символов, описание — до 300'});
try{
// The creator joins right away, in the same statement.
const id=(await db.query('WITH c AS (INSERT INTO communities(owner_id,name,description) VALUES($1,$2,$3) RETURNING id) INSERT INTO community_members(community_id,user_id) SELECT id,$1 FROM c RETURNING community_id',[req.user.id,name,description])).rows[0].community_id;
res.status(201).json(await one(req.user.id,id));
}catch(e){if(e.code==='23505')return res.status(409).json({error:'Сообщество с таким названием уже есть'});throw e}
}));
// Owner tools: edit the description or delete the community; its posts then stay in the general feed.
const owned=async(req,res)=>{const id=toId(req.params.id);const c=await one(req.user.id,id);if(!c){res.status(404).json({error:'Сообщество не найдено'});return null}if(!c.is_owner){res.status(403).json({error:'Это может только создатель сообщества'});return null}return id};
communityRouter.patch('/:id',run(async(req,res)=>{const id=await owned(req,res);if(!id)return;const description=typeof req.body.description==='string'?req.body.description.trim():null;if(description===null||description.length>300)return res.status(400).json({error:'Описание — до 300 символов'});await db.query('UPDATE communities SET description=$2 WHERE id=$1',[id,description]);res.json(await one(req.user.id,id))}));
communityRouter.delete('/:id',run(async(req,res)=>{const id=await owned(req,res);if(!id)return;await db.query('DELETE FROM communities WHERE id=$1',[id]);res.json({ok:true})}));
communityRouter.post('/:id/join',run(async(req,res)=>{const id=toId(req.params.id);if(!await one(req.user.id,id))return res.status(404).json({error:'Сообщество не найдено'});await db.query('INSERT INTO community_members(community_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,req.user.id]);res.json(await one(req.user.id,id))}));
communityRouter.post('/:id/leave',run(async(req,res)=>{const id=toId(req.params.id);if(!await one(req.user.id,id))return res.status(404).json({error:'Сообщество не найдено'});await db.query('DELETE FROM community_members WHERE community_id=$1 AND user_id=$2',[id,req.user.id]);res.json(await one(req.user.id,id))}));
communityRouter.post('/:id/mute',run(async(req,res)=>{const id=toId(req.params.id);if(typeof req.body.muted!=='boolean')return res.status(400).json({error:'Укажите режим уведомлений'});const r=await db.query('UPDATE community_members SET muted=$3 WHERE community_id=$1 AND user_id=$2 RETURNING muted',[id,req.user.id,req.body.muted]);if(!r.rows.length)return res.status(404).json({error:'Вы не участник сообщества'});res.json(await one(req.user.id,id))}));
