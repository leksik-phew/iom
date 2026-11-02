import express from 'express';
import {createHash} from 'node:crypto';
import {db} from './db.js';
import {redis} from './auth.js';
import {mail,devMail,supportEmail} from './mail.js';
export const supportRouter=express.Router();
const run=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
// Categories follow the platform rules (client/src/Legal.jsx).
export const categories={threat:'Угрозы или призывы к насилию',harassment:'Оскорбления и травля',identity:'Имена, места или данные, по которым можно узнать человека',illegal:'Нарушение законодательства',politics:'Политика и другие запрещённые темы',explicit:'Откровенный или шокирующий контент',spam:'Спам или реклама',other:'Другое'};
supportRouter.get('/categories',(req,res)=>res.json(Object.entries(categories).map(([id,title])=>({id,title}))));
// Reports and support messages share an hourly limit per account.
supportRouter.use(run(async(req,res,next)=>{if(!redis.isReady)return res.status(503).json({error:'Поддержка временно недоступна'});const key='iom:support-rate:'+createHash('sha256').update('support:'+req.user.id).digest('hex');const n=await redis.eval(`local n=redis.call('INCR',KEYS[1]) if n==1 then redis.call('EXPIRE',KEYS[1],3600) end return n`,{keys:[key]});if(n>10)return res.status(429).json({error:'Слишком много обращений. Попробуйте через час.'});next()}));
// Nothing is stored on the platform: the letter in the support mailbox is the only copy.
async function send(res,subject,text){if(!mail&&!devMail)return res.status(503).json({error:'Отправка писем ещё не настроена'});try{if(mail)await mail.sendMail({from:process.env.SMTP_FROM,to:supportEmail,subject,text});else console.log(`Support mail (development, not sent)\n${subject}\n${text}`)}catch{return res.status(503).json({error:'Не удалось отправить. Попробуйте позже.'})}res.status(201).json({ok:true})}
supportRouter.post('/report',run(async(req,res)=>{
const {kind,id,category,comment=''}=req.body;
if(!['post','comment','community'].includes(kind)||!Number.isSafeInteger(id)||id<1||typeof category!=='string'||!Object.hasOwn(categories,category)||typeof comment!=='string'||comment.length>1000)return res.status(400).json({error:'Выберите категорию. Комментарий — до 1000 символов.'});
const target=(await db.query({post:'SELECT topic,body,characters,events FROM posts WHERE id=$1',comment:'SELECT post_id,body FROM comments WHERE id=$1',community:'SELECT name,description FROM communities WHERE id=$1'}[kind],[id])).rows[0];
if(!target)return res.status(404).json({error:'Публикация не найдена'});
// The content is copied into the letter so moderators see it even after the author deletes it.
const content=kind==='community'?[`Сообщество #${id}: ${target.name}`,target.description]:kind==='post'?[`Сплетня #${id}, тема: ${target.topic}`,target.body,...(target.characters.length?['Персонажи: '+target.characters.join(', ')]:[]),...target.events.map((e,i)=>`Событие ${i+1}. ${e.title}\n${e.body}`)]:[`Комментарий #${id} к сплетне #${target.post_id}`,target.body];
await send(res,`[Жалоба] от user_id ${req.user.id}`,[`Категория: ${categories[category]}`,`Комментарий: ${comment.trim()||'—'}`,'','Содержимое:',...content].join('\n'));
}));
supportRouter.post('/message',run(async(req,res)=>{const {message}=req.body;if(typeof message!=='string'||!message.trim()||message.length>2000)return res.status(400).json({error:'Сообщение: 1–2000 символов'});await send(res,`[Поддержка] от user_id ${req.user.id}`,message.trim())}));
