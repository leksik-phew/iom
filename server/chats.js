import express from 'express';
import {randomBytes,createHash} from 'node:crypto';
import {redis} from './auth.js';
import {db} from './db.js';
import {visibleAuthor} from './posts.js';
export const chatRouter=express.Router();
const hash=s=>createHash('sha256').update(s).digest('hex');
const prefix='iom:chat:';
// A marker lives exactly as long as its login session; logout deletes it.
const marker=h=>'iom:session:'+h;
const member=id=>hash('member:'+id);
const run=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
async function keys(){const found=[];for await(const batch of redis.scanIterator({MATCH:prefix+'*',COUNT:100}))found.push(...batch);return found}
// Chats in the former presence-based format are dropped.
async function chats(){const found=[];for(const key of await keys()){const raw=await redis.get(key);if(!raw)continue;const c=JSON.parse(raw);if(c.seats)found.push(c);else await redis.del(key)}return found}
const mark=(token,expires)=>redis.set(marker(hash(token)),'1',{expiration:{type:'PXAT',value:new Date(expires).getTime()}});
async function holdSession(token){if(await redis.exists(marker(hash(token))))return;const s=(await db.query('SELECT expires FROM sessions WHERE token=$1 AND expires>NOW()',[token])).rows[0];if(s)await mark(token,s.expires)}
const held=async seat=>seat.sessions.length>0&&await redis.exists(seat.sessions.map(marker))>0;
// A chat stays while at least one participant still holds a valid session, never longer than 24 hours.
async function alive(c){if(c.expires<=Date.now())return false;for(const seat of c.seats)if(await held(seat))return true;return false}
// Optimistic write: it lands only if nobody changed the chat after it was read. No JSON is re-encoded in Lua.
async function update(id,change){for(let i=0;i<20;i++){const raw=await redis.get(prefix+id);if(!raw)return null;const c=JSON.parse(raw);if(await change(c)===false)return c;if(await redis.eval(`if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('SET',KEYS[1],ARGV[2],'KEEPTTL') return 1 end return 0`,{keys:[prefix+id],arguments:[raw,JSON.stringify(c)]}))return c}throw Error('Chat update conflict')}
export async function leaveChats(token){if(!redis.isReady)throw Error('Redis unavailable');const me=hash(token);await redis.del(marker(me));for(const c of await chats())if(c.seats.some(s=>s.sessions.includes(me))&&!await alive(c))await redis.del(prefix+c.id)}
// Cleanup also runs with no browser requests. Redis TTL is an additional hard expiry.
const cleanup=setInterval(async()=>{if(!redis.isReady)return;try{for(const c of await chats())if(!await alive(c))await redis.del(prefix+c.id)}catch{}},5000);cleanup.unref();
chatRouter.use((req,res,next)=>redis.isReady?next():res.status(503).json({error:'Чаты временно недоступны'}));
chatRouter.post('/',run(async(req,res)=>{
if(req.user.role!=='premium')return res.status(403).json({error:'Начинать личный чат можно с премом'});
const {kind,id}=req.body;if(!['post','comment'].includes(kind)||!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'Выберите публикацию или комментарий'});
// Only content the sender can see opens a chat: hidden stories and comments behave as missing.
const target=await visibleAuthor(req.user.id,kind,id);
if(!target?.user_id||target.user_id===req.user.id)return res.status(404).json({error:'Чат недоступен'});
const own=(await db.query('SELECT expires FROM sessions WHERE token=$1 AND expires>NOW()',[req.sessionToken])).rows[0];if(!own)return res.sendStatus(401);
await mark(req.sessionToken,own.expires);
const me=hash(req.sessionToken),other=member(target.user_id);
for(const c of await chats())if(c.seats.some(s=>s.sessions.includes(me))&&c.seats.some(s=>s.user===other)&&await alive(c))return res.json({id:c.id,number:c.number});
// The recipient's current sessions also hold the chat, so it survives the sender leaving before it is read.
const recipientSessions=(await db.query('SELECT token,expires FROM sessions WHERE user_id=$1 AND expires>NOW()',[target.user_id])).rows;
for(const s of recipientSessions)await mark(s.token,s.expires);
const chatId=randomBytes(16).toString('hex');const number=await redis.incr('iom:chat-counter');const expires=Date.now()+86400000;
await redis.set(prefix+chatId,JSON.stringify({id:chatId,number,expires,seats:[{user:member(req.user.id),sessions:[me],claimed:true},{user:other,sessions:recipientSessions.map(s=>hash(s.token)),claimed:false}],messages:[]}),{expiration:{type:'PXAT',value:expires}});
res.status(201).json({id:chatId,number});
}));
chatRouter.get('/',run(async(req,res)=>{
await holdSession(req.sessionToken);
const me=hash(req.sessionToken),user=member(req.user.id),result=[];
for(let c of await chats()){
const seat=c.seats.findIndex(s=>s.user===user);if(seat<0||!await alive(c))continue;
// A new session of the same account takes the seat only while no claimed session still holds it.
if(!c.seats[seat].claimed||!c.seats[seat].sessions.includes(me))c=await update(c.id,async x=>{const s=x.seats[seat];if(s.claimed&&(s.sessions.includes(me)||await held(s)))return false;s.sessions=[me];s.claimed=true});
if(c?.seats[seat].claimed&&c.seats[seat].sessions.includes(me))result.push({id:c.id,number:c.number,waiting:!c.seats[1-seat].claimed,messages:c.messages.map(m=>({body:m.body,created_at:m.created_at,mine:m.seat===seat}))});
}
res.json(result.sort((a,b)=>b.number-a.number));
}));
chatRouter.post('/:id/messages',run(async(req,res)=>{const {body}=req.body;if(typeof body!=='string'||!body.trim()||body.length>1000)return res.status(400).json({error:'Сообщение: 1–1000 символов'});
const me=hash(req.sessionToken);let status=404;
await update(req.params.id,async c=>{const seat=c.seats.findIndex(s=>s.claimed&&s.sessions.includes(me));if(seat<0||!await alive(c)){status=404;return false}if(c.messages.length>=200){status=400;return false}c.messages.push({body:body.trim(),seat,created_at:new Date().toISOString()});status=201});
res.status(status).json(status===201?{ok:true}:{error:status===400?'Лимит чата — 200 сообщений':'Чат завершён'});
}));
chatRouter.delete('/:id',run(async(req,res)=>{const raw=await redis.get(prefix+req.params.id);const c=raw&&JSON.parse(raw);if(!c?.seats?.some(s=>s.claimed&&s.sessions.includes(hash(req.sessionToken))))return res.status(404).json({error:'Чат не найден'});await redis.del(prefix+req.params.id);res.json({ok:true})}));
