import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createClient} from 'redis';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
// TEST_DATABASE_URL runs the server on a real PostgreSQL; it must point to a disposable database.
const base='http://localhost:3197/api';
let dir,redisProcess,redis,child,logs='';
// Each session keeps its own cookie, so several anonymous users act side by side.
function session(){let cookie='';return async(url,body,method)=>{const r=await fetch(base+url,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json',cookie},body:body?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()}}}
// The suite registers more users than the per-IP auth limit allows in a minute, so it resets that counter.
async function register(email){for(const key of await redis.keys('iom:rate:*'))await redis.del(key);const s=session();const reg=(await s('/auth/register',{email,accept:{privacy:true,rules:true,consent:true}})).data;assert.equal((await s('/auth/verify',{challenge:reg.challenge,code:reg.dev_code})).status,200);return s}
const privateFields=['user_id','owner_id','email','access_hash','sender','participants'];
const privateCheck=data=>{for(const key of privateFields)assert.ok(!Object.hasOwn(data,key),key+' leaked')};
const unread=async s=>(await s('/notifications/unread')).data.count;
const notes=async s=>(await s('/notifications')).data;
before(async()=>{
 dir=await mkdtemp(path.join(tmpdir(),'iom-social-'));
 redisProcess=spawn('redis-server',['--port','6395','--bind','127.0.0.1','--save','','--appendonly','no'],{stdio:'ignore'});
 redis=createClient({url:'redis://127.0.0.1:6395'});redis.on('error',()=>{});await redis.connect();
 child=spawn(process.execPath,['server/index.js'],{env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL||'',PORT:'3197',REDIS_URL:'redis://127.0.0.1:6395',DATA_DIR:dir,NODE_ENV:'development',SMTP_HOST:''},stdio:'pipe'});
 child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
 for(let i=0;i<150;i++){try{await fetch(base+'/me');break}catch{await pause(100)}}
});
after(async()=>{if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r))}await redis.quit();redisProcess.kill();await rm(dir,{recursive:true,force:true})});
let a,b,c,d,cid,sid;
test('Communities: premium creates, anyone joins, only members post, muted members are notified silently',async()=>{
 [a,b,c,d]=[await register('a@example.com'),await register('b@example.com'),await register('c@example.com'),await register('d@example.com')];
 assert.equal((await a('/premium',{plan:'month',code:'123456'})).status,200);
 assert.equal((await b('/communities',{name:'Офисные истории'})).status,403);
 assert.equal((await a('/communities',{name:'ab'})).status,400);
 assert.equal((await a('/communities',{name:'Название',description:'x'.repeat(301)})).status,400);
 const office=await a('/communities',{name:'  Офисные   истории ',description:'Что происходит на работе'});
 assert.equal(office.status,201);privateCheck(office.data);
 assert.equal(office.data.name,'Офисные истории');assert.equal(office.data.joined,true);assert.equal(office.data.is_owner,true);assert.equal(office.data.members,1);
 assert.equal((await a('/communities',{name:'офисные ИСТОРИИ'})).status,409);
 cid=office.data.id;
 assert.equal((await b(`/communities/${cid}`)).data.is_owner,false);
 assert.equal((await b('/communities/999999')).status,404);
 assert.equal((await b('/posts',{body:'Не участник',topic:'Работа',community_id:cid})).status,403);
 assert.equal((await b(`/communities/${cid}/join`,{})).data.joined,true);
 assert.equal((await b(`/communities/${cid}/join`,{})).data.members,2);
 await c(`/communities/${cid}/join`,{});
 assert.equal((await c(`/communities/${cid}/mute`,{muted:'yes'})).status,400);
 assert.equal((await c(`/communities/${cid}/mute`,{muted:true})).data.muted,true);
 assert.equal((await d(`/communities/${cid}/mute`,{muted:true})).status,404);
 assert.deepEqual((await b('/communities?mine=1')).data.map(x=>x.id),[cid]);
 assert.deepEqual((await d('/communities?mine=1')).data,[]);
 const found=(await d('/communities?q=работе')).data;assert.equal(found[0].id,cid);assert.equal(found[0].joined,false);
 const story=await b('/posts',{body:'Коллега опять опоздал на планёрку',topic:'Работа',community_id:cid});
 assert.equal(story.status,201);assert.equal(story.data.community_id,cid);sid=story.data.id;
 assert.equal(await unread(a),1);assert.equal(await unread(b),0);
 // Muted: listed, but the badge stays at zero.
 assert.equal(await unread(c),0);
 const silent=(await notes(c))[0];assert.equal(silent.type,'community_post');assert.equal(silent.silent,true);assert.equal(silent.community,'Офисные истории');assert.equal(silent.post_id,sid);
 const inFeed=(await d('/posts')).data.find(p=>p.id===sid);assert.equal(inFeed.community,'Офисные истории');assert.equal(inFeed.community_id,cid);
 const onlyCommunity=(await d(`/posts?community=${cid}`)).data;assert.deepEqual(onlyCommunity.map(p=>p.id),[sid]);
 // Members who left stop getting notifications.
 assert.equal((await c(`/communities/${cid}/leave`,{})).data.joined,false);
 await b('/posts',{body:'Вторая история про планёрку',topic:'Работа',community_id:cid});
 assert.equal((await notes(c)).length,1);assert.equal(await unread(a),2);
});
test('Post likes and comments notify the author once per target, never the actor',async()=>{
 await a(`/posts/${sid}/like`,{active:true});await a(`/posts/${sid}/like`,{active:true});
 await c(`/posts/${sid}/like`,{active:true});await b(`/posts/${sid}/like`,{active:true});
 const like=(await notes(b)).find(n=>n.type==='post_like');assert.equal(like.count,2);assert.equal(like.post_excerpt,'Коллега опять опоздал на планёрку');
 const top=await a(`/posts/${sid}/comments`,{body:'Это уже традиция'});assert.equal(top.status,201);
 const reply=await b(`/posts/${sid}/comments`,{body:'Каждый понедельник',reply_to:top.data.id});assert.equal(reply.status,201);
 const nested=await c(`/posts/${sid}/comments`,{body:'А у нас так же',reply_to:reply.data.id});assert.equal(nested.status,201);
 // A reply to a reply joins the thread of the top-level comment.
 const thread=(await d(`/posts/${sid}/comments`)).data;for(const x of thread)privateCheck(x);
 assert.deepEqual(thread.map(x=>[x.body,x.parent_id]),[['Это уже традиция',null],['Каждый понедельник',top.data.id],['А у нас так же',top.data.id]]);
 assert.equal((await d(`/posts/${sid}`)).data.comments,3);
 const bNotes=await notes(b);
 assert.equal(bNotes.find(n=>n.type==='post_comment').count,1,'only the comment by a: c replied to b and got a reply notice instead');
 const bReply=bNotes.find(n=>n.type==='comment_reply');assert.equal(bReply.count,1);assert.equal(bReply.comment_excerpt,'Каждый понедельник');
 const aReply=(await notes(a)).find(n=>n.type==='comment_reply');assert.equal(aReply.count,1);assert.equal(aReply.comment_excerpt,'Это уже традиция');
 for(const n of bNotes)privateCheck(n);
 const other=(await d('/posts',{body:'Другая история',topic:'Жизнь'})).data.id;
 assert.equal((await d(`/posts/${other}/comments`,{body:'Не туда',reply_to:top.data.id})).status,400);
 assert.equal((await d(`/posts/${sid}/comments`,{body:'Нет такого',reply_to:999999})).status,400);
 assert.equal((await d(`/posts/${sid}/comments`,{body:'Не число',reply_to:'1'})).status,400);
 assert.equal((await d('/posts/999999/comments',{body:'Нет поста'})).status,404);
 // Comment likes: counted per comment, the liker sees "liked", the author is notified.
 await b(`/comments/${top.data.id}/like`,{active:true});await d(`/comments/${top.data.id}/like`,{active:true});await a(`/comments/${top.data.id}/like`,{active:true});
 const liked=(await b(`/posts/${sid}/comments`)).data[0];assert.equal(liked.likes,3);assert.equal(liked.liked,true);
 assert.equal((await c(`/posts/${sid}/comments`)).data[0].liked,false);
 assert.equal((await notes(a)).find(n=>n.type==='comment_like').count,2);
 await d(`/comments/${top.data.id}/like`,{active:false});assert.equal((await b(`/posts/${sid}/comments`)).data[0].likes,2);
 assert.equal((await d('/comments/999999/like',{active:true})).status,404);
 assert.ok((await a(`/posts/${sid}/comments`)).data[0].is_own);
 // Reading resets the badge; a new event after that starts a new notification.
 assert.equal(await unread(b),3);
 await b('/notifications/read',{});assert.equal(await unread(b),0);
 await d(`/posts/${sid}/comments`,{body:'Ещё один'});
 const fresh=(await notes(b)).filter(n=>n.type==='post_comment');assert.deepEqual(fresh.map(n=>[n.count,n.read]),[[1,false],[1,true]]);
 assert.equal((await d(`/posts/${sid}`)).data.community,'Офисные истории');
 assert.equal((await d('/posts/999999')).status,404);assert.equal((await d('/posts/abc')).status,404);
 assert.equal((await d('/support/report',{kind:'community',id:cid,category:'politics'})).status,201);
 await pause(200);assert.match(logs,/Сообщество #\d+: Офисные истории\nЧто происходит на работе/);
});
test('"For you" ranks by topics, story words and similar users, skipping own and liked posts',async()=>{
 const [viewer,author,peer,other]=[await register('viewer@example.com'),await register('author@example.com'),await register('peer@example.com'),await register('other@example.com')];
 const post=async(body,topic)=>(await author('/posts',{body,topic})).data.id;
 const closed=await post('Кофейня у дома закрылась, и теперь утро без кофе','Город');
 const coffee=await post('Возле парка открылась новая кофейня, там варят отличный кофе','Город');
 const swings=await post('Во дворе поставили новые качели','Город');
 const repair=await post('Соседи снова затеяли ремонт в субботу утром','Жизнь');
 const vacation=await post('Начальник перенёс отпуск всего отдела','Отношения');
 await viewer(`/posts/${closed}/like`,{active:true});
 // The peer shares the viewer's taste and also liked the repair story; another user liked the vacation story.
 await peer(`/posts/${closed}/like`,{active:true});await peer(`/posts/${repair}/like`,{active:true});await other(`/posts/${vacation}/like`,{active:true});
 const ids=(await viewer('/posts?sort=recommended')).data.map(p=>p.id);
 assert.ok(!ids.includes(closed),'already liked');
 assert.ok(ids.indexOf(coffee)<ids.indexOf(swings),'same topic, matching words win');
 assert.ok(ids.indexOf(swings)<ids.indexOf(repair),'favourite topic wins');
 assert.ok(ids.indexOf(repair)<ids.indexOf(vacation),'similar users win over equal popularity');
 assert.ok(!(await author('/posts?sort=recommended')).data.some(p=>[closed,coffee,swings,repair,vacation].includes(p.id)),'own posts');
 // Without any signals the list still fills up from fresh and popular posts.
 assert.ok((await (await register('new@example.com'))('/posts?sort=recommended')).data.length>5);
 assert.deepEqual((await viewer(`/posts?sort=recommended&community=${cid}`)).data.every(p=>p.community_id===cid),true);
});
test('Community owner tools, member dislikes and posts that can only be anonymized',async()=>{
 const [owner,member,outsider,viewer]=[await register('owner@example.com'),await register('member@example.com'),await register('outsider@example.com'),await register('reader@example.com')];
 await owner('/premium',{plan:'week',code:'123456'});
 const club=(await owner('/communities',{name:'Соседи по подъезду'})).data;
 await member(`/communities/${club.id}/join`,{});await viewer(`/communities/${club.id}/join`,{});
 // Description: owner only, up to 300 characters.
 assert.equal((await member(`/communities/${club.id}`,{description:'Чужое'},'PATCH')).status,403);
 assert.equal((await owner(`/communities/${club.id}`,{description:'x'.repeat(301)},'PATCH')).status,400);
 assert.equal((await owner(`/communities/${club.id}`,{description:'  Про шум, лифт и парковку  '},'PATCH')).data.description,'Про шум, лифт и парковку');
 assert.equal((await outsider(`/communities/${club.id}`)).data.description,'Про шум, лифт и парковку');
 const story=(await member('/posts',{body:'Кто-то снова занял два места на парковке',topic:'Город',community_id:club.id})).data;
 const general=(await member('/posts',{body:'Обычная сплетня вне сообществ',topic:'Город'})).data;
 // Dislikes: members only, community posts only, and they replace the viewer's like.
 assert.equal((await outsider(`/posts/${story.id}/dislike`,{active:true})).status,403);
 assert.equal((await viewer(`/posts/${general.id}/dislike`,{active:true})).status,403);
 await viewer(`/posts/${story.id}/like`,{active:true});
 assert.equal((await viewer(`/posts/${story.id}/dislike`,{active:true})).status,200);
 let seen=(await viewer(`/posts/${story.id}`)).data;assert.deepEqual([seen.likes,seen.liked,seen.dislikes,seen.disliked,seen.member],[0,false,1,true,true]);
 await viewer(`/posts/${story.id}/like`,{active:true});
 seen=(await viewer(`/posts/${story.id}`)).data;assert.deepEqual([seen.likes,seen.dislikes,seen.disliked],[1,0,false]);
 await viewer(`/posts/${story.id}/dislike`,{active:true});
 assert.equal((await outsider(`/posts/${story.id}`)).data.member,false);
 assert.ok(!(await notes(member)).some(n=>n.post_id===story.id&&n.type!=='post_like'),'dislikes are not notified');
 // Nobody deletes community posts, not even the author; the owner may anonymize any of them.
 assert.equal((await member(`/posts/${story.id}`,null,'DELETE')).status,403);
 assert.equal((await owner(`/posts/${story.id}`,null,'DELETE')).status,404);
 assert.equal((await viewer(`/posts/${story.id}/anonymize`,{})).status,404);
 assert.equal((await owner(`/posts/${story.id}`)).data.community_owner,true);
 assert.equal((await member(`/posts/${story.id}`)).data.community_owner,false);
 assert.equal((await owner(`/posts/${story.id}/anonymize`,{})).status,200);
 const unlinked=(await member(`/posts/${story.id}`)).data;assert.equal(unlinked.anonymized,true);assert.equal(unlinked.is_own,null);
 assert.ok(!(await member('/posts?view=profile')).data.some(p=>p.id===story.id));
 // Without premium an author can still unlink their own community post, but not a general one.
 const own=(await member('/posts',{body:'Моя сплетня в сообществе',topic:'Жизнь',community_id:club.id})).data;
 assert.equal((await member(`/posts/${general.id}/anonymize`,{})).status,403);
 assert.equal((await member(`/posts/${own.id}/anonymize`,{})).status,200);
 assert.equal((await member(`/posts/${general.id}`,null,'DELETE')).status,200);
 // Deleting the community: owner only; its posts move to the general feed and its notifications go away.
 assert.ok((await notes(viewer)).some(n=>n.type==='community_post'));
 assert.equal((await member(`/communities/${club.id}`,null,'DELETE')).status,403);
 assert.equal((await owner(`/communities/${club.id}`,null,'DELETE')).status,200);
 assert.equal((await owner(`/communities/${club.id}`)).status,404);
 const kept=(await outsider(`/posts/${story.id}`)).data;assert.equal(kept.community,null);assert.equal(kept.community_id,null);
 assert.ok(!(await notes(viewer)).some(n=>n.type==='community_post'));
});
test('Dislikes push a post down in "For you" and hide it from the one who disliked it',async()=>{
 const [owner,first,second,viewer]=[await register('o2@example.com'),await register('m2@example.com'),await register('m3@example.com'),await register('v2@example.com')];
 await owner('/premium',{plan:'week',code:'123456'});
 const club=(await owner('/communities',{name:'Двор и окрестности'})).data;
 for(const s of [first,second])await s(`/communities/${club.id}/join`,{});
 const calm=(await owner('/posts',{body:'Во дворе починили фонарь',topic:'Город',community_id:club.id})).data.id;
 // Posted later, so on equal scores it would come first: only the dislikes can move it below.
 const disliked=(await owner('/posts',{body:'Во дворе покрасили скамейку',topic:'Город',community_id:club.id})).data.id;
 await first(`/posts/${disliked}/dislike`,{active:true});await second(`/posts/${disliked}/dislike`,{active:true});
 const ids=(await viewer('/posts?sort=recommended')).data.map(p=>p.id);
 assert.ok(ids.indexOf(calm)<ids.indexOf(disliked));
 assert.ok(!(await first('/posts?sort=recommended')).data.some(p=>p.id===disliked));
 // The profile and saved views ignore the recommendation order.
 assert.deepEqual((await owner('/posts?view=profile&sort=recommended')).data.map(p=>p.id),[disliked,calm]);
});
