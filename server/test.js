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
 const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,PORT:'3199',REDIS_URL:'redis://127.0.0.1:6398',DATA_DIR:dir,NODE_ENV:'development',SMTP_HOST:''},stdio:'pipe'});
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
  assert.equal((await request('/premium',{})).data.role,'premium');
  assert.equal((await request('/premium',{})).data.role,'premium');
  const p=await request('/posts',{body:'Проверка сохранения',topic:'Жизнь'});assert.equal(p.status,201);privateCheck(p.data);const id=p.data.id;
  await request(`/posts/${id}/like`,{active:true});await request(`/posts/${id}/like`,{active:true});await request(`/posts/${id}/save`,{active:true});
  const saved=(await request('/posts?view=saved')).data;assert.equal(saved.length,1);assert.equal(saved[0].likes,1);
  for(const post of (await request('/posts')).data){privateCheck(post);assert.equal(post.name,'Пользователь')}
  assert.equal((await request('/posts?view=profile')).data.length,1);
  await request(`/posts/${id}/comments`,{body:'Ответ'});const comment=(await request(`/posts/${id}/comments`)).data[0];privateCheck(comment);assert.equal(comment.name,'Пользователь');
  assert.equal((await request('/posts/1',null,'DELETE')).status,404);
  await request('/logout',{});assert.equal((await request('/posts')).status,401);
  assert.equal((await request('/auth/login',{access_key:secret})).data.role,'premium');
  assert.equal((await request('/posts/'+id,null,'DELETE')).status,200);
 }catch(e){console.error(logs);throw e}finally{
  if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}
  const db=new PGlite(dir);const cols=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='users'")).rows.map(x=>x.column_name);for(const field of ['name','email','handle','password','color'])assert.ok(!cols.includes(field));
  assert.equal((await db.query("SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_type.oid=enumtypid WHERE typname='user_role'")).rows.length,2);
  await db.close();await redis.quit();redisProcess.kill();await rm(dir,{recursive:true,force:true});
 }
});
