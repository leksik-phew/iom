import express from 'express';
import {chatRouter, endChats} from './chats.js';
import {randomBytes} from 'node:crypto';
import {authRouter, publicUser} from './auth.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {db,init} from './db.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
await init();
const app=express();app.disable('x-powered-by');app.use(express.json({limit:'64kb'}));
const run=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
app.use('/api',run(async(req,res,next)=>{if(!['GET','HEAD'].includes(req.method)&&req.headers.origin&&req.headers.origin!==`${req.protocol}://${req.headers.host}`)return res.status(403).json({error:'Недопустимый источник запроса'});const token=req.headers.cookie?.split('; ').find(x=>x.startsWith('iom_session='))?.slice(12);req.sessionToken=token;if(token)req.user=(await db.query('SELECT u.id,u.role,u.user_verified FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND s.expires>NOW() AND u.user_verified=TRUE',[token])).rows[0];next();}));
const auth=(req,res,next)=>req.user?next():res.status(401).json({error:'Войдите, чтобы продолжить'});
app.use('/api/auth',authRouter);
app.get('/api/me',(req,res)=>res.json(req.user?publicUser(req.user):null));
app.post('/api/premium',auth,run(async(req,res)=>{const user=(await db.query("UPDATE users SET role='premium' WHERE id=$1 AND user_verified=TRUE RETURNING role,user_verified",[req.user.id])).rows[0];res.json(publicUser(user))}));
// Reading and writing platform content both require a verified account.
app.use('/api/posts',auth);
app.use('/api/chats',auth,chatRouter);
app.post('/api/logout',run(async(req,res)=>{const token=req.headers.cookie?.split('; ').find(x=>x.startsWith('iom_session='))?.slice(12);if(token)await endChats(token);if(token)await db.query('DELETE FROM sessions WHERE token=$1',[token]);res.clearCookie('iom_session');res.json({ok:true})}));
app.get('/api/posts',run(async(req,res)=>{const uid=req.user?.id||0;const {q='',topic='',view='',sort=''}=req.query;const result=await db.query(`SELECT p.id,p.body,p.topic,p.created_at,p.characters,p.events,(p.user_id IS NULL) AS anonymized,'Пользователь' AS name,(p.user_id=$1) AS is_own,(SELECT COUNT(*)::int FROM likes WHERE post_id=p.id) AS likes,(SELECT COUNT(*)::int FROM comments WHERE post_id=p.id) AS comments,EXISTS(SELECT 1 FROM likes WHERE post_id=p.id AND user_id=$1) AS liked,EXISTS(SELECT 1 FROM bookmarks WHERE post_id=p.id AND user_id=$1) AS saved FROM posts p WHERE p.body ILIKE $2 AND ($3='' OR p.topic=$3) AND ($4!='saved' OR EXISTS(SELECT 1 FROM bookmarks WHERE post_id=p.id AND user_id=$1)) AND ($4!='profile' OR p.user_id=$1) ORDER BY ${sort==='popular'?'likes DESC,':''} p.created_at DESC,p.id DESC LIMIT 100`,[uid,`%${String(q).slice(0,100)}%`,topic,view]);res.json(result.rows)}));
const validBody=b=>typeof b==='string'&&b.trim().length>0&&b.length<=1000;
app.post('/api/posts',auth,run(async(req,res)=>{
const {body,topic,characters=[],events=[]}=req.body;
if(!validBody(body)||!['Жизнь','Город','Культура','Работа','Отношения'].includes(topic)||!Array.isArray(characters)||characters.length>8||!characters.every(c=>typeof c==='string'&&c.trim().length>0&&c.length<=40)||!Array.isArray(events)||events.length>10||!events.every(e=>typeof e?.title==='string'&&e.title.trim().length>0&&e.title.length<=80&&validBody(e.body)))return res.status(400).json({error:'Проверьте текст, тему, персонажей (до 8) и события (до 10).'});
res.status(201).json((await db.query("INSERT INTO posts(user_id,body,topic,characters,events) VALUES($1,$2,$3,$4,$5) RETURNING id,body,topic,created_at,characters,events,'Пользователь' AS name,TRUE AS is_own",[req.user.id,body.trim(),topic,JSON.stringify(characters.map(c=>c.trim())),JSON.stringify(events.map(e=>({title:e.title.trim(),body:e.body.trim()})))])).rows[0]);
}));
app.post('/api/posts/:id/anonymize',auth,run(async(req,res)=>{
if(req.user.role!=='premium')return res.status(403).json({error:'Обезличивание доступно с премом'});
const r=await db.query('UPDATE posts SET user_id=NULL WHERE id=$1 AND user_id=$2 RETURNING id',[req.params.id,req.user.id]);
res.status(r.rows.length?200:404).json(r.rows.length?{ok:true}:{error:'Сплетня не найдена'});
}));
for(const [route,table] of [['like','likes'],['save','bookmarks']])app.post(`/api/posts/:id/${route}`,auth,run(async(req,res)=>{if(!(await db.query('SELECT id FROM posts WHERE id=$1',[req.params.id])).rows.length)return res.sendStatus(404);if(req.body.active===true)await db.query(`INSERT INTO ${table}(user_id,post_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[req.user.id,req.params.id]);else await db.query(`DELETE FROM ${table} WHERE user_id=$1 AND post_id=$2`,[req.user.id,req.params.id]);res.json({ok:true})}));
app.get('/api/posts/:id/comments',run(async(req,res)=>res.json((await db.query("SELECT c.id,c.body,c.created_at,'Пользователь' AS name FROM comments c JOIN users u ON c.user_id=u.id WHERE post_id=$1 ORDER BY c.created_at",[req.params.id])).rows)));
app.post('/api/posts/:id/comments',auth,run(async(req,res)=>{if(!validBody(req.body.body))return res.status(400).json({error:'Комментарий: 1–1000 символов'});await db.query('INSERT INTO comments(user_id,post_id,body) VALUES($1,$2,$3)',[req.user.id,req.params.id,req.body.body.trim()]);res.status(201).json({ok:true})}));
app.delete('/api/posts/:id',auth,run(async(req,res)=>{const r=await db.query('DELETE FROM posts WHERE id=$1 AND user_id=$2 RETURNING id',[req.params.id,req.user.id]);res.status(r.rows.length?200:404).json({ok:!!r.rows.length})}));
app.use('/api',(req,res)=>res.status(404).json({error:'Не найдено'}));
app.use((err,req,res,next)=>{console.error('Request failed',err.code||'unknown');res.status(500).json({error:'Не удалось выполнить запрос. Попробуйте ещё раз.'})});
if(process.env.NODE_ENV==='production'){app.use(express.static(path.join(root,'dist')));app.get('*',(req,res)=>res.sendFile(path.join(root,'dist/index.html')))}else{const {createServer}=await import('vite');const vite=await createServer({configFile:path.join(root,'vite.config.js'),server:{middlewareMode:true},appType:'spa'});app.use(vite.middlewares)}
app.listen(process.env.PORT||3000,'0.0.0.0',()=>console.log('ЙОМ: http://localhost:'+(process.env.PORT||3000)));
