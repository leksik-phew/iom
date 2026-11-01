import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createClient} from 'redis';
import {PGlite} from '@electric-sql/pglite';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('Anonymous registration, verification, roles, privacy and ownership',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'iom-test-'));
 const redisProcess=spawn('redis-server',['--port','6398','--bind','127.0.0.1','--save','','--appendonly','no'],{stdio:'ignore'});
 const redis=createClient({url:'redis://127.0.0.1:6398'});redis.on('error',()=>{});await redis.connect();
 const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,DATABASE_URL:'',PORT:'3199',REDIS_URL:'redis://127.0.0.1:6398',DATA_DIR:dir,NODE_ENV:'development',SMTP_HOST:''},stdio:'pipe'});
 let cookie='',logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
 async function request(url,body,method){const r=await fetch('http://localhost:3199/api'+url,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json',cookie},body:body?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()}}
 const privateFields=['user_id','handle','color','email','access_hash','password'];
 function privateCheck(data){for(const key of privateFields)assert.ok(!Object.hasOwn(data,key),key+' leaked')}
 try{
  for(let i=0;i<150;i++){try{await fetch('http://localhost:3199/api/me');break}catch{await pause(100)}}
  assert.equal((await request('/posts')).status,401);
  const registration=(await request('/auth/register',{email:'anonymous@example.com'})).data;
  const key='iom:registration:'+registration.challenge;
  assert.equal(JSON.parse(await redis.get(key)).email,'anonymous@example.com');
  assert.ok(await redis.ttl(key)<=600);
  assert.equal((await request('/me')).data,null);
  assert.equal((await request('/auth/verify',{challenge:registration.challenge,code:'000000'})).status,400);
  const verified=await request('/auth/verify',{challenge:registration.challenge,code:registration.dev_code});
  assert.equal(verified.status,200);assert.equal(verified.data.user.user_verified,true);assert.equal(verified.data.user.role,'default');assert.equal(await redis.get(key),null);
  assert.equal((await request('/auth/verify',{challenge:registration.challenge,code:registration.dev_code})).status,400);
  privateCheck(verified.data.user);assert.ok(!('id' in verified.data.user));
  const secret=verified.data.access_key;
  // Premium needs a known plan and the confirmation code; a new purchase extends the current term.
  assert.equal((await request('/me')).data.premium_until,null);
  assert.deepEqual((await request('/premium/plans')).data.map(p=>p.id),['week','month','quarter','half','year']);
  assert.equal((await request('/premium',{})).status,400);
  assert.equal((await request('/premium',{plan:'decade',code:'123456'})).status,400);
  assert.equal((await request('/premium',{plan:['week'],code:'123456'})).status,400);
  const wrongCode=await request('/premium',{plan:'month',code:'654321'});assert.equal(wrongCode.status,400);assert.equal(wrongCode.data.error,'Неверный код. Осталось попыток: 4');
  assert.equal((await request('/me')).data.role,'default');
  const before=Date.now();
  const monthly=await request('/premium',{plan:'month',code:'123456'});assert.equal(monthly.status,200);assert.equal(monthly.data.role,'premium');privateCheck(monthly.data);
  assert.deepEqual(await redis.keys('iom:premium-attempts:*'),[]);
  const monthEnd=new Date(monthly.data.premium_until).getTime();
  assert.ok(monthEnd>before+27*86400000&&monthEnd<Date.now()+32*86400000);
  const extended=(await request('/premium',{plan:'week',code:'123456'})).data;
  assert.equal(new Date(extended.premium_until).getTime()-monthEnd,7*86400000);
  assert.equal((await request('/me')).data.premium_until,extended.premium_until);
  const p=await request('/posts',{body:'Проверка сохранения',topic:'Жизнь'});assert.equal(p.status,201);privateCheck(p.data);const id=p.data.id;
  await request(`/posts/${id}/like`,{active:true});await request(`/posts/${id}/like`,{active:true});await request(`/posts/${id}/save`,{active:true});
  const saved=(await request('/posts?view=saved')).data;assert.equal(saved.length,1);assert.equal(saved[0].likes,1);
  for(const post of (await request('/posts')).data){privateCheck(post);assert.equal(post.name,'Пользователь')}
  assert.equal((await request('/posts?view=profile')).data.length,1);
  await request(`/posts/${id}/comments`,{body:'Ответ'});const comment=(await request(`/posts/${id}/comments`)).data[0];privateCheck(comment);assert.equal(comment.name,'Пользователь');
  assert.equal((await request('/posts/1',null,'DELETE')).status,404);
  await request('/logout',{});assert.equal((await request('/posts')).status,401);
  const relogged=(await request('/auth/login',{access_key:secret})).data;assert.equal(relogged.role,'premium');assert.equal(relogged.premium_until,extended.premium_until);
  // A second account can reply but cannot initiate chats or anonymize posts.
  let firstCookie=cookie;
  cookie='';
  const secondReg=(await request('/auth/register',{email:'second@example.com'})).data;
  const secondVerified=await request('/auth/verify',{challenge:secondReg.challenge,code:secondReg.dev_code});
  const secondSecret=secondVerified.data.access_key;
  let secondCookie=cookie;
  const structured=await request('/posts',{body:'История',topic:'Жизнь',characters:['Персонаж А'],events:[{title:'Начало',body:'Персонаж А пришёл.'}]});
  assert.equal(structured.status,201);assert.equal(structured.data.events[0].title,'Начало');
  const storyId=structured.data.id;
  assert.equal((await request('/posts',{body:'История',topic:'Жизнь',events:[{title:'',body:'x'}]})).status,400);
  assert.equal((await request(`/posts/${storyId}/anonymize`,{})).status,403);
  assert.equal((await request('/chats',{kind:'post',id})).status,403);
  cookie=firstCookie;
  assert.equal((await request(`/posts/${storyId}/anonymize`,{})).status,404);
  const chat=await request('/chats',{kind:'post',id:storyId});assert.equal(chat.status,201);
  const chatId=chat.data.id;
  assert.equal((await request('/chats',{kind:'post',id:storyId})).data.id,chatId);
  // The recipient may open the chat before the first message.
  cookie=secondCookie;
  const empty=await request('/chats');assert.equal(empty.status,200);assert.deepEqual(empty.data[0].messages,[]);assert.equal(empty.data[0].waiting,false);
  cookie=firstCookie;
  assert.equal((await request(`/chats/${chatId}/messages`,{body:'Привет'})).status,201);
  cookie=secondCookie;
  const inbox=(await request('/chats')).data;assert.equal(inbox[0].messages[0].body,'Привет');assert.equal(inbox[0].messages[0].mine,false);
  assert.ok(!('seats' in inbox[0]));assert.ok(!('seat' in inbox[0].messages[0]));
  assert.equal((await request(`/chats/${chatId}/messages`,{body:'Ответ'})).status,201);
  // A third session cannot discover, read, delete or write into the chat.
  cookie='';const thirdReg=(await request('/auth/register',{email:'third@example.com'})).data;
  await request('/auth/verify',{challenge:thirdReg.challenge,code:thirdReg.dev_code});
  assert.deepEqual((await request('/chats')).data,[]);
  assert.equal((await request(`/chats/${chatId}/messages`,{body:'Intruder'})).status,404);
  assert.equal((await request('/chats/'+chatId,null,'DELETE')).status,404);
  // Five wrong codes freeze the premium endpoint for an hour, even for the right code.
  for(let i=1;i<5;i++)assert.equal((await request('/premium',{plan:'week',code:'000000'})).data.error,`Неверный код. Осталось попыток: ${5-i}`);
  assert.equal((await request('/premium',{plan:'week',code:'000000'})).status,429);
  const frozen=await request('/premium',{plan:'week',code:'123456'});assert.equal(frozen.status,429);assert.match(frozen.data.error,/60 мин/);
  assert.equal((await request('/me')).data.role,'default');
  const [attemptsKey]=await redis.keys('iom:premium-attempts:*');assert.ok(await redis.ttl(attemptsKey)>3590);
  await redis.del(attemptsKey);
  assert.equal((await request('/premium',{plan:'week',code:'123456'})).status,200);
  // Chats live only in Redis, never longer than 24 hours, and survive closed tabs without any heartbeat.
  assert.ok(await redis.pTTL('iom:chat:'+chatId)<=86400000);
  await pause(5500);assert.equal(await redis.exists('iom:chat:'+chatId),1);
  // The sender logs out: the recipient's session keeps the chat, and the sender's next session gets the reply.
  cookie=firstCookie;await request('/logout',{});assert.equal(await redis.exists('iom:chat:'+chatId),1);
  cookie=secondCookie;assert.equal((await request(`/chats/${chatId}/messages`,{body:'Ответ после выхода'})).status,201);
  cookie='';await request('/auth/login',{access_key:secret});firstCookie=cookie;
  const restored=(await request('/chats')).data.find(c=>c.id===chatId);
  assert.deepEqual(restored.messages.map(m=>[m.body,m.mine]),[['Привет',true],['Ответ',false],['Ответ после выхода',false]]);
  assert.equal((await request(`/chats/${chatId}/messages`,{body:'Я вернулся'})).status,201);
  // Another session of the recipient cannot take a seat that is still held.
  cookie='';await request('/auth/login',{access_key:secondSecret});
  assert.deepEqual((await request('/chats')).data,[]);
  await request('/logout',{});assert.equal(await redis.exists('iom:chat:'+chatId),1);
  // Ending the chat deletes it for both.
  cookie=secondCookie;assert.equal((await request('/chats/'+chatId,null,'DELETE')).status,200);
  assert.equal(await redis.exists('iom:chat:'+chatId),0);
  cookie=firstCookie;assert.deepEqual((await request('/chats')).data,[]);
  // The chat is deleted once both participants have logged out.
  cookie=secondCookie;await request(`/posts/${storyId}/comments`,{body:'Ещё мнение'});
  const targetComment=(await request(`/posts/${storyId}/comments`)).data[0];
  cookie=firstCookie;const commentChat=await request('/chats',{kind:'comment',id:targetComment.id});assert.equal(commentChat.status,201);
  cookie=secondCookie;await request('/chats');await request('/logout',{});
  assert.equal(await redis.exists('iom:chat:'+commentChat.data.id),1);
  cookie=firstCookie;await request('/logout',{});
  assert.equal(await redis.exists('iom:chat:'+commentChat.data.id),0);
  // A recipient with no session cannot hold a chat, so it ends when the sender logs out.
  cookie='';await request('/auth/login',{access_key:secret});
  const orphan=await request('/chats',{kind:'post',id:storyId});assert.equal(orphan.status,201);
  await request('/logout',{});assert.equal(await redis.exists('iom:chat:'+orphan.data.id),0);
  // A logged-in recipient holds a chat they have not opened yet, even after the sender logs out.
  cookie='';await request('/auth/login',{access_key:secondSecret});secondCookie=cookie;
  cookie='';await request('/auth/login',{access_key:secret});
  const unread=await request('/chats',{kind:'post',id:storyId});assert.equal(unread.status,201);
  await request(`/chats/${unread.data.id}/messages`,{body:'Прочитай потом'});
  await request('/logout',{});assert.equal(await redis.exists('iom:chat:'+unread.data.id),1);
  cookie=secondCookie;assert.equal((await request('/chats')).data.find(c=>c.id===unread.data.id).messages[0].body,'Прочитай потом');
  assert.equal((await request('/chats/'+unread.data.id,null,'DELETE')).status,200);
  await request('/logout',{});
  // Recipient has no session: the chat waits in the sender's session and the recipient's next login claims it.
  cookie='';await request('/auth/login',{access_key:secret});firstCookie=cookie;
  const offlineChat=await request('/chats',{kind:'post',id:storyId});assert.equal(offlineChat.status,201);
  const pending=(await request('/chats')).data.find(c=>c.id===offlineChat.data.id);assert.equal(pending.waiting,true);
  assert.equal((await request(`/chats/${offlineChat.data.id}/messages`,{body:'Сообщение офлайн'})).status,201);
  assert.equal((await request('/chats',{kind:'post',id:storyId})).data.id,offlineChat.data.id);
  cookie='';await request('/auth/login',{access_key:secondSecret});
  const delivered=(await request('/chats')).data.find(c=>c.id===offlineChat.data.id);
  assert.equal(delivered.messages[0].body,'Сообщение офлайн');assert.equal(delivered.waiting,false);
  assert.equal((await request(`/chats/${offlineChat.data.id}/messages`,{body:'Я вернулся'})).status,201);
  await request('/logout',{});
  assert.equal(await redis.exists('iom:chat:'+offlineChat.data.id),1);
  cookie=firstCookie;
  assert.deepEqual((await request('/chats')).data[0].messages.map(m=>m.body),['Сообщение офлайн','Я вернулся']);
  // Parallel messages are not lost: every write retries until it lands on the latest chat state.
  await Promise.all(['1','2','3','4','5'].map(body=>request(`/chats/${offlineChat.data.id}/messages`,{body})));
  assert.deepEqual((await request('/chats')).data[0].messages.slice(2).map(m=>m.body).sort(),['1','2','3','4','5']);
  // Anonymization preserves the story but removes ownership and contactability.
  const ownStory=(await request('/posts',{body:'Обезличенная история',topic:'Город',characters:['Сосед'],events:[]})).data;
  assert.equal((await request(`/posts/${ownStory.id}/anonymize`,{})).status,200);
  const publicStory=(await request('/posts')).data.find(p=>p.id===ownStory.id);
  assert.equal(publicStory.anonymized,true);assert.equal(publicStory.is_own,null);
  assert.ok(!(await request('/posts?view=profile')).data.some(p=>p.id===ownStory.id));
  assert.equal((await request('/posts/'+ownStory.id,null,'DELETE')).status,404);
  assert.equal((await request('/chats',{kind:'post',id:ownStory.id})).status,404);
  assert.equal((await request('/posts/'+id,null,'DELETE')).status,200);
 }catch(e){console.error(logs);throw e}finally{
  if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}
  const db=new PGlite(dir);const cols=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='users'")).rows.map(x=>x.column_name);for(const field of ['name','email','handle','password','color'])assert.ok(!cols.includes(field));
  assert.equal((await db.query("SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_type.oid=enumtypid WHERE typname='user_role'")).rows.length,2);
  assert.deepEqual((await db.query('SELECT plan FROM subscriptions ORDER BY id')).rows.map(r=>r.plan),['month','week','week']);
  assert.deepEqual((await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE '%chat%'")).rows,[]);
  await db.close();await redis.quit();redisProcess.kill();await rm(dir,{recursive:true,force:true});
 }
});
