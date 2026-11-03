import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createClient} from 'redis';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
// TEST_DATABASE_URL runs the server on a real PostgreSQL; it must point to a disposable database.
const base='http://localhost:3196/api';
let dir,redisProcess,redis,child,logs='';
function session(){let cookie='';return async(url,body,method)=>{const r=await fetch(base+url,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json',cookie},body:body?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()}}}
async function register(email,premium=false){for(const key of await redis.keys('iom:rate:*'))await redis.del(key);const s=session();const reg=(await s('/auth/register',{email,accept:{privacy:true,rules:true,consent:true}})).data;assert.equal((await s('/auth/verify',{challenge:reg.challenge,code:reg.dev_code})).status,200);if(premium)assert.equal((await s('/premium',{plan:'month',code:'123456'})).status,200);return s}
const leaks=data=>{for(const key of ['user_id','owner_id','email','access_hash'])assert.ok(!Object.hasOwn(data,key),key+' leaked')};
const notes=async s=>(await s('/notifications')).data;
const feedIds=async(s,query='')=>(await s('/posts'+query)).data.map(p=>p.id);
const story=async(s,body,extra={})=>{const r=await s('/posts',{body,topic:'Жизнь',...extra});assert.equal(r.status,201,JSON.stringify(r.data));return r.data.id};
before(async()=>{
 dir=await mkdtemp(path.join(tmpdir(),'iom-community-'));
 redisProcess=spawn('redis-server',['--port','6396','--bind','127.0.0.1','--save','','--appendonly','no'],{stdio:'ignore'});
 redis=createClient({url:'redis://127.0.0.1:6396'});redis.on('error',()=>{});
 for(let i=0;i<50;i++){try{await redis.connect();break}catch{await pause(100)}}
 child=spawn(process.execPath,['server/index.js'],{env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL||'',PORT:'3196',REDIS_URL:'redis://127.0.0.1:6396',DATA_DIR:dir,NODE_ENV:'development',SMTP_HOST:''},stdio:'pipe'});
 child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
 for(let i=0;i<150;i++){try{await fetch(base+'/me');break}catch{await pause(100)}}
});
after(async()=>{if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r))}await redis.quit();redisProcess.kill();await rm(dir,{recursive:true,force:true})});

test('Story limits: 1000 characters and 5 a day by default, 2000 and unlimited with premium',async()=>{
 const plain=await register('plain@example.com'),prem=await register('prem@example.com',true);
 assert.deepEqual((await plain('/posts/quota')).data,{limit:5,left:5,max_length:1000});
 assert.deepEqual((await prem('/posts/quota')).data,{limit:null,left:null,max_length:2000});
 assert.equal((await plain('/posts',{body:'с'.repeat(1001),topic:'Жизнь'})).status,400);
 await story(plain,'с'.repeat(1000));
 assert.equal((await prem('/posts',{body:'с'.repeat(2001),topic:'Жизнь'})).status,400);
 await story(prem,'с'.repeat(2000));
 for(let i=0;i<4;i++)await story(plain,'Сплетня '+i);
 assert.equal((await plain('/posts/quota')).data.left,0);
 const sixth=await plain('/posts',{body:'Шестая',topic:'Жизнь'});assert.equal(sixth.status,429);assert.match(sixth.data.error,/5 сплетен в день/);
 // Rejected attempts do not use up the limit.
 assert.equal((await plain('/posts/quota')).data.left,0);
 for(let i=0;i<6;i++)await story(prem,'Премиум '+i);
});

test('Premium-only stories and comments are hidden from default accounts',async()=>{
 const plain=await register('reader@example.com'),prem=await register('vip@example.com',true),other=await register('vip2@example.com',true);
 assert.equal((await plain('/posts',{body:'Хочу секрет',topic:'Жизнь',premium_only:true})).status,403);
 const secret=await story(prem,'Только для своих',{premium_only:true});
 assert.ok(!(await feedIds(plain)).includes(secret));assert.ok(!(await feedIds(plain,'?q=своих')).includes(secret));
 assert.equal((await plain(`/posts/${secret}`)).status,404);
 assert.equal((await plain(`/posts/${secret}/like`,{active:true})).status,404);
 assert.equal((await plain(`/posts/${secret}/comments`)).status,404);
 assert.equal((await other(`/posts/${secret}`)).data.premium_only,true);
 assert.ok((await feedIds(prem,'?view=profile')).includes(secret));
 // On an open story, a premium-only comment and the replies under it disappear for default accounts.
 const open=await story(plain,'Открытая сплетня');
 assert.equal((await plain(`/posts/${open}/comments`,{body:'Мой секрет',premium_only:true})).status,403);
 const hidden=(await other(`/posts/${open}/comments`,{body:'Только премам',premium_only:true})).data.id;
 await prem(`/posts/${open}/comments`,{body:'Ответ под скрытым',reply_to:hidden});
 await prem(`/posts/${open}/comments`,{body:'Обычный комментарий'});
 assert.deepEqual((await plain(`/posts/${open}/comments`)).data.map(c=>c.body),['Обычный комментарий']);
 assert.equal((await plain(`/posts/${open}`)).data.comments,1);
 assert.equal((await prem(`/posts/${open}`)).data.comments,3);
 assert.equal((await plain(`/comments/${hidden}/like`,{active:true})).status,404);
 assert.equal((await plain(`/posts/${open}/comments`,{body:'Ответ',reply_to:hidden})).status,400);
 // The default author hears only about the comment they can read.
 const n=(await notes(plain)).find(x=>x.type==='post_comment'&&x.post_id===open);assert.equal(n.count,1);
 assert.equal((await prem('/chats',{kind:'comment',id:hidden})).status,201);
});

let owner,club,closed;
test('Request communities: join requests notify the owner, decisions notify the requester',async()=>{
 owner=await register('owner@example.com',true);const [x,y,z]=[await register('x@example.com'),await register('y@example.com'),await register('z@example.com')];
 assert.equal((await owner('/communities',{name:'Неверный тип',access:'secret'})).status,400);
 club=(await owner('/communities',{name:'Клуб по заявке',access:'request'})).data;
 assert.equal(club.access,'request');assert.equal(club.invite_code.length,12);assert.equal(club.requests,0);
 const seen=(await x(`/communities/${club.id}`)).data;assert.equal(seen.invite_code,null);assert.equal(seen.requests,null);leaks(seen);
 const asked=(await x(`/communities/${club.id}/join`,{})).data;assert.equal(asked.joined,false);assert.equal(asked.requested,true);
 await y(`/communities/${club.id}/join`,{});await z(`/communities/${club.id}/join`,{});
 assert.equal((await x('/posts',{body:'Рано',topic:'Жизнь',community_id:club.id})).status,403);
 const n=(await notes(owner)).find(n=>n.type==='community_request');assert.equal(n.community_id,club.id);assert.equal(n.count,3);assert.equal(n.community,'Клуб по заявке');
 const list=(await owner(`/communities/${club.id}/requests`)).data;assert.equal(list.length,3);for(const r of list)leaks(r);assert.equal(list[0].posts,0);assert.equal(list[0].premium,false);
 assert.equal((await x(`/communities/${club.id}/requests`)).status,403);
 assert.equal((await owner(`/communities/${club.id}/requests/${list[0].id}`,{accept:true})).data.members,2);
 await owner(`/communities/${club.id}/requests/${list[1].id}`,{accept:false});
 assert.equal((await owner(`/communities/${club.id}/requests/${list[1].id}`,{accept:true})).status,404);
 assert.equal((await x(`/communities/${club.id}`)).data.joined,true);
 assert.equal((await notes(x)).find(n=>n.community_id===club.id).type,'community_accepted');
 assert.equal((await notes(y)).find(n=>n.community_id===club.id).type,'community_declined');
 // Withdrawing a request removes it from the owner's list.
 assert.equal((await z(`/communities/${club.id}/leave`,{})).data.requested,false);
 assert.equal((await owner(`/communities/${club.id}/requests`)).data.length,0);
 // Posts of a request community are public.
 const post=await story(x,'Новости клуба',{community_id:club.id});
 assert.ok((await feedIds(y)).includes(post));
 // Opening the community lets pending requests in.
 await y(`/communities/${club.id}/join`,{});
 assert.equal((await owner(`/communities/${club.id}`,{access:'public'},'PATCH')).data.members,3);
 assert.equal((await y(`/communities/${club.id}`)).data.joined,true);
});

test('Private communities: posts stay inside, invites skip approval, deletion releases posts',async()=>{
 const [inside,outside,guest]=[await register('in@example.com'),await register('out@example.com'),await register('guest@example.com')];
 closed=(await owner('/communities',{name:'Тайный клуб',access:'private'})).data;
 assert.equal((await outside(`/communities/${closed.id}/join`,{})).data.requested,true);
 assert.equal((await inside(`/communities/invite/aaaaaaaaaaaa`,{})).status,404);
 const joined=(await inside(`/communities/invite/${closed.invite_code}`,{})).data;assert.equal(joined.joined,true);assert.equal(joined.id,closed.id);
 const post=await story(inside,'Что было в клубе — остаётся в клубе',{community_id:closed.id});
 assert.ok(!(await feedIds(outside)).includes(post));assert.ok(!(await feedIds(outside,`?community=${closed.id}`)).includes(post));
 assert.equal((await outside(`/posts/${post}`)).status,404);
 assert.equal((await outside(`/posts/${post}/comments`,{body:'Подглядел'})).status,404);
 assert.ok((await feedIds(owner)).includes(post));assert.equal((await inside(`/posts/${post}`)).data.community_access,'private');
 // A new invite code replaces the old one.
 const fresh=(await owner(`/communities/${closed.id}/invite`,{})).data.invite_code;assert.notEqual(fresh,closed.invite_code);
 assert.equal((await guest(`/communities/invite/${closed.invite_code}`,{})).status,404);
 assert.equal((await owner(`/communities/${club.id}/invite`,{})).status,400);
 assert.equal((await owner(`/communities/${closed.id}`,null,'DELETE')).status,200);
 assert.ok((await feedIds(outside)).includes(post));
 assert.equal((await outside(`/posts/${post}`)).data.community,null);
});

test('Entry conditions: premium only and a minimum of stories',async()=>{
 const [plain,prem]=[await register('newbie@example.com'),await register('rich@example.com',true)];
 const strict=(await owner('/communities',{name:'Только опытные',min_posts:2})).data;
 const elite=(await owner('/communities',{name:'Только прем',premium_only:true})).data;
 assert.equal((await owner('/communities',{name:'Минус',min_posts:-1})).status,400);
 await story(plain,'Первая');
 const refused=await plain(`/communities/${strict.id}/join`,{});assert.equal(refused.status,403);assert.equal(refused.data.error,'Нужно не меньше 2 сплетен в профиле, у тебя 1');
 await story(plain,'Вторая');
 assert.equal((await plain(`/communities/${strict.id}/join`,{})).data.joined,true);
 assert.equal((await plain(`/communities/${elite.id}/join`,{})).status,403);
 assert.equal((await prem(`/communities/${elite.id}/join`,{})).data.joined,true);
 // Turning premium-only on removes members without premium; the owner stays.
 await story(prem,'Раз');await story(prem,'Два');
 assert.equal((await prem(`/communities/${strict.id}/join`,{})).data.joined,true);
 const tightened=(await owner(`/communities/${strict.id}`,{premium_only:true},'PATCH')).data;assert.equal(tightened.members,2);assert.equal(tightened.premium_only,true);
 assert.equal((await plain(`/communities/${strict.id}`)).data.joined,false);
 // Requests are checked again when accepted.
 const gated=(await owner('/communities',{name:'Заявка и прем',access:'request'})).data;
 await plain(`/communities/${gated.id}/join`,{});
 await owner(`/communities/${gated.id}`,{min_posts:5},'PATCH');
 const request=(await owner(`/communities/${gated.id}/requests`)).data[0];
 assert.equal((await owner(`/communities/${gated.id}/requests/${request.id}`,{accept:true})).status,409);
 assert.equal((await notes(plain)).find(n=>n.community_id===gated.id).type,'community_declined');
});
