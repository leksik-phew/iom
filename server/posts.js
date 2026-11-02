import express from 'express';
import {db} from './db.js';
import {notify,notifyCommunity} from './notifications.js';
import {recommendCtes,recommendScore} from './recommend.js';
export const postsRouter=express.Router();
export const commentsRouter=express.Router();
const run=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const topics=['Жизнь','Город','Культура','Работа','Отношения'];
const validBody=(b,max=1000)=>typeof b==='string'&&b.trim().length>0&&b.length<=max;
const toId=v=>/^\d{1,9}$/.test(String(v))?Number(v):null;
// Columns for viewer $1: the author is never exposed, only whether the viewer wrote the post.
const columns=`p.id,p.body,p.topic,p.created_at,p.characters,p.events,p.community_id,cm.name AS community,(p.user_id IS NULL) AS anonymized,'Пользователь' AS name,(p.user_id=$1) AS is_own,(SELECT COUNT(*)::int FROM likes WHERE post_id=p.id) AS likes,(SELECT COUNT(*)::int FROM comments WHERE post_id=p.id) AS comments,EXISTS(SELECT 1 FROM likes WHERE post_id=p.id AND user_id=$1) AS liked,EXISTS(SELECT 1 FROM bookmarks WHERE post_id=p.id AND user_id=$1) AS saved,(SELECT COUNT(*)::int FROM post_dislikes WHERE post_id=p.id) AS dislikes,EXISTS(SELECT 1 FROM post_dislikes WHERE post_id=p.id AND user_id=$1) AS disliked,EXISTS(SELECT 1 FROM community_members WHERE community_id=p.community_id AND user_id=$1) AS member,COALESCE(cm.owner_id=$1,FALSE) AS community_owner FROM posts p LEFT JOIN communities cm ON cm.id=p.community_id`;
postsRouter.get('/',run(async(req,res)=>{
const {q='',topic='',view='',sort='',community=''}=req.query;
const filters=`p.body ILIKE $2 AND ($3='' OR p.topic=$3) AND ($4!='saved' OR EXISTS(SELECT 1 FROM bookmarks WHERE post_id=p.id AND user_id=$1)) AND ($4!='profile' OR p.user_id=$1) AND ($5::int IS NULL OR p.community_id=$5)`;
// Recommendations skip the viewer's own, liked and disliked posts; saved posts and the profile keep chronological order.
const sql=sort==='recommended'&&!['saved','profile'].includes(view)?`WITH ${recommendCtes} SELECT ${columns} WHERE ${filters} AND p.user_id IS DISTINCT FROM $1 AND NOT EXISTS(SELECT 1 FROM likes WHERE post_id=p.id AND user_id=$1) AND NOT EXISTS(SELECT 1 FROM post_dislikes WHERE post_id=p.id AND user_id=$1) ORDER BY ${recommendScore} DESC,p.id DESC LIMIT 100`:`SELECT ${columns} WHERE ${filters} ORDER BY ${sort==='popular'?'likes DESC,':''}p.created_at DESC,p.id DESC LIMIT 100`;
res.json((await db.query(sql,[req.user.id,`%${String(q).slice(0,100)}%`,String(topic),String(view),toId(community)])).rows);
}));
postsRouter.get('/:id',run(async(req,res)=>{const id=toId(req.params.id);const post=id&&(await db.query(`SELECT ${columns} WHERE p.id=$2`,[req.user.id,id])).rows[0];post?res.json(post):res.status(404).json({error:'Публикация не найдена или удалена'})}));
postsRouter.post('/',run(async(req,res)=>{
const {body,topic,characters=[],events=[],community_id=null}=req.body;
if(!validBody(body,2000)||!topics.includes(topic)||!Array.isArray(characters)||characters.length>8||!characters.every(c=>typeof c==='string'&&c.trim().length>0&&c.length<=40)||!Array.isArray(events)||events.length>10||!events.every(e=>typeof e?.title==='string'&&e.title.trim().length>0&&e.title.length<=80&&validBody(e.body)))return res.status(400).json({error:'Проверьте текст (до 2000 символов), тему, персонажей (до 8) и события (до 10).'});
if(community_id!==null&&!(Number.isSafeInteger(community_id)&&(await db.query('SELECT 1 FROM community_members WHERE community_id=$1 AND user_id=$2',[community_id,req.user.id])).rows.length))return res.status(403).json({error:'Публиковать в сообщество могут только его участники'});
const post=(await db.query("INSERT INTO posts(user_id,body,topic,characters,events,community_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,body,topic,created_at,characters,events,community_id,'Пользователь' AS name,TRUE AS is_own",[req.user.id,body.trim(),topic,JSON.stringify(characters.map(c=>c.trim())),JSON.stringify(events.map(e=>({title:e.title.trim(),body:e.body.trim()}))),community_id])).rows[0];
if(community_id!==null)await notifyCommunity(community_id,post.id,req.user.id);
res.status(201).json(post);
}));
postsRouter.post('/:id/anonymize',run(async(req,res)=>{
const id=toId(req.params.id);const post=id&&(await db.query('SELECT p.user_id,p.community_id,c.owner_id FROM posts p LEFT JOIN communities c ON c.id=p.community_id WHERE p.id=$1',[id])).rows[0];
const owner=post?.owner_id===req.user.id;
if(!post||post.user_id===null||post.user_id!==req.user.id&&!owner)return res.status(404).json({error:'Сплетня не найдена'});
// Community posts cannot be deleted, so their authors may always unlink them; elsewhere it is a premium feature.
if(!owner&&!post.community_id&&req.user.role!=='premium')return res.status(403).json({error:'Обезличивание доступно с премом'});
await db.query('UPDATE posts SET user_id=NULL WHERE id=$1',[id]);res.json({ok:true});
}));
for(const [route,table] of [['like','likes'],['save','bookmarks']])postsRouter.post(`/:id/${route}`,run(async(req,res)=>{const id=toId(req.params.id);const post=id&&(await db.query('SELECT user_id FROM posts WHERE id=$1',[id])).rows[0];if(!post)return res.status(404).json({error:'Публикация не найдена'});if(req.body.active===true){const added=(await db.query(`INSERT INTO ${table}(user_id,post_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING post_id`,[req.user.id,id])).rows.length;if(route==='like')await db.query('DELETE FROM post_dislikes WHERE user_id=$1 AND post_id=$2',[req.user.id,id]);if(added&&route==='like'&&post.user_id!==req.user.id)await notify(post.user_id,'post_like',{post:id})}else await db.query(`DELETE FROM ${table} WHERE user_id=$1 AND post_id=$2`,[req.user.id,id]);res.json({ok:true})}));
postsRouter.get('/:id/comments',run(async(req,res)=>res.json((await db.query("SELECT c.id,c.parent_id,c.body,c.created_at,'Пользователь' AS name,(c.user_id=$2) AS is_own,(SELECT COUNT(*)::int FROM comment_likes WHERE comment_id=c.id) AS likes,EXISTS(SELECT 1 FROM comment_likes WHERE comment_id=c.id AND user_id=$2) AS liked FROM comments c JOIN users u ON c.user_id=u.id WHERE c.post_id=$1 ORDER BY c.created_at,c.id",[toId(req.params.id),req.user.id])).rows)));
postsRouter.post('/:id/comments',run(async(req,res)=>{
if(!validBody(req.body.body))return res.status(400).json({error:'Комментарий: 1–1000 символов'});
const id=toId(req.params.id);const post=id&&(await db.query('SELECT user_id FROM posts WHERE id=$1',[id])).rows[0];if(!post)return res.status(404).json({error:'Публикация не найдена'});
const {reply_to=null}=req.body;const target=reply_to===null?null:Number.isSafeInteger(reply_to)&&(await db.query('SELECT id,parent_id,user_id FROM comments WHERE id=$1 AND post_id=$2',[reply_to,id])).rows[0];
if(target===false||target===undefined)return res.status(400).json({error:'Комментарий для ответа не найден'});
// A reply to a reply joins the same thread under the top-level comment.
const comment=(await db.query('INSERT INTO comments(user_id,post_id,body,parent_id) VALUES($1,$2,$3,$4) RETURNING id',[req.user.id,id,req.body.body.trim(),target?target.parent_id??target.id:null])).rows[0];
// The replied-to author gets a reply notice; the post author a comment notice unless they already got the reply one.
if(target&&target.user_id!==req.user.id)await notify(target.user_id,'comment_reply',{post:id,comment:target.id});
if(post.user_id!==req.user.id&&target?.user_id!==post.user_id)await notify(post.user_id,'post_comment',{post:id});
res.status(201).json({id:comment.id});
}));
// Members dislike community posts; a dislike replaces the viewer's like and is never notified.
postsRouter.post('/:id/dislike',run(async(req,res)=>{const id=toId(req.params.id);const post=id&&(await db.query('SELECT community_id,EXISTS(SELECT 1 FROM community_members WHERE community_id=posts.community_id AND user_id=$2) AS member FROM posts WHERE id=$1',[id,req.user.id])).rows[0];if(!post)return res.status(404).json({error:'Публикация не найдена'});if(!post.member)return res.status(403).json({error:'Дизлайк могут ставить только участники сообщества'});if(req.body.active===true){await db.query('INSERT INTO post_dislikes(user_id,post_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.user.id,id]);await db.query('DELETE FROM likes WHERE user_id=$1 AND post_id=$2',[req.user.id,id])}else await db.query('DELETE FROM post_dislikes WHERE user_id=$1 AND post_id=$2',[req.user.id,id]);res.json({ok:true})}));
// Posts in communities stay: they can only be anonymized.
postsRouter.delete('/:id',run(async(req,res)=>{const id=toId(req.params.id);const post=id&&(await db.query('SELECT community_id FROM posts WHERE id=$1 AND user_id=$2',[id,req.user.id])).rows[0];if(!post)return res.status(404).json({ok:false});if(post.community_id)return res.status(403).json({error:'Сплетни в сообществах нельзя удалить, только обезличить'});await db.query('DELETE FROM posts WHERE id=$1',[id]);res.json({ok:true})}));
commentsRouter.post('/:id/like',run(async(req,res)=>{const id=toId(req.params.id);const comment=id&&(await db.query('SELECT user_id,post_id FROM comments WHERE id=$1',[id])).rows[0];if(!comment)return res.status(404).json({error:'Комментарий не найден'});if(req.body.active===true){const added=(await db.query('INSERT INTO comment_likes(user_id,comment_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING comment_id',[req.user.id,id])).rows.length;if(added&&comment.user_id!==req.user.id)await notify(comment.user_id,'comment_like',{post:comment.post_id,comment:id})}else await db.query('DELETE FROM comment_likes WHERE user_id=$1 AND comment_id=$2',[req.user.id,id]);res.json({ok:true})}));
