import './env.js';
import express from 'express';
import {chatRouter, leaveChats} from './chats.js';
import {supportRouter} from './support.js';
import {postsRouter,commentsRouter} from './posts.js';
import {communityRouter} from './communities.js';
import {notificationRouter,startNotificationCleanup} from './notifications.js';
import {createHash} from 'node:crypto';
import {authRouter, publicUser, redis} from './auth.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {db,init} from './db.js';
import {plans,premiumCode,activatePremium,startPremiumExpiry,effectiveRole} from './premium.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
await init();
await startPremiumExpiry();
await startNotificationCleanup();
const app=express();if(process.env.TRUST_PROXY==='1')app.set('trust proxy',1);app.disable('x-powered-by');app.use(express.json({limit:'64kb'}));
const run=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
app.use('/api',run(async(req,res,next)=>{if(!['GET','HEAD'].includes(req.method)&&req.headers.origin&&req.headers.origin!==`${req.protocol}://${req.headers.host}`)return res.status(403).json({error:'Недопустимый источник запроса'});const token=req.headers.cookie?.split('; ').find(x=>x.startsWith('iom_session='))?.slice(12);req.sessionToken=token;if(token)req.user=(await db.query(`SELECT u.id,${effectiveRole},u.premium_until,u.user_verified FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND s.expires>NOW() AND u.user_verified=TRUE`,[token])).rows[0];next();}));
const auth=(req,res,next)=>req.user?next():res.status(401).json({error:'Войдите, чтобы продолжить'});
app.use('/api/auth',authRouter);
app.get('/api/me',(req,res)=>res.json(req.user?publicUser(req.user):null));
app.get('/api/premium/plans',(req,res)=>res.json(Object.entries(plans).map(([id,p])=>({id,title:p.title}))));
// Five wrong codes freeze the endpoint for this account for an hour, even for the right code.
app.post('/api/premium',auth,run(async(req,res)=>{if(!redis.isReady)return res.status(503).json({error:'Оформление временно недоступно'});const attempts='iom:premium-attempts:'+createHash('sha256').update('premium:'+req.user.id).digest('hex');const frozen=()=>redis.ttl(attempts).then(t=>res.status(429).json({error:`Слишком много неверных кодов. Попробуйте через ${Math.max(1,Math.ceil(t/60))} мин.`}));if(Number(await redis.get(attempts))>=5)return frozen();const {plan,code}=req.body;if(typeof plan!=='string'||!Object.hasOwn(plans,plan))return res.status(400).json({error:'Выберите тариф'});if(typeof code!=='string'||code!==premiumCode){const n=await redis.eval(`local n=redis.call('INCR',KEYS[1]) if n==1 or n>=5 then redis.call('EXPIRE',KEYS[1],3600) end return n`,{keys:[attempts]});return n>=5?frozen():res.status(400).json({error:`Неверный код. Осталось попыток: ${5-n}`})}await redis.del(attempts);const user=await activatePremium(req.user.id,plan);if(!user)return res.sendStatus(401);res.json(publicUser(user))}));
// Reading and writing platform content both require a verified account.
app.use('/api/posts',auth,postsRouter);
app.use('/api/comments',auth,commentsRouter);
app.use('/api/communities',auth,communityRouter);
app.use('/api/notifications',auth,notificationRouter);
app.use('/api/chats',auth,chatRouter);
app.use('/api/support',auth,supportRouter);
app.post('/api/logout',run(async(req,res)=>{const token=req.headers.cookie?.split('; ').find(x=>x.startsWith('iom_session='))?.slice(12);if(token)await leaveChats(token);if(token)await db.query('DELETE FROM sessions WHERE token=$1',[token]);res.clearCookie('iom_session');res.json({ok:true})}));
app.use('/api',(req,res)=>res.status(404).json({error:'Не найдено'}));
app.use((err,req,res,next)=>{console.error('Request failed',err.code||'unknown');res.status(500).json({error:'Не удалось выполнить запрос. Попробуйте ещё раз.'})});
if(process.env.NODE_ENV==='production'){app.use(express.static(path.join(root,'dist')));app.get('*',(req,res)=>res.sendFile(path.join(root,'dist/index.html')))}else{const {createServer}=await import('vite');const vite=await createServer({configFile:path.join(root,'vite.config.js'),server:{middlewareMode:true},appType:'spa'});app.use(vite.middlewares)}
app.listen(process.env.PORT||3000,'0.0.0.0',()=>console.log('ЙОМ: http://localhost:'+(process.env.PORT||3000)));
