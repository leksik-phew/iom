import express from 'express';
import {randomBytes,createHash} from 'node:crypto';
import {redis} from './auth.js';
import {db} from './db.js';
export const chatRouter=express.Router();
const hash=s=>createHash('sha256').update(s).digest('hex');
const prefix='iom:chat:';
const presence=s=>'iom:presence:'+hash(s);
const run=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
async function keys(){const found=[];for await(const batch of redis.scanIterator({MATCH:prefix+'*',COUNT:100}))found.push(...batch);return found}
export async function endChats(token){if(!redis.isReady)throw Error('Redis unavailable');const participant=hash(token);await redis.del(presence(token));for(const key of await keys()){const raw=await redis.get(key);if(raw&&JSON.parse(raw).participants.includes(participant))await redis.del(key)}}
async function alive(chat){if(chat.expires<=Date.now())return false;for(const participant of chat.participants)if(!await redis.exists('iom:presence:'+participant))return false;return true}
// Cleanup also runs with no browser requests. Redis TTL is an additional hard expiry.
const cleanup=setInterval(async()=>{if(!redis.isReady)return;try{for(const key of await keys()){const raw=await redis.get(key);if(raw){const chat=JSON.parse(raw);if(!await alive(chat))await redis.del(key);else await redis.pExpire(key,Math.max(1,Math.min(45000,chat.expires-Date.now())))}}}catch{}},5000);cleanup.unref();
chatRouter.use((req,res,next)=>redis.isReady?next():res.status(503).json({error:'Чаты временно недоступны'}));
chatRouter.post('/heartbeat',run(async(req,res)=>{await redis.set(presence(req.sessionToken),'1',{EX:45});res.json({ok:true})}));
chatRouter.post('/end',run(async(req,res)=>{await endChats(req.sessionToken);res.json({ok:true})}));
chatRouter.post('/',run(async(req,res)=>{
if(req.user.role!=='premium')return res.status(403).json({error:'Начинать личный чат можно с премом'});
const {kind,id}=req.body;if(!['post','comment'].includes(kind)||!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'Выберите публикацию или комментарий'});
const target=(await db.query(`SELECT user_id FROM ${kind==='post'?'posts':'comments'} WHERE id=$1`,[id])).rows[0];
if(!target?.user_id||target.user_id===req.user.id)return res.status(404).json({error:'Чат недоступен'});
const sessions=(await db.query('SELECT token,expires FROM sessions WHERE user_id=$1 AND expires>NOW() ORDER BY expires DESC',[target.user_id])).rows;
let recipient;for(const session of sessions)if(await redis.exists(presence(session.token))){recipient=session;break}
if(!recipient)return res.status(409).json({error:'Пользователь сейчас не в сети. Временный чат доступен, когда оба участника онлайн.'});
const own=(await db.query('SELECT expires FROM sessions WHERE token=$1 AND expires>NOW()',[req.sessionToken])).rows[0];if(!own)return res.sendStatus(401);
const participants=[hash(req.sessionToken),hash(recipient.token)];
await redis.set(presence(req.sessionToken),'1',{EX:45});
for(const key of await keys()){const raw=await redis.get(key);if(raw){const c=JSON.parse(raw);if(c.participants.includes(participants[0])&&c.participants.includes(participants[1])&&await alive(c))return res.json({id:c.id,number:c.number})}}
const chatId=randomBytes(16).toString('hex');const number=await redis.incr('iom:chat-counter');const expires=Math.min(new Date(own.expires).getTime(),new Date(recipient.expires).getTime(),Date.now()+86400000);
await redis.set(prefix+chatId,JSON.stringify({id:chatId,number,participants,expires,messages:[]}),{PX:Math.max(1,Math.min(45000,expires-Date.now()))});res.status(201).json({id:chatId,number});
}));
chatRouter.get('/',run(async(req,res)=>{const result=[];const participant=hash(req.sessionToken);for(const key of await keys()){const raw=await redis.get(key);if(raw){const c=JSON.parse(raw);if(c.participants.includes(participant)&&await alive(c))result.push({id:c.id,number:c.number,messages:c.messages.map(m=>({body:m.body,created_at:m.created_at,mine:m.sender===participant}))})}}res.json(result.sort((a,b)=>b.number-a.number))}));
chatRouter.post('/:id/messages',run(async(req,res)=>{const {body}=req.body;if(typeof body!=='string'||!body.trim()||body.length>1000)return res.status(400).json({error:'Сообщение: 1–1000 символов'});
const raw=await redis.get(prefix+req.params.id);const participant=hash(req.sessionToken);if(!raw)return res.status(404).json({error:'Чат завершён'});const chat=JSON.parse(raw);if(!chat.participants.includes(participant)||!await alive(chat))return res.status(404).json({error:'Чат завершён'});
const result=await redis.eval(`local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end; local c=cjson.decode(raw); if #c.messages>=200 then return 2 end; table.insert(c.messages,cjson.decode(ARGV[1])); redis.call('SET',KEYS[1],cjson.encode(c),'KEEPTTL'); return 1`,{keys:[prefix+req.params.id],arguments:[JSON.stringify({body:body.trim(),sender:participant,created_at:new Date().toISOString()})]});res.status(result===1?201:result===2?400:404).json(result===1?{ok:true}:{error:result===2?'Лимит чата — 200 сообщений':'Чат завершён'});
}));
chatRouter.delete('/:id',run(async(req,res)=>{const key=prefix+req.params.id;const raw=await redis.get(key);if(!raw||!JSON.parse(raw).participants.includes(hash(req.sessionToken)))return res.status(404).json({error:'Чат не найден'});await redis.del(key);res.json({ok:true})}));
